import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Coffre : chiffrement des données sensibles (secrets à deux facteurs, et en phase 3 les secrets des sites).
 * Algorithme AES-256-GCM. La clé maître est un fichier lisible uniquement par l'utilisateur système de PAGINITY.
 * Limite connue : si le serveur est entièrement compromis, la clé maître peut être lue.
 */
export class Vault {
  private key: Buffer;

  constructor(dataDir: string) {
    const dir = path.join(dataDir, 'coffre');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const keyFile = path.join(dir, 'cle-maitre');
    if (fs.existsSync(path.join(dir, 'cle-maitre.nouvelle'))) {
      throw new Error('Un changement de la clé du coffre a été interrompu. Lancez « paginity-admin changer-cle --confirmer » pour le terminer avant de démarrer PAGINITY.');
    }
    if (!fs.existsSync(keyFile)) {
      fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
    }
    this.key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64');
    if (this.key.length !== 32) throw new Error('Clé maître du coffre invalide');
  }

  /** Coffre ouvert avec une clé donnée (changement de clé, contrôles). */
  static fromKey(key: Buffer): Vault {
    if (key.length !== 32) throw new Error('Clé du coffre invalide');
    const v = Object.create(Vault.prototype) as Vault;
    (v as unknown as { key: Buffer }).key = key;
    return v;
  }

  encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
  }

  decrypt(payload: string): string {
    const [v, iv, tag, enc] = payload.split('.');
    if (v !== 'v1') throw new Error('Format chiffré inconnu');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
  }

  /** Signature HMAC (liens d'aperçu, etc.). */
  sign(data: string): string {
    return crypto.createHmac('sha256', this.key).update(data).digest('base64url');
  }
}
