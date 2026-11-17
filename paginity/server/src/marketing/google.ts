import crypto from 'node:crypto';
import { UserError } from '../lib/util.js';

/**
 * Accès Google en LECTURE SEULE pour Search Console, par un compte de service dédié.
 *
 * - Un seul droit demandé : `webmasters.readonly` (lecture des données Search Console). Aucun autre.
 * - Jamais de « sub » (pas d'usurpation d'un utilisateur du domaine) : même si ce compte de service avait une
 *   délégation Gmail/Drive dans Google Workspace, PAGINITY ne pourrait pas s'en servir.
 * - Le compte de service ne voit que les propriétés Search Console où vous l'avez ajouté comme utilisateur
 *   (le niveau « Restreint » suffit). Pour tout couper : le retirer de Search Console et supprimer sa clé.
 * Adresses remplaçables pour les tests (faux serveur Google) : PAGINITY_GOOGLE_TOKEN_URL, PAGINITY_GOOGLE_API_URL.
 */
export const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const urlJeton = () => process.env.PAGINITY_GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
export const urlApi = () => (process.env.PAGINITY_GOOGLE_API_URL ?? 'https://www.googleapis.com').replace(/\/+$/, '');
const urlInspection = () => (process.env.PAGINITY_GOOGLE_INSPECTION_URL ?? 'https://searchconsole.googleapis.com').replace(/\/+$/, '');

export interface CleCompte {
  client_email: string;
  private_key: string;
  project_id?: string;
}

/** Vérifie une clé JSON de compte de service (sans jamais la renvoyer). */
export function lireCle(texte: unknown): CleCompte {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(String(texte ?? ''));
  } catch {
    throw new UserError(400, 'Ce fichier n’est pas une clé JSON valide.');
  }
  if (o.type !== 'service_account' || typeof o.client_email !== 'string' || typeof o.private_key !== 'string') {
    throw new UserError(400, 'Ce fichier n’est pas une clé de « compte de service » Google (type service_account).');
  }
  if (!/^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(o.client_email)) throw new UserError(400, 'Adresse du compte de service inattendue.');
  try {
    crypto.createPrivateKey(o.private_key);
  } catch {
    throw new UserError(400, 'La clé privée de ce fichier est illisible.');
  }
  return { client_email: o.client_email, private_key: o.private_key, project_id: typeof o.project_id === 'string' ? o.project_id : undefined };
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export class ClientGoogle {
  private jeton: { valeur: string; expire: number } | null = null;
  constructor(private cle: CleCompte) {}

  private async acces(): Promise<string> {
    if (this.jeton && this.jeton.expire > Date.now() + 60_000) return this.jeton.valeur;
    const maintenant = Math.floor(Date.now() / 1000);
    const entete = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    // Volontairement SANS « sub » : aucun utilisateur du domaine n'est représenté.
    const charge = b64u(JSON.stringify({ iss: this.cle.client_email, scope: SCOPE, aud: urlJeton(), iat: maintenant, exp: maintenant + 3600 }));
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${entete}.${charge}`), this.cle.private_key);
    let r: Response;
    try {
      r = await fetch(urlJeton(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${entete}.${charge}.${b64u(signature)}` }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new UserError(502, 'Google est injoignable pour l’instant. Réessayez plus tard.');
    }
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!r.ok || !j.access_token) {
      throw new UserError(502, j.error === 'invalid_grant' ? 'Google refuse cette clé (supprimée, désactivée ou horloge du serveur décalée).' : 'Google a refusé la connexion du compte de service.');
    }
    this.jeton = { valeur: j.access_token, expire: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }

  private async appel<T>(url: string, corps?: unknown): Promise<T> {
    const jeton = await this.acces();
    let r: Response;
    try {
      r = await fetch(url, {
        method: corps === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${jeton}`, ...(corps === undefined ? {} : { 'content-type': 'application/json' }) },
        body: corps === undefined ? undefined : JSON.stringify(corps),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new UserError(502, 'Google est injoignable pour l’instant. Réessayez plus tard.');
    }
    if (r.status === 403) throw new UserError(403, 'Le compte de service n’a pas accès à cette propriété Search Console : ajoutez-le comme utilisateur (niveau « Restreint » suffit).');
    if (r.status === 429) throw new UserError(429, 'Quota Google atteint pour aujourd’hui : réessayez demain.');
    if (!r.ok) throw new UserError(502, `Google a répondu ${r.status}.`);
    return (await r.json()) as T;
  }

  /** Propriétés Search Console accessibles à ce compte de service. */
  async proprietes(): Promise<{ siteUrl: string; permissionLevel: string }[]> {
    const j = await this.appel<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(`${urlApi()}/webmasters/v3/sites`);
    return (j.siteEntry ?? []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser');
  }

  async analyse(propriete: string, corps: Record<string, unknown>): Promise<{ keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }[]> {
    const j = await this.appel<{ rows?: { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }[] }>(
      `${urlApi()}/webmasters/v3/sites/${encodeURIComponent(propriete)}/searchAnalytics/query`,
      corps,
    );
    return j.rows ?? [];
  }

  async inspecter(propriete: string, adresse: string) {
    const j = await this.appel<{ inspectionResult?: { indexStatusResult?: Record<string, unknown> } }>(`${urlInspection()}/v1/urlInspection/index:inspect`, {
      inspectionUrl: adresse,
      siteUrl: propriete,
      languageCode: 'fr-FR',
    });
    return j.inspectionResult?.indexStatusResult ?? {};
  }
}
