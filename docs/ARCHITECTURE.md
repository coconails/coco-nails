# PAGINITY — Architecture du programme (prototype, phase 2)

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

## 6. Prévu pour les phases suivantes (emplacements réservés)

- `servers/sites.ts` répond aujourd'hui « fonctions non actives » sur `/api/*` et `/.netlify/functions/*` :
  c'est là que se branchera l'exécuteur de fonctions (conteneurs Podman, adaptateur Netlify v2).
- `jobs/queue.ts` accueillera le planificateur (tâches en UTC, rattrapage, verrous anti-doublons).
- `lib/vault.ts` contiendra les secrets des sites (déjà utilisé pour les secrets à deux facteurs).
- `routes-system.ts` (`serverHealth`) recevra l'état des sauvegardes et de la surveillance externe.
