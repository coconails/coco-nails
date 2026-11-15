import net from 'node:net';

/**
 * Adresse IP réelle d'un visiteur.
 * Derrière le tunnel (Cloudflare Tunnel, ou un autre relais installé SUR la même machine), toutes les connexions
 * arrivent de 127.0.0.1 : sans ce réglage, tout le monde partagerait la même adresse et un seul visiteur malveillant
 * bloquerait tous les autres. Avec PAGINITY_TRUST_PROXY=true, et seulement pour une connexion venant de la machine
 * elle-même, on lit l'adresse transmise par le relais :
 *  - « CF-Connecting-IP » (posé par Cloudflare, que le visiteur ne peut pas choisir) ;
 *  - sinon la DERNIÈRE adresse de « X-Forwarded-For » (celle ajoutée par le relais ; les premières peuvent être inventées).
 * Une connexion venant d'ailleurs ne peut jamais imposer son adresse.
 */
export function realIp(remote: string | undefined, headers: Record<string, unknown>): string {
  const addr = remote ?? '';
  if (process.env.PAGINITY_TRUST_PROXY !== 'true' || !isLoopback(addr)) return addr;
  const cf = first(headers['cf-connecting-ip']);
  if (cf && net.isIP(cf)) return cf;
  const xff = first(headers['x-forwarded-for']);
  const last = xff?.split(',').map((s) => s.trim()).filter(Boolean).pop();
  if (last && net.isIP(last)) return last;
  return addr;
}

function first(v: unknown): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' ? s.trim() : undefined;
}

export function isLoopback(addr: string): boolean {
  return addr === '::1' || /^127\./.test(addr) || /^::ffff:127\./.test(addr);
}
