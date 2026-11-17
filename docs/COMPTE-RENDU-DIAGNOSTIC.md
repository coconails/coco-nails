# Diagnostic du 17/11/2026 — corrections apportées

Toutes les corrections ont été vérifiées : 204 tests automatiques réussis (dont 6 nouveaux), 11 parcours dans Chromium
(135 contrôles) réussis, aucune faille connue dans les composants du logiciel en marche (`npm run audit-production`).

| Constat | Correction | Preuve |
|---|---|---|
| **A.** La sauvegarde bloquait le serveur | Archive, empreintes, ouverture et restauration d'essai sans bloquer (`tar` lancé à part, empreintes lues par morceaux) | Test « le serveur reste réactif » : avec 40 Mo, l'ancienne version figeait le serveur **1,6 s** (mesuré), la nouvelle jamais plus de 0,3 s |
| **B.** Adresses de notification non filtrées | Seuls les services de Google, Apple, Mozilla et Microsoft sont acceptés (https, sans port ni identifiant) | Test : adresses du réseau local, faux domaines, http et ports refusés |
| **C.** Briques jamais essayées en vrai | Hors code : voir « Essais réels » ci-dessous | — |
| **D.** Opérations coûteuses sans limite | Limite par site : aperçu 12/min, avant-après 6/min, audit 6/min, diagnostic 4/min, relevé Search Console 4/min, inspection 3/10 min (`lib/limiteur.ts`) | Test du limiteur |
| **E.** Fuseau horaire | Heure de sauvegarde et journées de visites en heure de Paris (`lib/fuseau.ts`, réglable par `PAGINITY_FUSEAU`) ; `TZ=Europe/Paris` dans le service | Tests hiver/été, minuit |
| **F.** Failles des outils de développement | **Aucune version corrigée n'existe** (`picomatch` ≤ 4.0.7, la dernière). La « correction » proposée par npm installerait d'anciennes versions de Vite/Vitest : refusée. Outils déjà à jour. Risque limité au poste de développement. Contrôle ajouté : `npm run audit-production` (0 faille) | `npm audit`, `npm view picomatch` |
| **G.** Fichiers trop gros, erreurs cachées | Assistant découpé : `ia/types.ts`, `ia/banc-execution.ts`, `ia/reunion.ts` (1 206 → 828 lignes) ; réglages de sauvegarde illisibles → alerte critique ; empreinte de mot de passe illisible et tâches de fond → journalisées ; plus aucun `as any` | 47 tests de l'assistant inchangés et réussis |
| **H.** Couverture inconnue, parcours dupliqués | Couverture mesurée (`npm run couverture`) : **89,5 % des lignes**, 84 % des instructions, 73 % des branches ; bibliothèque commune `e2e/lib/paginity.mjs` pour 7 parcours | Rapport de couverture ; parcours inchangés et réussis |
| **I.** Versions | 0.3.0 partout | — |
| **J.** Documentation | Chiffres de tests corrigés, liste des parcours | — |
| **K.** Manuel PDF | Fabriqué à la demande (`npm run manuel`), plus à chaque étape | — |
| **L.** Code dupliqué | `requireSudoOwner` commun (réglages IA, continuité, Search Console) | — |
| **M.** Contrôle de la base | Complet au plus une fois par heure, simple vérification sinon | — |
| **N.** Alertes Search Console répétées | Une au premier échec, puis au plus une par semaine | — |

## Essais réels (point C) — à faire avec vous, une étape à la fois

1. **Sur votre ordinateur** : installation guidée (`scripts/essai-ordinateur.sh`, ou `scripts/essai-windows.ps1`),
   puis ouvrir PAGINITY et créer un site d'essai.
2. **Un vrai modèle d'IA** : « Détecter les modèles installés », puis lancer le banc d'essai (vraies notes).
3. **Une notification sur votre téléphone** : Mon profil › Notifications › Activer, puis « Envoyer un essai ».
4. **Surveillance** : compte gratuit healthchecks.io, adresse « ping » collée dans PAGINITY, essai.
5. **Sauvegarde** vers un vrai dossier synchronisé, puis essai de restauration.
6. **Search Console** : compte de service dédié (sans rôle), clé envoyée, adresse ajoutée en « Restreint ».
7. **Futur serveur** : `paginity-installer`, puis reprise des étapes 2 à 6.

Rien de tout cela n'est lancé sans votre « procède ».
