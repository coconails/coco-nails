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
- Compta privée (étape 1, livrée le 13/11/2026) : page `public/compta/index.html` (mot de passe), API `netlify/functions/compta.mjs`
  (`/api/compta`), facture PDF `facture.mjs` (`/api/facture?n=&s=`, lien signé), rappel URSSAF planifié `rappel-urssaf.mjs`
  (tous les jours 7 h UTC : le 5 du mois + 5 jours avant l'échéance). Logique dans `netlify/lib/compta.mjs` (tableau Google Sheets
  privé, onglets Rendez-vous / Factures / Déclarations URSSAF / Réglages, créés automatiquement), PDF dans `netlify/lib/facture.mjs`
  (dépendance `pdf-lib` 1.17.1). Les RDV confirmés de l'agenda (extendedProperties.private.id, sans « À confirmer ») sont importés
  à l'ouverture de la page. Facture créée seulement à la validation, numéros F2026-001… sans trou, contenu figé en JSON.
- Compta étape 2 (14/11/2026) : onglet Dépenses (onglets Sheets « Dépenses » et « Abonnements » ; échéances d'abonnement
  créées « À valider » via une référence `abo:<id>:<AAAA-MM>` ; bilan recettes − dépenses), tickets archivés dans le Drive de
  Coralie (`netlify/lib/drive.mjs`, délégation `drive.file` au nom de contact@, dossier « Comptabilité Coco Nail's — Justificatifs »
  puis un dossier par année, empreinte SHA-256 notée), SumUp en lecture seule (`netlify/lib/sumup.mjs`, API
  `/v2.1/merchants/{code}/transactions/history` + `/v1.0/merchants/{code}/payouts` ; rapprochement automatique à la validation
  carte, colonne « Réf. SumUp » ; commission du mois écoulé ajoutée aux dépenses, réf. `sumup:<AAAA-MM>`).
  Test : `node outils-de-test/test-compta.mjs` (Google, Drive et SumUp simulés).
  Installable comme application (manifest `public/compta/manifest.webmanifest`, icônes 180/192/512 + masquable).
- Variables Netlify : `GOOGLE_CLIENT_EMAIL`, `GOOGLE_CALENDAR_ID` (= contact@coconails72.com), `GOOGLE_PRIVATE_KEY` (secrète, ne jamais la demander ni l'afficher).
  Compta : `COMPTA_SHEET_ID` (identifiant du tableau), `COMPTA_MOT_DE_PASSE` (secret, choisi par l'utilisateur, ne jamais le demander).
  SumUp (quand le compte existera) : `SUMUP_API_KEY` (secrète, ne jamais la demander), `SUMUP_MERCHANT_CODE` facultatif.
- Google : projet Cloud `coco-nails-514415`, compte de service `coconails@coco-nails-514415.iam.gserviceaccount.com`
  (ID client 116446334886747443278), API Calendar + Gmail activées (+ Sheets et Drive à activer pour la compta), délégation domaine scopes `gmail.send`
  (+ `drive.file` à ajouter pour les tickets).
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

- Compta, idées restantes : argent à mettre de côté, alerte des seuils, sauvegarde, rappel la veille aux clientes, demande d'avis
  Google, tableau de bord, export annuel, avoirs, bons cadeaux, fidélité.
- SumUp : compte pas encore créé ; lecteur conseillé Solo Lite (sans abonnement, 1,75 %). Workspace payé au mois, pas de Freebox.

## Horaires actuels
Lun, mar, jeu, ven 9 h–19 h · mer, sam 9 h–12 h · dim fermé. Tél. 07 68 22 70 15 (WhatsApp actif).
