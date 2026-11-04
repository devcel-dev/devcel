#!/usr/bin/env pwsh
# Build Windows executables and local importer folders
#Requires -Version 5.1
# Distribution packaging is opt-in; local builds do not generate release evidence.

param(
    [ValidateSet("release", "debug", "both")]
    [string]$Configuration = "both",  # "release", "debug", or "both"
    [switch]$SkipTauri = $false,
    [switch]$SkipImporters = $false,     # Skip all nine importer packages
    [switch]$Clean = $false,
    [switch]$Distribution, # Create verified distribution payloads instead of local outputs
    [string]$OutputDirectory,
    [string]$SourceRepository, # GitHub OWNER/REPO; Git checkouts default to their GitHub origin
    [string]$SourceCommit,     # Required for source archives; Git checkouts default to HEAD
    [switch]$NoOpen
)

# Windows PowerShell 5.1 delegates the build to PowerShell 7.
if ($PSVersionTable.PSVersion.Major -lt 7) {
    $candidates = @(Get-Command pwsh.exe -CommandType Application -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    $candidates += Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'
    $pwshPath = $null
    foreach ($candidate in @($candidates | Select-Object -Unique)) {
        if (!(Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            $major = & $candidate -NoLogo -NoProfile -Command '$PSVersionTable.PSVersion.Major' 2>$null
            if ($LASTEXITCODE -eq 0 -and @($major).Count -eq 1 -and "$major" -match '^\d+$' -and [int]$major -ge 7) {
                $pwshPath = $candidate
                break
            }
        } catch { continue }
    }
    if (!$pwshPath) {
        throw 'PowerShell 7 or later is required. No suitable pwsh.exe was found. Install it from https://aka.ms/powershell-release?tag=stable and reopen PowerShell.'
    }
    $forward = @{}
    foreach ($key in $PSBoundParameters.Keys) {
        $value = $PSBoundParameters[$key]
        if ($value -is [System.Management.Automation.SwitchParameter]) { $value = [bool]$value }
        $forward[$key] = $value
    }
    $payload = @{ Script = $PSCommandPath; Directory = (Get-Location).Path; Parameters = $forward } | ConvertTo-Json -Compress -Depth 5
    $data = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    $child = @'
$ErrorActionPreference = 'Stop'
try {
    $inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json -AsHashtable
    Set-Location -LiteralPath $inputData.Directory
    $parameters = $inputData.Parameters
    & $inputData.Script @parameters
    exit $LASTEXITCODE
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
'@
    $child = $child.Replace('__PAYLOAD__', $data)
    & $pwshPath -NoLogo -NoProfile -EncodedCommand ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($child)))
    exit $LASTEXITCODE
}

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false
# Cargo metadata is UTF-8 even when the Windows console uses a legacy code page.
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding

function Resolve-DevcelPython {
    # Both importer generation and Studio portable packaging require Python.
    # Probe capabilities before starting expensive builds; never infer success
    # from a Windows App Execution Alias or an embeddable interpreter's name.
    $probe = "import sys, tomllib, zipfile, tarfile, ssl, ctypes; sys.exit('Standard Python 3.11+ is required') if sys.version_info < (3, 11) or sys.flags.isolated else None; print('devcel-python-ready')"
    foreach ($name in @('python', 'py', 'python3')) {
        $prefix = @()
        if ($name -eq 'py') { $prefix = @('-3') }
        foreach ($command in @(Get-Command $name -CommandType Application -All -ErrorAction SilentlyContinue)) {
            try {
                $result = & $command.Source @prefix -c $probe 2>$null
                if ($LASTEXITCODE -eq 0 -and ($result -join "`n").Trim() -eq 'devcel-python-ready') {
                    return @{ Command = $command.Source; Prefix = $prefix }
                }
            } catch { continue }
        }
    }
    throw 'Python prerequisite failed: install standard Python 3.11+ with its standard library and script imports enabled, available as python, py -3, or python3, then reopen PowerShell 7. The isolated embeddable distribution is not supported.'
}

if (!$IsWindows) { throw "Run this script on native Windows." }
if ($Distribution -and !$SkipImporters) {
    # Only this directory's own checkout can supply provenance. In particular, a
    # source archive inside another checkout must not borrow its origin or HEAD.
    $hasLocalCheckout = Test-Path -LiteralPath (Join-Path $PSScriptRoot '.git')
    if ($hasLocalCheckout -and (!$PSBoundParameters.ContainsKey('SourceRepository') -or !$SourceCommit)) {
        try {
            $checkoutRoot = & git -C $PSScriptRoot rev-parse --show-toplevel 2>$null
            if ($LASTEXITCODE -ne 0 -or !$checkoutRoot -or @($checkoutRoot).Count -ne 1) { throw "Git checkout root is unavailable" }
            $actualRoot = [System.IO.Path]::GetFullPath($checkoutRoot.Trim()).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
            $expectedRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
            if (![string]::Equals($actualRoot, $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Git checkout root does not match this source directory" }
        } catch {
            throw "Cannot identify this source checkout. Specify -SourceRepository OWNER/REPO and -SourceCommit with the matching full commit hash."
        }
    }
    if (!$PSBoundParameters.ContainsKey('SourceRepository') -and $hasLocalCheckout) {
        try {
            $origin = & git -C $PSScriptRoot config --get remote.origin.url 2>$null
            if ($LASTEXITCODE -ne 0 -or !$origin -or @($origin).Count -ne 1) { throw "Git origin is unavailable" }
            # Accept only credential-free GitHub HTTPS or standard Git SSH URLs.
            # Never print the raw origin: a rejected URL may contain credentials.
            $githubOrigin = '^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([A-Za-z0-9][A-Za-z0-9_.-]*)/([A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?/?$'
            if ($origin -notmatch $githubOrigin) { throw "Origin is not a supported GitHub URL" }
            $SourceRepository = "$($Matches[1])/$($Matches[2])"
        } catch {
            throw "Cannot infer the source repository from a credential-free GitHub origin. Specify -SourceRepository OWNER/REPO containing the source revision."
        }
    }
    if ($SourceRepository -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$') {
        throw "Specify -SourceRepository OWNER/REPO containing the source revision for importer source links."
    }
    if ($SourceCommit -and $SourceCommit -notmatch '^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$') {
        throw "-SourceCommit must be a full Git commit hash."
    }
    if (!$SourceCommit -and !$hasLocalCheckout) {
        throw "This source archive has no Git checkout. Specify -SourceCommit using the commit recorded in BUILD-SOURCE.txt, and -SourceRepository OWNER/REPO containing that revision."
    }
}

# Prevent another invocation from modifying the same Cargo/npm output concurrently.
if ($SkipTauri -and $SkipImporters) { throw "Select at least one build: Studio or importers." }

$repoHash = [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($PSScriptRoot.ToLowerInvariant()))).Replace("-", "")
$buildMutex = New-Object System.Threading.Mutex($false, "Local\DevcelWindowsBuild_$repoHash")
try { $hasBuildLock = $buildMutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $hasBuildLock = $true }
if (!$hasBuildLock) { $buildMutex.Dispose(); throw "Another Windows package build is already running for this repository." }

$locationPushed = $false
$transcriptStarted = $false
$logFile = $null
try {
if (!$OutputDirectory) { Add-Type -AssemblyName System.Windows.Forms }

# Function to show folder browser dialog
function Get-OutputDirectory {
    $folderBrowser = New-Object System.Windows.Forms.FolderBrowserDialog
    try {
    $folderBrowser.Description = "Select output directory for build artifacts"
    $folderBrowser.RootFolder = [System.Environment+SpecialFolder]::MyComputer
    $folderBrowser.ShowNewFolderButton = $true

    # Set initial directory to Desktop
    $initialPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::Desktop)
    $folderBrowser.SelectedPath = $initialPath

    $result = $folderBrowser.ShowDialog()

    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
        return $folderBrowser.SelectedPath
    } else {
        Write-Host "Build cancelled by user." -ForegroundColor Yellow
        return $null
    }
    } finally { $folderBrowser.Dispose() }
}

# Main script starts here
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Devcel Windows Build Script" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Get output directory from user
$baseOutputDir = if ($OutputDirectory) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory) } else { Get-OutputDirectory }
if (!$baseOutputDir) { return }
Write-Host "Base output directory: $baseOutputDir" -ForegroundColor Green

# Create timestamp subdirectory
$buildStarted = [DateTimeOffset]::UtcNow
$buildEpoch = $buildStarted.ToUnixTimeSeconds()
$timestamp = $buildStarted.ToLocalTime().ToString("yyyyMMdd_HHmmss_fff")
$outputDir = Join-Path $baseOutputDir "Build_$timestamp"
New-Item -ItemType Directory -Path $outputDir -ErrorAction Stop | Out-Null
Write-Host "Created output directory: $outputDir" -ForegroundColor Green
Write-Host ""

# Create subdirectories for different artifacts
$tauriReleaseDir = Join-Path $outputDir "TauriApp_Release"
$tauriDebugDir = Join-Path $outputDir "TauriApp_Debug"
$unityOutputDir = Join-Path $outputDir "Importers"
$logFile = Join-Path $outputDir "build_log.txt"

# Start logging
Start-Transcript -LiteralPath $logFile | Out-Null
$transcriptStarted = $true
    # Create output directories
    if ($Configuration -eq "release" -or $Configuration -eq "both") {
        if (!$SkipTauri -and !(Test-Path -LiteralPath $tauriReleaseDir)) {
            New-Item -ItemType Directory -Path $tauriReleaseDir -Force | Out-Null
        }
    }
    if ($Configuration -eq "debug" -or $Configuration -eq "both") {
        if (!$SkipTauri -and !(Test-Path -LiteralPath $tauriDebugDir)) {
            New-Item -ItemType Directory -Path $tauriDebugDir -Force | Out-Null
        }
    }

    # Get script directory (project root)
    $projectRoot = $PSScriptRoot
    Push-Location -LiteralPath $projectRoot
    $locationPushed = $true

    $python = Resolve-DevcelPython
    $pythonPrefix = @($python.Prefix)

    # Fail with installation guidance before invoking Cargo metadata.
    foreach ($rustCommand in @('cargo', 'rustc', 'rustup')) {
        if (!(Get-Command $rustCommand -CommandType Application -ErrorAction SilentlyContinue)) {
            throw "Rust prerequisite failed: '$rustCommand' was not found. Install the pinned MSVC toolchain using https://rustup.rs/ and reopen PowerShell 7."
        }
    }

    $metadataJson = & cargo metadata --locked --no-deps --format-version 1
    if ($LASTEXITCODE -ne 0) { throw "Cargo metadata failed (exit $LASTEXITCODE)" }
    $cargoTargetDir = (($metadataJson -join "`n") | ConvertFrom-Json).target_directory
    $tauriConfig = Get-Content -LiteralPath (Join-Path $projectRoot "devcel-studio/src-tauri/tauri.conf.json") -Encoding utf8 -Raw | ConvertFrom-Json

    # Clean if requested
    if ($Clean) {
        Write-Host "Cleaning previous builds..." -ForegroundColor Yellow
        $targetPath = [System.IO.Path]::GetFullPath($cargoTargetDir)
        if (!$targetPath.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Clean target must be inside the repository: $targetPath"
        }
        $checkPath = $targetPath
        while ($checkPath -and $checkPath -ne $projectRoot) {
            if ((Test-Path -LiteralPath $checkPath) -and ((Get-Item -LiteralPath $checkPath).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
                throw "Clean target traverses a junction or symbolic link: $checkPath"
            }
            $checkPath = Split-Path -Parent $checkPath
        }
        if ($outputDir.StartsWith($targetPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Output directory must be outside the Cargo clean target."
        }
        if (Test-Path -LiteralPath $targetPath) {
            Remove-Item -LiteralPath $targetPath -Recurse -Force
        }
        Write-Host "Clean completed." -ForegroundColor Green
    }

    # Check prerequisites
    Write-Host "Checking prerequisites..." -ForegroundColor Yellow

    # Check Rust
    try {
        $rustVersion = rustc --version
        if ($LASTEXITCODE -ne 0) { throw "rustc failed (exit $LASTEXITCODE)" }
        $toolchainText = Get-Content -LiteralPath (Join-Path $projectRoot 'rust-toolchain.toml') -Encoding utf8 -Raw
        $expectedRust = [regex]::Match($toolchainText, '(?m)^channel\s*=\s*"([^"]+)"').Groups[1].Value
        if (!$expectedRust -or ($rustVersion.Trim() -split '\s+')[1] -ne $expectedRust) {
            throw "Rust $expectedRust is required (found $rustVersion). Check rust-toolchain.toml and RUSTUP_TOOLCHAIN."
        }
        Write-Host "[OK] Rust: $rustVersion" -ForegroundColor Green
    } catch {
        throw "Rust prerequisite failed: $_. Install the pinned MSVC toolchain using https://rustup.rs/"
    }

    # Resolve Volta's project pins from Studio, as the later npm build does.
    if (!$SkipTauri) {
        Push-Location -LiteralPath (Join-Path $projectRoot "devcel-studio")
        try {
            $studioPackage = Get-Content -LiteralPath "package.json" -Encoding utf8 -Raw | ConvertFrom-Json
            $nodeVersion = & node --version
            if ($LASTEXITCODE -ne 0) { throw "node failed (exit $LASTEXITCODE)" }
            $expectedNode = "v$($studioPackage.volta.node)"
            if ($nodeVersion.Trim() -ne $expectedNode) {
                throw "Node.js $expectedNode is required (found $nodeVersion). Install the version pinned in devcel-studio/package.json."
            }
            Write-Host "[OK] Node.js: $nodeVersion" -ForegroundColor Green
            $npmCommand = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
            $npmVersion = & $npmCommand --version
            if ($LASTEXITCODE -ne 0) { throw "npm failed (exit $LASTEXITCODE)" }
            if ($npmVersion.Trim() -ne $studioPackage.volta.npm) {
                throw "npm $($studioPackage.volta.npm) is required (found $npmVersion). Run npm install --global npm@$($studioPackage.volta.npm)."
            }
            Write-Host "[OK] npm: $npmVersion" -ForegroundColor Green
        } finally {
            Pop-Location
        }
    }

    # Add Windows MSVC target if not already added
    Write-Host "Ensuring Rust target is installed..." -ForegroundColor Yellow
    rustup target add x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) { throw "Rust target installation failed (exit $LASTEXITCODE)" }

    # Generated legal outputs are never maintained or hashed by hand.
    & $python.Command @pythonPrefix scripts/generate-third-party-notices.py --ensure
    if ($LASTEXITCODE -ne 0) { throw "License generation failed (exit $LASTEXITCODE)" }

    # Local executables are built in the current workspace, without vendoring or release evidence.
    if (!$Distribution) {
        foreach ($buildType in @('release', 'debug')) {
            if ($Configuration -ne 'both' -and $Configuration -ne $buildType) { continue }
            $nativeArgs = @('build', '--locked', '--target', 'x86_64-pc-windows-msvc', '-p', 'devcel-cli', '-p', 'devcel-runtime')
            if ($buildType -eq 'release') { $nativeArgs += '--release' }
            & cargo @nativeArgs
            if ($LASTEXITCODE -ne 0) { throw "CLI/runtime $buildType build failed (exit $LASTEXITCODE)" }
            if (!$SkipImporters) {
                & $python.Command @pythonPrefix scripts/local_build.py importers --repo $projectRoot --native-dir (Join-Path $cargoTargetDir "x86_64-pc-windows-msvc/$buildType") --out (Join-Path $unityOutputDir $buildType)
                if ($LASTEXITCODE -ne 0) { throw "Local importer staging failed (exit $LASTEXITCODE)" }
            }
        }
    }

    # Distribution packages retain the full source/license/provenance checks.
    if ($Distribution -and !$SkipImporters) {
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "  Building all nine Importer packages" -ForegroundColor Cyan
        Write-Host "========================================" -ForegroundColor Cyan

        Push-Location -LiteralPath $projectRoot
        try {
            # One fail-closed packaging path for all nine importers. Native Windows
            # builds include CLI bytes, manifest, licenses and matching source.
            $resolvedSourceCommit = $SourceCommit
            if (!$resolvedSourceCommit) {
                try {
                    $head = & git -C $projectRoot rev-parse HEAD
                    if ($LASTEXITCODE -ne 0 -or !$head) { throw "Git HEAD is unavailable" }
                    $resolvedSourceCommit = ($head -join "`n").Trim()
                } catch {
                    throw "Cannot identify Git HEAD. Specify -SourceCommit from BUILD-SOURCE.txt and the matching -SourceRepository OWNER/REPO."
                }
            }
            $env:PYTHONUTF8 = '1'
            & $python.Command @pythonPrefix scripts/package-importers.py --out $unityOutputDir --format directory --build-epoch $buildEpoch --platform win-x64 --source-repository $SourceRepository --source-commit $resolvedSourceCommit
            if ($LASTEXITCODE -ne 0) { throw "Importer packaging failed (exit $LASTEXITCODE)" }
            if (@(Get-ChildItem -LiteralPath $unityOutputDir -Filter 'devcel-*' -Directory).Count -ne 9) {
                throw "Expected all nine importer folders."
            }
            Write-Host "[OK] Verified nine CLI-bundled importer folders: $unityOutputDir" -ForegroundColor Green
        } finally {
            Pop-Location
        }
    }

    # Build Tauri Application
    if (!$SkipTauri) {
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "  Building Tauri Application" -ForegroundColor Cyan
        Write-Host "========================================" -ForegroundColor Cyan

        Push-Location -LiteralPath (Join-Path $projectRoot "devcel-studio")
        try {
            # Install npm dependencies
            Write-Host "Installing npm dependencies..." -ForegroundColor Yellow
            & $npmCommand ci --include=optional
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }
            & $npmCommand run check:tauri-contracts
            if ($LASTEXITCODE -ne 0) { throw "Tauri contract check failed (exit $LASTEXITCODE)" }
            & $npmCommand run typecheck
            if ($LASTEXITCODE -ne 0) { throw "Frontend type check failed (exit $LASTEXITCODE)" }

            # Function to copy build artifacts
            function Copy-TauriArtifacts {
                param(
                    [string]$BuildType,
                    [string]$TargetDir
                )

                Write-Host "Copying $BuildType build artifacts..." -ForegroundColor Yellow

                $buildPath = if ($BuildType -eq "release") { "release" } else { "debug" }

                $exePath = Join-Path $cargoTargetDir "x86_64-pc-windows-msvc/$buildPath/devcel-studio.exe"
                if (!(Test-Path -LiteralPath $exePath)) { throw "No standalone executable found at: $exePath" }
                if (!$Distribution) {
                    $localArgs = @('studio', '--repo', $projectRoot, '--native-dir', (Split-Path -Parent $exePath), '--out', $TargetDir)
                    if ($SourceCommit) { $localArgs += @('--source-commit', $SourceCommit) }
                    & $python.Command @pythonPrefix (Join-Path $projectRoot 'scripts/local_build.py') @localArgs
                    if ($LASTEXITCODE -ne 0) { throw "Local Studio staging failed (exit $LASTEXITCODE)" }
                    return
                }
                $archive = Join-Path $TargetDir "devcel-studio-$($tauriConfig.version)-windows-x64"
                $packager = Join-Path $projectRoot 'scripts/package-windows-studio.py'
                & $python.Command @pythonPrefix $packager --executable $exePath --out $archive --format directory --build-epoch $buildEpoch
                if ($LASTEXITCODE -ne 0) { throw "Portable Studio packaging failed (exit $LASTEXITCODE)" }
                if (!(Test-Path -LiteralPath $archive)) { throw "Portable Studio folder is missing: $archive" }
                Write-Host "[OK] Verified portable Studio folder: $archive" -ForegroundColor Green
            }

            foreach ($buildType in @('release', 'debug')) {
                if ($Configuration -ne 'both' -and $Configuration -ne $buildType) { continue }
                Write-Host "Building Studio ($buildType)..." -ForegroundColor Yellow
                $buildScript = if ($buildType -eq 'debug') { 'tauri:build:debug' } else { 'tauri:build' }
                $tauriArgs = @('run', $buildScript, '--', '--target', 'x86_64-pc-windows-msvc', '--no-bundle')
                if (!$Distribution) { $tauriArgs += @('--config', (Join-Path $projectRoot 'scripts/tauri-local.conf.json')) }
                & $npmCommand @tauriArgs
                if ($LASTEXITCODE -ne 0) { throw "Studio $buildType build failed (exit $LASTEXITCODE)" }
                if ($Distribution) {
                    $cliPrepare = Join-Path $projectRoot 'scripts/studio_cli.py'
                    $cliTarget = Join-Path $cargoTargetDir 'x86_64-pc-windows-msvc'
                    $cliArgs = @('--repo', $projectRoot, '--target-dir', $cliTarget, '--platform', 'win-x64', '--profile', $buildType, '--target', 'x86_64-pc-windows-msvc')
                    if ($SourceCommit) { $cliArgs += @('--source-commit', $SourceCommit) }
                    & $python.Command @pythonPrefix $cliPrepare @cliArgs
                    if ($LASTEXITCODE -ne 0) { throw "Studio bundled CLI preparation failed (exit $LASTEXITCODE)" }
                }
                $destination = if ($buildType -eq 'debug') { $tauriDebugDir } else { $tauriReleaseDir }
                Copy-TauriArtifacts -BuildType $buildType -TargetDir $destination
            }

        } finally {
            Pop-Location
        }
    }

    # Create summary file
    $summaryFile = Join-Path $outputDir "build_summary.txt"
    $summary = @"
Devcel Windows Build Summary
===========================
Build Date (UTC): $($buildStarted.ToString("o"))
Configuration: $Configuration
Distribution packages: $Distribution
Output Directory: $outputDir

Artifacts:
----------
"@

    if (!$SkipTauri) {
        if ($Configuration -eq "release" -or $Configuration -eq "both") {
            $summary += "`nTauri Application (Release): $tauriReleaseDir"
            $tauriReleaseFiles = Get-ChildItem -LiteralPath $tauriReleaseDir -Recurse -File -ErrorAction SilentlyContinue
            foreach ($file in $tauriReleaseFiles) {
                $summary += "`n  - $($file.FullName.Substring($outputDir.Length + 1)) ($([math]::Round($file.Length / 1MB, 2)) MB)"
            }
        }

        if ($Configuration -eq "debug" -or $Configuration -eq "both") {
            $summary += "`n`nTauri Application (Debug): $tauriDebugDir"
            $tauriDebugFiles = Get-ChildItem -LiteralPath $tauriDebugDir -Recurse -File -ErrorAction SilentlyContinue
            foreach ($file in $tauriDebugFiles) {
                $summary += "`n  - $($file.FullName.Substring($outputDir.Length + 1)) ($([math]::Round($file.Length / 1MB, 2)) MB)"
            }
        }
    }

    if (!$SkipImporters) {
        $summary += "`n`nImporter folders: $unityOutputDir"
        $unityFiles = Get-ChildItem -LiteralPath $unityOutputDir -Recurse -File -ErrorAction SilentlyContinue
        foreach ($file in $unityFiles) {
            $summary += "`n  - $($file.FullName.Substring($unityOutputDir.Length + 1)) ($([math]::Round($file.Length / 1MB, 2)) MB)"
        }
    }

    [System.IO.File]::WriteAllText($summaryFile, $summary, [System.Text.UTF8Encoding]::new($false))

    # Display summary
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Build Completed Successfully!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host $summary
    Write-Host ""
    Write-Host "Build log saved to: $logFile" -ForegroundColor Cyan
    Write-Host "Build summary saved to: $summaryFile" -ForegroundColor Cyan

    # Open output directory in Explorer
    Write-Host ""
    Write-Host "Opening output directory..." -ForegroundColor Yellow
    if (!$NoOpen) { Start-Process explorer.exe -ArgumentList "`"$outputDir`"" }

} catch {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "  Build Failed!" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "Error: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "Check the log file for details: $logFile" -ForegroundColor Yellow
    exit 1
} finally {
    try {
        if ($locationPushed) { Pop-Location }
        if ($transcriptStarted) { Stop-Transcript | Out-Null }
    } finally {
        $buildMutex.ReleaseMutex()
        $buildMutex.Dispose()
    }
}

