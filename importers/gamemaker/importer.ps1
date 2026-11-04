param([string]$Root = (Get-Location).Path)
$ErrorActionPreference = 'Stop'
$rid = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
$tools = Join-Path $PSScriptRoot 'tools'
$manifestPath = Join-Path $tools 'manifest.json'
$binary = Join-Path $tools "$rid\devcel.exe"
foreach ($path in @($PSScriptRoot,$tools,(Split-Path $binary),$binary,$manifestPath)) {
    $item = Get-Item -LiteralPath $path
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a symlink/reparse path in bundled CLI' }
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schema_version -ne 1) { throw 'Invalid CLI manifest; reinstall the matching ZIP' }
$entry = $manifest.binaries.$rid
if (!$entry -or $entry.path -ne "$rid/devcel.exe" -or $entry.sha256 -notmatch '^[0-9a-f]{64}$') { throw 'CLI platform/checksum missing' }
if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw 'CLI checksum mismatch; reinstall ZIP' }
& $binary importer-ui --engine gamemaker --root ([IO.Path]::GetFullPath($Root))
exit $LASTEXITCODE
