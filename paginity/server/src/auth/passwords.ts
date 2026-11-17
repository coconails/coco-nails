import { hash, verify } from '@node-rs/argon2';
import { UserError } from '../lib/util.js';

/** Paramètres Argon2id (recommandations OWASP : mémoire 19 Mio minimum ; nous prenons 64 Mio). */
const OPTS = { memoryCost: 65536, timeCost: 3, parallelism: 1 };

const COMMON = new Set([
  'motdepasse123', 'motdepasse1234', 'azertyuiop12', 'azertyuiop123', '123456789012', 'password1234',
  'passwordpassword', 'qwertyuiop12', 'soleil123456', 'bonjour12345', 'paginity1234', 'administrateur',
]);

export function checkPasswordPolicy(password: string, email?: string): void {
  if (typeof password !== 'string' || password.length < 12) {
    throw new UserError(400, 'Le mot de passe doit contenir au moins 12 caractères. Une phrase de plusieurs mots est idéale.');
  }
  if (password.length > 256) throw new UserError(400, 'Le mot de passe est trop long (256 caractères maximum).');
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password) || (email && lower.includes(email.toLowerCase().split('@')[0]) && email.split('@')[0].length >= 4)) {
    throw new UserError(400, 'Ce mot de passe est trop facile à deviner. Choisissez-en un autre.');
  }
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch (e) {
    // Empreinte de mot de passe abîmée ou illisible : refus, mais on le note pour pouvoir réparer le compte.
    console.error('[connexion] empreinte de mot de passe illisible :', (e as Error).message);
    return false;
  }
}

/** Empreinte factice pour garder un temps de réponse identique quand l'adresse n'existe pas. */
let dummy: string | null = null;
export async function dummyVerify(password: string): Promise<void> {
  if (!dummy) dummy = await hashPassword('paginity-mot-de-passe-factice');
  await verifyPassword(dummy, password);
}
