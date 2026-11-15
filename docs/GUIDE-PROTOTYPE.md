# Essayer le prototype PAGINITY sur un ordinateur

> Ce prototype sert à **tester** l'interface et le moteur de publication. Il n'est pas encore prévu pour héberger
> de vrais sites sur internet (installation définitive : phase 4).

## 1. Ce qu'il faut

- **Node.js 22.13 ou plus récent** (gratuit : nodejs.org, version « LTS »). Vérification : `node -v`.
- **Git** (gratuit : git-scm.com). Vérification : `git --version`.
- Un navigateur récent (Chrome, Edge, Firefox ou Safari).
- **Facultatif mais recommandé : Podman** (isolation des fonctions serveur dans des conteneurs). Sans Podman,
  PAGINITY utilise un processus restreint (isolation plus faible) et l'indique sur le tableau de bord.

Fonctionne sur Linux et macOS. Sur Windows, utilisez WSL (sous-système Linux) : le prototype utilise des liens
symboliques et la commande `tar`, non testés sous Windows directement.

## 2. Installation (une seule fois)

Dans un terminal, depuis le dossier `paginity` du dépôt :

```bash
npm install
npm run build
```

## 3. Démarrage

```bash
npm start
```

Le terminal affiche :

```
  PAGINITY — Créer · Gérer · Publier · Suivre
  Administration : http://localhost:8080
  Première installation — code à saisir dans le navigateur : XXXXXXXXXXXX
```

1. Ouvrez **http://localhost:8080**.
2. Saisissez le **code d'installation** affiché, votre nom, votre e-mail et un mot de passe (12 caractères minimum).
3. Activez la double authentification (application de codes à 6 chiffres ou passkey) et **rangez vos codes de secours**.
4. Créez un site avec « Ajouter un site ».

Les sites sont visibles sur `http://<nom-du-site>.localhost:8082` (Chrome, Edge et Firefox comprennent ces
adresses ; Safari peut ne pas les comprendre). Les aperçus s'ouvrent depuis l'interface.

Pour arrêter : `Ctrl+C` dans le terminal. Les données sont dans `paginity/data/` (à supprimer pour repartir de zéro).

## 4. Réglages possibles (variables d'environnement)

| Variable | Rôle | Par défaut |
|---|---|---|
| `PAGINITY_DATA_DIR` | Dossier des données | `paginity/data` |
| `PAGINITY_ADMIN_PORT` / `PREVIEW_PORT` / `SITES_PORT` | Ports | 8080 / 8081 / 8082 |
| `PAGINITY_PUBLIC_URL` | Adresse de l'administration (sert aussi aux passkeys) | `http://localhost:8080` |
| `PAGINITY_SESSION_IDLE_MINUTES` | Déconnexion après inactivité | 30 |
| `PAGINITY_KEEP_VERSIONS` | Versions fabriquées conservées par site | 20 |
| `PAGINITY_ISOLATION` | `podman` ou `processus` (par défaut : Podman s'il est installé) | automatique |
| `PAGINITY_CONTAINER_NETWORK` | Réseau des conteneurs (`slirp4netns`, `pasta`, `host`) | `slirp4netns` |
| `PAGINITY_CONTAINER_IMAGE` | Image Node.js des conteneurs | `docker.io/library/node:22-slim` |
| `PAGINITY_TRUST_PROXY` | `true` **uniquement** si PAGINITY est derrière un relais installé sur la même machine (Cloudflare Tunnel, Caddy…). L'adresse IP réelle de chaque visiteur est alors lue dans `CF-Connecting-IP` (sinon la dernière adresse de `X-Forwarded-For`), et seulement pour les connexions venant de la machine elle-même. Sans ce réglage derrière un tunnel, tous les visiteurs auraient la même adresse : les limites de tentatives et les journaux seraient faussés. | désactivé |
| `PAGINITY_SECURE_COOKIES` | Cookies réservés aux connexions chiffrées (https) | `true` si l'adresse publique commence par `https:` |
| `PAGINITY_ATTENDRE_HORLOGE` | `non` pour ne pas attendre la synchronisation de l'horloge (ordinateur sans systemd) | automatique |

## 5. Tests automatiques

```bash
npm test                      # 76 tests du serveur (connexion, sécurité, publication, fonctions, tâches, import…)
npm run build && npm run e2e  # parcours complet dans Chromium (nécessite Playwright)
npm run verifier              # contrôle des types (serveur, tests, interface) et de la syntaxe des scripts
```

Les tests de Coco Nail's s'exécutent seulement si le dépôt du site est présent (variable `COCO_NAILS_DIR`).
`test/coco-nails-simule.test.ts` fait tourner ses vraies fonctions (réservation, confirmation, refus, rappel SMS, compta,
SumUp) avec Google, OVHcloud et SumUp **simulés** (`test/simulation/services-simules.mjs`) : toute autre adresse
extérieure est refusée, aucune action réelle n'est possible. Ce simulateur n'est chargé que par les tests.

```bash
COCO_NAILS_DIR=/chemin/vers/coco-nails1 npm run e2e:phase3   # import réel, fonctions, secrets, formulaires
```

## 5 bis. Outils de secours et de mise à jour (préparés pour la phase 4)

**`paginity-admin`** (`paginity/scripts/paginity-admin`, ou `npm run admin -- <commande>`) s'utilise sur la machine
elle-même quand l'interface web n'est plus accessible. Il lit les mêmes données (`PAGINITY_DATA_DIR`) et note chaque
action dans le journal. Commandes : `etat`, `verifier` (base, clé du coffre, dossiers des sites), `debloquer [e-mail]`,
`fermer-sessions <e-mail>`, `mot-de-passe <e-mail>` (demandé au clavier, jamais sur la ligne de commande),
`reinitialiser-2fa <e-mail> --confirmer`, `activer <e-mail>`, `copie-base <fichier>` (copie cohérente, jamais écrasée).

**`paginity-maj`** (`paginity/scripts/paginity-maj`) met PAGINITY à jour depuis son dépôt Git, dans l'organisation prévue :
`/opt/paginity/versions/<date>-<commit>/`, lien `/opt/paginity/actuelle`, données dans `/var/lib/paginity`.
1. La nouvelle version est récupérée, installée (`npm ci --ignore-scripts`), fabriquée et testée **à côté** :
   en cas d'échec, rien ne change et PAGINITY n'est même pas arrêté.
2. PAGINITY est arrêté, la base est copiée (`sauvegardes/avant-maj-….db`), le lien bascule, PAGINITY redémarre.
3. Si PAGINITY ne répond pas dans les 60 secondes : la base copiée et l'ancienne version sont remises, et PAGINITY redémarre.
Une seule mise à jour à la fois ; les 3 dernières versions sont gardées. Réglages : `PAGINITY_MAJ_BASE`, `PAGINITY_MAJ_SOURCE`,
`PAGINITY_MAJ_REF`, `PAGINITY_MAJ_ARRET` / `PAGINITY_MAJ_DEMARRAGE` (par défaut `systemctl stop|start paginity`),
`PAGINITY_MAJ_SANTE`, `PAGINITY_MAJ_ATTENTE`, `PAGINITY_MAJ_GARDER`. Essayé dans `test/maj.test.ts` avec un faux PAGINITY ;
pas encore sur le mini-PC (phase 4).

## 6. Fonctions serveur, secrets et e-mails

- **Secrets** (clés Google, OVH…) : écran « Secrets » de chaque site. Saisissez-les vous-même ; ils sont chiffrés et ne
  sont plus jamais affichés. Le jeu « Test » sert uniquement aux aperçus.
- **Tâches planifiées** : écran « Fonctions et tâches ». Elles sont **désactivées par défaut** pour un site importé.
- **E-mails** (alertes, messages des formulaires) : « Réglages de la plateforme ». Avec Google Workspace :
  `smtp.gmail.com`, port 465, et un mot de passe d'application.
