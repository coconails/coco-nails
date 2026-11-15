import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx } from '../context.js';
import * as A from '../auth/service.js';
import * as W from '../auth/webauthn.js';
import { verifyPassword } from '../auth/passwords.js';
import { audit } from '../lib/audit.js';
import { now, randomToken, sha256, timingSafeEqualStr, UserError } from '../lib/util.js';
import { body, clearSessionCookie, deviceOf, ensureCsrfCookie, ipOf, requireSession, requireSudo, requireUser, setDeviceCookie, setSessionCookie } from './helpers.js';
import { isRole, ROLE_RANK, type Role } from '../sites/service.js';

export function setupCodePath(ctx: Ctx): string {
  return path.join(ctx.config.dataDir, 'plateforme', 'code-installation.txt');
}

/** À la première installation : un code à usage unique est écrit sur le serveur, pour que personne d'autre ne puisse créer le compte propriétaire. */
export function ensureSetupCode(ctx: Ctx): string | null {
  if (A.userCount(ctx) > 0) {
    fs.rmSync(setupCodePath(ctx), { force: true });
    return null;
  }
  const p = setupCodePath(ctx);
  if (!fs.existsSync(p)) fs.writeFileSync(p, randomToken(9).replace(/[-_]/g, 'x').slice(0, 12).toUpperCase(), { mode: 0o600 });
  return fs.readFileSync(p, 'utf8').trim();
}

export function registerAuthRoutes(app: FastifyInstance, ctx: Ctx): void {
  // État de la connexion (et jeton anti-falsification pour le navigateur).
  app.get('/api/etat', async (req, reply) => {
    const csrf = ensureCsrfCookie(ctx, req, reply);
    const installation = A.userCount(ctx) === 0;
    if (!req.auth) return { installation, connecte: false, csrf };
    return {
      installation,
      connecte: true,
      configurer2fa: !req.auth.session.mfa_ok,
      utilisateur: A.publicUser(ctx, req.auth.user),
      csrf,
      deconnexionInactiviteMinutes: ctx.config.sessionIdleMinutes,
    };
  });

  // ------------------------------------------------------------------ installation
  app.post('/api/installation', async (req, reply) => {
    const b = body<{ code?: string; nom?: string; email?: string; motDePasse?: string }>(req);
    const expected = ensureSetupCode(ctx);
    if (!expected) throw new UserError(409, 'PAGINITY est déjà installé.');
    A.assertNotLocked(ctx, [`ip:${ipOf(req)}`]);
    if (typeof b.code !== 'string' || !timingSafeEqualStr(b.code.trim().toUpperCase(), expected)) {
      A.recordFailure(ctx, [`ip:${ipOf(req)}`]);
      throw new UserError(400, "Code d'installation incorrect. Il s'affiche au démarrage du serveur et se trouve dans le fichier plateforme/code-installation.txt.");
    }
    const user = await A.createUser(ctx, { email: b.email ?? '', name: b.nom ?? '', password: b.motDePasse ?? '', isOwner: true });
    ctx.sites.defaultSpace();
    fs.rmSync(setupCodePath(ctx), { force: true });
    const token = A.createSession(ctx, user.id, { mfaOk: false, ip: ipOf(req), userAgent: req.headers['user-agent'] });
    setSessionCookie(ctx, reply, token);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'installation' });
    return { ok: true, configurer2fa: true };
  });

  // ------------------------------------------------------------------ connexion
  app.post('/api/connexion', async (req, reply) => {
    const b = body<{ email?: string; motDePasse?: string }>(req);
    const user = await A.checkCredentials(ctx, b.email, b.motDePasse, ipOf(req), deviceOf(ctx, req));
    const f = A.userHas2fa(ctx, user);
    if (!f.totp && !f.passkey) {
      // Compte sans double authentification : session limitée à sa configuration.
      const token = A.createSession(ctx, user.id, { mfaOk: false, ip: ipOf(req), userAgent: req.headers['user-agent'] });
      setSessionCookie(ctx, reply, token);
      A.clearFailures(ctx, A.loginKeys(ipOf(req), user.email, user, deviceOf(ctx, req)));
      return { etape: 'configurer-2fa' };
    }
    return { etape: '2fa', defi: A.createLoginChallenge(ctx, user.id), methodes: { totp: f.totp, passkey: f.passkey, secours: true } };
  });

  const finishLogin = (req: FastifyRequest, reply: FastifyReply, challenge: A.LoginChallengeRow, method: string) => {
    A.consumeChallenge(ctx, challenge);
    const user = A.getUser(ctx, challenge.user_id)!;
    const device = deviceOf(ctx, req);
    // Connexion complète réussie : on efface les erreurs de cet appareil, et ce navigateur devient un appareil reconnu.
    A.clearFailures(ctx, [`ip:${ipOf(req)}`, ...A.loginKeys(ipOf(req), user.email, user, device)]);
    setDeviceCookie(ctx, reply, user.id, device);
    const token = A.createSession(ctx, user.id, { mfaOk: true, ip: ipOf(req), userAgent: req.headers['user-agent'] });
    setSessionCookie(ctx, reply, token);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'connexion', details: { methode: method, appareil: String(req.headers['user-agent'] ?? '').slice(0, 120) } });
    return { ok: true };
  };

  app.post('/api/connexion/totp', async (req, reply) => {
    const b = body<{ defi?: string; code?: string }>(req);
    const ch = A.getLoginChallenge(ctx, b.defi);
    const user = A.getUser(ctx, ch.user_id);
    if (!user || !A.verifyTotp(ctx, user, b.code)) {
      A.failChallenge(ctx, ch, ipOf(req), deviceOf(ctx, req));
      throw new UserError(401, 'Code incorrect ou déjà utilisé.');
    }
    return finishLogin(req, reply, ch, 'totp');
  });

  app.post('/api/connexion/secours', async (req, reply) => {
    const b = body<{ defi?: string; code?: string }>(req);
    const ch = A.getLoginChallenge(ctx, b.defi);
    if (!A.useRecoveryCode(ctx, ch.user_id, b.code)) {
      A.failChallenge(ctx, ch, ipOf(req), deviceOf(ctx, req));
      throw new UserError(401, 'Code de secours incorrect ou déjà utilisé.');
    }
    audit(ctx.db, { userId: ch.user_id, ip: ipOf(req), action: 'code_secours_utilise' });
    return finishLogin(req, reply, ch, 'code de secours');
  });

  app.post('/api/connexion/passkey/options', async (req) => {
    const b = body<{ defi?: string }>(req);
    const ch = A.getLoginChallenge(ctx, b.defi);
    const options = await W.authenticationOptions(ctx, ch.user_id);
    ctx.db.prepare('UPDATE login_challenges SET webauthn_challenge = ? WHERE token_hash = ?').run(options.challenge, ch.token_hash);
    return options;
  });

  app.post('/api/connexion/passkey', async (req, reply) => {
    const b = body<{ defi?: string; reponse?: unknown }>(req);
    const ch = A.getLoginChallenge(ctx, b.defi);
    if (!ch.webauthn_challenge || !(await W.verifyPasskey(ctx, ch.user_id, ch.webauthn_challenge, b.reponse))) {
      A.failChallenge(ctx, ch, ipOf(req), deviceOf(ctx, req));
      throw new UserError(401, 'La passkey n’a pas été reconnue.');
    }
    return finishLogin(req, reply, ch, 'passkey');
  });

  app.post('/api/deconnexion', async (req, reply) => {
    if (req.auth) {
      A.destroySession(ctx, req.auth.session.id_hash);
      audit(ctx.db, { userId: req.auth.user.id, ip: ipOf(req), action: 'deconnexion' });
    }
    clearSessionCookie(ctx, reply);
    return { ok: true };
  });

  app.post('/api/deconnexion/partout', async (req, reply) => {
    const { user } = requireUser(req);
    A.destroyAllSessions(ctx, user.id);
    clearSessionCookie(ctx, reply);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'deconnexion_partout' });
    return { ok: true };
  });

  // ------------------------------------------------------------------ confirmation renforcée
  app.post('/api/confirmation', async (req) => {
    const { user, session } = requireUser(req);
    const b = body<{ motDePasse?: string; code?: string }>(req);
    // Personne déjà connectée : ses erreurs sont comptées pour son compte uniquement (un inconnu ne peut pas la bloquer).
    const keys = [`confirmation:${user.id}`];
    A.assertNotLocked(ctx, keys);
    const okPw = typeof b.motDePasse === 'string' && (await verifyPassword(user.password_hash, b.motDePasse));
    const f = A.userHas2fa(ctx, user);
    const okCode = okPw && ((f.totp && A.verifyTotp(ctx, user, b.code)) || A.useRecoveryCode(ctx, user.id, b.code));
    if (!okPw || !okCode) {
      A.recordFailure(ctx, keys);
      throw new UserError(401, 'Mot de passe ou code incorrect.');
    }
    A.grantSudo(ctx, session.id_hash);
    return { ok: true, valableMinutes: ctx.config.sudoMinutes };
  });

  app.post('/api/confirmation/passkey/options', async (req) => {
    const { user, session } = requireUser(req);
    const options = await W.authenticationOptions(ctx, user.id);
    ctx.db.prepare('UPDATE sessions SET webauthn_challenge = ? WHERE id_hash = ?').run(options.challenge, session.id_hash);
    return options;
  });

  app.post('/api/confirmation/passkey', async (req) => {
    const { user, session } = requireUser(req);
    const b = body<{ motDePasse?: string; reponse?: unknown }>(req);
    const keys = [`confirmation:${user.id}`];
    A.assertNotLocked(ctx, keys);
    const row = ctx.db.prepare('SELECT webauthn_challenge FROM sessions WHERE id_hash = ?').get(session.id_hash) as { webauthn_challenge: string | null };
    ctx.db.prepare('UPDATE sessions SET webauthn_challenge = NULL WHERE id_hash = ?').run(session.id_hash);
    const okPw = typeof b.motDePasse === 'string' && (await verifyPassword(user.password_hash, b.motDePasse));
    const okPk = !!row?.webauthn_challenge && (await W.verifyPasskey(ctx, user.id, row.webauthn_challenge, b.reponse));
    if (!okPw || !okPk) {
      A.recordFailure(ctx, keys);
      throw new UserError(401, 'Mot de passe ou passkey non reconnus.');
    }
    A.grantSudo(ctx, session.id_hash);
    return { ok: true, valableMinutes: ctx.config.sudoMinutes };
  });

  // ------------------------------------------------------------------ profil
  app.get('/api/profil', async (req) => {
    const { user } = requireSession(req);
    return { utilisateur: A.publicUser(ctx, user), passkeys: W.listPasskeys(ctx, user.id) };
  });

  app.patch('/api/profil', async (req) => {
    const { user } = requireUser(req);
    const b = body<{ nom?: string }>(req);
    const name = String(b.nom ?? '').trim().slice(0, 80);
    if (!name) throw new UserError(400, 'Le nom est obligatoire.');
    ctx.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
    return { ok: true };
  });

  app.post('/api/profil/mot-de-passe', async (req) => {
    const { user, session } = requireUser(req);
    const b = body<{ actuel?: string; nouveau?: string }>(req);
    await A.changePassword(ctx, user, b.actuel, b.nouveau);
    A.destroyAllSessions(ctx, user.id, session.id_hash);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'mot_de_passe_change' });
    return { ok: true };
  });

  app.post('/api/profil/2fa/totp/debut', async (req) => {
    const { user, session } = requireSession(req);
    if (session.mfa_ok && user.totp_enabled) requireSudo(req);
    return A.startTotpSetup(ctx, user);
  });

  app.post('/api/profil/2fa/totp/confirmer', async (req, reply) => {
    const { user, session } = requireSession(req);
    const b = body<{ code?: string }>(req);
    const user2 = A.getUser(ctx, user.id)!;
    A.confirmTotpSetup(ctx, user2, b.code);
    A.markMfa(ctx, session.id_hash);
    setDeviceCookie(ctx, reply, user.id, deviceOf(ctx, req));
    const hasCodes = (ctx.db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(user.id) as { n: number }).n > 0;
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'totp_active' });
    return { ok: true, codesSecours: hasCodes ? null : A.generateRecoveryCodes(ctx, user.id) };
  });

  app.post('/api/profil/2fa/totp/desactiver', async (req) => {
    const { user } = requireSudo(req);
    A.disableTotp(ctx, user);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'totp_desactive' });
    return { ok: true };
  });

  app.post('/api/profil/codes-secours', async (req) => {
    const { user } = requireSudo(req);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'codes_secours_regeneres' });
    return { codesSecours: A.generateRecoveryCodes(ctx, user.id) };
  });

  app.post('/api/profil/passkeys/options', async (req) => {
    const { user, session } = requireSession(req);
    if (session.mfa_ok) requireSudo(req);
    return W.registrationOptions(ctx, user, session.id_hash);
  });

  app.post('/api/profil/passkeys', async (req, reply) => {
    const { user, session } = requireSession(req);
    const b = body<{ reponse?: unknown; nom?: string }>(req);
    await W.registerPasskey(ctx, user, session.id_hash, b.reponse, b.nom);
    A.markMfa(ctx, session.id_hash);
    setDeviceCookie(ctx, reply, user.id, deviceOf(ctx, req));
    const hasCodes = (ctx.db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(user.id) as { n: number }).n > 0;
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'passkey_ajoutee' });
    return { ok: true, codesSecours: hasCodes ? null : A.generateRecoveryCodes(ctx, user.id) };
  });

  app.delete('/api/profil/passkeys/:id', async (req) => {
    const { user } = requireSudo(req);
    W.deletePasskey(ctx, user, (req.params as { id: string }).id);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'passkey_supprimee' });
    return { ok: true };
  });

  app.get('/api/profil/sessions', async (req) => {
    const { user, session } = requireUser(req);
    const rows = ctx.db.prepare('SELECT id_hash, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC').all(user.id) as {
      id_hash: string;
      created_at: number;
      last_seen_at: number;
      ip: string | null;
      user_agent: string | null;
    }[];
    return rows.map((r) => ({ id: r.id_hash.slice(0, 16), courante: r.id_hash === session.id_hash, creeeLe: r.created_at, vueLe: r.last_seen_at, ip: r.ip, appareil: r.user_agent }));
  });

  app.delete('/api/profil/sessions/:id', async (req) => {
    const { user } = requireUser(req);
    const id = (req.params as { id: string }).id;
    if (!/^[a-f0-9]{16}$/.test(id)) throw new UserError(400, 'Session invalide.');
    ctx.db.prepare("DELETE FROM sessions WHERE user_id = ? AND substr(id_hash, 1, 16) = ?").run(user.id, id);
    return { ok: true };
  });

  // ------------------------------------------------------------------ invitations
  app.post('/api/invitations', async (req) => {
    const { user } = requireUser(req);
    const b = body<{ email?: string; roles?: { siteId: string; role: Role }[] }>(req);
    const email = A.normalizeEmail(b.email);
    if (A.getUserByEmail(ctx, email)) throw new UserError(409, 'Cette personne a déjà un compte : ajoutez-la directement dans les réglages du site.');
    const roles = Array.isArray(b.roles) ? b.roles : [];
    if (!user.is_owner && roles.length === 0) throw new UserError(400, 'Choisissez au moins un site.');
    for (const r of roles) {
      if (!isRole(r.role)) throw new UserError(400, 'Rôle invalide.');
      const { role } = ctx.sites.require(user, r.siteId, 'membres');
      if (role !== 'proprietaire' && ROLE_RANK[r.role] > ROLE_RANK.editeur) throw new UserError(403, 'Seul le propriétaire peut nommer un administrateur de site.');
    }
    const token = randomToken(24);
    ctx.db
      .prepare('INSERT INTO invitations (token_hash, email, roles, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), email, JSON.stringify(roles), user.id, now(), now() + 7 * 86_400_000);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'invitation', details: { email, roles } });
    return { lien: `${ctx.config.publicUrl}/invitation/${token}`, expireLe: now() + 7 * 86_400_000 };
  });

  const getInvitation = (token: string) => {
    const inv = ctx.db.prepare('SELECT * FROM invitations WHERE token_hash = ?').get(sha256(token)) as
      | { token_hash: string; email: string; roles: string; expires_at: number; used_at: number | null }
      | undefined;
    if (!inv || inv.used_at || inv.expires_at < now()) throw new UserError(404, 'Cette invitation n’est plus valable. Demandez-en une nouvelle.');
    return inv;
  };

  app.get('/api/invitations/:token', async (req) => {
    const inv = getInvitation((req.params as { token: string }).token);
    return { email: inv.email };
  });

  app.post('/api/invitations/:token/accepter', async (req, reply) => {
    const inv = getInvitation((req.params as { token: string }).token);
    const b = body<{ nom?: string; motDePasse?: string }>(req);
    const user = await A.createUser(ctx, { email: inv.email, name: b.nom ?? '', password: b.motDePasse ?? '', isOwner: false });
    for (const r of JSON.parse(inv.roles) as { siteId: string; role: Role }[]) {
      if (ctx.sites.get(r.siteId)) ctx.db.prepare('INSERT OR REPLACE INTO site_members (site_id, user_id, role) VALUES (?, ?, ?)').run(r.siteId, user.id, r.role);
    }
    ctx.db.prepare('UPDATE invitations SET used_at = ? WHERE token_hash = ?').run(now(), inv.token_hash);
    const token = A.createSession(ctx, user.id, { mfaOk: false, ip: ipOf(req), userAgent: req.headers['user-agent'] });
    setSessionCookie(ctx, reply, token);
    audit(ctx.db, { userId: user.id, ip: ipOf(req), action: 'invitation_acceptee' });
    return { ok: true, configurer2fa: true };
  });
}
