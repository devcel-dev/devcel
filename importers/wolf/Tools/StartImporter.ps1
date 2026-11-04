# Windows-standard launcher. No Python, Node.js, or separately installed CLI required.
param([string]$TitleRoot = '')
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Windows.Forms
    if (-not $TitleRoot) {
        $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
        $dialog.Description = 'Select the WOLF game folder containing Data'
        $dialog.ShowNewFolderButton = $false
        if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }
        $TitleRoot = $dialog.SelectedPath
    }
    $TitleRoot = (Resolve-Path -LiteralPath $TitleRoot).Path
    if (-not (Test-Path -LiteralPath (Join-Path $TitleRoot 'Data') -PathType Container)) {
        throw 'Data folder not found. Select the WOLF game root folder.'
    }
    # Use OS architecture: 32-bit PowerShell on a 64-bit system must still pick x64.
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $rid = switch ($architecture.ToUpperInvariant()) { 'AMD64' { 'win-x64' } 'ARM64' { 'win-arm64' } default { throw "Unsupported CPU: $architecture" } }
    $bin = Join-Path $PSScriptRoot 'bin'
    function Assert-NoReparse([string]$file) {
        $current = Get-Item -LiteralPath $file -Force
        while ($null -ne $current) {
            if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Cannot launch the CLI through a link: $($current.FullName)" }
            $current = if ($current -is [IO.FileInfo]) { $current.Directory } else { $current.Parent }
        }
    }
    $manifestPath = Join-Path $bin 'manifest.json'
    Assert-NoReparse $manifestPath
    $manifest = Get-Content -LiteralPath $manifestPath -Encoding UTF8 -Raw | ConvertFrom-Json
    if ($manifest.schema_version -ne 1 -or $manifest.supportedPlatforms -notcontains $rid) {
        throw 'Invalid bundled CLI manifest. Extract the Importer ZIP again.'
    }
    $entry = $manifest.binaries.$rid
    if ($entry.path -cne "$rid/devcel.exe" -or $entry.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid CLI entry.' }
    $binary = Join-Path $bin ($entry.path.Replace('/', '\'))
    Assert-NoReparse $binary
    if ((Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) { throw 'CLI SHA256 mismatch. Extract the Importer ZIP again.' }
    Write-Host 'Opening import settings in your browser. When finished, press Ctrl+C in this window to exit.'
    & $binary importer-ui --engine wolf --root $TitleRoot
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
