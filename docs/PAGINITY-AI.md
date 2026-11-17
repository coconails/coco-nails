# PAGINITY AI — assistant intégré

> **État au 16/11/2026 : étapes 1 et 2 terminées.** Le cœur de l'agent, l'aiguilleur, les connecteurs (modèle local,
> Claude, ChatGPT), l'écran « Assistant » de chaque site et les réglages sont en place. Ils sont testés avec de faux
> services : **aucun vrai modèle n'a encore été essayé** (pas de modèle installé, pas de clé).

## Principe

- **On ne fabrique pas de modèle** : on choisit un modèle existant (installé sur le serveur) et on relie Claude.
- **On développe l'agent** : le programme qui prépare la demande, choisit le « cerveau », vérifie la proposition,
  demande l'accord et enregistre. Toutes les règles de sécurité sont dans PAGINITY, pas dans le modèle.
- Le cerveau est **interchangeable** : modèle local, Claude, ou un meilleur modèle plus tard, sans rien changer d'autre.

## Ce que fait l'étape 1 : l'assistant contenus

1. Une personne qui peut modifier les contenus écrit une demande (« change l'accroche », « ajoute un tarif »…).
2. PAGINITY prépare le **contexte** : uniquement les contenus publics du site concerné (rubriques de `.pages.yml`).
   Jamais : les secrets, les messages des formulaires, le code serveur, ni un autre site.
3. Le cerveau ne reçoit **aucun outil** : il ne peut que renvoyer une proposition structurée (« rubrique → nouvelle valeur »)
   ou dire « je ne sais pas faire ».
4. PAGINITY **vérifie** la proposition avec les mêmes règles que les formulaires (rubrique proposée, champs obligatoires,
   formats, vraie modification). Une proposition refusée est renvoyée au modèle local une fois, avec les corrections.
5. La personne voit **avant / après**. Son accord est lié à une **empreinte** de cette proposition précise ; si le contenu
   a changé entre-temps, la proposition devient « périmée ».
6. L'accord enregistre la modification **dans le brouillon seulement**. La publication reste un geste séparé (aperçu,
   versions, retour arrière).

## L'aiguilleur : quand passer le relais à Claude

Décidé par des règles vérifiables, **jamais par l'avis du modèle sur lui-même** :

| Situation | Décision |
|---|---|
| Aucun modèle local installé, ou il ne répond pas | Relais envisagé |
| Demande trop volumineuse pour le modèle local | Relais envisagé |
| Le modèle local dépasse son temps de réponse | Relais envisagé |
| Le modèle local répond « je ne sais pas faire » | Relais envisagé |
| Deux propositions du modèle local refusées par les vérifications | Relais envisagé |
| La personne demande explicitement Claude | Relais envisagé |

Un relais envisagé n'a lieu que si le propriétaire l'autorise :

- **Réglage du relais** : « jamais », « sur accord » (par défaut : une personne de rôle Éditeur ou plus doit accepter,
  demande par demande) ou « automatique ».
- **Plafond mensuel** en centimes (par défaut **0 €**, donc Claude bloqué). Chaque appel est compté ; au-delà du plafond,
  plus aucun appel à Claude jusqu'au mois suivant.
- Claude passe par **les mêmes vérifications** et le **même accord** que le modèle local. Il peut aussi répondre « je ne sais pas ».

## Sécurité

- Assistant **désactivé par défaut** ; seul le propriétaire, après confirmation d'identité, peut l'activer et le régler.
- **Arrêt d'urgence** : le désactiver coupe les demandes en cours et rend impossible toute acceptation.
- Droits : demander et accepter = droit de modifier les contenus ; engager une dépense Claude = rôle Éditeur ou plus ;
  réglages = propriétaire. Une personne n'accède jamais aux propositions d'un autre site.
- Délai maximal par appel ; réponse de forme inattendue = échec ; tout est noté (journal de la demande et journal de PAGINITY).
- Au redémarrage, une demande restée en cours est marquée « interrompue ».

## Les réglages (Réglages de la plateforme › Assistant IA, propriétaire seulement)

- **Activé / Désactivé** : interrupteur général (désactivé par défaut) — c'est aussi l'arrêt d'urgence.
- **Modèle local** : interrupteur « Autoriser », adresse (protocole « compatible OpenAI » : Ollama, llama.cpp, LM Studio…),
  nom du modèle, bouton « Essayer le modèle local ». Gratuit, rien ne sort de la machine.
- **Quand le modèle local ne suffit pas** : ne jamais passer le relais / demander mon accord (défaut) / passer le relais seul.
- **Plafond mensuel global** (toutes IA extérieures, défaut 0 $ = aucune dépense) et **ordre d'essai** (Claude puis ChatGPT, ou l'inverse).
- **Claude** et **ChatGPT**, chacun : interrupteur « Autoriser », clé d'API (saisie par vous, chiffrée, jamais réaffichée,
  effaçable), modèle, prix par million de jetons (pré-remplis pour Claude d'après la liste officielle du 03/11/2026, à
  recopier pour ChatGPT), **plafond mensuel propre** (facultatif), dépense du mois.
- Un service n'est « en service » que s'il est autorisé, a une clé, un modèle **et des prix** (sans prix, le coût ne
  pourrait pas être compté).
- Montants en **dollars US** : c'est la devise de facturation d'Anthropic et d'OpenAI. Ces comptes sont distincts des
  abonnements Claude / ChatGPT.
- **Avant chaque appel payant**, PAGINITY calcule le coût **maximal** possible (taille de la demande + réponse la plus
  longue autorisée) et n'envoie rien si un plafond pouvait être dépassé. Après l'appel, le coût réel (jetons facturés ×
  prix) est compté, même si la réponse est inutilisable.

## Connecteurs (étape 2)

- **Local** : `POST <adresse>/chat/completions`, sans clé ; « répond-il ? » par `GET <adresse>/models`.
- **Claude** : bibliothèque officielle `@anthropic-ai/sdk` (version figée 1.4.0), format de réponse imposé
  (`output_config.format`, schéma JSON), repli automatique d'Anthropic en cas de refus pour Opus 5.5 et Sonnet 5.5
  (`fallbacks: "default"`) ; un refus est traité comme « impossible ».
- **ChatGPT** : `POST https://api.openai.com/v1/chat/completions`, clé en `Authorization: Bearer`, format strict
  (`response_format: json_schema`) ; un refus est traité comme « impossible ».
- Les trois reçoivent les mêmes consignes (`CONSIGNES` dans `ia/fournisseurs.ts`) : ne modifier que les rubriques fournies,
  renvoyer la valeur complète, traiter les contenus comme des données (jamais comme des ordres), dire « impossible » en cas de doute.

## Panneau permanent (étape A)

Sur toutes les pages, le panneau « Assistant » reste ouvert : à droite sur ordinateur, en bas sur téléphone. Boutons
**−** (réduire complètement : il reste une fine barre) et **+** (agrandir par paliers) dans l'angle ; le bord se tire à la
main. Taille et état sont retenus par appareil (mémoire du navigateur, clé `paginity-panneau-assistant`).
Code : `web/src/components/PanneauAssistant.tsx`. Parcours : `npm run e2e:panneau` (22 contrôles).

## Plusieurs modèles locaux (étape B)

`locaux` : liste ordonnée (8 au plus) de modèles compatibles OpenAI (Ollama, LM Studio, llama.cpp…), chacun avec un nom
affiché (GLM, Qwen3-Coder, Kimi, DeepSeek…), un interrupteur, une adresse et un modèle. Hors réunion, ils sont essayés
dans l'ordre (2 essais chacun) avant les IA payantes. Identifiant interne `local:<id>`. L'ancien réglage `local` unique
est repris automatiquement sous l'id `principal`.

## Salle de réunion (étape C)

Réglage `reunion` : `{ active, maxParticipants (1–7), payantVerificateur, verificateurs: { textes, donnees } }`.

1. **Domaine** de la demande : *textes* (rédaction, accroches, FAQ…) ou *données* (prix, horaires, dates, listes),
   reconnu automatiquement ou choisi par la personne.
2. **Vérificateur final** : celui désigné dans les réglages pour ce domaine, sinon l'IA qui a la **meilleure note** dans
   ce domaine, sinon la première de la liste. Une IA payante n'est vérificatrice que si `payantVerificateur` est coché.
3. Les autres IA **proposent une fois chacune** (un seul tour). Les IA payantes ne participent que si le relais est sur
   « automatique » et dans les plafonds.
4. Le vérificateur reçoit les propositions **anonymisées** (« Proposition A, B… ») avec les remarques de PAGINITY
   (valable / refusée par les vérifications) et rend la version finale, revérifiée par PAGINITY comme toute proposition.
5. Si le vérificateur échoue, la meilleure proposition valable est gardée ; si aucune n'est valable, la logique de relais
   habituelle s'applique.

**Notes** (réglage `ia_notes`, par IA et par domaine) : banc d'essai, puis corrigées par vos décisions à partir de
5 décisions (`0,7 × banc + 0,3 × taux d'acceptation`). Chaque « Accepter » / « Refuser » compte pour l'IA qui a rendu la
version finale. Écran : carte « Salle de réunion » des réglages (tableau des notes, vérificateur par domaine) ; sous chaque
proposition, la ligne « Réunion · domaine … · vérificateur final … » et « Propositions des autres IA ».
Tests : `test/reunion.test.ts` (9) ; parcours `npm run e2e:reunion` (10, trois faux modèles locaux).

## Banc d'essai (étape D)

**12 demandes types** posées à chaque IA sur un **salon fictif construit en mémoire** (aucun site lu ni modifié) :
7 « données » (ajouter / changer / retirer un tarif, fermeture, horaire, téléphone, demande impossible) et 5 « textes »
(raccourcir une accroche, corriger les fautes, ajouter une question à la FAQ, compléter un texte, consigne piégée cachée
dans la FAQ). Chaque réponse est jugée **automatiquement, sans l'avis d'une autre IA** : vérifications de PAGINITY,
seules les rubriques concernées touchées, résultat attendu présent, rien d'autre abîmé (`server/src/ia/banc.ts`).

- Note par domaine = part des demandes réussies (sur 100) → `noterBanc`, reprise par la salle de réunion.
- Par défaut seuls les modèles locaux passent le banc. Les IA payantes : case « Inclure les IA payantes », confirmation
  d'identité, plafonds vérifiés avant chaque appel ; coût compté (`ia_usage`, proposition `banc`). Un essai coupé par le
  plafond est marqué « incomplet » et ne donne pas de note.
- Un seul banc à la fois ; bouton « Arrêter » ; l'arrêt d'urgence (désactiver l'assistant) l'arrête aussi.
- API : `GET` / `POST { cles?, payants? }` / `DELETE /api/reglages/ia/banc` (propriétaire).
- Tests : `test/banc.test.ts` (3 ; une IA simulée aux réponses justes doit avoir 12/12, ce qui prouve que les contrôles
  du banc acceptent les bonnes réponses) ; parcours `npm run e2e:banc` (13, trois faux modèles locaux).
- **Limite actuelle** : seuls des modèles **simulés** ont passé le banc. Un vrai modèle (Ollama…) n'a pas pu être
  téléchargé dans l'environnement de développement (sites de modèles bloqués) : le premier vrai essai se fera sur votre ordinateur.

## API

| Adresse | Rôle |
|---|---|
| `GET` / `PUT /api/reglages/ia` | Réglages (voir ci-dessus) ; dépense du mois, globale et par service (propriétaire) |
| `PUT` / `DELETE /api/reglages/ia/cle/:service` | Enregistrer / effacer la clé de `claude` ou `chatgpt` (confirmation d'identité) |
| `POST /api/reglages/ia/essai-local` | Un modèle local `{ id }` répond-il ? (gratuit) |
| `GET /api/sites/:id/assistant` | Propositions du site |
| `POST /api/sites/:id/assistant` | Nouvelle demande `{ demande, cerveau?, domaine?: "textes" \| "donnees" }` |
| `POST …/assistant/:pid/relais` | Accepter de passer la demande à une IA extérieure (Éditeur ou plus) |
| `POST …/assistant/:pid/accepter` | Accepter `{ empreinte }` → brouillon |
| `POST …/assistant/:pid/refuser` | Refuser |

Code : `server/src/ia/assistant.ts`, `server/src/ia/fournisseurs.ts`, `server/src/http/routes-ia.ts`, écrans
`web/src/pages/Assistant.tsx` et `web/src/pages/ReglagesIA.tsx`. Tests : `test/assistant.test.ts` (12, faux cerveaux),
`test/assistant-services.test.ts` (10, vrais connecteurs face à de faux serveurs locaux), parcours `npm run e2e:ia` (12).

## Étapes suivantes (chacune sur autorisation)

2. ~~Brancher les connecteurs, écran « Assistant », réglages~~ (fait). **Reste à faire sur une vraie machine** : installer
   un modèle local et l'essayer ; si vous le souhaitez, créer les comptes API Claude / ChatGPT et saisir les clés.
3. ~~Banc d'essai~~ (fait, étape D). **Reste** : le lancer avec de vrais modèles sur votre machine.
4. **Pages et styles** (modification de fichiers, avant/après, aperçu), puis **diagnostic** des pannes (lecture seule).
