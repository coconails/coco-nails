# Installer PAGINITY sur le serveur (phase 4 — préparation)

> **État :** les fichiers sont prêts et ont été essayés en **simulation** (aucune commande système exécutée) dans un
> environnement Ubuntu 24.04 de test. Ils n'ont **pas encore été lancés sur un vrai Debian**. La première installation
> réelle se fera ensemble, étape par étape, sur la machine choisie.

## Ce qui est prêt

| Fichier | Rôle |
|---|---|
| `paginity/scripts/paginity-installer` | Première installation (refuse si PAGINITY est déjà installé ou si des données existent) |
| `paginity/deploiement/paginity.service` | Service systemd : démarrage automatique, redémarrage après panne, durcissement |
| `paginity/deploiement/paginity.env.exemple` | Réglages (copiés en `/etc/paginity/paginity.env`), sans aucun secret |
| `paginity/scripts/paginity-maj` | Mises à jour avec retour arrière automatique |
| `paginity/scripts/paginity-admin` | Secours, sauvegarde, restauration, changement de clé |

## Organisation sur la machine

- `/opt/paginity/versions/<date>-<commit>/` : une copie complète par version ; `/opt/paginity/actuelle` pointe vers celle en service.
- `/var/lib/paginity/` : **toutes les données** (droits 700, utilisateur `paginity`). C'est ce dossier que l'on sauvegarde.
- `/etc/paginity/paginity.env` : réglages (droits 640).
- `/home/paginity/` : espace de Podman (images et conteneurs des fonctions), **pas** dans les données sauvegardées.

## Étapes prévues

1. Installer Debian (version stable du moment) avec **chiffrement du disque**, sans interface graphique, SSH par clé uniquement.
2. Installer les outils : `git`, `podman`, `uidmap`, `tar`, `curl`, `util-linux` (flock), et **Node.js 24 LTS**.
   *À vérifier le jour J : la version de Node.js fournie par Debian peut être trop ancienne ; il faudra alors
   la source officielle de Node.js. Le service attend Node.js en `/usr/bin/node`.*
3. Lancer `sudo paginity/scripts/paginity-installer --source <adresse du dépôt> --ref <branche>`.
   Il crée l'utilisateur, les dossiers, récupère et teste le code, installe et démarre le service.
4. Ouvrir l'administration et saisir le code d'installation (`/var/lib/paginity/plateforme/code-installation.txt`).
5. Faire une première sauvegarde : `sudo -u paginity paginity-admin sauvegarder /chemin/vers/disque-externe`.

## Ce qui reste à décider ou à faire sur la machine (non préparé ici)

- Accès depuis internet (tunnel) et accès **privé** à l'administration (seuls les sites seraient publics).
- Pare-feu, mises à jour automatiques de sécurité de Debian.
- Copie chiffrée des sauvegardes hors de la machine (disque tournant, second lieu) et essai de restauration.
- Onduleur, surveillance extérieure (alerte si le serveur ne répond plus).
- Vérifier sur la vraie machine : Podman sans droits root sous systemd, accès des fonctions au réseau local,
  limites de mémoire et de processeur des conteneurs.

## Ce qui a été essayé (simulation, 16/11/2026)

- `systemd-analyze verify` sur le service : accepté (seule remarque : Node.js n'était pas en `/usr/bin/node` sur la machine d'essai).
- Installation simulée complète depuis le dépôt : dépendances, fabrication, **tous les tests réussis** (112 à l'époque), dossiers et droits créés.
- La copie installée démarre avec la même commande et les mêmes réglages que le service : l'administration répond,
  le code d'installation est créé, `paginity-admin etat` fonctionne.
- Une seconde installation est refusée.
