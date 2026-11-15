# PAGINITY — Cahier des charges (version 1.1, fin de phase 1)

> Plateforme personnelle de création, d'hébergement, de gestion et de publication de sites web.
> **Créer · Gérer · Publier · Suivre**
>
> Ce document regroupe toutes les décisions prises pendant la phase 1 (conception).
> Légende : ✅ décision confirmée · 🔵 choix recommandé, retenu par délégation · ⚪ question encore ouverte.
> Rien de ce qui est marqué « à vérifier » ne doit être considéré comme un fait établi.

---

## 1. Vision

PAGINITY est un **centre de contrôle unique**, installé sur un petit serveur à la maison (Raspberry Pi 5 ou mini-PC),
qui remplace les fonctions réellement utilisées de **Pages CMS** (contenus), **GitHub** (code et historique) et
**Netlify** (hébergement, publication, fonctions serveur, tâches planifiées).

Le projet est **personnel** aujourd'hui. Il est conçu pour pouvoir évoluer plus tard vers une activité
professionnelle (micro-entreprise : création, gestion et hébergement de sites clients), **sans développer
maintenant** la partie commerciale.

Principes : simplicité · fiabilité · sécurité · autonomie · compatibilité · modularité · transparence ·
réversibilité · validation par des tests réels · autorisation avant toute modification.

## 2. Décisions d'architecture

| # | Décision | Statut |
|---|---|---|
| D1 | Chaque fichier a **un seul mode propriétaire** (contenus, visuel, code) ; protection anti-écrasement par version de fichier ; indicateur « qui modifie quoi » | ✅ |
| D2 | Interface en **React** (TypeScript) | ✅ |
| D3 | Architecture **hybride** : interface et orchestration sur mesure, composants open source éprouvés pour le reste | ✅ |
| D4 | Les pages du mode visuel seront fabriquées en **HTML ordinaire**, exportables sans PAGINITY | ✅ |
| D5 | Fonctions serveur isolées dans des **conteneurs Podman sans droits administrateur**, dès la phase 3 | ✅ |
| D6 | Comptes créés **sur invitation uniquement** | ✅ |
| D7 | Rôles par site : **propriétaire**, **administrateur de site**, **éditeur**, **contributeur** | ✅ |
| D8 | Notion d'**espace** dès le départ, **portabilité** (ARM64 et x86_64, aucune dépendance au Pi dans le cœur), **thème** unique | ✅ |
| D9 | Médias **dans Git**, compressés automatiquement (2 560 px, 2 Mo max), alerte au-delà de 500 Mo par site | ✅ |
| D10 | **Un brouillon commun par site** ; liste des modifications et de leurs auteurs avant publication | ✅ |
| D11 | **Aperçu sans fonctions réelles** (actives seulement avec des secrets de test) | ✅ |
| D12 | **Domaine séparé** pour les aperçus (≈ 10–15 €/an, à acheter avant la phase 4) | ✅ |
| D13 | Double authentification obligatoire : **codes à 6 chiffres + passkeys + codes de secours** | ✅ |
| D14 | Accès distant par **Cloudflare Tunnel** (DNS géré par Cloudflare, domaines toujours enregistrés chez Squarespace) ; solution de remplacement documentée : relais sur serveur loué + WireGuard | 🔵 |
| D15 | Accès local **de secours depuis l'ordinateur principal** (entrée locale + vrai certificat obtenu via Cloudflare DNS) ; accès local généralisé seulement après test de la box | 🔵 |
| D16 | Composants d'interface **Mantine** | 🔵 |
| D17 | V1 : interface téléphone pour les actions courantes + icône d'application ; PWA complète plus tard | 🔵 |
| D18 | Coolify, Dokploy et CapRover **non retenus** comme base (Docker, ≥ 2 Go de mémoire, pas de CMS ni de compatibilité Netlify) | 🔵 |
| D19 | Éditeur de contenus **propre à PAGINITY**, lisant le format `.pages.yml` (Pages CMS exige GitHub ; Decap, Keystatic et Sveltia ne conviennent pas en production multi-appareils) | 🔵 |
| D20 | Base interne **SQLite intégrée à Node.js** (`node:sqlite`) : aucun module compilé à installer | 🔵 |
| D21 | Mots de passe protégés par **Argon2id** | 🔵 |
| D22 | Pas de vidéo hébergée sur le serveur (conditions Cloudflare) : utiliser YouTube, Vimeo ou un service dédié | 🔵 |

## 3. Exigences fonctionnelles

### 3.1 Indispensable en version 1
1. Héberger plusieurs sites HTML/CSS/JavaScript/JSON, chacun rattaché à un espace.
2. Créer un site (modèle vierge ou vitrine) ou **importer** un site existant (archive ZIP, dépôt Git public).
3. **Mode contenus** : formulaires générés depuis `.pages.yml`, ou déduits automatiquement des fichiers JSON.
4. **Mode code** : éditeur HTML/CSS/JS/JSON avec coloration, contrôle de validité, comparaison, historique.
5. **Médiathèque** : ajout, remplacement, suppression contrôlée, vérification du vrai type de fichier,
   compression, suppression des métadonnées (dont la position GPS des photos).
6. **Brouillon commun**, aperçu privé, comparaison avec la version en ligne, annulation des modifications.
7. **Publication en 10 étapes**, sans coupure, avec retour automatique en cas d'échec.
8. **Historique** complet (Git) et **restauration** d'une version sans toucher aux données métier.
9. **Centre d'activités** : les opérations longues continuent côté serveur, même navigateur fermé.
10. Comptes, rôles par site, invitations, double authentification, sessions, journal d'audit.
11. Tableau de bord : état des sites, du serveur, alertes.
12. **Export complet** d'un site (dépôt Git + données) dans un format standard.
13. Fonctions Node.js isolées, adaptateur Netlify Functions v2, tâches planifiées fiables (phase 3).
14. Sauvegardes chiffrées hors du serveur, surveillance externe, alertes e-mail (phase 4).
15. Coco Nail's fonctionnel avec toutes ses intégrations (phases 3 à 5).

### 3.2 Plus tard (phase 6)
Éditeur visuel à blocs (Puck, licence MIT) avec aperçu multi-formats · PWA complète et notifications ·
consultation des réservations · statistiques sans cookies · publication programmée · bibliothèque de
modules et de modèles · envoi de gros fichiers avec reprise · personnalisation de l'interface par client ·
facturation (hors périmètre tant que non décidé).

## 4. Interface

- Navigateurs pris en charge : **deux dernières versions** de Chrome, Edge, Firefox, Safari (Mac, iPhone, iPad),
  Chrome et Firefox sur Android. Aucune installation sur les appareils.
- Ordinateur : interface complète. Tablette : interface complète en disposition tactile.
  Téléphone : état des sites, textes, tarifs, horaires, photos, aperçu, publication, alertes.
- Français clair, confirmations avant les opérations dangereuses, objectif d'accessibilité **WCAG 2.2 AA**
  (à vérifier par des tests, il ne découle pas automatiquement des composants).
- Identité : logo PAGINITY, bleu nuit / or / argent, mode sombre par défaut et mode clair.

## 5. Sécurité (résumé)

| Couche | Mesures |
|---|---|
| Réseau | Aucun port ouvert sur la box, pare-feu fermé en entrée, tunnel |
| Adresses | Administration, aperçus et sites sur des origines séparées ; sites clients jamais en sous-domaine de l'administration |
| Identité | Argon2id, double authentification obligatoire, codes de secours, limitation des tentatives, sessions courtes, confirmation renforcée pour les actions sensibles |
| Requêtes | Vérification de l'origine + jeton anti-falsification (CSRF) sur toutes les modifications |
| Droits | Contrôle centralisé (utilisateur, rôle, site) ; mode code réservé au propriétaire et aux administrateurs de site |
| Isolation | Conteneurs par site pour les fonctions **et** la fabrication (phase 3) ; aucun code serveur libre pour des tiers en V1 |
| Données | Secrets chiffrés (AES-256-GCM, clé maître lisible par PAGINITY seul) ; fichiers privés hors de la zone servie ; fichiers commençant par « . » jamais servis |
| Traçabilité | Journal d'audit (1 an) ; journaux d'accès visiteurs (30 jours) — durées à revoir avant toute activité professionnelle |

Limite connue : le chiffrement des secrets ne protège pas contre une prise de contrôle complète du serveur.

## 6. Sauvegarde et reprise

- Objectifs proposés (🔵) : perte maximale **quasi nulle** pour le code et les contenus (envoi après chaque
  publication), **24 h** pour le reste ; remise en service **sous 24 h** (restauration sur un nouveau matériel
  ou sur un serveur loué à l'heure).
- 3 copies, 2 supports, 1 hors de chez soi : SSD + **deux disques USB alternés chaque mois** (un toujours débranché)
  + **Google Drive chiffré** (restic + rclone, connexion OAuth). Avant le premier client : copie immuable
  (Backblaze B2 Object Lock, ≈ 1 €/mois, à vérifier).
- Conservation : 7 quotidiennes, 4 hebdomadaires, 12 mensuelles. Contrôle d'intégrité hebdomadaire, restauration
  d'essai mensuelle automatique, restauration complète manuelle chaque trimestre.
- **Clé de sauvegarde** : coffre PAGINITY + papier + gestionnaire de mots de passe.

## 7. Surveillance

Sites (toutes les minutes), erreurs des fonctions, tâches planifiées, disque (80 % / 90 %), mémoire, température,
état du SSD, âge de la dernière sauvegarde (> 26 h), connexions suspectes, mises à jour, certificats
(alerte à 14 jours — durée Let's Encrypt : 64 jours au 10/02/2027, 45 jours au 16/02/2028).
Surveillance externe : Healthchecks.io (signal de vie) et UptimeRobot (test des sites publics) — conditions
d'usage commercial à revérifier avant le premier client. Alertes : information (tableau de bord), attention
(récapitulatif quotidien), critique (e-mail immédiat via l'API Gmail).

## 8. Matériel et coûts

| Élément | Estimation | Remarque |
|---|---|---|
| Serveur | Raspberry Pi 5 8 Go (≈ 175 $ la carte seule depuis avril 2026) **ou** mini-PC Intel N150 16 Go / 512 Go (médiane ≈ 349 $ aux États-Unis, nov. 2026) | ⚪ Devis français à établir. **Si le Pi n'est pas déjà acheté, le mini-PC est probablement le meilleur rapport qualité-prix** (mémoire doublée, SSD et horloge inclus) |
| Accessoires Pi | Alimentation 27 W, boîtier ventilé, carte NVMe + SSD, pile d'horloge (≈ 5 €) | Inutiles pour un mini-PC |
| Onduleur avec port USB compatible NUT | À chiffrer | Vérifier le modèle dans la liste NUT |
| Deux disques USB de sauvegarde | ≈ 60 € | Rotation mensuelle |
| Domaine d'aperçu | ≈ 10–15 €/an | D12 |
| Électricité | Pi : 2–3 W au repos (mesures de particuliers), quelques euros par an ; mini-PC : probablement 10–20 €/an | Mesurer sur place |
| Logiciels | 0 € | Tous open source |
| Serveur de secours | Seulement pendant une panne | Facturation à l'heure |

## 9. Risques principaux

| # | Risque | Gravité | Parade |
|---|---|---|---|
| 1 | Maintenance d'un logiciel sur mesure par une personne non développeuse | Élevée | Partie sur mesure réduite au minimum, dépendances limitées, guide de maintenance, mises à jour testées |
| 2 | Coupure des e-mails lors du changement de DNS | Élevée | Inventaire, DNS déplacé **séparément** de l'hébergement, tests avant/après, retour arrière |
| 3 | Doublons (SMS, paiements) pendant le fonctionnement en parallèle | Élevée | Tâches et paiements actifs d'un seul côté |
| 4 | Perte de la clé de sauvegarde | Critique | Trois copies de la clé |
| 5 | Panne de courant, de box ou de matériel | Moyenne | Onduleur, redémarrage automatique, page de secours, restauration sous 24 h |
| 6 | Horaires des tâches décalés (Netlify fonctionne en UTC) | Moyenne | Planificateur en UTC, tests d'heure d'été/hiver |
| 7 | Code tiers malveillant | Élevée (activité pro) | Pas de code serveur libre pour les clients, conteneurs, liste d'adresses sortantes autorisées plus tard |
| 8 | Mentions légales : l'hébergeur doit être identifié — risque d'exposer son adresse personnelle | Moyenne | ⚪ À vérifier juridiquement **avant** la bascule de Coco Nail's |
| 9 | Clés d'API restreintes par adresse IP (OVH) | Moyenne | Vérification dans l'espace client OVH avant migration |
| 10 | Photos HEIC non lisibles par la version standard de `sharp` (brevets) | Faible | Message clair ; conversion à étudier |
| 11 | Hausse du prix de la mémoire (Pi et mini-PC) | Faible | Architecture portable, devis avant achat |

## 10. Plan de migration de Coco Nail's (résumé)

1. Inventaire du code (accès GitHub en lecture nécessaire) : fonctions, adresses, horaires UTC, usages propres à
   Netlify, dépendances ARM64, noms des variables, webhooks, restrictions IP, liens déjà envoyés, données Netlify.
2. Phase 3 : fonctions de Coco Nail's dans PAGINITY avec des **secrets de test**.
3. Phase 4 : serveur définitif, sous-domaine de test, sauvegardes et restauration validées.
4. J11 — fonctionnement en parallèle (une à deux semaines), tâches et paiements actifs **d'un seul côté**.
5. J12 — **migration du DNS seul** vers Cloudflare en continuant de pointer vers Netlify ; e-mails vérifiés.
6. J13 — bascule de l'hébergement ; Netlify reste prêt à reprendre ; critères de retour arrière écrits.
7. J14 — retrait de Netlify après plusieurs semaines stables et accord explicite.

## 11. Planning et critères de validation

| Phase | Jalons | Critère de passage |
|---|---|---|
| 1 Conception | Ce document | Décisions D1–D22 consignées ✅ |
| 2 Prototype local | J1 socle · J2 versions et publication · J3 contenus et médias · J4 code · J5 mobile, passkeys, accessibilité | Parcours complet testé : créer, modifier, prévisualiser, publier, restaurer, depuis ordinateur et format téléphone |
| 3 Fonctions + Coco Nail's | J6 exécuteur et adaptateur Netlify · J7 planificateur et alertes · J8 Coco Nail's en test | Liste de vérification de Coco Nail's entièrement cochée avec secrets de test |
| 4 Installation | J9 serveur définitif · J10 tests de panne | Restauration complète réussie, reprises mesurées |
| 5 Migration | J11 à J14 | Voir § 10 |
| 6 Évolutions | Éditeur visuel, PWA, etc. | Au cas par cas |

Chaque compte rendu distingue : testé automatiquement · testé sur un vrai appareil · prévu mais non testé.

## 12. Questions encore ouvertes

1. Possédez-vous déjà le Raspberry Pi 5 ? (tranche le choix du matériel)
2. Modèle de la box et fournisseur internet (accès local, conditions d'hébergement).
3. Appareils disponibles pour les tests réels.
4. **Accès GitHub en lecture** au dépôt de Coco Nail's (bloquant pour la phase 3).
5. Restriction par adresse IP des clés d'API OVH.
6. Obligations LCEN/DSA, mentions légales, conditions du fournisseur internet (avant tout usage professionnel,
   et avant la bascule pour la question des mentions légales).
