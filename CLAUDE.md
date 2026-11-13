# Coco Nail's — site coconails72.com

Site de Coralie Bellanger, prothésiste ongulaire auto-entrepreneuse (seule) à Saint-Jean-du-Bois (72430),
entre Noyen-sur-Sarthe et La Suze-sur-Sarthe. Elle reçoit dans un « espace beauté » aménagé (ne plus écrire « mobile-home »).
L'utilisateur (son compagnon) n'est pas développeur : expliquer en français simple, étape par étape.
Règle de travail : quand il annonce une liste d'instructions, ne rien modifier avant qu'il dise « procède ».

## Architecture (en ligne et fonctionnel au 13/11/2026)
- Dépôt GitHub privé `coconails/coco-nails1` (branche `main`) → Netlify (projet `silly-kataifi-f31ee1`), publication auto à chaque commit. Site PUBLIC (doit le rester : les fonctions relisent `/contenu/*.json` sur le site).
- `public/index.html` : page unique (HTML + CSS + JS inline). Les contenus viennent de `public/contenu/*.json`
  (soins, coordonnees, reservation, paiement, questions, photos, teintes, evenement, legal).
- `.pages.yml` : menus de l'espace de gestion Pages CMS (app.pagescms.org) qu'utilise Coralie. Indentation YAML stricte.
- `netlify/functions/` (Netlify Functions 2.0, ESM) :
  - `disponibilites.mjs` GET `/api/disponibilites?du=&au=` → plages occupées (freeBusy Google Agenda).
  - `reserver.mjs` POST `/api/reserver` → revérifie les règles + freeBusy, crée un événement jaune « À confirmer : … »
    (id choisi par le site, infos cliente en extendedProperties.private), envoie via Gmail un e-mail à Coralie
    (boutons Confirmer/Refuser) et un accusé à la cliente. Piège anti-robots : champ `bot-field`.
  - `rdv.mjs` GET/POST `/api/rdv?id=&a=confirmer|refuser&s=` → liens signés HMAC (clé dérivée de GOOGLE_PRIVATE_KEY).
    GET affiche un bouton (les messageries pré-ouvrent les liens), POST agit : confirmer = titre sans préfixe + couleur verte
    + e-mail de confirmation (.ics joint) ; refuser = suppression + e-mail invitant à rechoisir.
- `netlify/lib/agenda.mjs` (JWT compte de service, Agenda, Gmail via délégation `sub`, jours fériés, règles)
  et `netlify/lib/messages.mjs` (gabarits d'e-mails et pages).
- Variables Netlify : `GOOGLE_CLIENT_EMAIL`, `GOOGLE_CALENDAR_ID` (= contact@coconails72.com), `GOOGLE_PRIVATE_KEY` (secrète, ne jamais la demander ni l'afficher).
- Google : projet Cloud `coco-nails-514415`, compte de service `coconails@coco-nails-514415.iam.gserviceaccount.com`
  (ID client 116446334886747443278), API Calendar + Gmail activées, délégation domaine scope `gmail.send` uniquement.
- Domaine chez Squarespace (via Google Workspace) : A @ 75.2.60.5, CNAME www → silly-kataifi-f31ee1.netlify.app,
  MX/SPF/DKIM/DMARC Google à ne jamais toucher. Search Console validé, sitemap envoyé, site indexé.

## Comment livrer une modification
L'utilisateur envoie les fichiers sur GitHub par le navigateur (Add file > Upload files), Netlify republie.
GitHub web ignore souvent les fichiers commençant par un point (.pages.yml) : les modifier dans l'éditeur GitHub.
Toujours tester localement avant (Google simulé) et montrer un aperçu avant de livrer.

## Reste à faire
- Remplacer dans `public/index.html` la phrase « Coralie vous reçoit dans un mobile-home entièrement aménagé en espace beauté. »
  par « Coralie vous reçoit dans un espace beauté entièrement aménagé, calme et chaleureux. » (proposé, pas encore fait).
- Mentions légales (Pages CMS > Informations légales) : SIRET (en attente CMA), médiateur CM2C (adhésion à faire),
  TVA = « TVA non applicable, article 293 B du CGI ».
- Fiche Google Business en cours de validation : horaires détaillés, adresse visible, logo, photos, lien d'avis à coller
  dans Pages CMS > Horaires et coordonnées. Vérifier qu'il n'existe pas de fiche en double.
- Assurance (avenant habitation), bio Instagram, double authentification sur tous les comptes.

## Horaires actuels
Lun, mar, jeu, ven 9 h–19 h · mer, sam 9 h–12 h · dim fermé. Tél. 07 68 22 70 15 (WhatsApp actif).
