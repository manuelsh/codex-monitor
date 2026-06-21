$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "Codex Monitor.lnk"
$launcherPath = Join-Path $repoRoot "Codex Monitor.cmd"
$iconPath = Join-Path $repoRoot "assets\codex-monitor.ico"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcherPath
$shortcut.WorkingDirectory = $repoRoot
if (Test-Path -LiteralPath $iconPath) {
  $shortcut.IconLocation = "$iconPath,0"
} else {
  $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
}
$shortcut.Description = "Start Codex Monitor"
$shortcut.Save()

Write-Host "Created $shortcutPath"
