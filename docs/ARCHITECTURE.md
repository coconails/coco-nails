# PAGINITY — Architecture du programme (phases 2 et 3)

> Ce document décrit le programme **tel qu'il est réellement écrit** à la fin de la phase 2.
> Les décisions et leurs raisons sont dans [CAHIER-DES-CHARGES.md](CAHIER-DES-CHARGES.md).

## 1. Vue d'ensemble

```
 Navigateur (ordinateur, tablette, téléphone)            Visiteurs des sites
        │  https://admin…  (port 8080 en local)                │
        ▼                                                      ▼
 ┌──────────────────────── PAGINITY (un seul processus Node.js) ─────────────────────────┐
 │                                                                                         │
 │  SERVEUR D'ADMINISTRATION (Fastify)          SERVEUR DES SITES (port 8082)               │
 │  ├─ interface web (React, déjà fabriquée)    └─ choisit le site d'après le nom de        │
 │  └─ API /api/…  (contrôles communs :            domaine, sert la version en ligne,       │
 │     origine, jeton anti-falsification,          redirections et en-têtes « Netlify »     │
 │     session, droits)                                                                     │
 │                                              SERVEUR DES APERÇUS (port 8081)             │
 │                                              └─ adresses temporaires <site>--<code>.…    │
 │                                                                                         │
 │  Modules : comptes · sites · contenus · médias · fichiers · publication · activités ·   │
 │            journal · coffre · santé                                                      │
 └─────────────────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
 DISQUE (dossier de données)
   plateforme/paginity.db        base SQLite (comptes, sites, publications, activités, journal)
   coffre/cle-maitre             clé de chiffrement (lisible par PAGINITY seulement)
   espaces/<espace>/sites/<id>/
       source/                   dépôt Git du site = le brouillon (chaque enregistrement = un point d'historique)
       versions/v0001 …          versions publiées, en lecture seule (20 dernières)
       en-ligne → versions/vN    lien symbolique, basculé de façon atomique
       apercus/, apercu →        fabrications du brouillon pour l'aperçu
       donnees/                  données métier du site (hors historique, jamais touchées par une restauration)
   temporaire/                   vidé à chaque démarrage
```

En production (phase 4), **Caddy** et **Cloudflare Tunnel** seront placés devant ces trois serveurs ; le code
de PAGINITY ne dépend ni de l'un ni de l'autre (portabilité, D8).

## 2. Organisation du code

```
paginity/
├── server/                       serveur (TypeScript, Node.js ≥ 22.13)
│   ├── src/
│   │   ├── index.ts              démarrage, affichage du code d'installation
│   │   ├── main.ts               assemblage des modules (sans ouvrir de port : utilisé par les tests)
│   │   ├── config.ts             réglages par variables d'environnement
│   │   ├── db.ts                 base SQLite intégrée à Node (node:sqlite) + migrations
│   │   ├── auth/                 mots de passe (Argon2id), sessions, limitation des tentatives,
│   │   │                         codes à 6 chiffres (anti-rejeu), codes de secours, passkeys (WebAuthn)
│   │   ├── sites/                sites, rôles, fichiers sûrs, fiche paginity.yml / netlify.toml,
│   │   │                         médiathèque (sharp), import ZIP/Git, export
│   │   ├── content/              lecture de .pages.yml, déduction automatique, validation
│   │   ├── publish/              contrôles, fabrication, bascule atomique, vérification, restauration, aperçu
│   │   ├── jobs/queue.ts         centre d'activités (opérations longues côté serveur)
│   │   ├── servers/              serveur des sites et des aperçus, service des fichiers statiques
│   │   ├── http/                 API (connexion, sites, système) et protections communes
│   │   └── lib/                  Git, coffre (AES-256-GCM), journal d'audit, événements, outils
│   ├── templates/                modèles « vitrine » et « vierge »
│   └── test/                     tests automatiques (Vitest)
├── web/                          interface (React 19, Mantine 9, TanStack Query, CodeMirror 6)
│   ├── public/                   logo, icônes, manifeste (ajout à l'écran d'accueil)
│   └── src/pages, src/components
└── e2e/parcours.mjs              parcours complet dans un vrai navigateur (Playwright, Chromium)
```

## 3. Les règles qui protègent le travail

| Règle | Où dans le code |
|---|---|
| Une seule écriture à la fois par site (file d'attente par site) | `KeyedMutex` dans `lib/util.ts`, `SiteService.lock` |
| Pas d'écrasement silencieux : chaque écriture fournit la version lue ; sinon refus 409 | `writeChecked` dans `sites/files.ts` |
| Impossible de sortir du dossier du site, d'atteindre `.git` ou de suivre un lien symbolique | `resolveIn` dans `sites/files.ts` |
| Chaque enregistrement est un point d'historique ; l'historique n'est jamais réécrit | `lib/git.ts` (`commitPaths`, `resetTreeTo` + nouveau point) |
| Publication : version préparée entièrement, puis bascule atomique, vérification et retour automatique | `publish/pipeline.ts` |
| Restauration sans toucher au brouillon ni aux données métier | `runRestore` (bascule seulement), `donnees/` hors Git |
| Droits vérifiés à un seul endroit | `SiteService.require` + `roleAllows` |
| Toute modification par l'API exige l'origine attendue et le jeton anti-falsification | crochet `onRequest` dans `http/app.ts` |
| Actions sensibles : identité reconfirmée (10 min) | `requireSudo`, `/api/confirmation` |
| Fichiers commençant par « . » et fichiers techniques jamais publiés | `buildOutput`, `serveStatic` |

## 4. Publication en 10 étapes

`Verrou` → `Figer le brouillon` (point d'historique + copie figée) → `Contrôler` (JSON, schéma .pages.yml,
page d'accueil, tailles, vidéos) → `Fabriquer` (copie du dossier publié ; l'étape de préparation du site
viendra en phase 3, dans un conteneur) → `Vérifier le résultat` (liens internes) → `Ranger la version`
(lecture seule) → `Fonctions serveur` (phase 3) → `Basculer` (lien symbolique remplacé d'un coup) →
`Vérifier en ligne` (requête réelle au serveur des sites ; en cas d'échec, retour automatique) → `Enregistrer`
(étiquette Git `pub-N`, journal, nettoyage des vieilles versions).

## 5. API (résumé)

| Domaine | Points d'accès |
|---|---|
| Connexion | `GET /api/etat`, `POST /api/installation`, `POST /api/connexion` (+ `/totp`, `/secours`, `/passkey`), `POST /api/deconnexion[/partout]`, `POST /api/confirmation[/passkey]` |
| Profil | `/api/profil`, `/mot-de-passe`, `/2fa/totp/*`, `/codes-secours`, `/passkeys`, `/sessions` |
| Invitations | `POST /api/invitations`, `GET /api/invitations/:jeton`, `POST …/accepter` |
| Sites | `GET/POST /api/sites`, `POST /api/sites/import`, `GET/PATCH/DELETE /api/sites/:id`, `/export`, `/membres` |
| Contenus et médias | `/api/sites/:id/contenus[/:nom]`, `/medias` |
| Mode code | `/api/sites/:id/fichiers`, `/fichier`, `/fichiers/nouveau`, `/fichiers/renommer`, `/brut`, `/presence` |
| Publication | `/modifications`, `/diff`, `/annuler`, `/apercu`, `/publier`, `/publications[/:n/remettre|reprendre]`, `/historique` |
| Système | `/api/tableau-de-bord`, `/api/activites[/flux]`, `/api/sante`, `/api/journal`, `/api/utilisateurs` |

## 6. Fonctions serveur et tâches (phase 3)

```
 Visiteur ──► serveur des sites ──┬─► fichier statique (version en ligne)
                                  ├─► formulaire Netlify (data-netlify) ──► module formulaires (chiffré en base, e-mail)
                                  └─► /api/…, /.netlify/functions/…, adresses déclarées par les fonctions
                                          │  (socket Unix, jamais de port réseau ouvert)
                                          ▼
                            EXÉCUTEUR DU SITE (un par site et par environnement)
                            runtime/worker.mjs : imite Netlify Functions v2
                            (Request/Response, context.params/cookies/ip, Netlify.env, config.path/schedule)
                            ├─ isolation « podman » : conteneur sans privilège, lecture seule,
                            │   ne voit que /app (le code du site) ; limites mémoire/processeur/processus
                            └─ isolation « processus » (secours) : modèle de permissions de Node.js
                                (lecture du code du site seulement, ni écriture, ni sous-processus)
```

| Élément | Fichier | Rôle |
|---|---|---|
| Exécuteur | `server/runtime/worker.mjs` | Charge les fonctions de la version, répond aux appels, exécute les tâches planifiées |
| Isolation | `src/functions/isolation.ts` | Conteneur Podman ou processus restreint ; étape de préparation isolée (« node script.mjs » seulement, sans réseau en conteneur) ; `npm ci --ignore-scripts` avec cache |
| Gestion des exécuteurs | `src/functions/service.ts` | Démarrage à la demande, remplacement sans coupure à chaque publication, arrêt après inactivité, journal (secrets masqués), statistiques, délai maximal (30 s) |
| Fabrication | `src/publish/fabrication.ts` | Dépendances → préparation → copie du dossier publié → code des fonctions dans `.app` (jamais servi) |
| Secrets | `src/functions/secrets.ts` | Deux jeux (production, test), chiffrés ; noms détectés dans le code (`process.env.X`) |
| Formulaires | `src/functions/forms.ts` | Formulaires Netlify déclarés dans les pages, champ piège, limite d'envois, messages chiffrés |
| Planificateur | `src/functions/scheduler.ts`, `cron.ts` | Cron 5 champs en UTC ; une exécution par créneau (unicité en base) ; pas d'exécution simultanée ; attente de la synchronisation de l'horloge ; tâches manquées signalées, rattrapage optionnel (6 h) ; aucune relance automatique ; désactivé par défaut pour un site importé |
| Alertes et e-mails | `src/lib/alerts.ts`, `src/lib/mail.ts` | Alerte critique = e-mail immédiat ; « attention » = récapitulatif quotidien ; SMTP (ex. Google Workspace) |

Publication : l'étape « Fonctions serveur » démarre l'exécuteur de la nouvelle version **à côté** de l'ancien et
refuse la publication si une fonction ne se charge pas. Après la bascule et la vérification, le nouvel exécuteur
remplace l'ancien ; en cas d'échec, l'ancien reste actif.

Aperçu : les fonctions ne tournent que si des **secrets de test** existent (exécuteur séparé, `CONTEXT=deploy-preview`) ;
les formulaires de l'aperçu n'enregistrent rien.

## 7. Prévu pour les phases suivantes

- Sauvegardes chiffrées hors du serveur, surveillance externe, procédure de restauration (phase 4).
- Installation sur le serveur définitif : Caddy, Cloudflare Tunnel, utilisateur système dédié, Podman sans droits
  administrateur avec réseau `slirp4netns` ou `pasta`, limites de ressources (cgroups v2) à vérifier sur le matériel.
