param([Parameter(Mandatory=$true)][ValidateSet('win-x64','win-arm64')][string]$Rid)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\tools'))
$path = Join-Path $root "$Rid\devcel.exe"
foreach ($item in @((Split-Path $root), $root, (Join-Path $root "manifest.json"), (Split-Path $path), $path)) {
    if ((Get-Item -LiteralPath $item).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Symlink/reparse paths are not supported for bundled CLI' }
}
(Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
