# PAGINITY — Bilan complet au 20/11/2026

*Audit complet réalisé le 20/11/2026 sur le dernier état du travail (branche `claude/program-architecture-2ghvd6`), suivi du récapitulatif de tout ce qui a été décidé et construit. Chaque résultat chiffré ci-dessous a été **réellement mesuré aujourd'hui**, sauf mention contraire.*

---

## Partie 1 — En bref, honnêtement

**Ce qui est vrai :**
- PAGINITY est un **prototype avancé et solide**. Il fonctionne de bout en bout sur une machine de développement Linux. Tout ce qui y est testé passe.
- Les accès sont bien protégés : **toutes les 139 adresses de l'API** vérifient l'identité ou le rôle, sauf les 10 qui doivent rester ouvertes (connexion, installation, invitation).
- La conception est prudente : rien n'est publié, dépensé ou envoyé sans un geste humain.

**Ce qui n'est pas encore vrai :**
- PAGINITY **n'héberge aucun vrai site** aujourd'hui. Coco Nail's tourne toujours sur Netlify, et c'est très bien ainsi tant que les étapes suivantes ne sont pas faites.
- Il **n'a jamais été installé** sur le futur serveur (Raspberry Pi ou mini-PC). Les phases 4 (installation) et 5 (bascule de Coco Nail's) ne sont **pas commencées**.
- Plusieurs briques n'ont **jamais tourné avec les vrais services**, seulement avec des imitations :
  - Google (Search Console, Agenda, Gmail, Sheets, Drive) ;
  - OVH, SumUp ;
  - les modèles d'IA (local, Claude, ChatGPT) ;
  - l'envoi réel d'e-mails ;
  - les notifications sur un vrai téléphone.
- Les essais n'ont été faits que dans **Chromium** : jamais Safari, iPhone, Firefox, ni un vrai téléphone.
- L'accessibilité (objectif WCAG 2.2 AA) n'a **jamais été mesurée**.

**Le plus grand risque n'est pas technique :** c'est un logiciel sur mesure d'environ **28 000 lignes**, écrit avec une IA. Il n'a pas de communauté ni d'équipe de maintenance. Vous ne pouvez pas le faire évoluer seul. Chaque correction ou mise à jour importante demandera une aide, humaine ou IA, et il faudra **toujours la vérifier**. C'est le risque n° 1 déjà inscrit au cahier des charges, et il reste entier.

**Mon avis :** le travail fait est sérieux et bien testé pour un prototype. Mais il ne faut **pas** déplacer Coco Nail's avant d'avoir réussi, sur la vraie machine :
1. une installation complète ;
2. une restauration complète à partir d'une sauvegarde ;
3. une période de fonctionnement en parallèle avec Netlify.

---

## Partie 2 — Taille du programme (mesurée le 20/11/2026)

| Partie | Fichiers | Lignes |
|---|---|---|
| Serveur (cœur : comptes, sites, publication, fonctions, IA, référencement…) | 71 | 12 371 |
| Exécuteur des fonctions (isolation) | 1 | 232 |
| Interface (écrans) | 57 | 8 148 |
| Tests automatiques du serveur | 37 | 5 322 |
| Parcours dans le navigateur | 14 | 2 055 |
| Scripts d'installation, de secours et de mise à jour | 5 | 456 |
| **Total du code** | **185** | **≈ 28 600** |
| Documentation (10 documents) | 10 | 1 744 |
| Manuel PDF | 1 | 3,7 Mo |

| Mesure | Valeur |
|---|---|
| Programme fabriqué, prêt à installer (sans les composants) | serveur 1,5 Mo + interface 2,1 Mo |
| Interface, premier chargement | 469 Ko de JavaScript (environ 140 Ko compressé) + 260 Ko de styles |
| Composants open source utilisés | 18 côté serveur, 19 côté interface (+ 22 outils de développement) |
| Dossier des composants installés (`node_modules`) | 411 Mo |
| Historique Git du dépôt de travail | 53 Mo, 47 enregistrements (dont 43 pour PAGINITY), du 15 au 20/11/2026 |
| Adresses de l'API | 139 |
| Migrations de la base de données | 12 |

*La place réelle sur le serveur dépendra surtout de vos sites et de leurs photos, pas du programme.*

---

## Partie 3 — Audit : fonctionnement

### 3.1 Contrôles exécutés aujourd'hui

| Contrôle | Résultat (20/11/2026) |
|---|---|
| Vérification du code (types du serveur, des tests et de l'interface, syntaxe des scripts) | ✔ aucune erreur |
| Fabrication du programme | ✔ réussie |
| Tests automatiques du serveur | ✔ **204 / 204** réussis (34 séries, 37 s) |
| Parcours complets dans un vrai navigateur (Chromium) | ✔ **11 parcours, 128 contrôles, 0 échec** |
| Failles connues dans les composants du programme | ✔ **0** |
| Failles connues dans les outils de développement | ✔ **0** (il y en avait 8 le 17/11, corrigées depuis) |
| Le détail par parcours | installation et publication 16 · fonctions et Coco Nail's 11 · assistant 12 · panneau 22 · réunion 10 · banc d'essai 13 · continuité 12 · assistant avancé 12 · confort 6 · référencement 7 · Search Console 7 |

**Pas mesuré**, faute d'outil : l'accessibilité, Safari et Firefox, un vrai téléphone, les performances sur le futur serveur. La part du code couverte par les tests avait été mesurée le 17/11 : environ 89 % des lignes.

### 3.2 État de chaque module

| Module | État réel |
|---|---|
| Comptes, double authentification (codes, passkeys, codes de secours), rôles, invitations, journal | ✔ testé (tests + navigateur) |
| Sites : création, import ZIP/Git, contenus (`.pages.yml`), médias, mode code, brouillon, aperçu, publication en 10 étapes, versions, retour arrière, export | ✔ testé ; import réel d'une copie de Coco Nail's réussi |
| Fonctions serveur (imitation de Netlify), secrets, formulaires, tâches planifiées, alertes par e-mail | ✔ testé avec des services **imités** ; Podman testé seulement sur la machine de développement |
| Outils de secours (`paginity-admin`), sauvegarde/restauration manuelles, changement de clé, mise à jour avec retour arrière | ✔ testé |
| Sauvegarde automatique chiffrée hors machine, essai de restauration mensuel | ✔ testé vers un dossier local ; **jamais vers un vrai Google Drive ou disque USB** |
| Alerte de panne (battement de cœur), page de secours | ✔ testé avec un service de surveillance **imité** |
| Assistant IA (contenus, pages et styles, réunion, banc d'essai, diagnostic, dictée) | ✔ testé avec des **modèles simulés uniquement** |
| Notifications téléphone, aperçu téléphone, compteur de visites, surveillance des failles | ✔ testé (services imités) |
| Référencement M1 (audit) | ✔ testé, y compris sur une copie réelle de Coco Nail's |
| Référencement M2 (Search Console) | ✔ testé avec un **faux Google** uniquement |
| Installateurs Windows et Mac | Windows **jamais exécuté** ; Mac/Linux seulement en simulation |
| Installation sur le serveur définitif, accès depuis internet (Cloudflare Tunnel) | ✘ **pas commencé** (phase 4) |
| Bascule de Coco Nail's | ✘ **pas commencé** (phase 5) |

---

## Partie 4 — Audit : droits et accès

### 4.1 Qui peut faire quoi (vérifié dans le code)

| Action sur un site | Contributeur | Éditeur | Administrateur du site | Propriétaire |
|---|---|---|---|---|
| Voir le site, l'aperçu, les visites, l'audit, l'assistant | ✔ | ✔ | ✔ | ✔ |
| Modifier les contenus et les médias (brouillon) | ✔ | ✔ | ✔ | ✔ |
| Publier, revenir à une version, fiche de secours | — | ✔ | ✔ | ✔ |
| Engager une dépense d'IA payante (si autorisée) | — | ✔ | ✔ | ✔ |
| Mode code (HTML, CSS, JS du site) | — | — | ✔ | ✔ |
| Réglages du site, secrets, personnes, export | — | — | ✔ | ✔ |
| Code exécuté **sur le serveur** (fonctions, préparation, dépendances) | — | — | — | ✔ |
| Gérer les administrateurs d'un site | — | — | — | ✔ |
| Créer, importer ou supprimer un site | — | — | — | ✔ |
| Réglages de la plateforme (IA, sauvegarde, alertes, Search Console, e-mails) | — | — | — | ✔ (+ confirmation d'identité) |

### 4.2 Contrôle de toutes les adresses de l'API (analyse automatique du code, 20/11/2026)

| Protection exigée | Nombre d'adresses |
|---|---|
| Ouvertes (connexion, installation, déconnexion, invitation par lien, état) — c'est voulu | 10 |
| Session sans double authentification (uniquement pour la configurer) | 3 |
| Connecté avec double authentification | 79 |
| Connecté + identité confirmée récemment (actions sensibles) | 16 |
| Propriétaire | 21 |
| Propriétaire + identité confirmée | 10 |
| **Total** | **139** |

- **Toutes** les adresses qui concernent un site vérifient le rôle sur **ce** site. 67 contrôles de rôle au total : voir 23, contenus 10, publier 12, code 5, réglages 11, membres 4, exporter 1, supprimer 1.
- Une personne sans rôle sur un site reçoit « Site introuvable » : elle ne peut même pas savoir qu'il existe.

### 4.3 Protections générales (vérifiées dans le code)

- Mots de passe **Argon2id**. Double authentification **obligatoire**. Limitation des tentatives par adresse IP et par compte. Un inconnu ne peut pas bloquer la connexion de la propriétaire.
- Témoins de session `HttpOnly`, `SameSite=Strict`, `Secure` en https. Vérification de l'origine + jeton anti-falsification sur toutes les modifications.
- En-têtes de sécurité stricts. Aperçus et sites sur des adresses séparées de l'administration.
- Secrets chiffrés (AES-256-GCM), **jamais réaffichés** : l'écran ne montre que les noms.
- Sauvegarde chiffrée par flux (scrypt + AES-256-GCM) avec votre phrase. Sans elle, le fichier est illisible.
- L'IA ne reçoit **aucun outil**. Tout ce qu'elle propose est revérifié par PAGINITY, puis soumis à votre accord.

### 4.4 Ce que l'audit a trouvé (honnêtement)

Aucune faille grave n'a été trouvée. Voici tout ce qui mérite d'être connu, du plus important au moins important.

| # | Constat | Gravité | Ce que je conseille |
|---|---|---|---|
| 1 | **Une alerte marquée « lue » l'est pour tout le monde.** Si un membre d'un site (même Contributeur) marque une alerte de ce site comme lue, elle disparaît aussi pour vous, et elle ne part plus dans le récapitulatif quotidien par e-mail. | Moyenne | Garder « lu » par personne, ou réserver ce geste aux Éditeurs et plus. Petite correction. |
| 2 | **Les fonctions serveur peuvent joindre internet**, et en mode « processus restreint », aussi les appareils de la maison (box, NAS…). C'est nécessaire pour Google, OVH et SumUp, et c'est réservé au code écrit par le propriétaire. Le conteneur Podman n'a jamais été vérifié sur le vrai serveur. | Moyenne (élevée avant d'accueillir des clients) | Vérifier Podman en phase 4 ; ajouter une liste d'adresses autorisées avant tout client. |
| 3 | **La sauvegarde est plus simple que prévu au cahier des charges.** Une seule destination (un dossier), au lieu de « 3 copies, 2 supports, 1 hors de la maison » (restic + rclone, deux disques USB alternés, copie immuable). Conservation par nombre de fichiers, pas en 7 jours / 4 semaines / 12 mois. | Moyenne | Pour Coco Nail's : choisir un dossier synchronisé avec Google Drive **et** garder un disque USB manuel. Revoir avant tout client. |
| 4 | **La surveillance prévue n'est pas complète.** Les sites ne sont pas testés depuis l'extérieur chaque minute (UptimeRobot non branché), les certificats et l'usure du disque ne sont pas suivis. Disque, mémoire, charge et température le sont. | Moyenne | À faire en phase 4, quand le serveur et le tunnel existeront. |
| 5 | **Le propriétaire est un compte unique et tout-puissant.** S'il perd son téléphone **et** ses codes de secours, seul l'outil de secours sur la machine permet de reprendre la main. | Faible | Imprimer les codes de secours, les ranger avec la phrase de sauvegarde. |
| 6 | **Le manuel PDF et les captures sont gardés dans l'historique Git** (53 Mo en 5 jours). | Faible | Garder le PDF hors de l'historique, ou le refaire rarement. |
| 7 | **L'écran de l'assistant est chargé même quand on ne s'en sert pas** (le panneau est toujours présent). | Faible | Sans effet visible aujourd'hui. |
| 8 | **Ce qui ne peut pas encore être affirmé** : compatibilité Safari/iPhone, accessibilité, résistance réelle aux coupures de courant, comportement avec les vrais services Google, OVH et SumUp. | — | Essais réels, étape par étape, avec votre accord. |

**Ce qui a été vérifié et va bien** : les droits par rôle sont centralisés et appliqués partout. Le code exécuté sur le serveur est réservé au propriétaire. Les valeurs des secrets ne sortent jamais vers l'écran. Une personne d'un site ne voit rien des autres sites (ni activités, ni alertes, ni propositions de l'IA). Aucune dépense d'IA n'est possible par défaut (plafond 0 €).

---

## Partie 5 — Récapitulatif de tout ce qui a été retenu

### 5.1 Le projet
- **But** : remplacer, pour vos sites, Pages CMS (contenus), GitHub (code et historique) et Netlify (hébergement, publication, fonctions, tâches). Le tout sur un petit serveur à la maison.
- **Premier site** : Coco Nail's (coconails72.com), qui doit continuer à fonctionner sans interruption.
- **Plus tard, peut-être** : une activité professionnelle (sites de clients). Rien de commercial n'est développé maintenant.
- **Principes** : simplicité, fiabilité, sécurité, autonomie, réversibilité, tests réels, **rien sans votre autorisation**.

### 5.2 Vos règles de travail (toujours en vigueur)
1. Quand vous annoncez une liste d'instructions, rien n'est modifié avant votre « procède ».
2. Vous ne communiquez jamais de mots de passe, clés ou secrets : vous les saisissez vous-même.
3. Ne jamais prétendre avoir testé ce qui ne l'a pas été, ni inventer un résultat.
4. Ne pas toucher au design, aux couleurs ni au logo sans demande.
5. Aucun service réel pendant les tests sans autorisation. Aucune vraie réservation, aucun paiement, facture, SMS ou e-mail.
6. Ne pas interrompre Coco Nail's. Ne rien déployer sans validation.
7. Éviter les dépendances inutiles. Ne pas toucher aux réservations, paiements, factures, SMS ni aux données des clientes.
8. Le dépôt de Coco Nail's n'est jamais modifié. Le travail se fait sur la branche de travail.
9. Le manuel PDF n'est refait qu'à la demande.

### 5.3 Les grandes décisions techniques (cahier des charges)

| # | Décision |
|---|---|
| D1 | Chaque fichier a un seul « mode » propriétaire (contenus, visuel, code) ; anti-écrasement |
| D2, D16 | Interface React + Mantine |
| D4 | Pages en HTML ordinaire, exportables sans PAGINITY |
| D5, D24 | Fonctions isolées dans Podman sans droits administrateur ; à défaut, processus restreint |
| D6, D7 | Comptes sur invitation ; rôles : propriétaire, administrateur de site, éditeur, contributeur |
| D9 | Médias dans Git, compressés (2 560 px, 2 Mo), sans position GPS |
| D10, D11 | Un brouillon commun par site ; aperçu sans actions réelles (secrets de test seulement) |
| D12 | Domaine séparé pour les aperçus (≈ 10–15 €/an, à acheter) |
| D13 | Double authentification obligatoire (codes, passkeys, codes de secours) |
| D14, D15 | Accès distant par Cloudflare Tunnel ; accès local de secours |
| D19 | Éditeur de contenus propre, compatible `.pages.yml` |
| D20, D21 | Base SQLite intégrée à Node.js ; mots de passe Argon2id |
| D22 | Pas de vidéos hébergées (YouTube, Vimeo…) |
| D23 | Formulaires Netlify remplacés par un module PAGINITY, sans modifier les sites |
| D25 | Tâches planifiées : pas de relance automatique, désactivées pour un site importé |
| D26 | E-mails par SMTP (Google Workspace, mot de passe d'application) |

### 5.4 Ce qui a été construit (dans l'ordre)

| Date | Étape |
|---|---|
| 15/11 | **Phase 1** : cahier des charges. **Phase 2** : prototype (comptes, sites, contenus, médias, code, aperçu, publication en 10 étapes, versions). Interface |
| 15/11 | **Phase 3** : fonctions serveur isolées (imitation de Netlify v2), secrets, formulaires, planificateur, alertes. Import de Coco Nail's avec ses 8 fonctions. Manuel illustré |
| 15/11 | Corrections de sécurité : liens symboliques, coupures, export/réimport, aperçus sans effet réel, blocage de connexion, outils de secours et de mise à jour |
| 16/11 | Sauvegarde et restauration, changement de clé du coffre, cloisonnement, passkeys testées, préparation de l'installation (phase 4) |
| 16–17/11 | **Assistant IA** : modèle local / Claude / ChatGPT avec plafonds de dépense (0 € par défaut), panneau permanent, plusieurs modèles, salle de réunion, banc d'essai, questions de précision, annulation, dictée, pages et styles avec avant/après, diagnostic |
| 17/11 | **Continuité** : sauvegarde automatique chiffrée, essai de restauration mensuel, alerte de panne, page de secours. Installateurs Windows/Mac. **Confort** : notifications téléphone, aperçu téléphone, visites sans cookies, failles des composants |
| 17/11 | **Référencement** : M1 audit local (25 règles), M2 Search Console en lecture seule, IndexNow facultatif |
| 17/11 | Diagnostic approfondi et corrections : sauvegarde non bloquante, notifications filtrées, heure de Paris, limites de fréquence, outils mis à jour, assistant découpé |
| 18–20/11 | **Nouveau logo** : « P A G [bouclier] I N I T Y » centré, bouclier et P animés, orbite « Saturne » sur les pages d'accès, nouvelles icônes et nouvelle couverture du manuel |

### 5.5 Études remises (en attente de vos décisions)
- **Diagnostic approfondi** (17/11) : corrections faites, sauf les essais réels.
- **Étude SEO / GEO / Sorank** (20/11) : plan en 4 priorités. Rien n'est lancé, **j'attends votre « procède »**, avec 7 décisions à prendre (section 16 de l'étude).

### 5.6 Ce qui reste à faire, dans l'ordre conseillé

| # | Action | Qui |
|---|---|---|
| 1 | Répondre : avez-vous le Raspberry Pi ou faut-il acheter un mini-PC ? Quelle box internet ? | Vous |
| 2 | **Essais réels sur votre ordinateur** : installation guidée, un vrai modèle d'IA local, une notification sur votre téléphone (il me faut savoir si votre ordinateur est sous Windows ou Mac) | Vous + moi |
| 3 | Comptes **de test** : agenda Google de test, copie de la feuille de compta, OVH/SumUp en mode test ; mot de passe d'application Google | Vous |
| 4 | **Phase 4** : installation sur le serveur définitif, Cloudflare Tunnel, domaine d'aperçu, sauvegarde réelle et **restauration complète réussie** | Vous + moi |
| 5 | Vérifications juridiques : mentions légales de l'hébergeur (adresse personnelle), restrictions IP des clés OVH | Vous |
| 6 | **Phase 5** : Coco Nail's en parallèle 1 à 2 semaines, DNS déplacé seul, bascule, Netlify gardé en secours | Vous + moi, avec accord à chaque étape |
| 7 | Référencement priorité 1 (si « procède ») | Moi |
| 8 | Plus tard (phase 6) : éditeur visuel par blocs, publication programmée, invitations par e-mail, statistiques détaillées (M3) | Selon vos choix |

*Côté Coco Nail's (hors PAGINITY), il reste aussi : le double SIREN à régulariser, l'expéditeur SMS OVH, les mentions légales, la fiche Google Business, l'assurance, la double authentification sur tous les comptes.*
