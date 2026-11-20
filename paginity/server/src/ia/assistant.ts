import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../context.js';
import type { UserRow } from '../auth/service.js';
import type { SiteRow } from '../sites/service.js';
import { getSetting, setSetting } from '../db.js';
import { audit } from '../lib/audit.js';
import { now, randomId, UserError } from '../lib/util.js';
import { loadSchema, readEntry, saveEntry } from '../content/service.js';
import { validateEntryValue } from '../content/schema.js';
import { assertMayWrite, isServerCode } from '../sites/server-code.js';
import { contexteFichiers, estFichier, PREFIXE, verifierFichier } from './pages.js';
import { writeChecked } from '../sites/files.js';
import { authorOf } from '../sites/service.js';
import { tenirReunion } from './reunion.js';
import { GestionBanc } from './banc-execution.js';
import { cerveauChatGPT, cerveauClaude, cerveauLocal, TARIFS_CLAUDE, type ConfigLocal, type ConfigLocalNomme } from './fournisseurs.js';

/**
 * PAGINITY AI — étape 1 : le cœur de l'agent et l'aiguilleur (« assistant contenus »).
 *
 * Principes (voir docs/PAGINITY-AI.md) :
 *  - Le « cerveau » (modèle local ou Claude) ne reçoit AUCUN outil : seulement la demande et les contenus publics
 *    du site concerné (jamais les secrets, les messages des formulaires ni le code serveur). Il ne peut que renvoyer
 *    une proposition structurée : « rubrique X → nouvelle valeur ».
 *  - PAGINITY vérifie la proposition avec les mêmes règles que les formulaires (rubrique existante, champs valides).
 *  - Rien n'est écrit tant qu'une personne n'a pas accepté CETTE proposition (empreinte), et seulement dans le
 *    brouillon : la publication reste un geste séparé, avec aperçu et retour arrière.
 *  - Le relais vers Claude est décidé par des règles vérifiables, jamais par l'avis du modèle sur lui-même ;
 *    il est soumis au réglage du propriétaire (jamais / sur accord / automatique) et à un plafond mensuel.
 */

export * from './types.js';
import { CLE, DOMAINES, domaineDe, ESSAIS_LOCAUX, estLocal, LIBELLE, MAX_LOCAUX, mois, NOMS_EXTERNES, REGLAGES_DEFAUT } from './types.js';
import type { Cerveau, Changement, DemandeCerveau, Domaine, LigneProposition, NomCerveau, NomExterne, Note, ReglagesIA, ReponseCerveau, RubriqueContexte, StatutProposition } from './types.js';

export class Assistant {
  /** Cerveaux imposés (tests uniquement). */
  cerveaux: Record<string, Cerveau> = {};
  surcharge = false;
  private enVol = new Set<AbortController>();
  /** Banc d'essai (exécution déportée dans banc-execution.ts). */
  readonly banc: GestionBanc;

  constructor(private ctx: Ctx) {
    this.banc = new GestionBanc(ctx, this);
  }

  // ------------------------------------------------------------------ réglages
  reglages(): ReglagesIA {
    let r: Partial<ReglagesIA> = {};
    try {
      r = JSON.parse(getSetting(this.ctx.db, 'ia') ?? '{}');
    } catch {
      /* réglages abîmés : valeurs par défaut */
    }
    return {
      ...REGLAGES_DEFAUT,
      ...r,
      // Anciennes données (un seul modèle local) : reprises comme premier modèle de la liste.
      locaux: Array.isArray(r.locaux)
        ? r.locaux
        : (r as { local?: ConfigLocal }).local?.url
          ? [{ id: 'principal', nom: 'Modèle local', ...(r as { local: ConfigLocal }).local }]
          : [],
      claude: { ...REGLAGES_DEFAUT.claude, ...r.claude },
      chatgpt: { ...REGLAGES_DEFAUT.chatgpt, ...r.chatgpt },
      reunion: { ...REGLAGES_DEFAUT.reunion, ...r.reunion, verificateurs: { ...r.reunion?.verificateurs } },
    };
  }

  modifierReglages(input: Record<string, any>): ReglagesIA {
    const r = this.reglages();
    const centimes = (v: unknown, nul = false): number | null => {
      if (nul && (v === null || v === '')) return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new UserError(400, 'Plafond invalide (en centimes, entre 0 et 10 000).');
      return n;
    };
    const prix = (v: unknown): number | null => {
      if (v === null || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1000) throw new UserError(400, 'Prix invalide (par million de jetons).');
      return n;
    };
    const adresse = (v: unknown): string => {
      const t = String(v ?? '').trim();
      if (t && !/^https?:\/\/[^\s]+$/.test(t)) throw new UserError(400, 'Adresse invalide (http:// ou https://).');
      return t;
    };
    const duree = (v: unknown) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 5 || n > 900) throw new UserError(400, 'Délai invalide (5 à 900 secondes).');
      return n;
    };
    if (typeof input.active === 'boolean') r.active = input.active;
    if (typeof input.dictee === 'boolean') r.dictee = input.dictee;
    if (input.relaisExterne !== undefined) {
      if (!['jamais', 'demander', 'auto'].includes(input.relaisExterne)) throw new UserError(400, 'Mode de relais inconnu.');
      r.relaisExterne = input.relaisExterne;
    }
    if (input.plafondMensuelCentimes !== undefined) r.plafondMensuelCentimes = centimes(input.plafondMensuelCentimes)!;
    if (input.ordre !== undefined) {
      if (!Array.isArray(input.ordre) || input.ordre.length !== 2 || !NOMS_EXTERNES.every((n) => input.ordre.includes(n))) throw new UserError(400, 'Ordre invalide.');
      r.ordre = input.ordre;
    }
    const local = (l: any, existant?: ConfigLocalNomme): ConfigLocalNomme => {
      const m: ConfigLocalNomme = existant ? { ...existant } : { id: '', nom: 'Modèle local', actif: false, url: '', modele: '', tailleMax: 60_000, delaiS: 120 };
      if (l.id !== undefined) {
        if (typeof l.id !== 'string' || !/^[a-z0-9-]{1,20}$/.test(l.id)) throw new UserError(400, 'Identifiant de modèle invalide.');
        m.id = l.id;
      }
      if (l.nom !== undefined) {
        const n = String(l.nom).trim().slice(0, 60);
        if (!n) throw new UserError(400, 'Donnez un nom au modèle (par exemple « Qwen3-Coder »).');
        m.nom = n;
      }
      if (typeof l.actif === 'boolean') m.actif = l.actif;
      if (l.url !== undefined) m.url = adresse(l.url);
      if (l.modele !== undefined) m.modele = String(l.modele).trim().slice(0, 200);
      if (l.delaiS !== undefined) m.delaiS = duree(l.delaiS);
      if (l.tailleMax !== undefined) {
        const n = Number(l.tailleMax);
        if (!Number.isInteger(n) || n < 1000 || n > 10_000_000) throw new UserError(400, 'Taille maximale invalide.');
        m.tailleMax = n;
      }
      if (!m.id) m.id = randomId().slice(0, 10);
      return m;
    };
    if (Array.isArray(input.locaux)) {
      if (input.locaux.length > MAX_LOCAUX) throw new UserError(400, `${MAX_LOCAUX} modèles locaux au plus.`);
      const liste = input.locaux.map((l: any) => local(l, r.locaux.find((x) => x.id === l?.id)));
      if (new Set(liste.map((l: ConfigLocalNomme) => l.id)).size !== liste.length) throw new UserError(400, 'Deux modèles ont le même identifiant.');
      r.locaux = liste;
    }
    // Ancienne forme (un seul modèle) : met à jour ou crée le modèle « principal ».
    if (input.local && typeof input.local === 'object') {
      const i = r.locaux.findIndex((x) => x.id === 'principal');
      const m = local({ id: 'principal', ...input.local }, i >= 0 ? r.locaux[i] : undefined);
      if (i >= 0) r.locaux[i] = m;
      else r.locaux.unshift(m);
    }
    for (const nom of NOMS_EXTERNES) {
      const e = input[nom];
      if (!e) continue;
      if (typeof e.actif === 'boolean') r[nom].actif = e.actif;
      if (e.modele !== undefined) r[nom].modele = String(e.modele).trim().slice(0, 200);
      if (e.prixEntree !== undefined) r[nom].prixEntree = prix(e.prixEntree);
      if (e.prixSortie !== undefined) r[nom].prixSortie = prix(e.prixSortie);
      if (e.plafondCentimes !== undefined) r[nom].plafondCentimes = centimes(e.plafondCentimes, true);
      if (e.delaiS !== undefined) r[nom].delaiS = duree(e.delaiS);
      if (e.url !== undefined) r[nom].url = adresse(e.url);
    }
    if (input.reunion && typeof input.reunion === 'object') {
      const re = input.reunion;
      if (typeof re.active === 'boolean') r.reunion.active = re.active;
      if (typeof re.payantVerificateur === 'boolean') r.reunion.payantVerificateur = re.payantVerificateur;
      if (re.maxParticipants !== undefined) {
        const n = Number(re.maxParticipants);
        if (!Number.isInteger(n) || n < 1 || n > 7) throw new UserError(400, 'Nombre de participants invalide (1 à 7).');
        r.reunion.maxParticipants = n;
      }
      if (re.verificateurs && typeof re.verificateurs === 'object') {
        for (const d of Object.keys(DOMAINES) as Domaine[]) {
          const v = re.verificateurs[d];
          if (v === undefined) continue;
          if (v === null || v === '' || v === 'auto') delete r.reunion.verificateurs[d];
          else if (typeof v === 'string' && /^(local:[a-z0-9-]{1,20}|claude|chatgpt)$/.test(v)) r.reunion.verificateurs[d] = v;
          else throw new UserError(400, 'Vérificateur inconnu.');
        }
      }
    }
    setSetting(this.ctx.db, 'ia', JSON.stringify(r));
    // Arrêt d'urgence : tout ce qui tourne est coupé, rien ne pourra plus être accepté.
    if (!r.active) {
      for (const c of this.enVol) c.abort();
      this.banc.arreterBanc();
    }
    return r;
  }

  /** Clé d'API d'un service extérieur : chiffrée dans le coffre, jamais réaffichée. */
  definirCle(nom: NomExterne, cle: unknown): void {
    if (typeof cle !== 'string' || cle.trim().length < 10 || cle.length > 500) throw new UserError(400, 'Clé invalide.');
    setSetting(this.ctx.db, CLE[nom], this.ctx.vault.encrypt(cle.trim()));
  }
  effacerCle(nom: NomExterne): void {
    this.ctx.db.prepare('DELETE FROM settings WHERE key = ?').run(CLE[nom]);
  }
  private cle(nom: NomExterne): string | null {
    const v = getSetting(this.ctx.db, CLE[nom]);
    return v ? this.ctx.vault.decrypt(v) : null;
  }

  depenseDuMois(nom?: NomExterne): number {
    const sql = nom ? 'SELECT COALESCE(SUM(centimes), 0) AS n FROM ia_usage WHERE mois = ? AND fournisseur = ?' : 'SELECT COALESCE(SUM(centimes), 0) AS n FROM ia_usage WHERE mois = ?';
    return (this.ctx.db.prepare(sql).get(...(nom ? [mois(), nom] : [mois()])) as { n: number }).n;
  }

  /** Cerveaux en service : ceux fournis par les tests, sinon construits d'après les réglages. */
  cerveauxActifs(): Record<string, Cerveau> {
    if (this.surcharge) return this.cerveaux;
    const r = this.reglages();
    const out: Record<string, Cerveau> = {};
    for (const l of r.locaux) if (l.actif && l.url && l.modele) out[`local:${l.id}`] = cerveauLocal(l);
    const cc = this.cle('claude');
    if (r.claude.actif && cc && r.claude.modele && r.claude.prixEntree !== null && r.claude.prixSortie !== null) out.claude = cerveauClaude(r.claude, cc);
    const co = this.cle('chatgpt');
    if (r.chatgpt.actif && co && r.chatgpt.modele && r.chatgpt.prixEntree !== null && r.chatgpt.prixSortie !== null) out.chatgpt = cerveauChatGPT(r.chatgpt, co);
    return out;
  }

  // ------------------------------------------------------------------ notes par domaine
  notes(): Record<Domaine, Record<string, Note>> {
    try {
      const n = JSON.parse(getSetting(this.ctx.db, 'ia_notes') ?? '{}');
      return { textes: n.textes ?? {}, donnees: n.donnees ?? {} };
    } catch {
      return { textes: {}, donnees: {} };
    }
  }
  private ecrireNotes(n: Record<Domaine, Record<string, Note>>) {
    setSetting(this.ctx.db, 'ia_notes', JSON.stringify(n));
  }
  /** Note de banc d'essai (0 à 100) d'un cerveau dans un domaine. */
  noterBanc(cle: string, domaine: Domaine, note: number) {
    const n = this.notes();
    const x = n[domaine][cle];
    n[domaine][cle] = { acceptes: x?.acceptes ?? 0, refuses: x?.refuses ?? 0, banc: Math.max(0, Math.min(100, Math.round(note))) };
    this.ecrireNotes(n);
  }
  /** Vos décisions (accepter / refuser) font évoluer la note de l'IA qui a préparé la proposition. */
  private compterDecision(cle: string | null, domaine: Domaine | null, acceptee: boolean) {
    if (!cle || !domaine) return;
    const n = this.notes();
    const x = n[domaine][cle] ?? { banc: null, acceptes: 0, refuses: 0 };
    if (acceptee) x.acceptes++;
    else x.refuses++;
    n[domaine][cle] = x;
    this.ecrireNotes(n);
  }
  /** Note globale : banc d'essai, corrigée par vos décisions dès qu'il y en a au moins 5. */
  note(cle: string, domaine: Domaine): number | null {
    const x = this.notes()[domaine][cle];
    if (!x) return null;
    const decisions = x.acceptes + x.refuses;
    const taux = decisions >= 5 ? (x.acceptes / decisions) * 100 : null;
    if (x.banc !== null && taux !== null) return Math.round(0.7 * x.banc + 0.3 * taux);
    return x.banc ?? (taux === null ? null : Math.round(taux));
  }

  /** Tous les cerveaux déclarés (en service ou non), avec leur nom. */
  toutesCles(): Record<string, string> {
    const r = this.reglages();
    const out: Record<string, string> = {};
    for (const l of r.locaux) out[`local:${l.id}`] = l.nom;
    out.claude = 'Claude';
    out.chatgpt = 'ChatGPT';
    if (this.surcharge) for (const k of Object.keys(this.cerveaux)) out[k] ??= this.libelle(k);
    return out;
  }

  /** Nom lisible d'un cerveau (« Qwen3-Coder », « Claude »…). */
  libelle(cle: string | null): string {
    if (!cle) return '';
    if (this.surcharge && this.cerveaux[cle]?.libelle) return this.cerveaux[cle].libelle!;
    if (LIBELLE[cle]) return LIBELLE[cle];
    if (cle.startsWith('local:')) return this.reglages().locaux.find((l) => `local:${l.id}` === cle)?.nom ?? 'un modèle local';
    return cle;
  }

  etat() {
    const r = this.reglages();
    return {
      reglages: r,
      cles: { claude: !!getSetting(this.ctx.db, CLE.claude), chatgpt: !!getSetting(this.ctx.db, CLE.chatgpt) },
      depenseDuMoisCentimes: this.depenseDuMois(),
      depenseParService: { claude: this.depenseDuMois('claude'), chatgpt: this.depenseDuMois('chatgpt') },
      enService: Object.fromEntries(Object.keys(this.cerveauxActifs()).map((k) => [k, true])),
      tarifsClaude: TARIFS_CLAUDE,
      domaines: DOMAINES,
      notes: Object.fromEntries(
        (Object.keys(DOMAINES) as Domaine[]).map((d) => [d, Object.fromEntries(Object.keys(this.toutesCles()).map((k) => [k, { note: this.note(k, d), ...this.notes()[d][k] }]))]),
      ),
      libelles: this.toutesCles(),
    };
  }

  // ------------------------------------------------------------------ kit de démarrage : modèles installés
  /** Nom affiché à partir du nom Ollama : « qwen3-coder:30b » → « Qwen3-Coder 30b ». */
  static joliNom(id: string): string {
    const [base, taille] = id.split(':');
    const nom = base
      .split('/')
      .pop()!
      .split('-')
      .map((m) => (/^(glm|gpt|llm)\d*$/i.test(m) ? m.toUpperCase() : m.charAt(0).toUpperCase() + m.slice(1)))
      .join('-');
    return taille && taille !== 'latest' ? `${nom} ${taille}` : nom;
  }

  /** Liste les modèles d'un serveur Ollama (ou compatible) : adresse de base sans « /v1 ». */
  async detecter(adresse: unknown): Promise<{ url: string; modeles: { id: string; nom: string; deja: boolean }[] }> {
    let base = typeof adresse === 'string' && adresse.trim() ? adresse.trim() : 'http://127.0.0.1:11434';
    base = base.replace(/\/+$/, '').replace(/\/v1$/, '');
    let u: URL;
    try {
      u = new URL(base);
    } catch {
      throw new UserError(400, 'Adresse invalide (exemple : http://127.0.0.1:11434).');
    }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new UserError(400, 'Adresse invalide (exemple : http://127.0.0.1:11434).');
    let donnees: { data?: { id?: unknown }[] };
    try {
      const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!r.ok) throw new Error(String(r.status));
      donnees = (await r.json()) as typeof donnees;
    } catch {
      throw new UserError(502, 'Aucun serveur de modèles ne répond à cette adresse. Ollama est-il démarré ?');
    }
    const url = `${base}/v1`;
    const deja = new Set(this.reglages().locaux.filter((l) => l.url.replace(/\/+$/, '') === url).map((l) => l.modele));
    const modeles = (Array.isArray(donnees.data) ? donnees.data : [])
      .map((m) => String(m?.id ?? ''))
      .filter((id) => id && id.length < 200 && !/embed/i.test(id))
      .slice(0, 50)
      .map((id) => ({ id, nom: Assistant.joliNom(id), deja: deja.has(id) }));
    return { url, modeles };
  }

  /** Ajoute (autorisés) les modèles choisis parmi ceux détectés. */
  async ajouterDetectes(adresse: unknown, ids: unknown): Promise<ReglagesIA> {
    const d = await this.detecter(adresse);
    const choisis = Array.isArray(ids) ? ids.map(String) : [];
    const r = this.reglages();
    const nouveaux = d.modeles.filter((m) => choisis.includes(m.id) && !m.deja);
    if (!nouveaux.length) throw new UserError(400, 'Aucun nouveau modèle choisi.');
    if (r.locaux.length + nouveaux.length > MAX_LOCAUX) throw new UserError(400, `${MAX_LOCAUX} modèles locaux au plus.`);
    return this.modifierReglages({ locaux: [...r.locaux, ...nouveaux.map((m) => ({ nom: m.nom, actif: true, url: d.url, modele: m.id }))] });
  }

  // ------------------------------------------------------------------ précision, annulation, demandes réelles
  /** L'IA a posé une question : la réponse complète la demande, qui repart (nouvelle proposition). */
  async repondre(site: SiteRow, user: UserRow, id: string, reponse: unknown) {
    const p = this.ligne(site, id);
    if (p.statut !== 'question') throw new UserError(409, 'Cette demande n’attend pas de réponse.');
    const r = typeof reponse === 'string' ? reponse.trim() : '';
    if (!r || r.length > 500) throw new UserError(400, 'Écrivez votre réponse (500 caractères au plus).');
    this.ctx.db.prepare("UPDATE ia_propositions SET statut = 'repondue', decide_le = ? WHERE id = ?").run(now(), id);
    this.noter(id, `Réponse de ${user.name} : « ${r} ». La demande repart, complétée.`);
    const info = p.reunion ? JSON.parse(p.reunion) : {};
    return this.demander(site, user, `${p.demande}\nPrécision demandée : ${p.raison ?? ''}\nRéponse : ${r}`.slice(0, 2000), {
      domaine: info.choixDomaine === 'vous' ? info.domaine : undefined,
      portee: info.portee,
    });
  }

  /** Annule une proposition acceptée : remet les rubriques comme avant, si personne n'y a touché depuis. */
  async annuler(site: SiteRow, user: UserRow, id: string) {
    const p = this.ligne(site, id) as LigneProposition & { versions_apres?: string | null };
    if (p.statut !== 'acceptee' || !p.versions_apres) throw new UserError(409, 'Seule une proposition acceptée peut être annulée.');
    const versionsApres = JSON.parse(p.versions_apres) as Record<string, string>;
    const changements = JSON.parse(p.changements!) as Changement[];
    const { versions } = this.contexteDe(site, id);
    const touchees = changements.filter((c) => (versions[c.rubrique] ?? null) !== versionsApres[c.rubrique]);
    if (touchees.length) {
      throw new UserError(409, `Impossible d’annuler : « ${touchees.map((c) => c.libelle).join(' », « ')} » a été modifié depuis. Faites la correction dans « Contenus » (ou retrouvez l’ancienne version dans « Versions »).`);
    }
    for (const c of changements) await this.ecrire(site, user, c.rubrique, c.avant, versions[c.rubrique] ?? null);
    this.ctx.db.prepare("UPDATE ia_propositions SET statut = 'annulee', decide_le = ? WHERE id = ?").run(now(), id);
    this.noter(id, `Annulée par ${user.name} : les contenus sont revenus comme avant dans le brouillon.`);
    this.banc.oublierReelle(id);
    audit(this.ctx.db, { userId: user.id, action: 'ia_annulee', siteId: site.id, details: { id } });
    return this.lire(site, id);
  }

  // ------------------------------------------------------------------ banc d'essai (voir banc-execution.ts)
  bancEtat() {
    return this.banc.bancEtat();
  }
  lancerBanc(cles: unknown, payants: boolean) {
    return this.banc.lancerBanc(cles, payants);
  }
  arreterBanc(): boolean {
    return this.banc.arreterBanc();
  }
  oublierReelles(): void {
    this.banc.oublierReelles();
  }

  // ------------------------------------------------------------------ contexte transmis au cerveau
  /** Contenus publics du site, et rien d'autre (pas de secrets, de messages, de code serveur, d'autre site). */
  contexte(site: SiteRow): { rubriques: RubriqueContexte[]; versions: Record<string, string | null> } {
    const schema = loadSchema(this.ctx, site);
    const rubriques: RubriqueContexte[] = [];
    const versions: Record<string, string | null> = {};
    for (const e of schema.entries) {
      if (e.type !== 'file' || isServerCode(this.ctx, site, e.path)) continue;
      try {
        const r = readEntry(this.ctx, site, e.name);
        rubriques.push({ nom: e.name, libelle: e.label, champs: e.fields, liste: e.list, valeur: r.valeur });
        versions[e.name] = r.version;
      } catch {
        /* rubrique illisible : simplement pas proposée au cerveau */
      }
    }
    return { rubriques, versions };
  }

  /** Contexte selon la portée de la demande : contenus (formulaires) ou pages et styles (fichiers HTML/CSS). */
  private contexteDe(site: SiteRow, id: string) {
    return this.portee(id) === 'pages' ? contexteFichiers(this.ctx, site) : this.contexte(site);
  }
  private portee(id: string): 'contenus' | 'pages' {
    const r = this.ctx.db.prepare('SELECT reunion FROM ia_propositions WHERE id = ?').get(id) as { reunion: string | null } | undefined;
    try {
      return r?.reunion && JSON.parse(r.reunion).portee === 'pages' ? 'pages' : 'contenus';
    } catch {
      return 'contenus';
    }
  }
  /** Écrit une valeur (rubrique de contenu ou fichier) dans le brouillon ; renvoie la nouvelle version. */
  private async ecrire(site: SiteRow, user: UserRow, rubrique: string, valeur: unknown, version: string | null): Promise<string> {
    if (!estFichier(rubrique)) return (await saveEntry(this.ctx, site, user, rubrique, valeur, version)).version;
    const rel = rubrique.slice(PREFIXE.length);
    assertMayWrite(this.ctx, site, user, [rel]);
    return this.ctx.sites.lock(site.id, async () => {
      const w = writeChecked(this.ctx.sites.repoDir(site), rel, String(valeur), version);
      await this.ctx.sites.repo(site).commitPaths([w.rel], `Assistant : ${w.rel}`, authorOf(user));
      return w.version;
    });
  }

  // ------------------------------------------------------------------ demande
  async demander(site: SiteRow, user: UserRow, texte: unknown, opts: { forcer?: NomExterne; domaine?: unknown; portee?: unknown; seo?: { regle: string; page: string | null; message: string } } = {}) {
    const reg = this.reglages();
    if (!reg.active) throw new UserError(409, 'L’assistant est désactivé. Le propriétaire peut l’activer dans les Réglages de la plateforme.');
    const demande = typeof texte === 'string' ? texte.trim() : '';
    if (!demande || demande.length > 2000) throw new UserError(400, 'Décrivez votre demande (2 000 caractères au plus).');
    const id = randomId('ia');
    const domaine: Domaine = opts.domaine === 'textes' || opts.domaine === 'donnees' ? opts.domaine : domaineDe(demande);
    this.ctx.db
      .prepare("INSERT INTO ia_propositions (id, site_id, user_id, demande, statut, journal, cree_le, reunion) VALUES (?, ?, ?, ?, 'en_cours', '[]', ?, ?)")
      .run(id, site.id, user.id, demande, now(), JSON.stringify({ domaine, choixDomaine: opts.domaine === 'textes' || opts.domaine === 'donnees' ? 'vous' : 'automatique', ...(opts.portee === 'pages' ? { portee: 'pages' } : {}), ...(opts.seo ? { seo: opts.seo } : {}) }));
    audit(this.ctx.db, { userId: user.id, action: 'ia_demande', siteId: site.id, details: { id } });
    await this.traiter(id, site, opts.forcer ?? 'local');
    return this.lire(site, id);
  }

  /** Accord humain pour passer la demande à Claude (mode « sur accord »). */
  async relayer(site: SiteRow, user: UserRow, id: string) {
    const p = this.ligne(site, id);
    if (p.statut !== 'accord_requis') throw new UserError(409, 'Cette demande n’attend pas d’accord.');
    if (!this.reglages().active) throw new UserError(409, 'L’assistant est désactivé.');
    this.noter(id, `Relais vers une IA extérieure accepté par ${user.name}.`);
    audit(this.ctx.db, { userId: user.id, action: 'ia_relais_accepte', siteId: site.id, details: { id } });
    const voulu = (this.ctx.db.prepare('SELECT cerveau FROM ia_propositions WHERE id = ?').get(id) as { cerveau: string | null }).cerveau;
    await this.traiter(id, site, voulu === 'claude' || voulu === 'chatgpt' ? voulu : 'externe', true);
    return this.lire(site, id);
  }

  private async traiter(id: string, site: SiteRow, depart: NomCerveau | 'externe', relaisAccepte = false): Promise<void> {
    const { rubriques, versions } = this.contexteDe(site, id);
    if (!rubriques.length)
      return this.finir(id, 'impossible', {
        raison: this.portee(id) === 'pages' ? 'Ce site n’a pas de fichier HTML ou CSS modifiable par l’assistant.' : 'Ce site n’a pas de contenus modifiables par formulaire : l’assistant n’a rien sur quoi travailler.',
      });
    const demande = (this.ctx.db.prepare('SELECT demande FROM ia_propositions WHERE id = ?').get(id) as { demande: string }).demande;
    const taille = JSON.stringify(rubriques).length + demande.length;
    const cerveaux = this.cerveauxActifs();
    let raisonRelais: string | null = null;

    // 1 bis. Salle de réunion (si activée) : chaque IA propose une fois, la plus forte du domaine vérifie en dernier.
    if (depart === 'local' && this.reglages().reunion.active) {
      const r = await tenirReunion(this, this.ctx, id, site, demande, rubriques, versions, taille, cerveaux);
      if (r.fini) return;
      raisonRelais = r.raisonRelais;
      this.noter(id, `Relais envisagé vers une IA extérieure : ${raisonRelais}.`);
    }

    // 1. Modèles locaux, dans l'ordre choisi, sauf si la tâche leur échappe d'emblée.
    if (depart === 'local' && !this.reglages().reunion.active) {
      const locaux = Object.keys(cerveaux).filter(estLocal);
      if (!locaux.length) raisonRelais = 'aucun modèle local n’est en service';
      const raisons: string[] = [];
      for (const cle of locaux) {
        const local = cerveaux[cle];
        const nomL = capitale(this.libelle(cle));
        if (taille > local.tailleMax) {
          this.noter(id, `${nomL} : demande trop volumineuse pour ce modèle.`);
          raisons.push('demande trop volumineuse');
          continue;
        }
        if (!(await local.disponible().catch(() => false))) {
          this.noter(id, `${nomL} ne répond pas.`);
          raisons.push('modèle qui ne répond pas');
          continue;
        }
        let corrections: string[] | undefined;
        for (let essai = 1; essai <= ESSAIS_LOCAUX; essai++) {
          const r = await this.appeler(local, { demande, rubriques, corrections });
          if (r.erreur) {
            this.noter(id, `${nomL} : ${r.erreur}.`);
            raisons.push(r.erreur);
            break;
          }
          if (r.reponse!.statut === 'question') return this.finir(id, 'question', { cerveau: cle, raison: r.reponse!.question.slice(0, 300) });
          if (r.reponse!.statut === 'impossible') {
            this.noter(id, `${nomL} : « je ne sais pas faire » (${r.reponse!.raison}).`);
            raisons.push('« je ne sais pas faire »');
            break;
          }
          const v = this.verifier(r.reponse!.changements, rubriques, versions, demande);
          if (v.ok) return this.finir(id, 'proposee', { cerveau: cle, explication: r.reponse!.explication, changements: v.changements, site });
          this.noter(id, `${nomL}, essai ${essai} : proposition refusée par les vérifications (${v.erreurs.join(' ; ')}).`);
          corrections = v.erreurs;
          if (essai === ESSAIS_LOCAUX) raisons.push('propositions refusées par les vérifications');
        }
      }
      if (locaux.length) {
        const unique = [...new Set(raisons)];
        raisonRelais =
          locaux.length === 1
            ? `le modèle local n’a pas abouti (${unique.join(', ')})`
            : `aucun des ${locaux.length} modèles locaux n’a abouti (${unique.join(', ')})`;
        // Formulations historiques, gardées pour les cas simples.
        if (locaux.length === 1 && unique.length === 1) {
          if (unique[0] === 'demande trop volumineuse') raisonRelais = 'la demande est trop volumineuse pour le modèle local';
          else if (unique[0] === 'modèle qui ne répond pas') raisonRelais = 'le modèle local ne répond pas';
          else if (unique[0] === '« je ne sais pas faire »') raisonRelais = 'le modèle local ne sait pas faire cette demande';
          else if (unique[0] === 'propositions refusées par les vérifications') raisonRelais = 'les propositions du modèle local ne passent pas les vérifications';
          else raisonRelais = `le modèle local a échoué (${unique[0]})`;
        }
      }
      this.noter(id, `Relais envisagé vers une IA extérieure : ${raisonRelais}.`);
    }

    // 2. IA extérieures, dans l'ordre choisi, selon les règles du propriétaire.
    const reg = this.reglages();
    const candidates: NomExterne[] = depart === 'claude' || depart === 'chatgpt' ? [depart] : reg.ordre;
    const blocages: string[] = [];
    const possibles: NomExterne[] = [];
    if (reg.relaisExterne === 'jamais') blocages.push('le relais vers les IA extérieures est désactivé dans les réglages');
    else {
      for (const nom of candidates) {
        const c = cerveaux[nom];
        if (!c) {
          blocages.push(`${LIBELLE[nom]} n’est pas en service`);
          continue;
        }
        const estimation = c.estimer?.({ demande, rubriques }) ?? 0;
        const plafondService = reg[nom].plafondCentimes;
        const depasse = (depense: number, plafond: number) => depense >= plafond || depense + estimation > plafond;
        if (depasse(this.depenseDuMois(), reg.plafondMensuelCentimes)) {
          blocages.push(`le plafond mensuel global serait dépassé (${euros(reg.plafondMensuelCentimes)})`);
          continue;
        }
        if (plafondService !== null && depasse(this.depenseDuMois(nom), plafondService)) {
          blocages.push(`le plafond de ${LIBELLE[nom]} serait dépassé (${euros(plafondService)})`);
          continue;
        }
        possibles.push(nom);
      }
    }
    if (!possibles.length) {
      return this.finir(id, 'impossible', {
        raison: `${raisonRelais ? `${capitale(raisonRelais)}, et ` : ''}${[...new Set(blocages)].join(', ')}. Rien n’a été modifié ; vous pouvez faire la modification vous-même dans « Contenus ».`,
      });
    }
    if (reg.relaisExterne === 'demander' && !relaisAccepte) {
      if (depart === 'claude' || depart === 'chatgpt') this.ctx.db.prepare('UPDATE ia_propositions SET cerveau = ? WHERE id = ?').run(depart, id);
      return this.finir(id, 'accord_requis', {
        raison: `${capitale(raisonRelais ?? `vous avez demandé ${LIBELLE[possibles[0]]}`)}. Passer la demande à ${LIBELLE[possibles[0]]} ? (contenus publics du site uniquement, payant)`,
      });
    }
    let derniere = '';
    for (const nom of possibles) {
      const c = cerveaux[nom]!;
      const nomL = capitale(LIBELLE[nom]);
      const r = await this.appeler(c, { demande, rubriques });
      if (r.cout) this.compter(id, nom, r.cout);
      if (r.erreur) {
        this.noter(id, `${nomL} n’a pas pu répondre (${r.erreur}).`);
        derniere = `${nomL} n’a pas pu répondre (${r.erreur})`;
        continue;
      }
      if (r.reponse!.statut === 'question') return this.finir(id, 'question', { cerveau: nom, raison: r.reponse!.question.slice(0, 300) });
      if (r.reponse!.statut === 'impossible') {
        this.noter(id, `${nomL} : « je ne sais pas faire » (${r.reponse!.raison}).`);
        derniere = `${nomL} ne sait pas faire cette demande : ${r.reponse!.raison}`;
        continue;
      }
      const v = this.verifier(r.reponse!.changements, rubriques, versions, demande);
      if (!v.ok) {
        this.noter(id, `${nomL} : proposition refusée par les vérifications (${v.erreurs.join(' ; ')}).`);
        derniere = `la proposition de ${LIBELLE[nom]} ne passe pas les vérifications de PAGINITY`;
        continue;
      }
      return this.finir(id, 'proposee', { cerveau: nom, explication: r.reponse!.explication, changements: v.changements, site });
    }
    return this.finir(id, 'impossible', { raison: `${capitale(derniere)}. Rien n’a été modifié.` });
  }

  /** Coût maximal d'un appel payant encore autorisé par les plafonds (global et propre au service). */
  /** @internal (banc d'essai, réunion) */
  budgetPermet(cle: string, c: Cerveau, d: DemandeCerveau): boolean {
    if (estLocal(cle)) return true;
    const reg = this.reglages();
    const nom = cle as NomExterne;
    const estimation = c.estimer?.(d) ?? 0;
    const depasse = (depense: number, plafond: number) => depense >= plafond || depense + estimation > plafond;
    if (depasse(this.depenseDuMois(), reg.plafondMensuelCentimes)) return false;
    const ps = reg[nom]?.plafondCentimes;
    return !(ps !== null && ps !== undefined && depasse(this.depenseDuMois(nom), ps));
  }

  /** Appel protégé : délai maximal, arrêt d'urgence, réponse de forme inattendue. */
  /** @internal (banc d'essai, réunion) */
  async appeler(c: Cerveau, d: DemandeCerveau): Promise<{ reponse?: ReponseCerveau; erreur?: string; cout?: number }> {
    const ctl = new AbortController();
    this.enVol.add(ctl);
    let minuteur: NodeJS.Timeout | undefined;
    try {
      const delai = new Promise<never>((_, rej) => {
        minuteur = setTimeout(() => {
          ctl.abort();
          rej(new Error('temps de réponse dépassé'));
        }, c.delaiMs);
      });
      const arret = new Promise<never>((_, rej) => ctl.signal.addEventListener('abort', () => rej(new Error(this.reglages().active ? 'temps de réponse dépassé' : 'arrêt d’urgence'))));
      const reponse = await Promise.race([c.proposer(structuredClone(d), ctl.signal), delai, arret]);
      const cout = Math.max(0, Math.round(Number((reponse as { coutCentimes?: number })?.coutCentimes) || 0));
      if (!reponse || !['proposition', 'impossible', 'question'].includes(reponse.statut)) return { erreur: 'réponse illisible', cout };
      if (reponse.statut === 'question' && !String(reponse.question ?? '').trim()) return { erreur: 'réponse illisible', cout };
      if (reponse.statut === 'proposition' && !Array.isArray(reponse.changements)) return { erreur: 'réponse illisible', cout };
      return { reponse, cout };
    } catch (e) {
      const cout = Math.max(0, Math.round(Number((e as { coutCentimes?: number })?.coutCentimes) || 0));
      return { erreur: (e as Error).message || 'erreur', cout };
    } finally {
      clearTimeout(minuteur);
      this.enVol.delete(ctl);
    }
  }

  /** Les mêmes règles que les formulaires : rubrique proposée au cerveau, champs valides, vraie modification. */
  /** @internal (banc d'essai, réunion) */
  verifier(chg: { rubrique: string; valeur: unknown }[], rubriques: RubriqueContexte[], versions: Record<string, string | null>, demande?: string) {
    const erreurs: string[] = [];
    const changements: Changement[] = [];
    if (!chg.length) erreurs.push('aucune modification proposée');
    const vues = new Set<string>();
    for (const c of chg) {
      const r = rubriques.find((x) => x.nom === c?.rubrique);
      if (!r) {
        erreurs.push(`rubrique inconnue « ${String(c?.rubrique).slice(0, 60)} »`);
        continue;
      }
      if (vues.has(r.nom)) {
        erreurs.push(`rubrique « ${r.libelle} » proposée deux fois`);
        continue;
      }
      vues.add(r.nom);
      if (estFichier(r.nom)) erreurs.push(...verifierFichier(r.libelle, String(r.valeur), c.valeur, demande));
      else {
        const errs = validateEntryValue({ name: r.nom, label: r.libelle, type: 'file', path: '', format: 'json', list: r.liste, fields: r.champs }, c.valeur);
        for (const e of errs) erreurs.push(`${r.libelle} : ${e.message}`);
        if (JSON.stringify(c.valeur) === JSON.stringify(r.valeur)) erreurs.push(`« ${r.libelle} » : rien ne change`);
      }
      changements.push({ rubrique: r.nom, libelle: r.libelle, versionBase: versions[r.nom] ?? null, avant: r.valeur, apres: c.valeur });
    }
    return erreurs.length ? { ok: false as const, erreurs: erreurs.slice(0, 10) } : { ok: true as const, changements };
  }

  /** @internal (réunion d'IA) */
  compter(id: string, nom: NomExterne, centimes: number) {
    this.ctx.db.prepare('INSERT INTO ia_usage (mois, at, proposition_id, centimes, fournisseur) VALUES (?, ?, ?, ?, ?)').run(mois(), now(), id, centimes, nom);
    this.ctx.db.prepare('UPDATE ia_propositions SET cout_centimes = cout_centimes + ? WHERE id = ?').run(centimes, id);
  }

  /** @internal (réunion d'IA) */
  noter(id: string, texte: string) {
    const row = this.ctx.db.prepare('SELECT journal FROM ia_propositions WHERE id = ?').get(id) as { journal: string };
    const j = JSON.parse(row.journal) as { le: number; texte: string }[];
    j.push({ le: now(), texte: texte.slice(0, 500) });
    this.ctx.db.prepare('UPDATE ia_propositions SET journal = ? WHERE id = ?').run(JSON.stringify(j), id);
  }

  /** @internal (réunion d'IA) */
  finir(
    id: string,
    statut: StatutProposition,
    o: { cerveau?: NomCerveau; explication?: string; raison?: string; changements?: Changement[]; site?: SiteRow },
  ): void {
    // L'empreinte lie l'accord à CETTE proposition précise (site, versions de départ, valeurs proposées).
    const empreinte = o.changements
      ? crypto.createHash('sha256').update(JSON.stringify({ id, site: o.site?.id, changements: o.changements.map((c) => [c.rubrique, c.versionBase, c.apres]) })).digest('hex').slice(0, 32)
      : null;
    this.ctx.db
      .prepare('UPDATE ia_propositions SET statut = ?, cerveau = COALESCE(?, cerveau), explication = ?, raison = ?, changements = ?, empreinte = ? WHERE id = ?')
      .run(statut, o.cerveau ?? null, o.explication?.slice(0, 2000) ?? null, o.raison ?? null, o.changements ? JSON.stringify(o.changements) : null, empreinte, id);
    if (o.raison) this.noter(id, o.raison);
  }

  // ------------------------------------------------------------------ décision humaine
  async accepter(site: SiteRow, user: UserRow, id: string, empreinte: unknown) {
    const p = this.ligne(site, id);
    if (!this.reglages().active) throw new UserError(409, 'L’assistant est désactivé : la proposition ne peut plus être acceptée.');
    if (p.statut !== 'proposee') throw new UserError(409, 'Cette proposition ne peut pas (ou plus) être acceptée.');
    if (typeof empreinte !== 'string' || empreinte !== p.empreinte) throw new UserError(409, 'Cette validation ne correspond pas à la proposition affichée. Rechargez-la.');
    const changements = JSON.parse(p.changements!) as Changement[];
    // Si une rubrique a changé depuis la proposition, l'accord ne vaut plus.
    const { versions } = this.contexteDe(site, id);
    if (changements.some((c) => (versions[c.rubrique] ?? null) !== c.versionBase)) {
      this.finir(id, 'perimee', { raison: 'Les contenus ont été modifiés depuis la proposition : elle n’est plus valable. Refaites la demande.' });
      throw new UserError(409, 'Les contenus ont été modifiés depuis la proposition : elle n’est plus valable. Refaites la demande.');
    }
    const pages = this.portee(id) === 'pages';
    const instantane = pages ? [] : this.contexte(site).rubriques;
    const versionsApres: Record<string, string> = {};
    for (const c of changements) versionsApres[c.rubrique] = await this.ecrire(site, user, c.rubrique, c.apres, c.versionBase);
    this.ctx.db.prepare("UPDATE ia_propositions SET statut = 'acceptee', decide_le = ?, versions_apres = ? WHERE id = ?").run(now(), JSON.stringify(versionsApres), id);
    if (!pages) this.banc.retenirPourBanc(p, instantane, changements);
    this.compterDecision(p.cerveau, p.reunion ? JSON.parse(p.reunion).domaine ?? null : null, true);
    this.noter(id, `Acceptée par ${user.name} : enregistrée dans le brouillon (pas encore publiée).`);
    this.nettoyerApercu(site, id);
    audit(this.ctx.db, { userId: user.id, action: 'ia_acceptee', siteId: site.id, details: { id, cerveau: p.cerveau, rubriques: changements.map((c) => c.rubrique) } });
    return this.lire(site, id);
  }

  /** Après une correction de référencement acceptée : résultat du nouvel audit du brouillon, gardé avec la proposition. */
  noterVerificationSeo(site: SiteRow, id: string, v: { corrige: boolean; message: string }) {
    const p = this.ligne(site, id);
    const r = p.reunion ? JSON.parse(p.reunion) : {};
    this.ctx.db.prepare('UPDATE ia_propositions SET reunion = ? WHERE id = ?').run(JSON.stringify({ ...r, verificationSeo: { ...v, le: now() } }), id);
    this.noter(id, v.message);
  }

  refuser(site: SiteRow, user: UserRow, id: string) {
    const p = this.ligne(site, id);
    if (!['proposee', 'accord_requis'].includes(p.statut)) throw new UserError(409, 'Cette proposition est déjà terminée.');
    this.ctx.db.prepare("UPDATE ia_propositions SET statut = 'refusee', decide_le = ? WHERE id = ?").run(now(), id);
    if (p.statut === 'proposee') this.compterDecision(p.cerveau, p.reunion ? JSON.parse(p.reunion).domaine ?? null : null, false);
    this.noter(id, `Refusée par ${user.name}. Rien n’a été modifié.`);
    this.nettoyerApercu(site, id);
    audit(this.ctx.db, { userId: user.id, action: 'ia_refusee', siteId: site.id, details: { id } });
    return this.lire(site, id);
  }

  // ------------------------------------------------------------------ lecture
  /** L'aperçu « après » d'une proposition ne sert plus une fois décidée. */
  private nettoyerApercu(site: SiteRow, id: string) {
    fs.rmSync(path.join(this.ctx.sites.dir(site), 'apercus-propositions', id.replace(/[^\w-]/g, '')), { recursive: true, force: true });
  }

  private ligne(site: SiteRow, id: string): LigneProposition {
    const p = this.ctx.db.prepare('SELECT * FROM ia_propositions WHERE id = ? AND site_id = ?').get(id, site.id) as LigneProposition | undefined;
    if (!p) throw new UserError(404, 'Proposition introuvable.');
    return p;
  }

  lire(site: SiteRow, id: string) {
    const p = this.ligne(site, id);
    return {
      id: p.id,
      demande: p.demande,
      statut: p.statut,
      cerveau: p.cerveau,
      cerveauLibelle: p.cerveau ? capitale(this.libelle(p.cerveau)) : null,
      explication: p.explication,
      raison: p.raison,
      changements: p.changements ? (JSON.parse(p.changements) as Changement[]).map(({ versionBase: _v, ...c }) => c) : [],
      empreinte: p.statut === 'proposee' ? p.empreinte : null,
      coutCentimes: p.cout_centimes,
      journal: JSON.parse(p.journal) as { le: number; texte: string }[],
      reunion: this.reunionLisible(p.reunion),
      portee: p.reunion && JSON.parse(p.reunion).portee === 'pages' ? 'pages' : 'contenus',
      seo: (p.reunion ? JSON.parse(p.reunion).seo ?? null : null) as { regle: string; page: string | null; message: string } | null,
      verificationSeo: (p.reunion ? JSON.parse(p.reunion).verificationSeo ?? null : null) as { corrige: boolean; message: string; le: number } | null,
      annulable: p.statut === 'acceptee' && !!(p as { versions_apres?: string | null }).versions_apres,
      creeLe: p.cree_le,
    };
  }

  private reunionLisible(brut: string | null) {
    if (!brut) return null;
    const r = JSON.parse(brut);
    return {
      domaine: r.domaine as Domaine,
      domaineLibelle: DOMAINES[r.domaine as Domaine],
      choixDomaine: r.choixDomaine,
      verificateur: r.verificateur ? capitale(this.libelle(r.verificateur)) : null,
      choixVerificateur: r.choixVerificateur ?? null,
      statutVerificateur: r.statutVerificateur ?? null,
      participants: (r.participants ?? []).map((x: { cle: string }) => ({ ...x, libelle: capitale(this.libelle(x.cle)) })),
    };
  }

  liste(site: SiteRow) {
    const ids = this.ctx.db.prepare('SELECT id FROM ia_propositions WHERE site_id = ? ORDER BY cree_le DESC LIMIT 50').all(site.id) as { id: string }[];
    return ids.map((r) => this.lire(site, r.id));
  }

  /** Au démarrage : une demande restée « en cours » (arrêt du serveur) est marquée interrompue. */
  reprise(): void {
    this.ctx.db.prepare("UPDATE ia_propositions SET statut = 'interrompue' WHERE statut = 'en_cours'").run();
  }
}

/** Montant en devise de facturation des services (dollars US chez Anthropic et OpenAI). */
function euros(c: number): string {
  return `${(c / 100).toFixed(2).replace('.', ',')} $`;
}

function capitale(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Fichiers proposés (chemin dans le dépôt → contenu) d'une proposition « pages », pour l'aperçu. */
export function fichiersProposes(p: { changements: { rubrique: string; apres: unknown }[] }): Record<string, string> {
  return Object.fromEntries(p.changements.filter((c) => estFichier(c.rubrique)).map((c) => [c.rubrique.slice(PREFIXE.length), String(c.apres)]));
}

/** Diagnostic : explication en français simple par le premier modèle LOCAL qui répond (rien ne sort de la machine). */
export async function expliquerDiagnostic(a: Assistant, consignes: string, rapport: string): Promise<{ texte: string; par: string } | null> {
  if (!a.reglages().active) return null;
  for (const [cle, c] of Object.entries(a.cerveauxActifs())) {
    if (!estLocal(cle) || !c.expliquer || !(await c.disponible().catch(() => false))) continue;
    try {
      const texte = (await c.expliquer(consignes, rapport, AbortSignal.timeout(c.delaiMs))).trim();
      if (texte) return { texte: texte.slice(0, 3000), par: capitale(a.libelle(cle)) };
    } catch {
      /* modèle suivant */
    }
  }
  return null;
}
