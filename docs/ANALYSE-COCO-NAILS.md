# Analyse de compatibilité : Coco Nail's → PAGINITY

> Réalisée le 15/11/2026 par lecture du dépôt privé (lecture seule, aucune modification) et par un **import réel**
> dans PAGINITY (test automatique `server/test/coco-nails.test.ts`). Aucun secret n'a été lu ni utilisé.

## 1. Ce qui a été vérifié par un test réel

| Point | Résultat |
|---|---|
| Import du dépôt (archive ZIP) | ✅ Le site est créé ; dossier publié `public`, étape de préparation et fonctions détectés depuis `netlify.toml` |
| Toutes les rubriques de `.pages.yml` ouvertes en formulaires | ✅ 9 rubriques ; types utilisés : texte, texte long, nombre, oui/non, date, liste de choix, image, objets et listes (avec maximum), motifs (horaires « 09:00 ») |
| Ré-enregistrement à l'identique | ✅ Accepté par la validation, aucun point d'historique inutile |
| Publication | ✅ Réussie (sans étape de préparation ni fonctions, voir § 3) |
| Redirection `/rdv` → `/#reserver` (301) | ✅ |
| En-têtes de `netlify.toml` (X-Frame-Options, Cache-Control `no-cache` sur `/contenu/*`, `noindex` sur `/compta/*`) | ✅ |
| Le code des fonctions (`netlify/…`) et la fiche ne sont pas publiés | ✅ |
| Appels `/api/*` | Réponse claire « fonctions pas encore actives » (503), comme prévu en phase 2 |

## 2. Inventaire technique

| Élément | Constat | Conséquence pour PAGINITY |
|---|---|---|
| 8 fonctions Netlify v2 (ESM) | 6 appelées par une adresse (`config.path` : `/api/disponibilites`, `/api/reserver`, `/api/rdv`, `/api/compta`, `/api/facture`, `/api/desinscription`) et 2 planifiées | Adaptateur Netlify v2 nécessaire (phase 3) |
| Signature des fonctions | `export default async (req)` : uniquement la requête standard ; **aucun usage de l'objet `context`**, ni de `Netlify.env`, ni de Netlify Blobs | Adaptateur **simple** : très bonne nouvelle |
| Tâches planifiées | `0 7 * * *` (rappel URSSAF) et `0 9 * * *` (rappels clientes), **en heure UTC** | Le planificateur lira ces horaires en UTC (risque R9). L'heure locale d'envoi change déjà entre été et hiver sur Netlify |
| Variable `URL` fournie par Netlify | Utilisée par les fonctions planifiées pour relire `/contenu/*.json` sur le site public | L'adaptateur devra fournir `URL` (adresse publique du site) |
| Variables secrètes | Google (compte de service), compta, SumUp, OVH (noms connus, valeurs jamais lues) | À saisir dans le coffre de PAGINITY, par vous, en phase 3 |
| Liens signés (rendez-vous, factures, désinscription) | Clés dérivées de secrets existants | Les **mêmes valeurs** de secrets devront être utilisées pour que les liens déjà envoyés restent valables |
| **Formulaires Netlify** | Les formulaires « rendez-vous » (solution de secours si les e-mails échouent) et « contact » utilisent `data-netlify="true"` | ⚠️ **Point important** : hors Netlify, ces envois ne sont reçus par personne. Il faudra un module « formulaires » PAGINITY (phase 3) **ou** une petite adaptation du site, à décider avec vous |
| Étape de préparation `netlify/preparer-page.mjs` | Écrit dans la page les tarifs, FAQ, horaires et données structurées pour Google | Sans elle, la page fonctionne (le JavaScript affiche les contenus) mais **le référencement Google serait moins bon**. Elle doit tourner (dans un conteneur) **avant** toute bascule |
| Dépendances | `pdf-lib` 1.17.1 uniquement (JavaScript pur) | Compatible ARM64 (Raspberry Pi) et x86 |
| Espace compta `/compta` | Application installable, protégée par mot de passe côté fonction | Fonctionnera dès que les fonctions seront actives |
| Services externes | Google (Agenda, Gmail, Sheets, Drive), OVH SMS, SumUp (lecture seule, compte pas encore actif) | Aucun changement côté site. **À vérifier** : restriction éventuelle des clés OVH par adresse IP |
| Délais | Fonctions classiques limitées par Netlify (≈ 10 s), tâches planifiées 30 s | PAGINITY laissera au moins ces durées |

## 3. État après la phase 3 (15/11/2026)

| Point | État | Vérifié par |
|---|---|---|
| Les 8 fonctions se chargent et répondent | ✅ | test automatique + parcours navigateur (conteneur Podman et processus restreint) |
| `/api/disponibilites` sans secrets répond `{ actif: false }` ; `/api/compta` signale « non configurée » | ✅ | idem |
| Étape de préparation `preparer-page.mjs` exécutée dans l'isolation (données pour Google présentes dans la page) | ✅ | idem |
| Dépendance `pdf-lib` installée (`npm ci` sans scripts, cache) | ✅ | idem |
| Variable `URL` fournie aux fonctions | ✅ | test (adresse du site) |
| Tâches `rappels` (9 h UTC) et `rappel-urssaf` (7 h UTC) reconnues, **désactivées par défaut** | ✅ | idem |
| Formulaires « contact » et « rendez-vous » (secours) reçus par le **module formulaires de PAGINITY**, **sans modifier le site** | ✅ | idem |
| Secrets attendus détectés automatiquement (Google, compta, OVH, SumUp) | ✅ | idem |
| **Fonctionnement réel avec Google, OVH, SumUp** | ⏳ **Non testé** | nécessite vos comptes de test (voir ci-dessous) |

Décision prise pour les formulaires : **module PAGINITY** (le site n'est pas modifié). Les messages sont visibles
dans l'écran « Formulaires » et peuvent être envoyés par e-mail (à configurer dans les Réglages de la plateforme).

## 4. Ce qui reste avant de pouvoir migrer

1. **Tests réels avec des comptes de test** (votre action) : agenda Google de test, copie de la feuille de compta,
   SumUp et OVH en mode test, saisis dans « Secrets › Test », puis essai complet dans l'aperçu.
2. Saisie des **secrets de production** (mêmes valeurs que sur Netlify, pour que les liens déjà envoyés restent valables).
3. Vérifier la restriction éventuelle des clés OVH par adresse IP.
4. Phase 4 (serveur définitif, sauvegardes) puis phase 5 : activer les tâches planifiées sur PAGINITY **le jour où elles
   sont désactivées sur Netlify**, jamais avant.
