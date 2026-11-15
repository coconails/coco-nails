# Compte rendu — Phases 1 et 2 (15/11/2026)

## Ce qui a été réalisé

### Phase 1 — Cahier des charges et conception
- [CAHIER-DES-CHARGES.md](CAHIER-DES-CHARGES.md) : décisions D1 à D22, exigences, sécurité, sauvegardes, surveillance,
  matériel et coûts, risques, plan de migration, planning et critères de validation.
- [ANALYSE-COCO-NAILS.md](ANALYSE-COCO-NAILS.md) : inventaire du site existant et import réel dans PAGINITY.
- L'ancien document « Atelier » a été remplacé.

Décisions prises par délégation pendant cette étape : D14 (Cloudflare Tunnel), D15 révisée (accès local de secours),
D16 (Mantine), D17 (mobile en V1), D18 (Coolify et Dokploy non retenus), D19 (éditeur de contenus propre),
D20 (SQLite intégré à Node), D21 (Argon2id), D22 (pas de vidéo hébergée).
Une décision supplémentaire a été prise pendant le développement : **les aperçus utilisent une adresse temporaire
impossible à deviner** (`<site>--<code>.domaine-d-apercu`, valable 2 heures) au lieu d'un cookie, car les navigateurs
bloquent de plus en plus les cookies dans les cadres (Safari en particulier). Conséquence : toute personne qui reçoit ce
lien peut voir l'aperçu pendant 2 heures.

### Phase 2 — Prototype local ([ARCHITECTURE.md](ARCHITECTURE.md))
- **Comptes et sécurité** : installation par code à usage unique, mots de passe Argon2id, double authentification
  obligatoire (codes à 6 chiffres avec protection contre la réutilisation, passkeys, 10 codes de secours), limitation
  des tentatives, sessions (inactivité 30 min, 12 h max), confirmation d'identité pour les actions sensibles, jeton
  anti-falsification et contrôle d'origine, invitations à usage unique, rôles par site, journal d'audit.
- **Sites** : espaces, création depuis 2 modèles (vitrine, vierge), import ZIP (protégé contre les chemins dangereux)
  ou dépôt Git public, lecture de `netlify.toml`, fiche `paginity.yml`, réglages, domaines, membres, export complet,
  suppression.
- **Mode contenus** : formulaires générés depuis `.pages.yml` ou déduits des fichiers JSON ; listes, objets, choix,
  images, dates, motifs ; validation côté navigateur et serveur ; mise en forme JSON d'origine conservée.
- **Médiathèque** : vérification du vrai type de fichier, redimensionnement, compression, suppression des métadonnées
  (dont GPS), refus des SVG et HEIC avec explication, remplacement, suppression contrôlée (« encore utilisé dans… »).
- **Mode code** : arborescence, éditeur CodeMirror (coloration, contrôle du JSON, Ctrl/Cmd+S), création, renommage,
  suppression, comparaison avec la version en ligne, historique par fichier.
- **Brouillon commun et anti-écrasement** : chaque écriture vérifie la version lue (aucun écrasement silencieux entre
  personnes, onglets ou modes), indicateur « qui modifie aussi ».
- **Aperçu privé** multi-formats (téléphone, tablette, ordinateur), sans aucune fonction serveur réelle.
- **Publication en 10 étapes**, bascule atomique, vérification en conditions réelles, **retour automatique** en cas
  d'échec, avertissements (liens cassés, vidéos).
- **Versions** : remise en ligne d'une publication (sans toucher au brouillon ni aux données), reprise du brouillon
  depuis une publication, annulation des modifications (tout ou un fichier), historique.
- **Centre d'activités** : opérations longues côté serveur, suivies en direct, marquées « interrompues » après un
  redémarrage (jamais reprises à moitié).
- **Tableau de bord, santé du serveur** (disque, mémoire, charge, température si disponible), **journal**, **profil**
  (2FA, passkeys, codes de secours, mot de passe, appareils connectés).
- **Interface** en français, mode sombre/clair, adaptée au téléphone, logo et icônes PAGINITY, ajout à l'écran d'accueil.

## Ce qui a été testé

### Tests automatiques réellement exécutés (tous réussis)
| Série | Nombre | Contenu |
|---|---|---|
| `server/test/auth.test.ts` | 10 | installation, mot de passe trop court, 2FA obligatoire, anti-falsification, rejeu de code refusé, code de secours à usage unique, blocage après 5 erreurs, confirmation d'identité, journal, invitation |
| `server/test/sites.test.ts` | 15 | création, validation des contenus, conflit d'écriture, chemins interdits, JSON invalide, modifications champ par champ, aperçu par adresse temporaire, publication 10 étapes, restauration, reprise du brouillon, annulation, retour automatique sur panne simulée, publication refusée si JSON invalide, médiathèque, droits du contributeur, export, import ZIP sûr, redirections et en-têtes, activités interrompues |
| `server/test/coco-nails.test.ts` | 3 | import réel du site Coco Nail's, 9 rubriques en formulaires, publication, `/rdv`, en-têtes |
| `e2e/parcours.mjs` (navigateur **Chromium**, Playwright) | 16 vérifications | installation, 2FA, codes de secours, assistant de création, modification d'un tarif, aperçu en cadre (format téléphone), publication suivie en direct, site public à jour, versions, **passkey** (authentificateur virtuel) avec confirmation d'identité, **connexion par passkey**, affichage iPhone 13 sans défilement horizontal, menu mobile, **publication terminée après fermeture de la page**, aucune erreur JavaScript |

Mesure indicative (machine de développement, pas le Pi) : publication d'un petit site en **0,1 à 0,2 seconde** ;
chargement initial de l'interface ≈ 117 Ko compressés.

### Non testé (à faire)
- **Aucun test sur de vrais appareils** (PC Windows, Mac, iPhone, iPad, Android) ni dans Firefox et Safari :
  seul Chromium était disponible. Le format iPhone a été simulé dans Chromium, ce n'est pas Safari.
- Pas d'audit d'accessibilité formel (WCAG 2.2 AA).
- Pas de test sur Raspberry Pi ou mini-PC (phase 4).
- Passkeys réelles (Face ID, Touch ID, Windows Hello) : seulement un authentificateur virtuel.

## Ce qui fonctionne
Tout ce qui est listé dans les tests ci-dessus, en local, sur un ordinateur Linux.

## Ce qui ne fonctionne pas encore / limites connues
- **Fonctions serveur, étape de préparation, tâches planifiées, formulaires Netlify** : non pris en charge
  (phase 3). Les appels répondent clairement « pas encore actif ».
- **Sauvegardes automatiques, surveillance externe, alertes e-mail** : phase 4. En attendant : export manuel par site.
- **Invitations** : le lien est à copier et envoyer soi-même (pas encore d'envoi d'e-mail).
- **Collections** de `.pages.yml` : visibles mais à modifier en mode code.
- **Photos HEIC** et **SVG** refusés dans la médiathèque (message explicatif).
- **Domaines** : enregistrés dans les réglages, mais pas encore de marche à suivre DNS (phase 5).
- **Éditeur visuel à blocs** : phase 6, comme convenu.
- Sous Windows (hors WSL) : non testé.
- La base `node:sqlite` est signalée « expérimentale » par Node 22 ; elle fonctionne, et devrait devenir stable.

## Ce qui reste à faire
Phase 3 (fonctions + Coco Nail's), phase 4 (installation, sauvegardes, surveillance, tests de panne),
phase 5 (migration), phase 6 (évolutions). Détail dans le cahier des charges § 11 et l'analyse Coco Nail's § 3.

## Vos actions
1. **Lire** ce compte rendu et le cahier des charges ; signaler ce qui ne vous convient pas.
2. Si vous le souhaitez, **essayer le prototype** sur un ordinateur ([GUIDE-PROTOTYPE.md](GUIDE-PROTOTYPE.md)) et
   noter ce qui est peu clair.
3. Répondre aux **questions encore ouvertes** (cahier des charges § 12), surtout : avez-vous déjà le Raspberry Pi ?
4. Décider pour les **formulaires Netlify** de Coco Nail's : module PAGINITY ou petite adaptation du site.
5. Préparer pour la phase 3 des **comptes de test** (agenda Google de test, copie de la feuille de compta) et
   vérifier dans votre espace OVH si les clés d'API sont limitées par adresse IP.

Remarque : le dépôt `coconails/coco-nails` qui contient PAGINITY est **public** sur GitHub. Il ne contient aucun
secret ni donnée de clientes, mais vous pouvez le rendre privé dans les réglages GitHub si vous préférez.

## Décision de passage
La phase 3 (fonctions serveur et Coco Nail's) **n'est pas commencée**. Elle attend votre accord explicite.
