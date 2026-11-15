import crypto from 'node:crypto';

/** Erreur destinée à l'utilisateur, avec un message en français et un code HTTP. */
export class UserError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const now = (): number => Date.now();

export function randomId(prefix = ''): string {
  return prefix + crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').toLowerCase().slice(0, 10);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Empreinte courte d'un contenu, utilisée comme « version » d'un fichier (anti-écrasement). */
export function contentVersion(data: string | Buffer): string {
  return sha256(data).slice(0, 16);
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Transforme un nom en identifiant d'adresse : « Coco Nail's » → « coco-nails ». */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Exécute les tâches une par une pour une même clé (ex. un site), dans l'ordre d'arrivée. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

export function humanizeKey(key: string): string {
  const s = key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
