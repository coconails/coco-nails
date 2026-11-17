import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupOwner, startPaginity, stopPaginity, totpCode, type Client } from './helpers.js';
import type { Cerveau, DemandeCerveau, ReponseCerveau } from '../src/ia/assistant.js';
import { messageUtilisateur } from '../src/ia/fournisseurs.js';

/**
 * Assistant « pages et styles » : l'IA reçoit les fichiers HTML/CSS (jamais le JavaScript), ses propositions sont
 * vérifiées (pas de nouveau script, d'attribut « on… », de « javascript: » ni d'adresse d'un autre site), l'aperçu
 * avant / après ne touche pas au site, l'accord écrit dans le brouillon, l'annulation remet le fichier.
 */
type P = Awaited<ReturnType<typeof startPaginity>>;
let comportement: (d: DemandeCerveau) => ReponseCerveau = () => ({ statut: 'impossible', raison: 'x' });
const recu: DemandeCerveau[] = [];
const cerveau: Cerveau = {
  nom: 'local:qwen',
  tailleMax: 10_000_000,
  delaiMs: 1000,
  async disponible() {
    return true;
  },
  async proposer(d) {
    recu.push(d);
    return comportement(d);
  },
};
const css = (d: DemandeCerveau) => String(d.rubriques.find((r) => r.nom === 'fichier:public/style.css')!.valeur);
const html = (d: DemandeCerveau) => String(d.rubriques.find((r) => r.nom === 'fichier:public/index.html')!.valeur);
const fichier = (nom: string, valeur: string): ReponseCerveau => ({ statut: 'proposition', changements: [{ rubrique: `fichier:${nom}`, valeur }], explication: 'ok' });

function getApercu(p: P, url: string, chemin: string): Promise<string> {
  const u = new URL(url);
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: p.ctx.config.previewPort, path: chemin, headers: { host: u.host } }, (r) => {
      let b = '';
      r.on('data', (d) => (b += d));
      r.on('end', () => res(b));
    }).on('error', rej);
  });
}

describe('Assistant : pages et styles', () => {
  let p: P;
  let c: Client;
  let siteId: string;
  const url = (x = '') => `/api/sites/${siteId}/assistant${x}`;
  const lireCss = async () => (await c.call('GET', `/api/sites/${siteId}/fichier?chemin=public/style.css`)).json.contenu as string;

  beforeAll(async () => {
    p = await startPaginity({ cerveaux: { 'local:qwen': cerveau } });
    let secret: string;
    ({ c, secret } = await setupOwner(p));
    siteId = (await c.call('POST', '/api/sites', { nom: 'Salon Pages', modele: 'vitrine' })).json.id;
    expect((await c.call('POST', '/api/confirmation', { motDePasse: 'une phrase de passe solide', code: totpCode(secret, 1) })).status).toBe(200);
    expect((await c.call('PUT', '/api/reglages/ia', { active: true, relaisExterne: 'jamais' })).status).toBe(200);
  }, 60_000);
  afterAll(async () => stopPaginity(p));

  it('l’IA reçoit les fichiers HTML et CSS (pas le JavaScript) et des consignes adaptées', async () => {
    comportement = () => ({ statut: 'impossible', raison: 'test' });
    await c.call('POST', url(), { demande: 'Rends les boutons verts', portee: 'pages' });
    const d = recu.at(-1)!;
    const noms = d.rubriques.map((r) => r.nom);
    expect(noms).toContain('fichier:public/index.html');
    expect(noms).toContain('fichier:public/style.css');
    expect(noms.some((n) => n.endsWith('.js') || !n.startsWith('fichier:'))).toBe(false);
    expect(messageUtilisateur(d)).toContain('MODE PAGES ET STYLES');
  });

  it('refuse les ajouts dangereux (script, attribut on…, javascript:, autre site)', async () => {
    const essais: [string, (d: DemandeCerveau) => ReponseCerveau, RegExp][] = [
      ['script', (d) => fichier('public/index.html', html(d).replace('</body>', '<script>alert(1)</script></body>')), /<script> refusé/],
      ['on', (d) => fichier('public/index.html', html(d).replace('<body', '<body onload="x()"')), /attribut « on… »/],
      ['js', (d) => fichier('public/index.html', html(d).replace('</body>', '<a href="javascript:x()">a</a></body>')), /javascript:/],
      ['autre site', (d) => fichier('public/style.css', `@import url(https://polices.exemple.com/x.css);\n${css(d)}`), /autre site ajoutée \(polices\.exemple\.com\)/],
      ['css cassé', (d) => fichier('public/style.css', `${css(d)}\n.x {`), /accolades/],
    ];
    for (const [nom, f, attendu] of essais) {
      comportement = f;
      const r = await c.call('POST', url(), { demande: `essai ${nom}`, portee: 'pages' });
      expect(r.json.statut, nom).toBe('impossible');
      expect(JSON.stringify(r.json.journal), nom).toMatch(attendu);
    }
  });

  it('avant / après : deux aperçus, le site n’est pas touché ; accepter écrit, annuler remet', async () => {
    const avant = await lireCss();
    comportement = (d) => fichier('public/style.css', css(d).replace('--accent: #b7791f', '--accent: #2f9e44'));
    const pr = (await c.call('POST', url(), { demande: 'Rends les boutons verts', portee: 'pages' })).json;
    expect(pr, JSON.stringify(pr.journal)).toMatchObject({ statut: 'proposee', portee: 'pages' });
    expect(pr.changements[0]).toMatchObject({ rubrique: 'fichier:public/style.css', libelle: 'public/style.css' });
    const ap = await c.call('POST', url(`/${pr.id}/apercu`));
    expect(ap.status, JSON.stringify(ap.json)).toBe(200);
    expect(await getApercu(p, ap.json.avant, '/style.css')).toContain('--accent: #b7791f');
    expect(await getApercu(p, ap.json.apres, '/style.css')).toContain('--accent: #2f9e44');
    expect(await lireCss()).toBe(avant); // rien d'écrit
    const ok = await c.call('POST', url(`/${pr.id}/accepter`), { empreinte: pr.empreinte });
    expect(ok.json).toMatchObject({ statut: 'acceptee', annulable: true });
    expect(await lireCss()).toContain('--accent: #2f9e44');
    expect((await c.call('POST', url(`/${pr.id}/annuler`))).json.statut).toBe('annulee');
    expect(await lireCss()).toBe(avant);
    // Les demandes « pages » ne deviennent pas des demandes types du banc.
    expect((await c.call('GET', '/api/reglages/ia/banc')).json.reelles).toBe(0);
  });
});
