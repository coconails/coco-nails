# essai-windows.ps1 : installer PAGINITY pour l'ESSAYER sur un PC Windows 10 (2004+) ou 11.
#
# PAGINITY a besoin d'un environnement Linux : Windows le fournit gratuitement avec WSL (« sous-système Windows pour
# Linux »). Ce script :
#   1. regarde la machine (version de Windows, mémoire, place libre) ;
#   2. installe WSL avec Ubuntu s'il manque (demande les droits d'administrateur, puis un REDÉMARRAGE :
#      relancez ce script ensuite) ;
#   3. copie PAGINITY dans Ubuntu (plus rapide que de travailler sur le disque C:) et y lance essai-ordinateur.sh,
#      qui installe Node.js, PAGINITY, Ollama et les modèles d'IA adaptés (en demandant avant chaque étape) ;
#   4. pose sur le Bureau un raccourci « Lancer PAGINITY ».
#
# Utilisation : clic droit sur ce fichier > « Exécuter avec PowerShell »,
#   ou dans PowerShell : powershell -ExecutionPolicy Bypass -File scripts\essai-windows.ps1
$ErrorActionPreference = 'Stop'
function Dire($t) { Write-Host "`n[PAGINITY] $t" -ForegroundColor Yellow }
function Info($t) { Write-Host "  $t" }
function Demander($q) { $r = Read-Host "  $q [o/N]"; return $r -match '^(o|oui|y|yes)$' }
function Fin($code) { Read-Host "`nAppuyez sur Entrée pour fermer"; exit $code }

# 1. La machine
$build = [Environment]::OSVersion.Version.Build
$ramGo = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
$libreGo = [math]::Round((Get-PSDrive C).Free / 1GB)
Dire "Votre machine : Windows (build $build), mémoire $ramGo Go, place libre sur C: $libreGo Go."
if ($build -lt 19041) { Dire "Windows trop ancien pour WSL 2 : faites les mises à jour Windows (version 2004 ou plus)."; Fin 1 }
if ($libreGo -lt 10) { Dire "Il faut au moins 10 Go libres sur C:."; Fin 1 }

# 2. WSL + Ubuntu
$distros = ''
try { $distros = (wsl.exe --list --quiet 2>$null) -join ' ' -replace "`0", '' } catch { $distros = '' }
if ($distros -notmatch 'Ubuntu') {
  Dire "WSL avec Ubuntu n'est pas installé."
  if (-not (Demander "L'installer maintenant ? (fenêtre administrateur, puis redémarrage du PC)")) { Fin 1 }
  Start-Process wsl.exe -ArgumentList '--install', '-d', 'Ubuntu' -Verb RunAs -Wait
  Dire "Redémarrez le PC. Au redémarrage, Ubuntu vous demandera un nom d'utilisateur et un mot de passe (à retenir)."
  Info "Relancez ensuite ce script pour continuer."
  Fin 0
}

# 3. Copie de PAGINITY dans Ubuntu et installation
$source = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceWsl = (wsl.exe -d Ubuntu -- wslpath -a ($source -replace '\\', '/')).Trim()
Dire "Copie de PAGINITY dans Ubuntu (~/paginity)."
wsl.exe -d Ubuntu -- bash -lc "mkdir -p ~/paginity && cp -r '$sourceWsl/.' ~/paginity/ && rm -rf ~/paginity/node_modules"
Dire "Installation (Node.js, PAGINITY, Ollama, modèles) : répondez aux questions."
wsl.exe -d Ubuntu -- bash -lc "cd ~/paginity && bash scripts/essai-ordinateur.sh"
if ($LASTEXITCODE -ne 0) { Dire "L'installation s'est arrêtée (voir le message ci-dessus). Corrigez puis relancez ce script."; Fin 1 }

# 4. Raccourci sur le Bureau
$bureau = [Environment]::GetFolderPath('Desktop')
$bat = Join-Path $bureau 'Lancer PAGINITY.bat'
Set-Content -Path $bat -Encoding ASCII -Value "@echo off`r`ntitle PAGINITY`r`nwsl.exe -d Ubuntu -- bash -lc `"~/paginity/lancer-paginity.sh`"`r`npause"
Dire "C'est prêt. Double-cliquez sur « Lancer PAGINITY » (Bureau), puis ouvrez http://localhost:8080"
Fin 0
