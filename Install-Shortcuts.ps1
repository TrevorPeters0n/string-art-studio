# Creates (or removes) Desktop and Start Menu shortcuts for String Art Studio.
#
#   powershell -ExecutionPolicy Bypass -File Install-Shortcuts.ps1
#   powershell -ExecutionPolicy Bypass -File Install-Shortcuts.ps1 -Remove
#
# Only ever touches these two .lnk files — nothing else on the system.

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = 'String Art Studio.lnk'

$targets = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) $name),
    (Join-Path ([Environment]::GetFolderPath('StartMenu')) "Programs\$name")
)

if ($Remove) {
    foreach ($t in $targets) {
        if (Test-Path $t) { Remove-Item $t -Force; Write-Host "removed  $t" }
        else { Write-Host "not there $t" }
    }
    Write-Host "`nShortcuts removed. The app folder itself is untouched."
    return
}

$vbs  = Join-Path $root 'Launch.vbs'
$icon = Join-Path $root 'icon.ico'
if (-not (Test-Path $vbs)) { throw "Launch.vbs not found next to this script." }

$shell = New-Object -ComObject WScript.Shell
foreach ($t in $targets) {
    $dir = Split-Path -Parent $t
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

    $lnk = $shell.CreateShortcut($t)
    $lnk.TargetPath       = "$env:SystemRoot\System32\wscript.exe"
    $lnk.Arguments        = """$vbs"""
    $lnk.WorkingDirectory = $root
    $lnk.Description      = 'Turn a photo into a nail-by-nail string art threading sequence'
    if (Test-Path $icon) { $lnk.IconLocation = "$icon,0" }
    $lnk.Save()
    Write-Host "created  $t"
}

Write-Host "`nDone. Launch it from the Desktop or the Start Menu."
Write-Host "To undo:  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Remove"
