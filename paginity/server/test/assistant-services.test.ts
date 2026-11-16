import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, totpCode, type Client } from './helpers.js';

/**
 * PAGINITY AI, étape 2 : les vrais connecteurs (modèle local, Claude, ChatGPT) parlent à de FAUX serveurs locaux
 * qui imitent leurs services. Aucun appel ne sort de la machine, aucune vraie clé n'est utilisée.
 * On vérifie ce qui est envoyé (format, clé, absence de secrets), le calcul du coût et le respect des plafonds.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;
interface Recu {
  chemin: string;
  entetes: http.IncomingHttpHeaders;
  corps: any;
}

/** Faux serveur : `repondre` décide de la réponse ; tout ce qui arrive est gardé. */
function fauxServeur() {
  const recus: Recu[] = [];
  const s = {
    recus,
    port: 0,
    repondre: (_r: Recu): { statut?: number; json: unknown } => ({ statut: 500, json: {} }),
    serveur: http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        const r: Recu = { chemin: req.url ?? '', entetes: req.headers, corps: b ? JSON.parse(b) : null };
        recus.push(r);
        if (req.method === 'GET' && r.chemin.endsWith('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[{"id":"modele-test"}]}');
          return;
        }
        const out = s.repondre(r);
        res.writeHead(out.statut ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(out.json));
      });
    }),
  };
  return s;
}

/** Réponse d'un modèle : changer l'accroche (valeur complète de la rubrique, encodée en JSON). */
function propositionAccroche(corpsUtilisateur: string, texte: string): string {
  const contenus = JSON.parse(corpsUtilisateur.split('<contenus>\n')[1].split('\n</contenus>')[0]);
  const site = contenus.find((r: any) => r.rubrique === 'site');
  return JSON.stringify({ statut: 'proposition', changements: [{ rubrique: 'site', valeur_json: JSON.stringify({ ...site.valeur, accroche: texte }) }], explication: 'Accroche modifiée.', raison: '' });
}
const openai = (contenu: string, usage = { prompt_tokens: 1000, completion_tokens: 500 }) => ({ json: { choices: [{ message: { role: 'assistant', content: contenu } }], usage } });
const anthropic = (texte: string, stop = 'end_turn', usage = { input_tokens: 1000, output_tokens: 500 }) => ({
  json: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: texte }], stop_reason: stop, stop_sequence: null, usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage } },
});
const impossible = JSON.stringify({ statut: 'impossible', changements: [], explication: '', raison: 'trop difficile' });

describe('PAGINITY AI — connecteurs réels vers de faux services', () => {
  let p: P;
  let c: Client;
  let siteId: string;
  const local = fauxServeur();
  const claude = fauxServeur();
  const chatgpt = fauxServeur();
  const reglages = (r: Record<string, unknown>) => c.call('PUT', '/api/reglages/ia', r);
  const demander = (demande: string) => c.call('POST', `/api/sites/${siteId}/assistant`, { demande });
  const derniereUtilisateur = (s: ReturnType<typeof fauxServeur>) => {
    const b = s.recus.at(-1)!.corps;
    return b.messages.find((m: any) => m.role === 'user').content as string;
  };

  beforeAll(async () => {
    for (const s of [local, claude, chatgpt]) {
      await new Promise<void>((r) => s.serveur.listen(0, '127.0.0.1', () => r()));
      s.port = (s.serveur.address() as AddressInfo).port;
    }
    p = await startPaginity();
    let secret: string;
    ({ c, secret } = await setupOwner(p));
    expect((await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: totpCode(secret, 1) })).status).toBe(200);
    siteId = (await c.call('POST', '/api/sites', { nom: 'Salon IA', modele: 'vitrine' })).json.id;
    expect((await c.call('PUT', `/api/sites/${siteId}/secrets/production/CLE_API`, { valeur: 'cle-secrete-du-site-77' })).status).toBe(200);
  }, 60_000);
  afterAll(async () => {
    for (const s of [local, claude, chatgpt]) s.serveur.close();
    await stopPaginity(p);
  });

  it('modèle local (protocole compatible OpenAI) : essai, proposition, aucun coût', async () => {
    expect((await reglages({ active: true, local: { actif: true, url: `http://127.0.0.1:${local.port}/v1`, modele: 'modele-test' } })).status).toBe(200);
    expect((await c.call('POST', '/api/reglages/ia/essai-local', {})).json).toEqual({ repond: true, enService: true });
    local.repondre = (r) => openai(propositionAccroche(r.corps.messages[1].content, 'Accroche du modèle local'));
    const r = await demander('Change l’accroche');
    expect(r.json, JSON.stringify(r.json.journal)).toMatchObject({ statut: 'proposee', cerveau: 'local', coutCentimes: 0 });
    const envoi = local.recus.find((x) => x.chemin.endsWith('/chat/completions'))!;
    expect(envoi.corps.model).toBe('modele-test');
    expect(envoi.corps.messages[0].content).toMatch(/Tu es l'assistant de PAGINITY/);
    expect(JSON.stringify(envoi.corps)).not.toContain('cle-secrete-du-site-77');
    expect(envoi.entetes.authorization).toBeUndefined();
  });

  it('clés d’API : chiffrées dans le coffre, jamais renvoyées à l’interface', async () => {
    const a = await c.call('PUT', '/api/reglages/ia/cle/claude', { cle: 'sk-ant-cle-de-test-claude-123' });
    expect(a.status).toBe(200);
    expect(a.json.cles).toEqual({ claude: true, chatgpt: false });
    await c.call('PUT', '/api/reglages/ia/cle/chatgpt', { cle: 'sk-cle-de-test-openai-456' });
    const etat = await c.call('GET', '/api/reglages/ia');
    expect(etat.body).not.toContain('sk-ant-cle-de-test-claude-123');
    expect(etat.body).not.toContain('sk-cle-de-test-openai-456');
    const stocke = p.ctx.db.prepare("SELECT value FROM settings WHERE key = 'ia_cle_claude'").get() as { value: string };
    expect(stocke.value.startsWith('v1.')).toBe(true);
    expect(stocke.value).not.toContain('sk-ant');
    expect((await c.call('PUT', '/api/reglages/ia/cle/inconnu', { cle: 'x'.repeat(20) })).status).toBe(404);
  });

  it('Claude : bonne clé, format imposé, repli automatique, coût calculé sur les jetons facturés', async () => {
    await reglages({ relaisExterne: 'auto', plafondMensuelCentimes: 1000, claude: { actif: true, url: `http://127.0.0.1:${claude.port}` } });
    local.repondre = () => openai(impossible);
    claude.repondre = (r) => anthropic(propositionAccroche(r.corps.messages[0].content, 'Accroche de Claude'));
    const r = await demander('Accroche élégante');
    expect(r.json, JSON.stringify(r.json.journal)).toMatchObject({ statut: 'proposee', cerveau: 'claude' });
    // 1 000 jetons lus à 4 $ + 500 écrits à 20 $ par million = 0,014 $ → 2 centimes (arrondi au-dessus).
    expect(r.json.coutCentimes).toBe(2);
    const envoi = claude.recus.at(-1)!;
    expect(envoi.chemin).toMatch(/\/v1\/messages/);
    // La bibliothèque officielle transmet la clé dans l'en-tête Authorization (ou x-api-key selon les versions).
    expect(envoi.entetes.authorization === 'Bearer sk-ant-cle-de-test-claude-123' || envoi.entetes['x-api-key'] === 'sk-ant-cle-de-test-claude-123').toBe(true);
    expect(String(envoi.entetes['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(envoi.corps).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', output_config: { format: { type: 'json_schema' } } });
    expect(envoi.corps.system).toMatch(/Tu es l'assistant de PAGINITY/);
    expect(JSON.stringify(envoi.corps)).not.toContain('cle-secrete-du-site-77');
    expect((await c.call('GET', '/api/reglages/ia')).json.depenseParService).toEqual({ claude: 2, chatgpt: 0 });
  });

  it('ChatGPT sans prix renseignés : jamais utilisé (le coût ne pourrait pas être compté)', async () => {
    await reglages({ ordre: ['chatgpt', 'claude'], chatgpt: { actif: true, modele: 'modele-openai-test', url: `http://127.0.0.1:${chatgpt.port}/v1` } });
    expect((await c.call('GET', '/api/reglages/ia')).json.enService).toEqual({ local: true, claude: true });
    const avant = chatgpt.recus.length;
    await demander('Accroche élégante');
    expect(chatgpt.recus.length).toBe(avant);
  });

  it('ChatGPT : clé en « Bearer », format strict, et passage au suivant si un plafond serait dépassé', async () => {
    await reglages({ chatgpt: { prixEntree: 1, prixSortie: 4 }, claude: { plafondCentimes: 0 } });
    chatgpt.repondre = (r) => openai(propositionAccroche(derniereUtilisateur(chatgpt) ?? r.corps.messages[1].content, 'Accroche de ChatGPT'));
    const avantClaude = claude.recus.length;
    const r = await demander('Accroche chaleureuse');
    expect(r.json, JSON.stringify(r.json.journal)).toMatchObject({ statut: 'proposee', cerveau: 'chatgpt', coutCentimes: 1 });
    const envoi = chatgpt.recus.at(-1)!;
    expect(envoi.entetes.authorization).toBe('Bearer sk-cle-de-test-openai-456');
    expect(envoi.corps).toMatchObject({ model: 'modele-openai-test', max_completion_tokens: 16000, response_format: { type: 'json_schema', json_schema: { strict: true } } });
    expect(claude.recus.length).toBe(avantClaude); // plafond propre à Claude : 0
    // ChatGPT en panne, Claude bloqué par son plafond : rien n'est fait, l'explication est claire.
    chatgpt.repondre = () => ({ statut: 503, json: {} });
    const r2 = await demander('Accroche chaleureuse');
    expect(r2.json.statut).toBe('impossible');
    expect(r2.json.journal.map((j: any) => j.texte).join(' ')).toMatch(/ChatGPT n’a pas pu répondre \(le service a répondu 503\)/);
  });

  it('le plafond global tient compte du coût MAXIMAL possible d’un appel avant de l’envoyer', async () => {
    // Avec un plafond global de 0,10 $, un appel à Claude pourrait coûter jusqu'à ~0,33 $ (16 000 jetons écrits) : refusé d'avance.
    await reglages({ ordre: ['claude', 'chatgpt'], plafondMensuelCentimes: 13, claude: { plafondCentimes: null }, chatgpt: { actif: false } });
    const avant = claude.recus.length;
    const r = await demander('Accroche');
    expect(r.json.statut).toBe('impossible');
    expect(r.json.raison).toMatch(/plafond mensuel global serait dépassé/);
    expect(claude.recus.length).toBe(avant);
    await reglages({ plafondMensuelCentimes: 1000 });
  });

  it('Claude : refus, réponse illisible ou clé refusée → rien n’est modifié, et le coût facturé est compté', async () => {
    await reglages({ chatgpt: { actif: false } });
    const depense = () => (p.ctx.db.prepare("SELECT COALESCE(SUM(centimes),0) AS n FROM ia_usage WHERE fournisseur = 'claude'").get() as { n: number }).n;
    let d0 = depense();
    claude.repondre = () => anthropic('', 'refusal');
    const refus = await demander('Accroche');
    expect(refus.json.statut).toBe('impossible');
    expect(refus.json.raison).toMatch(/Claude a refusé/);
    expect(depense()).toBeGreaterThan(d0);
    d0 = depense();
    claude.repondre = () => anthropic('ceci n’est pas du JSON');
    const illisible = await demander('Accroche');
    expect(illisible.json.statut).toBe('impossible');
    expect(illisible.json.journal.map((j: any) => j.texte).join(' ')).toMatch(/réponse illisible/);
    expect(depense()).toBeGreaterThan(d0);
    claude.repondre = () => ({ statut: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
    const cle = await demander('Accroche');
    expect(cle.json.journal.map((j: any) => j.texte).join(' ')).toMatch(/clé Claude refusée/);
  });

  it('chaque service peut être désactivé à tout moment ; la clé peut être effacée', async () => {
    await reglages({ claude: { actif: false } });
    expect((await c.call('GET', '/api/reglages/ia')).json.enService).toEqual({ local: true });
    await reglages({ claude: { actif: true } });
    expect((await c.call('DELETE', '/api/reglages/ia/cle/claude')).json.cles.claude).toBe(false);
    expect((await c.call('GET', '/api/reglages/ia')).json.enService).toEqual({ local: true });
  });
});
