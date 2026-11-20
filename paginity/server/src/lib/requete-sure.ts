import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Requête HTTP « sûre » vers une adresse venant du contenu d'un site (liens externes, site en ligne) :
 * - http/https seulement, ports habituels, pas d'identifiants dans l'adresse ;
 * - l'adresse IP est vérifiée AU MOMENT DE LA CONNEXION (pas de contournement par un DNS qui change) :
 *   jamais la machine elle-même, le réseau de la maison (box, NAS…) ni les adresses réservées ;
 * - aucune redirection suivie automatiquement (l'appelant revérifie chaque étape) ;
 * - corps de réponse ignoré (seuls le code et la redirection comptent), délai maximal.
 * En test automatique (NODE_ENV=test), les adresses locales sont permises pour les faux serveurs.
 */
export interface ReponseSure {
  statut: number;
  location: string | null;
}

const localPermis = () => process.env.NODE_ENV === 'test';

/** Adresse IP privée, locale ou réservée (IPv4 et IPv6). */
export function adresseInterne(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // partage d'adresses des opérateurs
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return adresseInterne(x.slice(7));
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff');
}

/** Raison du refus d'une adresse, ou null si elle peut être essayée. */
export function adresseRefusee(u: URL): string | null {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'adresse non web';
  if (u.username || u.password) return 'adresse avec identifiants';
  if (localPermis()) return null;
  if (u.port && !['80', '443'].includes(u.port)) return 'port inhabituel';
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return 'adresse locale';
  if (net.isIP(h) && adresseInterne(h)) return 'adresse du réseau local';
  return null;
}

const recherche: net.LookupFunction = (hote, options, rappel) => {
  dns.lookup(hote, { ...options, all: true }, (err, adresses) => {
    if (err) return (rappel as (e: Error | null, a: string, f: number) => void)(err, '', 0);
    const liste = adresses as dns.LookupAddress[];
    const interdite = !localPermis() && liste.find((a) => adresseInterne(a.address));
    if (interdite || !liste.length) return (rappel as (e: Error | null, a: string, f: number) => void)(new Error('adresse du réseau local refusée'), '', 0);
    if ((options as { all?: boolean }).all) return (rappel as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, liste);
    (rappel as (e: null, a: string, f: number) => void)(null, liste[0].address, liste[0].family);
  });
};

/**
 * Une requête, sans suivre les redirections.
 * `interne` : connexion directe au serveur des sites de PAGINITY (même machine), avec l'en-tête Host voulu.
 */
export function requeteSure(adresse: string, opts: { methode?: 'HEAD' | 'GET'; delai?: number; interne?: { port: number; hote: string } } = {}): Promise<ReponseSure> {
  const u = new URL(adresse);
  if (!opts.interne) {
    const refus = adresseRefusee(u);
    if (refus) return Promise.reject(new Error(refus));
  }
  const delai = opts.delai ?? 8000;
  return new Promise((resolve, reject) => {
    const mod = opts.interne ? http : u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method: opts.methode ?? 'HEAD',
        host: opts.interne ? '127.0.0.1' : u.hostname.replace(/^\[|\]$/g, ''),
        port: opts.interne ? opts.interne.port : u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        headers: { host: opts.interne ? opts.interne.hote : u.host, 'user-agent': 'PAGINITY-verification (lecture seule)', accept: 'text/html,*/*;q=0.5' },
        lookup: opts.interne ? undefined : recherche,
        timeout: delai,
      },
      (res) => {
        resolve({ statut: res.statusCode ?? 0, location: typeof res.headers.location === 'string' ? res.headers.location : null });
        res.destroy();
      },
    );
    req.on('timeout', () => req.destroy(new Error('pas de réponse')));
    req.on('error', (e) => reject(e));
    req.end();
  });
}

/** Suit les redirections (5 au plus), en revérifiant chaque adresse. */
export async function suivre(adresse: string, opts: { methode?: 'HEAD' | 'GET'; interne?: { port: number; hote: string; origine: string } } = {}): Promise<{ statut: number; etapes: string[]; finale: string }> {
  const etapes: string[] = [];
  let courante = adresse;
  for (let i = 0; i <= 5; i++) {
    const memeOrigine = opts.interne && new URL(courante).origin === opts.interne.origine;
    const r = await requeteSure(courante, { methode: opts.methode, interne: memeOrigine ? opts.interne : undefined });
    if (r.statut >= 300 && r.statut < 400 && r.location) {
      etapes.push(courante);
      courante = new URL(r.location, courante).toString();
      continue;
    }
    return { statut: r.statut, etapes, finale: courante };
  }
  throw new Error('trop de redirections');
}
