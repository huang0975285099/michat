<#
.SYNOPSIS
Builds the Yunmi Windows installer and signed Android release APK.

.EXAMPLE
.\build-release.ps1

.EXAMPLE
.\build-release.ps1 -SkipTests

.EXAMPLE
.\build-release.ps1 -WindowsOnly

.EXAMPLE
.\build-release.ps1 -AndroidOnly
#>

[CmdletBinding()]
param(
    [switch]$SkipTests,
    [switch]$WindowsOnly,
    [switch]$AndroidOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($WindowsOnly -and $AndroidOnly) {
    throw 'WindowsOnly and AndroidOnly cannot be used together.'
}

$frontendDir = $PSScriptRoot
$repoDir = Split-Path -Parent $frontendDir
$distDir = Join-Path $frontendDir 'dist'
$downloadDir = Join-Path $repoDir 'downloads'
$packageJsonPath = Join-Path $frontendDir 'package.json'
$androidGradlePath = Join-Path $frontendDir 'src-capacitor\android\app\build.gradle'
$buildWindows = -not $AndroidOnly
$buildAndroid = -not $WindowsOnly

function Write-Step {
    param([string]$Message)
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Invoke-Checked {
    param(
        [string]$Label,
        [scriptblock]$Command
    )

    Write-Step $Label
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

function Require-File {
    param(
        [string]$Path,
        [string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description was not found: $Path"
    }
}

function Copy-ReleaseFile {
    param(
        [string]$Source,
        [string]$FileName
    )

    Require-File -Path $Source -Description $FileName
    Copy-Item -LiteralPath $Source -Destination (Join-Path $distDir $FileName) -Force
    Copy-Item -LiteralPath $Source -Destination (Join-Path $downloadDir $FileName) -Force
}

function Get-Sha256 {
    param([string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

Require-File -Path $packageJsonPath -Description 'Frontend package.json'
$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpmCommand) {
    throw 'pnpm was not found. Install Node.js and pnpm, then reopen the terminal.'
}
$pnpmPath = $pnpmCommand.Source

if ($buildWindows) {
    $cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
    if (-not $cargoCommand) {
        $cargoPath = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
        if (Test-Path -LiteralPath $cargoPath -PathType Leaf) {
            $env:PATH = "$(Split-Path -Parent $cargoPath);$env:PATH"
            $cargoCommand = Get-Command cargo -ErrorAction SilentlyContinue
        }
    }
    if (-not $cargoCommand) {
        throw 'Rust cargo was not found. Install Rust with rustup, then reopen the terminal.'
    }
}

$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$version = [string]$packageJson.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw 'package.json does not contain a valid version.'
}

if ($buildAndroid) {
    Require-File -Path $androidGradlePath -Description 'Android build.gradle'
    $androidGradle = Get-Content -LiteralPath $androidGradlePath -Raw
    $androidVersionMatch = [regex]::Match($androidGradle, 'versionName\s+["'']([^"'']+)["'']')
    if (-not $androidVersionMatch.Success) {
        throw 'Android versionName was not found in build.gradle.'
    }
    if ($androidVersionMatch.Groups[1].Value -ne $version) {
        throw "Version mismatch: package.json=$version, Android=$($androidVersionMatch.Groups[1].Value)."
    }

    Require-File -Path (Join-Path $frontendDir 'yunChat.jks') -Description 'Android signing keystore'
    Require-File -Path (Join-Path $frontendDir 'src-capacitor\android\keystore.properties') -Description 'Android signing properties'
    Require-File -Path (Join-Path $frontendDir 'build-android.cmd') -Description 'Android build script'
}

New-Item -ItemType Directory -Force -Path $distDir, $downloadDir | Out-Null

Push-Location $frontendDir
try {
    Write-Host "Yunmi Release $version" -ForegroundColor Green

    if (-not $SkipTests) {
        $testScripts = @(
            'lint',
            'test:i18n',
            'test:update',
            'test:chat-preferences',
            'test:chat-watermark',
            'test:chat-message-content',
            'test:image-selection',
            'test:image-compression',
            'test:version',
            'test:file-metadata',
            'test:file-download',
            'test:voice',
            'test:call',
            'test:ironfist',
            'test:sugar-pop'
        )
        foreach ($testScript in $testScripts) {
            Invoke-Checked -Label "Running $testScript" -Command { & $pnpmPath run $testScript }
        }
    } else {
        Write-Host 'Tests skipped by request.' -ForegroundColor Yellow
    }

    if ($buildWindows) {
        Invoke-Checked -Label 'Building Windows NSIS installer' -Command { & $pnpmPath run build:tauri }
        $windowsInstaller = Join-Path $frontendDir "src-tauri\target\release\bundle\nsis\Yunmi_${version}_x64-setup.exe"
        Copy-ReleaseFile -Source $windowsInstaller -FileName 'yunChat.exe'
    }

    if ($buildAndroid) {
        Invoke-Checked -Label 'Building signed Android release APK' -Command { & (Join-Path $frontendDir 'build-android.cmd') release }
        $androidApk = Join-Path $frontendDir 'src-capacitor\android\app\build\outputs\apk\release\app-release.apk'
        Copy-ReleaseFile -Source $androidApk -FileName 'yunChat.apk'

        $sdkRoot = if ($env:ANDROID_SDK_ROOT) {
            $env:ANDROID_SDK_ROOT
        } elseif ($env:ANDROID_HOME) {
            $env:ANDROID_HOME
        } else {
            Join-Path $env:LOCALAPPDATA 'Android\Sdk'
        }
        $apksigner = Get-ChildItem -LiteralPath (Join-Path $sdkRoot 'build-tools') -Filter 'apksigner.bat' -Recurse -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($apksigner) {
            Invoke-Checked -Label 'Verifying APK signature' -Command { & $apksigner.FullName verify --verbose (Join-Path $distDir 'yunChat.apk') }
        } else {
            Write-Warning 'apksigner was not found; Gradle completed signing, but the extra signature verification was skipped.'
        }
    }

    $releaseFiles = @()
    foreach ($name in 'yunChat.exe', 'yunChat.apk') {
        $path = Join-Path $downloadDir $name
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $releaseFiles += Get-Item -LiteralPath $path
        }
    }

    $checksumLines = foreach ($file in $releaseFiles) {
        $hash = (Get-Sha256 -Path $file.FullName).ToLowerInvariant()
        "$hash  $($file.Name)"
    }
    $checksumText = ($checksumLines -join "`n") + "`n"
    [System.IO.File]::WriteAllText((Join-Path $downloadDir 'SHA256SUMS.txt'), $checksumText, [System.Text.UTF8Encoding]::new($false))
    [System.IO.File]::WriteAllText((Join-Path $distDir 'SHA256SUMS.txt'), $checksumText, [System.Text.UTF8Encoding]::new($false))

    Write-Step 'Release build completed'
    foreach ($file in $releaseFiles) {
        $hash = Get-Sha256 -Path $file.FullName
        Write-Host ("{0} ({1:N0} bytes)" -f $file.FullName, $file.Length) -ForegroundColor Green
        Write-Host "SHA256: $hash"
    }
} finally {
    Pop-Location
}
