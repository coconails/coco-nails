# Essayer le prototype PAGINITY sur un ordinateur

> Ce prototype sert à **tester** l'interface et le moteur de publication. Il n'est pas encore prévu pour héberger
> de vrais sites sur internet (installation définitive : phase 4).

## 1. Ce qu'il faut

- **Node.js 22.13 ou plus récent** (gratuit : nodejs.org, version « LTS »). Vérification : `node -v`.
- **Git** (gratuit : git-scm.com). Vérification : `git --version`.
- Un navigateur récent (Chrome, Edge, Firefox ou Safari).

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

## 5. Tests automatiques

```bash
npm test                      # 28 tests du serveur (connexion, sécurité, publication, droits, import…)
npm run build && npm run e2e  # parcours complet dans Chromium (nécessite Playwright)
```

Le test d'import de Coco Nail's s'exécute seulement si le dépôt du site est présent (variable `COCO_NAILS_DIR`).
