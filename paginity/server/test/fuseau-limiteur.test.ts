import { describe, expect, it } from 'vitest';
import { decalerJour, heureLocale, jourLocal } from '../src/lib/fuseau.js';
import { limiter, viderLimites } from '../src/lib/limiteur.js';

describe('Heure de Paris, quel que soit le réglage du système', () => {
  it('heure et jour en hiver et en été', () => {
    expect(heureLocale(Date.UTC(2026, 10, 18, 2, 0))).toBe(3); // hiver : UTC+1
    expect(heureLocale(Date.UTC(2026, 6, 18, 1, 0))).toBe(3); // été : UTC+2
    expect(jourLocal(Date.UTC(2026, 10, 17, 23, 30))).toBe('2026-11-18'); // 0 h 30 à Paris : déjà le 18
    expect(decalerJour('2026-03-29', 1)).toBe('2026-03-30'); // passage à l'heure d'été sans effet
    expect(decalerJour('2026-01-01', -1)).toBe('2025-12-31');
  });
  it('réglable', () => {
    process.env.PAGINITY_FUSEAU = 'UTC';
    try {
      expect(heureLocale(Date.UTC(2026, 10, 18, 2, 0))).toBe(2);
    } finally {
      delete process.env.PAGINITY_FUSEAU;
    }
  });
});

describe('Limite des opérations coûteuses', () => {
  it('bloque au-delà du maximum, puis libère après la fenêtre', () => {
    viderLimites();
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) limiter('audit:s1', 3, 60_000, t + i);
    expect(() => limiter('audit:s1', 3, 60_000, t + 10)).toThrow(/réessayez dans 60 s/);
    limiter('audit:s2', 3, 60_000, t + 10); // autre site : indépendant
    limiter('audit:s1', 3, 60_000, t + 60_001); // fenêtre passée
  });
});
