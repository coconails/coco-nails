#!/usr/bin/env bash
# essai-ordinateur.sh : installer PAGINITY pour l'ESSAYER sur un ordinateur ordinaire (Mac, Linux, ou Windows via WSL),
# avec l'assistant IA et des modèles gratuits choisis selon la mémoire de la machine.
#
# Ce qu'il fait, dans l'ordre (il DEMANDE avant chaque installation ; rien n'est effacé) :
#   1. regarde la machine : système, mémoire, place libre, processeur ;
#   2. vérifie Node.js (22.13 ou plus) et Git ; propose de les installer s'ils manquent (Mac : Homebrew) ;
#   3. installe les dépendances de PAGINITY et le fabrique (dans ce dossier) ;
#   4. vérifie Ollama (le logiciel gratuit qui fait tourner les modèles d'IA) ; propose de l'installer ;
#   5. propose les modèles adaptés à la mémoire et les télécharge si vous acceptez ;
#   6. crée « lancer-paginity.sh » pour démarrer PAGINITY d'un double-clic ou d'une commande.
#
# Utilisation, depuis le dossier « paginity » : bash scripts/essai-ordinateur.sh [--oui] [--sans-ia]
#   --oui      répond « oui » à toutes les questions (installation sans surveillance)
#   --sans-ia  n'installe ni Ollama ni modèle
# Essai sans rien installer ni télécharger : PAGINITY_ESSAI_SIMULATION=1 (les commandes sont seulement affichées ;
#   PAGINITY_ESSAI_RAM_GO et PAGINITY_ESSAI_SYSTEME permettent d'imiter une autre machine).
set -euo pipefail

SIMU="${PAGINITY_ESSAI_SIMULATION:-0}"
OUI=0
IA=1
for a in "$@"; do
  case "$a" in
    --oui) OUI=1 ;;
    --sans-ia) IA=0 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Option inconnue : $a" >&2; exit 1 ;;
  esac
done

DOSSIER="$(cd "$(dirname "$0")/.." && pwd)"
dire() { printf '\n\033[1m[PAGINITY]\033[0m %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
echec() { printf '\n\033[31m[PAGINITY] PROBLÈME :\033[0m %s\n' "$*" >&2; exit 1; }
faire() { if [ "$SIMU" = 1 ]; then info "(simulation) $*"; else "$@"; fi; }
demander() {
  [ "$OUI" = 1 ] && { info "$1 → oui (--oui)"; return 0; }
  local r
  read -r -p "  $1 [o/N] " r || r=""
  case "$r" in o|O|oui|Oui|OUI|y|Y) return 0 ;; *) return 1 ;; esac
}

# ------------------------------------------------------------------ 1. La machine
SYSTEME="${PAGINITY_ESSAI_SYSTEME:-$(uname -s)}"
WSL=0
grep -qi microsoft /proc/version 2>/dev/null && WSL=1
if [ -n "${PAGINITY_ESSAI_RAM_GO:-}" ]; then
  RAM_GO="$PAGINITY_ESSAI_RAM_GO"
elif [ "$SYSTEME" = Darwin ]; then
  RAM_GO=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
else
  RAM_GO=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
fi
LIBRE_GO=$(( $(df -Pk "$DOSSIER" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
ARCH="$(uname -m)"
case "$SYSTEME" in
  Darwin) NOM_SYS="Mac (macOS)" ;;
  Linux) if [ "$WSL" = 1 ]; then NOM_SYS="Windows (sous-système Linux WSL)"; else NOM_SYS="Linux"; fi ;;
  *) echec "système non pris en charge ($SYSTEME). Sur Windows, lancez plutôt scripts\\essai-windows.ps1." ;;
esac
dire "Votre machine : $NOM_SYS, processeur $ARCH, mémoire ${RAM_GO} Go, place libre ${LIBRE_GO} Go."
[ "$LIBRE_GO" -ge 3 ] || echec "il faut au moins 3 Go libres (10 Go conseillés avec l'IA)."
[ "$RAM_GO" -ge 4 ] || echec "il faut au moins 4 Go de mémoire."

# ------------------------------------------------------------------ 2. Node.js et Git
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }
if ! node_ok || ! command -v git >/dev/null; then
  dire "Node.js (22.13 ou plus) ou Git manque."
  if [ "$SYSTEME" = Darwin ] && command -v brew >/dev/null; then
    demander "Les installer avec Homebrew (brew install node git) ?" && faire brew install node git
  elif [ "$SYSTEME" = Darwin ]; then
    info "Installez Node.js « LTS » depuis https://nodejs.org (fichier .pkg), puis relancez ce script."
    [ "$SIMU" = 1 ] || exit 1
  else
    info "Installez Node.js 24 avec nvm (sans droits d'administrateur) :"
    info "  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install 24"
    info "et Git avec : sudo apt install git"
    [ "$SIMU" = 1 ] || exit 1
  fi
  [ "$SIMU" = 1 ] || node_ok || echec "Node.js est toujours absent ou trop ancien."
fi
dire "Node.js $(node -v 2>/dev/null || echo '?') et Git présents."

# ------------------------------------------------------------------ 3. PAGINITY
dire "Installation de PAGINITY dans $DOSSIER (quelques minutes la première fois)."
( cd "$DOSSIER" && faire npm ci --ignore-scripts --no-audit --no-fund && faire npm run build )

# ------------------------------------------------------------------ 4. Ollama
OLLAMA_URL="http://127.0.0.1:11434"
ollama_repond() { curl -fsS -m 3 "$OLLAMA_URL/api/version" >/dev/null 2>&1; }
MODELES=()
if [ "$IA" = 1 ]; then
  if ! command -v ollama >/dev/null; then
    dire "Ollama (gratuit, fait tourner les modèles d'IA sur votre machine) n'est pas installé."
    if [ "$SYSTEME" = Darwin ]; then
      if command -v brew >/dev/null && demander "L'installer avec Homebrew (brew install ollama) ?"; then faire brew install ollama
      else info "Téléchargez l'application sur https://ollama.com/download, ouvrez-la, puis relancez ce script."; fi
    elif demander "L'installer avec le script officiel d'Ollama (demande le mot de passe administrateur) ?"; then
      # Téléchargé dans un fichier et montré avant d'être lancé (jamais « curl | sh » à l'aveugle).
      faire curl -fsSL https://ollama.com/install.sh -o /tmp/ollama-install.sh
      info "Script enregistré dans /tmp/ollama-install.sh (vous pouvez le lire)."
      demander "Le lancer maintenant ?" && faire sh /tmp/ollama-install.sh
    fi
  fi
  if command -v ollama >/dev/null || [ "$SIMU" = 1 ]; then
    if ! ollama_repond; then
      dire "Démarrage d'Ollama en arrière-plan."
      if [ "$SIMU" = 1 ]; then info "(simulation) ollama serve &"; else (nohup ollama serve >/tmp/ollama.log 2>&1 &); sleep 3; fi
    fi
    # Modèles conseillés selon la mémoire (noms de la bibliothèque Ollama ; vérifiés au téléchargement).
    if   [ "$RAM_GO" -ge 32 ]; then MODELES=("qwen3:14b|9 Go" "glm4:9b|5,5 Go" "qwen3-coder:30b|19 Go")
    elif [ "$RAM_GO" -ge 16 ]; then MODELES=("qwen3:8b|5,2 Go" "glm4:9b|5,5 Go")
    elif [ "$RAM_GO" -ge 8 ];  then MODELES=("qwen3:4b|2,6 Go")
    else MODELES=("qwen3:1.7b|1,4 Go"); fi
    dire "Modèles conseillés pour ${RAM_GO} Go de mémoire :"
    for m in "${MODELES[@]}"; do info "• ${m%%|*} (environ ${m##*|} à télécharger)"; done
    info "Kimi K2 et DeepSeek V3 complets sont trop gros pour un ordinateur : ils restent possibles plus tard via leur service en ligne."
    for m in "${MODELES[@]}"; do
      nom="${m%%|*}"
      if demander "Télécharger $nom ?"; then
        if faire ollama pull "$nom"; then :; else info "Échec du téléchargement de $nom (nom changé ? connexion ?) : on continue."; fi
      fi
    done
  else
    info "Ollama absent : l'assistant IA restera désactivé (tout le reste de PAGINITY fonctionne)."
  fi
fi

# ------------------------------------------------------------------ 5. Lanceur
LANCEUR="$DOSSIER/lancer-paginity.sh"
if [ "$SIMU" = 1 ]; then LANCEUR="${PAGINITY_ESSAI_LANCEUR:-/tmp/lancer-paginity.sh}"; fi
cat > "$LANCEUR" <<LANCE
#!/usr/bin/env bash
# Démarre PAGINITY pour un essai sur cet ordinateur. Arrêt : Ctrl+C.
cd "$DOSSIER"
export PAGINITY_DATA_DIR="\${PAGINITY_DATA_DIR:-\$HOME/PAGINITY-essai/donnees}"
export PAGINITY_ATTENDRE_HORLOGE=non
mkdir -p "\$PAGINITY_DATA_DIR"
if [ "$IA" = 1 ] && command -v ollama >/dev/null && ! curl -fsS -m 3 $OLLAMA_URL/api/version >/dev/null 2>&1; then
  (nohup ollama serve >/tmp/ollama.log 2>&1 &); sleep 2
fi
echo "Ouvrez http://localhost:8080 dans votre navigateur."
exec npm start
LANCE
chmod +x "$LANCEUR"

dire "C'est prêt."
info "1. Démarrez PAGINITY : $LANCEUR"
info "2. Ouvrez http://localhost:8080 et saisissez le code d'installation affiché dans le terminal."
info "3. Réglages de la plateforme › Assistant IA › « Détecter les modèles installés » : vos modèles"
info "   sont ajoutés, puis « Lancer le banc d'essai » donne leurs notes."
info "Vos données d'essai sont dans ~/PAGINITY-essai (à supprimer pour repartir de zéro)."
