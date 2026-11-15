# Architecture du programme — « Atelier »

> Plateforme personnelle d'hébergement et de gestion de sites, installée sur un Raspberry Pi.
> Elle remplace dans une seule interface : **Pages CMS** (modifier les contenus), **GitHub** (garder le code et son
> historique) et **Netlify** (mettre en ligne, faire tourner les fonctions serveur et les tâches planifiées).
>
> Ce document décrit **uniquement l'architecture** : de quoi le programme est fait, comment les morceaux se parlent,
> où sont rangées les données. **Aucune ligne de programme n'est écrite à ce stade.**
> Le nom « Atelier » est provisoire.

---

## 1. L'idée en une image

Imaginez une boutique avec **une seule porte d'entrée** (le tunnel Cloudflare), **un accueil** qui dirige chaque
visiteur vers le bon rayon (l'aiguilleur), **des rayons** (un par site), **un bureau fermé à clé** pour vous (l'interface
d'administration), et **un coffre** rangé chaque nuit dans un autre bâtiment (la sauvegarde hors du Pi).

```
                         INTERNET
     visiteurs de coconails.fr        vous, sur atelier.mondomaine.fr
                │                                   │
                ▼                                   ▼
   ┌────────────────────────────────────────────────────────────┐
   │  CLOUDFLARE (gratuit)                                      │
   │  • HTTPS automatique (le cadenas)                          │
   │  • protection anti-attaques                                │
   │  • « Cloudflare Access » : 1er verrou devant l'admin       │
   └───────────────────────────┬────────────────────────────────┘
                               │ tunnel chiffré, sortant
                               │ (la box n'est pas ouverte)
═══════════════════════════════╪══════════════ RASPBERRY PI 5 ═══════
                               ▼
                     ┌───────────────────┐
                     │   cloudflared     │  (le bout du tunnel côté Pi)
                     └─────────┬─────────┘
                               ▼
   ┌────────────────────────────────────────────────────────────┐
   │  ATELIER — programme principal (Node.js, 1 seul service)   │
   │                                                            │
   │  ┌──────────────┐  « quel site est demandé ? »             │
   │  │  AIGUILLEUR  │──────────────┬───────────────┐           │
   │  └──────────────┘              │               │           │
   │         │                      ▼               ▼           │
   │         │              pages & images    /api/... ou       │
   │         │              (fichiers déjà    /.netlify/...     │
   │         │               prêts)                 │           │
   │         ▼                                      │           │
   │  ┌──────────────────────────────┐              │           │
   │  │ INTERFACE D'ADMINISTRATION   │              │           │
   │  │ tableau de bord, contenus,   │              │           │
   │  │ publication, santé, réglages │              │           │
   │  └──────────────┬───────────────┘              │           │
   │                 ▼                              │           │
   │  ┌───────────┐ ┌────────────┐ ┌────────────┐   │           │
   │  │ CONTENUS  │ │PUBLICATION │ │PLANIFICA-  │   │           │
   │  │ (le CMS)  │ │ + historique│ │TEUR (cron) │   │           │
   │  └───────────┘ └────────────┘ └─────┬──────┘   │           │
   │  ┌───────────┐ ┌────────────┐       │          │           │
   │  │ SECRETS   │ │SURVEILLANCE│       │          │           │
   │  │ (coffre)  │ │+ SAUVEGARDE│       │          │           │
   │  └───────────┘ └────────────┘       │          │           │
   └─────────────────────────────────────┼──────────┼───────────┘
                                         ▼          ▼
   ┌────────────────────────────────────────────────────────────┐
   │  EXÉCUTEURS DE FONCTIONS — 1 processus séparé PAR SITE     │
   │  ┌──────────────────┐  ┌──────────────────┐                │
   │  │ Coco Nail's      │  │ futur site B     │  …             │
   │  │ réservation,     │  │ formulaire de    │                │
   │  │ factures, SMS…   │  │ contact          │                │
   │  └────────┬─────────┘  └──────────────────┘                │
   └───────────┼────────────────────────────────────────────────┘
               ▼
     Services extérieurs inchangés : Google (Agenda, Gmail, Sheets,
     Drive), SumUp, OVHcloud SMS
═════════════════════════════════════════════════════════════════════
        │  chaque nuit, copie chiffrée
        ▼
   SAUVEGARDES HORS DU PI : Google Drive (chiffré) + miroir GitHub privé
```

**Ce qu'il faut retenir :**
- Il n'y a que **deux programmes** qui tournent en permanence : `cloudflared` (le tunnel) et **Atelier**.
  Les exécuteurs de fonctions sont lancés et surveillés par Atelier lui-même.
- La box internet n'a **aucun port ouvert** : c'est le Pi qui appelle Cloudflare, jamais l'inverse.
- Chaque site a ses fonctions dans **son propre processus** : si une fonction de Coco Nail's plante, les autres sites
  et l'interface d'administration continuent de fonctionner.

---

## 2. Les briques du programme Atelier

Atelier est **un seul programme** découpé en **modules** bien séparés (comme les pièces d'une maison). Chaque module a
un rôle unique et une « porte » claire pour parler aux autres. On peut donc en améliorer un sans casser les autres.

| # | Module | Rôle, en clair | Remplace |
|---|--------|----------------|----------|
| 1 | **Noyau** | Lit la configuration, tient le journal (« ce qui s'est passé »), gère la petite base de données interne. Tous les autres modules s'appuient dessus. | — |
| 2 | **Aiguilleur** (serveur web) | Reçoit chaque visite, regarde le nom de domaine demandé et l'envoie au bon site. Sert les pages et images, ou transmet à l'exécuteur de fonctions. Applique les redirections et en-têtes de chaque site. | Netlify (hébergement) |
| 3 | **Comptes & sécurité** | Connexion à l'admin : mot de passe + code à 6 chiffres (double authentification). Limite les tentatives, ferme la session après inactivité. | — |
| 4 | **Interface d'administration** | Les écrans que vous voyez (§ 6). | Interfaces Netlify, GitHub, Pages CMS |
| 5 | **Contenus** (le CMS) | Lit le « schéma de contenu » de chaque site et fabrique automatiquement les formulaires. Vérifie les saisies (un prix est un nombre, etc.). Gère les photos (redimensionnement, compression). | Pages CMS |
| 6 | **Publication & historique** | Enregistre chaque modification comme une version, prépare le site (« build »), le met en ligne d'un coup, et permet de revenir en arrière en un clic. | GitHub + Netlify (déploiements) |
| 7 | **Exécuteur de fonctions** | Fait tourner le code serveur de chaque site (réservation, PDF, e-mails…). Imite le format des fonctions Netlify pour ne pas réécrire Coco Nail's. | Netlify Functions |
| 8 | **Planificateur** | Lance les tâches à heure fixe (rappels clientes, rappel URSSAF…), garde la trace de chaque exécution, rattrape une tâche manquée après une coupure. | Netlify Scheduled Functions |
| 9 | **Coffre à secrets** | Range les clés et mots de passe des sites **chiffrés**. Vous les saisissez vous-même dans l'interface ; ils ne sont jamais réaffichés en clair, jamais écrits dans l'historique, jamais sauvegardés en clair. | Variables d'environnement Netlify |
| 10 | **Surveillance & alertes** | Voyant par site (vert/orange/rouge), espace disque, température du Pi, erreurs récentes, dernières sauvegardes, mises à jour disponibles. Envoie un e-mail en cas de problème. | — |
| 11 | **Sauvegarde** | Chaque nuit : copie chiffrée hors du Pi, vérification, nettoyage des vieilles copies. Procédure de restauration testée. | — |
| 12 | **Catalogue de modèles & modules** | Les « modèles de départ » pour créer un site et les « modules » activables (réservation, compta, rappels, formulaire de contact…). | — |
| 13 | *(plus tard)* **Statistiques** | Compte les visites **sans cookies** (aucune donnée personnelle conservée). | — |

### Qui parle à qui

```
  Interface d'admin ──► Contenus ──► Publication ──► Aiguilleur (bascule vers la nouvelle version)
          │                              │
          │                              └──► Exécuteur (redémarre les fonctions du site si le code a changé)
          ├──► Coffre à secrets ─────────────► Exécuteur (donne les secrets au démarrage, en mémoire seulement)
          ├──► Planificateur ────────────────► Exécuteur (« lance la tâche rappels de 9 h »)
          └──► Surveillance ◄──── tous les modules envoient leurs événements au journal (Noyau)
```

Règle importante : **l'interface d'administration ne touche jamais directement aux fichiers des sites.** Elle passe
toujours par les modules Contenus et Publication. C'est ce qui garantit que chaque changement est enregistré dans
l'historique et peut être annulé.

---

## 3. Comment un site est rangé sur le disque

Tout est rangé sur le **disque SSD**, dans un seul dossier. Un site = un dossier, toujours organisé pareil.

```
/srv/atelier/
├── atelier/                    ← le programme Atelier lui-même
├── donnees/
│   ├── atelier.db              ← petite base interne (comptes, liste des sites, journal,
│   │                             historique des tâches planifiées, état des sauvegardes)
│   ├── cle-maitre              ← clé qui ouvre le coffre (lisible par Atelier seulement)
│   └── secrets/                ← un fichier chiffré par site
│       └── coco-nails.chiffre
└── sites/
    └── coco-nails/
        ├── depot/              ← le « dépôt » : code + contenus + tout l'historique
        │   ├── atelier.yml     ← la fiche du site (voir ci-dessous)
        │   ├── .pages.yml      ← schéma de contenu (format Pages CMS conservé tel quel)
        │   ├── public/         ← page HTML, contenus JSON, images
        │   └── netlify/        ← fonctions, bibliothèques, étape de préparation (inchangés)
        ├── versions/           ← les versions prêtes à servir
        │   ├── 2026-11-15_1402/
        │   ├── 2026-11-15_1630/
        │   └── en-ligne  →  2026-11-15_1630     (un simple « panneau indicateur »)
        ├── apercu/             ← la version brouillon, visible seulement par vous
        ├── donnees-privees/    ← fichiers que les fonctions ont le droit d'écrire
        └── journaux/           ← erreurs et événements de ce site
```

### La fiche du site (`atelier.yml`)

Un petit fichier texte, lisible par un humain, qui dit tout ce qu'Atelier doit savoir sur le site. Exemple de contenu
(c'est une **description**, pas du programme) :

```yaml
nom: Coco Nail's
domaines: [coconails.fr, www.coconails.fr]
dossier_publie: public
preparation: netlify/preparer-page.mjs      # étape lancée avant chaque mise en ligne
fonctions:
  dossier: netlify/functions
  format: netlify-v2                        # couche de compatibilité utilisée
modules: [reservation, compta, rappels-sms, factures, desinscription]
secrets_attendus:                           # les NOMS seulement, jamais les valeurs
  - GOOGLE_CLE_COMPTE_SERVICE
  - SUMUP_CLE
  - OVH_CLE
alertes: vous@exemple.fr                     # où envoyer les alertes de ce site
```

Si la fiche manque (cas d'un site Netlify importé tel quel), Atelier sait lire le fichier `netlify.toml` existant pour
la deviner, puis vous propose de l'enregistrer.

---

## 4. Les trois parcours principaux

### 4.1 Modifier un contenu, voir l'aperçu, publier

```
 Vous changez un prix          Atelier                           Visiteurs
 ─────────────────────         ──────────────────────────        ──────────
 1. ouvre « Tarifs »     ──►  lit .pages.yml, affiche le
                              formulaire pré-rempli
 2. tape 45 € au lieu    ──►  vérifie (c'est bien un nombre)
    de 40 €                   enregistre en BROUILLON
 3. clique « Aperçu »    ──►  prépare une copie dans apercu/
                              → lien privé pour la voir
 4. clique « Publier »   ──►  a) enregistre une version dans
                                 l'historique (« Tarifs : pose
                                 gel 40 → 45 € », date, auteur)
                              b) lance l'étape de préparation
                                 (preparer-page.mjs)
                              c) range le résultat dans
                                 versions/2026-11-15_1630/
                              d) vérifie que la page s'ouvre
                              e) déplace le panneau « en-ligne » ──►  voient la nouvelle
                                                                      version, sans coupure
```

- **Instantané et sans limite** : pas de crédits, pas de file d'attente chez un prestataire.
- **Sans coupure** : la nouvelle version est entièrement prête avant que le panneau « en-ligne » bascule. Si la
  préparation échoue (étape c ou d), rien ne change pour les visiteurs et vous voyez le message d'erreur.
- **Retour arrière** : « Revenir à la version précédente » = déplacer le panneau vers l'ancienne version (1 seconde).
  On garde les 20 dernières versions prêtes à servir ; les plus anciennes restent dans l'historique et peuvent être
  reconstruites.

### 4.2 Une visiteuse réserve un rendez-vous

```
 navigateur ──► Cloudflare ──► tunnel ──► Aiguilleur
                                            │ « coconails.fr/api/reserver » → fonction
                                            ▼
                                   Exécuteur Coco Nail's
                                   (processus à part, secrets en mémoire)
                                            │
                                            ├─► Google Agenda (créneau)
                                            ├─► Gmail (confirmation)
                                            └─► réponse à la visiteuse
```

L'aiguilleur coupe la demande si la fonction met trop longtemps (par exemple 30 s) et l'inscrit dans les erreurs du
site, pour qu'une fonction bloquée ne fige pas tout.

### 4.3 Une tâche planifiée (rappels de la veille)

Le **planificateur** connaît l'horaire de chaque tâche (lu dans le code des fonctions, comme Netlify, ou réglé dans
l'interface). À l'heure dite, il demande à l'exécuteur du site de lancer la tâche, puis note : heure de début, durée,
succès ou échec. En cas d'échec : nouvel essai, puis alerte e-mail. Si le Pi était éteint à l'heure prévue (coupure de
courant), la tâche est **rattrapée** au redémarrage quand c'est sans danger (une case « rattraper si manquée » par
tâche, pour éviter par exemple d'envoyer des rappels SMS en pleine nuit).

---

## 5. La couche de compatibilité Netlify (pour ne pas réécrire Coco Nail's)

Le site Coco Nail's utilise les **fonctions Netlify « 2.0 »** : chaque fichier reçoit une demande et renvoie une
réponse, avec un petit bloc de réglages (adresse, horaire). Ce format repose sur des standards du web que Node.js
comprend déjà nativement. L'exécuteur d'Atelier fournit donc **les mêmes « prises »** que Netlify :

| Ce que la fonction attend de Netlify | Ce qu'Atelier fournit |
|---|---|
| Être appelée sur `/.netlify/functions/nom` ou sur l'adresse déclarée dans ses réglages | L'aiguilleur fait la même correspondance |
| Recevoir la demande et un « contexte » (adresse IP, cookies, paramètres d'adresse…) | Un contexte équivalent, construit par l'exécuteur |
| Lire ses secrets (`Netlify.env.get(...)` ou `process.env`) | Les deux, alimentés par le coffre, en mémoire |
| Un horaire `schedule` pour les tâches planifiées | Lu et confié au planificateur |
| Les bibliothèques partagées (`netlify/lib/`) et les dépendances (`pdf-lib`, Google…) | Installées une fois par site, à la publication |
| L'étape de préparation (`preparer-page.mjs`) | Lancée à chaque publication, comme un « build » |
| Les redirections et en-têtes (`netlify.toml`, `_redirects`, `_headers`) | Les cas courants sont gérés par l'aiguilleur |

Ce qui **ne sera pas** imité (non utilisé par le site, à confirmer lors de l'inventaire en phase 3) : les
« Edge Functions », les « Blobs » Netlify, Netlify Identity, les formulaires Netlify. Si l'inventaire montre que l'un
d'eux sert, on l'ajoutera ou on adaptera le site au cas par cas.

Les futurs sites plus simples n'auront pas besoin de cette couche : un site de quelques pages sans fonctions se résume
à son dossier `public/` et à son schéma de contenu.

---

## 6. Les écrans de l'interface (maquettes textuelles)

**Tableau de bord**
```
┌ Atelier ───────────────────────────────────────────── [Santé ●] [Réglages] [Déconnexion] ┐
│  Mes sites                                                    [ + Ajouter un site ]       │
│  ● Coco Nail's      coconails.fr     publié il y a 2 h    [Contenus] [Versions] [Plus ▾] │
│  ● Site B           siteb.fr         publié il y a 3 j    [Contenus] [Versions] [Plus ▾] │
│                                                                                           │
│  Santé du système :  Disque 18 % ●   Sauvegarde cette nuit 03:12 ●   Erreurs 24 h : 0 ●   │
│                      Mises à jour : 2 en attente (installées dimanche 04:00)              │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

**Contenus d'un site** — liste des rubriques issues du schéma (Accueil, Tarifs, Horaires, FAQ, Photos…), puis pour
chacune un formulaire simple. En bas : `[Enregistrer le brouillon]  [Aperçu]  [Publier]`, et un bandeau
« 3 modifications non publiées ».

**Versions** — liste chronologique : date, description automatique (« Tarifs modifiés »), qui, et un bouton
`[Revenir à cette version]` sur chaque ligne. La version en ligne est marquée d'une étiquette verte.

**Fonctions & tâches** — liste des fonctions du site avec leur nombre d'appels et d'erreurs sur 24 h, et des tâches
planifiées avec « prochaine exécution » / « dernière exécution : réussie à 09:00 », plus `[Lancer maintenant]`.

**Secrets** — uniquement les **noms** attendus, avec l'état « renseigné ✓ / manquant ✗ » et un bouton
`[Remplacer la valeur]`. La valeur n'est jamais réaffichée.

**Ajouter un site** — formulaire : nom, domaine, modèle de départ (vide / vitrine une page / copie d'un site existant /
import d'un dépôt GitHub), modules à cocher. À la fin, Atelier indique les réglages DNS à faire chez Squarespace.

**Santé** — détail des voyants, journal des erreurs filtrable par site, historique des sauvegardes avec la date du
dernier test de restauration, réglages des alertes e-mail.

---

## 7. Sécurité (intégrée à l'architecture)

| Risque | Ce que prévoit l'architecture |
|---|---|
| Quelqu'un tente d'entrer dans l'admin | **Deux verrous** : Cloudflare Access (vérification de votre e-mail Google avant même d'atteindre le Pi, gratuit) **puis** la connexion Atelier avec double authentification. Tentatives limitées. |
| Une fonction d'un site est piratée ou boguée | Elle tourne dans **son processus**, sous un **utilisateur système dédié** sans droits sur les autres sites, sur l'admin ou sur le coffre. Elle ne voit que ses propres secrets. |
| Vol de secrets | Coffre chiffré ; la clé maître n'est lisible que par Atelier ; les secrets ne sont jamais dans l'historique, les journaux ou les sauvegardes en clair. |
| Fuite de données privées (compta, clientes) | Seul `public/` de la version en ligne est servi. Tout le reste (dépôt, `donnees-privees/`, journaux) est inaccessible depuis internet par construction. Les données clientes restent dans Google Sheets / Drive comme aujourd'hui. |
| Failles du système | Mises à jour de sécurité automatiques (fenêtre de nuit fixe), pare-feu qui refuse toute connexion entrante, connexion à distance au Pi uniquement par clé et via le réseau local ou un accès Cloudflare. |
| Erreur de manipulation | Tout passe par l'historique : on peut toujours revenir en arrière. |

---

## 8. Sauvegardes et reprise après panne

**Ce qui est sauvegardé chaque nuit :** les dépôts de tous les sites (avec leur historique), la base interne, le
coffre **chiffré**, les `donnees-privees/`. Pas besoin de sauvegarder `versions/` : elles se reconstruisent.

**Où :** deux endroits indépendants hors du Pi.
1. **Google Drive** (déjà inclus dans Google Workspace) : archive chiffrée avant envoi — Google ne peut pas la lire.
2. **Miroir GitHub privé** : copie des dépôts des sites (code et contenus, jamais les secrets).

**Garder la clé :** la clé de chiffrement des sauvegardes est la seule chose à conserver vous-même, hors du Pi (papier
dans un tiroir + gestionnaire de mots de passe). Sans elle, les sauvegardes sont illisibles — y compris pour vous.

**Reprise :** une procédure écrite « Pi neuf → tout remarche » (installer le système, installer Atelier, donner la clé,
lancer la restauration). Elle sera testée réellement avant la bascule, puis rejouée régulièrement ; la date du dernier
test s'affiche sur l'écran Santé.

**Pannes de courant / box :** l'onduleur laisse le temps au Pi de s'éteindre proprement ; au retour du courant tout
redémarre seul (Atelier, tunnel, exécuteurs) et le planificateur rattrape les tâches marquées comme rattrapables.
Pendant une coupure internet, les sites sont injoignables : c'est la limite principale de l'auto-hébergement (voir
question 6).

---

## 9. Choix des briques

### 9.1 Plateforme : faire maison ou utiliser un outil existant ?

| Option | Avantages | Inconvénients | Coût |
|---|---|---|---|
| **A. Atelier « maison » léger** (Node.js + quelques bibliothèques éprouvées) | Fait exactement ce qu'il faut ; interface en français, simple ; compatibilité Netlify sur mesure ; peu de mémoire ; un seul service à surveiller | C'est à nous de l'écrire et de le maintenir ; demande des tests sérieux | Gratuit |
| **B. Coolify ou CapRover** (hébergeurs « à la Netlify » auto-hébergés) | Publication, HTTPS, tâches déjà faits | Reposent sur Docker (plus lourd, plus de pièces) ; **aucun CMS** ; pas de format Netlify Functions ; interface technique en anglais ; il faudrait quand même ajouter un CMS par-dessus | Gratuit |
| **C. Assemblage d'outils** : Coolify + Decap CMS ou Directus + Gitea | Chaque brique est mûre | 3 ou 4 outils à installer, mettre à jour et faire dialoguer ; Directus stocke les contenus dans une base, pas dans les fichiers JSON du site (migration plus lourde) ; Decap a besoin d'un service Git à côté | Gratuit, mais maintenance élevée |

**Recommandation : A**, en **réutilisant des bibliothèques solides** plutôt qu'en réinventant :
- **Git** (le logiciel, le même que GitHub) pour l'historique des versions — fiable et éprouvé depuis 20 ans ;
- **SQLite** pour la petite base interne — un simple fichier, rien à administrer ;
- une bibliothèque standard pour la **double authentification** (codes à 6 chiffres compatibles Google Authenticator) ;
- **sharp** pour les photos ;
- le format **`.pages.yml`** de Pages CMS repris tel quel pour les schémas de contenu : vos schémas actuels
  fonctionnent sans modification.

C'est le choix qui respecte le mieux « le moins de composants possible » et « sans réécriture profonde ».

### 9.2 Où garder l'historique des versions ?

| Option | Avantages | Inconvénients |
|---|---|---|
| **A. Git directement sur le Pi** (sans interface GitHub) + miroir GitHub privé chaque nuit | Simple, rapide, hors ligne ; GitHub ne sert plus que de copie de secours | Pas d'interface « GitHub » sur le Pi (l'écran Versions d'Atelier la remplace) |
| B. Installer Gitea/Forgejo (un « GitHub » auto-hébergé) | Interface complète de code | Un service de plus à maintenir, pas nécessaire pour un non-développeur |
| C. Garder GitHub comme source principale | Rien à changer | Dépendance à internet pour publier ; ne remplace pas GitHub |

**Recommandation : A.**

### 9.3 Protéger l'accès à l'administration

| Option | Avantages | Inconvénients |
|---|---|---|
| **A. Cloudflare Access + connexion Atelier avec double authentification** | Deux verrous indépendants ; Access est gratuit jusqu'à 50 utilisateurs | Un réglage de plus chez Cloudflare |
| B. Connexion Atelier seule (mot de passe + code) | Plus simple | Le Pi reçoit directement les tentatives d'intrusion |
| C. Admin accessible seulement depuis la maison (réseau local / VPN) | Très sûr | Impossible de modifier le site depuis le téléphone à l'extérieur sans installer un VPN |

**Recommandation : A.**

### 9.4 Comment isoler les fonctions des sites ?

| Option | Avantages | Inconvénients |
|---|---|---|
| **A. Un processus Node.js par site, sous un utilisateur système dédié** | Léger, robuste, isolation suffisante pour des sites qui vous appartiennent | Moins cloisonné que des conteneurs |
| B. Un conteneur Docker par site | Cloisonnement fort | Docker à installer et maintenir, plus de mémoire et de complexité |
| C. Tout dans le même processus qu'Atelier | Le plus simple | Une fonction qui plante peut faire tomber l'admin et tous les sites |

**Recommandation : A.** (On pourra passer à B plus tard pour un site hébergé pour quelqu'un d'autre.)

### 9.5 Où envoyer les sauvegardes ?

| Option | Avantages | Inconvénients | Coût |
|---|---|---|---|
| **A. Google Drive (chiffré) + miroir GitHub privé** | Déjà payés / gratuits ; deux lieux indépendants | Dépend de Google pour la copie principale | 0 € en plus |
| B. Google Drive seul | Plus simple | Un seul lieu | 0 € |
| C. Stockage objet (Backblaze B2, etc.) | Conçu pour ça | Un compte et une facture de plus | ~1 €/mois |

**Recommandation : A.**

---

## 10. Évolutivité : modèles et modules

- Un **modèle de départ** = un dossier de site prêt à l'emploi (page, schéma de contenu, fiche `atelier.yml`).
  Coco Nail's deviendra lui-même un modèle (« salon avec réservation »).
- Un **module** = un ensemble cohérent : des fonctions + un morceau de schéma de contenu + la liste des secrets
  nécessaires + éventuellement une tâche planifiée. Exemples : `reservation`, `formulaire-contact`, `compta`,
  `rappels-sms`, `factures`. Cocher un module à la création d'un site copie ces éléments dans le site et ajoute les
  secrets attendus à l'écran Secrets.
- Ajouter un nouveau type de module ne demande pas de toucher au cœur d'Atelier.

---

## 11. Ressources du Raspberry Pi (ordre de grandeur estimé, à vérifier en phase 4)

| Élément | Mémoire estimée |
|---|---|
| Système + tunnel | ~400 Mo |
| Atelier | ~150 Mo |
| Exécuteur par site avec fonctions | ~80–150 Mo |
| Préparation d'une publication (ponctuelle) | ~300 Mo pendant quelques secondes |

Avec 8 Go, la marge permet largement une dizaine de sites. Ces chiffres sont des **estimations**, pas des mesures.

---

## 12. Questions à trancher avant de continuer

1. **Nom** de la plateforme et **adresse d'administration** exacte (ex. `atelier.coconails.fr` ?).
2. **Domaine** du site Coco Nail's et liste des sous-domaines utilisés aujourd'hui.
3. Est-ce que **vous seul(e)** utiliserez l'admin, ou faut-il prévoir plus tard un accès limité pour quelqu'un
   d'autre (ex. la gérante qui ne modifie que les horaires) ?
4. Les données des fonctions (réservations, compta) restent-elles **toutes dans Google Sheets / Drive**, ou certaines
   doivent-elles être stockées sur le Pi ?
5. Acceptez-vous **Cloudflare** comme intermédiaire (ce qui implique de faire gérer les DNS des domaines par Cloudflare
   tout en gardant l'enregistrement chez Squarespace) ?
6. En cas de **coupure internet à la maison**, une indisponibilité du site de quelques heures est-elle acceptable, ou
   faut-il une page de secours hébergée ailleurs (ex. Cloudflare Pages, gratuit) affichant « réservez par téléphone » ?
7. À quelle **adresse e-mail** envoyer les alertes, et à partir de quel compte Google les envoyer ?
8. Combien de **temps garder l'historique** des versions et des sauvegardes (proposition : tout l'historique Git,
   30 sauvegardes quotidiennes + 12 mensuelles) ?
9. Les fonctions Netlify utilisent-elles des fonctionnalités particulières (Netlify Blobs, Edge Functions, formulaires
   Netlify, Identity) ? Je le vérifierai dans le code lors de la phase 3 si vous me donnez accès au dépôt.
10. L'interface doit-elle être pensée d'abord pour **le téléphone** ou pour l'ordinateur ?

---

## 13. Ce que ce document n'est pas (encore)

Il décrit l'architecture. Les autres volets de la phase 1 — **plan de migration sans coupure, liste du matériel avec
prix, analyse détaillée des risques, planning par étapes testables** — feront l'objet de documents séparés quand vous
le demanderez.

**Rien n'a été programmé ni testé** : ce document est une proposition à valider ou à corriger.
