import crypto from 'node:crypto';

/**
 * Authentificateur de passkey LOGICIEL, pour les tests uniquement (sans dépendance) :
 * fabrique de vraies réponses WebAuthn (clé P-256, format « none »), signées comme le ferait un téléphone.
 */
type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | Record<string, unknown>;

function tete(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? tete(0, v) : tete(1, -1 - v);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([tete(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([tete(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([tete(4, v.length), ...v.map(cbor)]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([tete(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k as Cbor), cbor(x as Cbor)])]);
}

const b64u = (b: Buffer) => b.toString('base64url');
const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest();

export class Authentificateur {
  readonly cles = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly credId = crypto.randomBytes(16);
  compteur = 0;

  constructor(public rpId = 'localhost', public origine = 'http://localhost:8080') {}

  private cose(): Map<Cbor, Cbor> {
    const jwk = this.cles.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]);
  }

  private authData(withCred: boolean, compteur: number): Buffer {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(compteur);
    const base = Buffer.concat([sha256(this.rpId), Buffer.from([withCred ? 0x45 : 0x05]), c]);
    if (!withCred) return base;
    const len = Buffer.from([this.credId.length >> 8, this.credId.length & 255]);
    return Buffer.concat([base, Buffer.alloc(16), len, this.credId, cbor(this.cose())]);
  }

  /** Réponse à des options d'enregistrement (generateRegistrationOptions). */
  enregistrer(options: { challenge: string }, origine = this.origine) {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: origine, crossOrigin: false }));
    const att = cbor({ fmt: 'none', attStmt: {}, authData: this.authData(true, this.compteur) });
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal'] }, clientExtensionResults: {} };
  }

  /** Réponse à des options de connexion (generateAuthenticationOptions). */
  signer(options: { challenge: string }, o: { origine?: string; compteur?: number; cle?: crypto.KeyObject } = {}) {
    const compteur = o.compteur ?? ++this.compteur;
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: o.origine ?? this.origine, crossOrigin: false }));
    const ad = this.authData(false, compteur);
    const sig = crypto.sign('sha256', Buffer.concat([ad, sha256(clientData)]), o.cle ?? this.cles.privateKey);
    return { id: b64u(this.credId), rawId: b64u(this.credId), type: 'public-key', response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(ad), signature: b64u(sig) }, clientExtensionResults: {} };
  }
}
