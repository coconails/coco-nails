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
- Rappels clientes (15/11/2026) : `netlify/functions/rappels.mjs` planifiée chaque jour 9 h UTC — rappel la veille (service, SMS sans STOP)
  et « prochain soin » (publicité, uniquement si accord, SMS avec STOP géré par OVH, jamais dimanche/férié, 1 relance à +21 j,
  rien si un autre RDV existe). SMS via OVHcloud (`netlify/lib/sms.mjs`, API signée, textes ramenés au jeu GSM ≤160 car.),
  sinon e-mail. Accords : 2 cases sur le formulaire de réservation (veille cochée, prochain soin décochée, stockées dans
  extendedProperties.private ok_veille/ok_prochain/accord_le), cases dans la compta pour les RDV téléphone/message, fiche
  « Mes clientes ». Onglets Sheets « Clientes » (choix + preuve : par qui, quand ; STOP) et « Rappels envoyés ».
  Lien signé « Gérer mes messages » : `netlify/functions/desinscription.mjs` (`/api/desinscription`). Délai par soin :
  champ Pages CMS `rappel_jours` (sinon N semaines → 7N−3 jours, dépose → aucun, autre → 21). Adresse courte `/rdv`.
  Vocabulaire : côté clientes « pause beauté » (SMS, e-mails, case du formulaire), titre du site « La carte beauté »
  (sous-titre « Soins des ongles & tarifs » pour Google) ; côté compta et Pages CMS on garde « soin ».
- Fermetures depuis Google Agenda : événement « Toute la journée » dont le titre contient Fermé / Fermeture / Vacances / Congés /
  Formation (accents et majuscules indifférents, même réglé « Disponible ») → jours fermés sur le site (`fermetureAgenda` dans
  agenda.mjs, renvoyés par `/api/disponibilites` sans les titres, refusés par `/api/reserver`). Sans publication.
  Les « Fermetures exceptionnelles » de Pages CMS restent possibles (elles coûtent une publication).
- SEO (15/11/2026) : commande de build Netlify `node netlify/preparer-page.mjs` qui écrit dans public/index.html, depuis
  public/contenu/*.json, la carte beauté, les options, la FAQ, les horaires, le téléphone et les cadres des photos d'accueil
  (le JS de la page vide puis réaffiche ces zones, les photos sont glissées dans les cadres), remplace le JSON-LD par un
  @graph NailSalon (téléphone, zone desservie = 16 communes du Val de Sarthe + Noyen, priceRange, OfferCatalog des soins)
  + FAQPage, et date le sitemap. En cas d'erreur, la page est laissée telle quelle. Titre « Prothésiste ongulaire à
  Saint-Jean-du-Bois (Sarthe) | Coco Nail's », phrase Val de Sarthe + accès/parking dans « Un espace rien que pour vous »,
  page `public/404.html`. Nom commercial : toujours « Coco Nail's » (pas « Coco Nails 72 »). Pas de texte caché, pas de llms.txt.
  Mesures locales Lighthouse mobile : CLS 0,158 → 0,002, performance 91-93 → 97-99, accessibilité 97 → 100.
- Comptoir iPad (18/11/2026) : `public/compta/comptoir/index.html` (adresse /compta/comptoir, même mot de passe et mêmes données que
  /compta via `/api/compta`). iPad Air 1 (A1475, iOS 12.5.7) : JavaScript ES5 uniquement, pas de `gap` en flexbox ni `inset`, pas d'images WebP (logo en PNG)
  (test automatique). 6 onglets de widgets (Aujourd'hui, Caisse, Rendez-vous, Semaine, Compta, Clientes), choix/ordre/taille
  enregistrés dans Réglages (clé `comptoir`), note `note_comptoir`, `objectif_mois`, `seuil_ca`. `vue.comptoir` = agenda 8 jours
  (RDV perso anonymes « Occupé »), fermetures, horaires, paiements SumUp du jour. Action `decider` (confirmer/refuser une demande,
  logique partagée avec rdv.mjs dans `netlify/lib/rendezvous.mjs`), origine de ligne « Sur place », GET `/api/compta?sumup=jour`
  (guet du paiement carte pendant l'encaissement). WhatsApp impossible sur l'iPad (iOS 15.5 requis) : QR code wa.me à scanner
  avec l'iPhone pro (`qrcode.js` MIT). Appels/SMS via « Appels sur d'autres appareils » / « Transfert de SMS ».
  Aperçu local : `node outils-de-test/serveur-comptoir.mjs` (mot de passe « demo », données d'exemple).
  SumUp : lecteur **Solo** choisi (autonome) ; plus tard, envoi du montant au Solo via la Cloud API (clé affiliée à créer).
- Variables Netlify : `GOOGLE_CLIENT_EMAIL`, `GOOGLE_CALENDAR_ID` (= contact@coconails72.com), `GOOGLE_PRIVATE_KEY` (secrète, ne jamais la demander ni l'afficher).
  Compta : `COMPTA_SHEET_ID` (identifiant du tableau), `COMPTA_MOT_DE_PASSE` (secret, choisi par l'utilisateur, ne jamais le demander).
  SumUp (relié le 15/11/2026) : `SUMUP_API_KEY` (clé SECRÈTE `sup_sk_…`, pas la clé publique `sup_pk_` ; ne jamais la demander),
  `SUMUP_MERCHANT_CODE` = M07DDC5B.
  SMS OVHcloud (100 crédits achetés le 14/11/2026) : `OVH_APPLICATION_KEY`, `OVH_APPLICATION_SECRET`, `OVH_CONSUMER_KEY` (secrètes),
  `OVH_SMS_SERVICE` (ex. sms-ab12345-1), `OVH_SMS_EXPEDITEUR` (« CocoNails » une fois validé chez OVH).
- Google : projet Cloud `coco-nails-514415`, compte de service `coconails@coco-nails-514415.iam.gserviceaccount.com`
  (ID client 116446334886747443278), API Calendar + Gmail activées (+ Sheets et Drive à activer pour la compta), délégation domaine scopes `gmail.send`
  (+ `drive.file` à ajouter pour les tickets).
- Domaine chez Squarespace (via Google Workspace) : A @ 75.2.60.5, CNAME www → silly-kataifi-f31ee1.netlify.app,
  MX/SPF/DKIM/DMARC Google à ne jamais toucher. Search Console validé, sitemap envoyé, site indexé.

## Comment livrer une modification
Claude travaille directement dans le dépôt `coconails/coco-nails1` et pousse sur `main` (Netlify republie).
**Règle (incident du 16/11/2026)** : ne jamais livrer des fichiers construits depuis une ancienne copie (zip, dossier local, autre conversation).
Toujours partir de la dernière version de `main` (git pull), car Coralie modifie les contenus via Pages CMS. Le 16/11, un envoi
de `messages.mjs` et `index.html` du 13/11 a cassé tous les déploiements (exports rappelUrssaf/factureCliente manquants) ;
corrigé en restaurant ces fichiers (commit e247b6a). L'utilisateur n'envoie plus de fichiers de code à la main.
GitHub web ignore souvent les fichiers commençant par un point (.pages.yml) : les modifier dans l'éditeur GitHub.
Toujours tester localement avant (Google simulé) et montrer un aperçu avant de livrer.

## Reste à faire
- SIRET de Coco Nail's : SIREN 132 514 431 (création validée par l'INSEE le 05/11/2026), SIRET pas encore publié
  (avis de situation introuvable au 14/11). Ne jamais inventer le SIRET ; l'attendre avant les factures, SumUp et le médiateur.
- OVHcloud SMS (compte sms-fe253701-1) : expéditeur « CocoNails » demandé le 14/11/2026 (en attente de validation), clés API
  recréées (droits GET/POST /sms/*), à mettre dans Netlify avec les 5 variables OVH_* après validation, puis 1 Trigger deploy.
- Mentions légales (Pages CMS > Informations légales) : SIRET (en attente CMA), médiateur CM2C (adhésion à faire),
  TVA = « TVA non applicable, article 293 B du CGI ».
- Fiche Google Business en cours de validation : horaires détaillés, adresse visible, logo, photos, lien d'avis à coller
  dans Pages CMS > Horaires et coordonnées. Vérifier qu'il n'existe pas de fiche en double.
- Assurance (avenant habitation), bio Instagram, double authentification sur tous les comptes.

- En attente (décision de l'utilisateur) : rubrique « Avis clientes » (quand ~5 avis) et e-mail de demande d'avis le lendemain.
- Compta, idées restantes : argent à mettre de côté, alerte des seuils, sauvegarde, demande d'avis Google, tableau de bord,
  export annuel, avoirs, bons cadeaux, fidélité, compteur de visites sans cookies.
- Netlify gratuit (300 crédits/mois, 15 par publication) ; badge « Powered by Netlify » non désactivable gratuitement
  (boutons flottants du site remontés au-dessus). Brevo écarté (SMS réservés aux forfaits payants) → OVHcloud.
- SumUp : compte créé et relié à la compta (15/11/2026) ; lecteur choisi : SumUp Solo (autonome, l'appli SumUp exige iPadOS 16).
  Workspace payé au mois, pas de Freebox. Netlify : formule Personal prise en novembre 2026 pour finir les publications,
  retour possible à la formule gratuite ensuite (penser à le faire avant le renouvellement).

## Horaires actuels
Lun, mar, jeu, ven 9 h–19 h · mer, sam 9 h–12 h · dim fermé. Tél. 07 68 22 70 15 (WhatsApp actif), fixe 02 43 92 62 54
(champ facultatif `coordonnees.telephone_fixe` : rubrique Contact « Portable » / « Téléphone fixe », mentions légales, e-mails clientes).
