# Compte rendu — Phase 3 : fonctions serveur et Coco Nail's (15/11/2026)

## Ce qui a été réalisé

- **Exécuteur des fonctions** (imite Netlify Functions v2) : `export default async (req, context)`, adresses
  `config.path` (avec paramètres), adresse par défaut `/.netlify/functions/<nom>`, `context.params`, `context.ip`,
  `context.cookies`, `Netlify.env`, variables `URL`, `CONTEXT`, `SITE_NAME`, tâches `config.schedule`.
- **Isolation** :
  - conteneur **Podman** sans privilège (lecture seule, ne voit que le code du site, limites de ressources) ;
  - en secours, processus restreint par le modèle de permissions de Node.js.
  - Chaque site a ses propres secrets ; une fonction trop lente est coupée (30 s).
- **Étape de préparation** (`node script.mjs`) exécutée dans l'isolation, sans réseau en conteneur.
  Dépendances installées par `npm ci` **sans exécuter aucun script**, avec cache.
- **Publication** : l'étape « Fonctions serveur » démarre la nouvelle version à côté de l'ancienne. La publication
  est refusée si une fonction ne se charge pas, et l'ancienne version reste en ligne.
- **Coffre à secrets** :
  - deux jeux de valeurs, production et test ;
  - noms détectés automatiquement dans le code ;
  - valeurs chiffrées, jamais réaffichées, masquées dans les journaux ;
  - confirmation d'identité demandée pour les modifier.
- **Aperçu** : les fonctions n'y tournent qu'avec des **secrets de test**, et les formulaires de l'aperçu
  n'enregistrent rien.
- **Formulaires** : un module PAGINITY remplace les formulaires Netlify **sans modifier le site** (décision D23).
  - Il refuse les robots (champ piège) et limite le nombre d'envois.
  - Les messages sont chiffrés, visibles dans l'écran « Formulaires », exportables en tableur, et peuvent être
    envoyés par e-mail.
- **Planificateur** :
  - horaires lus en heure UTC, comme Netlify ;
  - une seule exécution par créneau, même après un redémarrage ;
  - jamais deux exécutions simultanées d'une même tâche ;
  - attente que l'horloge soit synchronisée ;
  - tâches manquées signalées, rattrapage seulement si vous l'autorisez ;
  - aucune relance automatique ;
  - **désactivé par défaut pour un site importé**, pour éviter les doubles rappels avec Netlify ;
  - bouton « Lancer maintenant ».
- **Alertes** : enregistrées sur le tableau de bord. Une alerte critique est envoyée **par e-mail immédiatement** ;
  les autres sont regroupées dans un récapitulatif quotidien. L'envoi passe par un serveur d'e-mails (SMTP),
  par exemple celui de Google Workspace.
- **Nouveaux écrans** : Fonctions et tâches, Secrets, Formulaires, Réglages de la plateforme. Les alertes du
  tableau de bord peuvent être marquées comme lues.

## Ce qui a été testé

### Tests automatiques réellement exécutés (tous réussis)

| Série | Nombre | Contenu |
|---|---|---|
| Tests du serveur | **45** (dont 17 nouveaux) | Expressions de planification. Adaptateur Netlify. **Isolation** : lecture de la clé du coffre et de la base refusée, sous-processus refusés, écriture refusée. Secrets propres à chaque site. Coupure des fonctions trop lentes. Publication refusée si une fonction est cassée. Formulaires et robots. **E-mails** (serveur d'e-mails de test : test, alerte critique, récapitulatif, notification de formulaire). Planificateur (doublons, panne de 23 min, rattrapage, horloge non synchronisée). Aperçu avec et sans secrets de test. **Conteneur Podman**. |
| Coco Nail's (import réel) | 6 | Préparation pour Google exécutée, 8 fonctions chargées, vraies fonctions appelées, secrets détectés, formulaires contact et robot |
| Parcours navigateur phase 3 (Chromium) | 11 vérifications | Import de Coco Nail's par l'assistant, publication avec fonctions, écrans Fonctions, Secrets (avec confirmation d'identité) et Formulaires, appel réel depuis la page publique, format téléphone, aucune erreur JavaScript |
| Parcours navigateur phase 2 | 16 vérifications | Relancé : toujours réussi |

### Non testé
- **Coco Nail's avec de vrais comptes** (Google Agenda, Gmail, Sheets, Drive, OVH, SumUp) : il faut vos comptes
  de test, voir « Vos actions ». Sans secrets, les fonctions répondent correctement « non configuré ».
- **Podman sans droits administrateur sur un vrai serveur** : testé seulement dans l'environnement de développement.
  - Le conteneur a fonctionné en mode administrateur.
  - En mode sans droits, le conteneur a démarré, mais son réseau isolé n'a pas pu être créé (limite de cette
    machine) ; il ne marche ici qu'avec le réseau de la machine (`host`).
  - Les limites de mémoire n'ont pas pu être appliquées : cette machine utilise cgroups v1, et Raspberry Pi OS
    utilise cgroups v2.
  - À vérifier en phase 4 sur le matériel.
- Envoi réel d'e-mails par Google Workspace (seul un serveur d'e-mails de test a été utilisé).
- Vrais appareils, Safari, Firefox (toujours uniquement Chromium).

## Ce qui fonctionne
Tout ce qui est listé dans les tests ci-dessus, sur l'ordinateur de développement (Linux).

## Limites connues
- Étape de préparation : seule la forme `node chemin/script.mjs` est acceptée. C'est le cas de Coco Nail's.
  Il n'y a pas d'interpréteur de commandes, par sécurité.
- Les fonctions Netlify « v1 » (`exports.handler`) et les Edge Functions ne sont pas prises en charge ; Coco Nail's
  n'en utilise pas.
- Les fichiers joints aux formulaires sont ignorés ; Coco Nail's n'en a pas.
- En mode « processus restreint », les fonctions peuvent toujours accéder à internet (nécessaire pour Google, OVH…).
  Une liste d'adresses autorisées pourra être ajoutée avant d'accueillir des clients.
- Le délai maximal des tâches planifiées est fixé à 2 minutes, et à 30 secondes pour les appels de visiteurs.

## Vos actions
1. **Préparer des comptes de test**, pour essayer Coco Nail's sans toucher aux vraies données :
   - un agenda Google de test ;
   - une copie de la feuille de compta ;
   - si possible SumUp et OVH en mode test.

   Saisissez leurs valeurs vous-même dans PAGINITY, écran « Secrets », colonne « Test ». Ne me les envoyez jamais.
2. **Vérifier dans votre espace OVH** si les clés d'API sont limitées à certaines adresses IP.
3. **Créer un mot de passe d'application Google** pour l'adresse qui enverra les alertes. Vous le saisirez dans
   « Réglages de la plateforme » au moment de l'installation définitive.
4. Toujours ouvert : **avez-vous déjà le Raspberry Pi ?** C'est nécessaire pour la phase 4.

## Décision de passage
La phase 4 (installation sur le serveur définitif, sauvegardes, surveillance, tests de panne) **n'est pas commencée**.
Elle demande le matériel et votre accord explicite.
