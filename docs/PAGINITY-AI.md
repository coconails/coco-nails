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

## API

| Adresse | Rôle |
|---|---|
| `GET` / `PUT /api/reglages/ia` | Réglages (voir ci-dessus) ; dépense du mois, globale et par service (propriétaire) |
| `PUT` / `DELETE /api/reglages/ia/cle/:service` | Enregistrer / effacer la clé de `claude` ou `chatgpt` (confirmation d'identité) |
| `POST /api/reglages/ia/essai-local` | Le modèle local répond-il ? (gratuit) |
| `GET /api/sites/:id/assistant` | Propositions du site |
| `POST /api/sites/:id/assistant` | Nouvelle demande `{ demande, cerveau?: "claude" \| "chatgpt" }` |
| `POST …/assistant/:pid/relais` | Accepter de passer la demande à une IA extérieure (Éditeur ou plus) |
| `POST …/assistant/:pid/accepter` | Accepter `{ empreinte }` → brouillon |
| `POST …/assistant/:pid/refuser` | Refuser |

Code : `server/src/ia/assistant.ts`, `server/src/ia/fournisseurs.ts`, `server/src/http/routes-ia.ts`, écrans
`web/src/pages/Assistant.tsx` et `web/src/pages/ReglagesIA.tsx`. Tests : `test/assistant.test.ts` (12, faux cerveaux),
`test/assistant-services.test.ts` (8, vrais connecteurs face à de faux serveurs locaux), parcours `npm run e2e:ia` (10).

## Étapes suivantes (chacune sur autorisation)

2. ~~Brancher les connecteurs, écran « Assistant », réglages~~ (fait). **Reste à faire sur une vraie machine** : installer
   un modèle local et l'essayer ; si vous le souhaitez, créer les comptes API Claude / ChatGPT et saisir les clés.
3. **Banc d'essai** : une vingtaine de demandes types pour comparer les modèles et mesurer le coût réel de Claude.
4. **Pages et styles** (modification de fichiers, avant/après, aperçu), puis **diagnostic** des pannes (lecture seule).
