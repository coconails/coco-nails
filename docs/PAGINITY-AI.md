# PAGINITY AI — assistant intégré

> **État au 16/11/2026 : étape 1 terminée** (cœur de l'agent et aiguilleur, testés avec de faux cerveaux).
> Aucune IA réelle n'est encore branchée : l'assistant est donc invisible et inutilisable tant que l'étape 2 n'est pas faite.

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

## API (étape 1)

| Adresse | Rôle |
|---|---|
| `GET` / `PUT /api/reglages/ia` | Réglages : `active`, `relaisClaude`, `plafondMensuelCentimes` ; dépense du mois (propriétaire) |
| `GET /api/sites/:id/assistant` | Propositions du site |
| `POST /api/sites/:id/assistant` | Nouvelle demande `{ demande, cerveau?: "claude" }` |
| `POST …/assistant/:pid/relais` | Accepter de passer la demande à Claude (Éditeur ou plus) |
| `POST …/assistant/:pid/accepter` | Accepter `{ empreinte }` → brouillon |
| `POST …/assistant/:pid/refuser` | Refuser |

Code : `paginity/server/src/ia/assistant.ts`, `paginity/server/src/http/routes-ia.ts`. Tests : `test/assistant.test.ts` (12).

## Étapes suivantes (chacune sur autorisation)

2. **Brancher les vrais cerveaux** : un modèle local (sur votre ordinateur ou le futur serveur) et Claude (clé saisie par
   vous dans le coffre). Écran « Assistant » dans chaque site, et réglages dans « Réglages de la plateforme ».
3. **Banc d'essai** : une vingtaine de demandes types pour comparer les modèles et mesurer le coût réel de Claude.
4. **Pages et styles** (modification de fichiers, avant/après, aperçu), puis **diagnostic** des pannes (lecture seule).
