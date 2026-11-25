# One-command Android dev launch: `npm run android`.
#
# Wraps `tauri android dev` so you don't have to set up the Android env or boot an
# emulator by hand each time. It:
#   1. Discovers the Android SDK + NDK (no hardcoded machine paths - this is a public repo).
#   2. Boots an emulator if no device/emulator is already connected.
#   3. Runs `tauri android dev` against it.
#
# Everything is auto-detected with env-var overrides, so it works on any dev's machine:
#   ANDROID_HOME / ANDROID_SDK_ROOT  - SDK location (falls back to %LOCALAPPDATA%\Android\Sdk)
#   NDK_HOME                         - specific NDK (falls back to the newest installed under $SDK\ndk)
#   ANDROID_AVD_HOME                 - where AVDs live (optional; only set if you moved them off C:)
#   SIGNBIT_AVD                      - which AVD to boot (falls back to the first one found)
#   GRADLE_USER_HOME                 - Gradle cache location (optional; leave default unless C: is full)
#
# No-op friendly: if an emulator/device is already connected it skips the boot and just runs dev.
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads a BOM-less script as the
# legacy ANSI codepage, so non-ASCII punctuation (em-dashes, etc.) corrupts parsing.

$ErrorActionPreference = 'Stop'

# --- 0. Optional local overrides (gitignored, machine-specific) --------------
# If you moved AVDs / the Gradle cache off C: (e.g. a full system drive), put your
# machine-specific paths in scripts/android-dev.local.ps1 (gitignored, never shipped):
#   $env:ANDROID_AVD_HOME  = "D:\android\avd"
#   $env:GRADLE_USER_HOME  = "D:\android\gradle"
# Most devs won't need this file at all - the defaults (C:) just work.
$localOverrides = Join-Path $PSScriptRoot 'android-dev.local.ps1'
if (Test-Path $localOverrides) {
  Write-Host "[android] Loading local overrides: $localOverrides"
  . $localOverrides
}

# --- 1. Locate the SDK -------------------------------------------------------
$sdk = $env:ANDROID_HOME
if (-not $sdk) { $sdk = $env:ANDROID_SDK_ROOT }
if (-not $sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not (Test-Path $sdk)) {
  Write-Error "Android SDK not found. Install Android Studio, or set ANDROID_HOME to your SDK path. Looked in: $sdk"
  exit 1
}
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
Write-Host "[android] SDK: $sdk"

# --- 2. Locate the NDK (newest installed unless NDK_HOME is set) --------------
if (-not $env:NDK_HOME) {
  $ndkRoot = Join-Path $sdk 'ndk'
  if (Test-Path $ndkRoot) {
    $newest = Get-ChildItem $ndkRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if ($newest) { $env:NDK_HOME = $newest.FullName }
  }
}
if (-not $env:NDK_HOME -or -not (Test-Path $env:NDK_HOME)) {
  Write-Error "NDK not found. In Android Studio: SDK Manager > SDK Tools > check 'NDK (Side by side)'. Or set NDK_HOME."
  exit 1
}
Write-Host "[android] NDK: $($env:NDK_HOME)"

$adb = Join-Path $sdk 'platform-tools\adb.exe'
$emulator = Join-Path $sdk 'emulator\emulator.exe'

# --- 3. Boot an emulator only if nothing is connected ------------------------
# `adb devices` lists one line per device as "<serial><TAB>device" (or "offline"/"unauthorized").
# Match a line that ends in the word "device" but isn't the "List of devices attached" header.
$connected = (& $adb devices | Where-Object { $_ -match '\bdevice$' -and $_ -notmatch 'List of devices' })
if ($connected) {
  Write-Host "[android] A device/emulator is already connected - skipping boot."
} else {
  # Pick the AVD: SIGNBIT_AVD override, else the first one the emulator lists.
  $avd = $env:SIGNBIT_AVD
  if (-not $avd) {
    $avd = (& $emulator -list-avds | Select-Object -First 1)
  }
  if (-not $avd) {
    Write-Error "No emulator (AVD) found. Create one in Android Studio > Device Manager, or set SIGNBIT_AVD."
    exit 1
  }
  Write-Host "[android] Booting emulator '$avd' (a window will open)..."
  # Launch detached so this script can move on to `tauri android dev`.
  Start-Process -FilePath $emulator -ArgumentList @('-avd', $avd, '-no-snapshot-load') -WindowStyle Normal

  Write-Host "[android] Waiting for the emulator to finish booting..."
  & $adb wait-for-device
  do {
    Start-Sleep -Seconds 3
    $booted = (& $adb shell getprop sys.boot_completed 2>$null).Trim()
  } while ($booted -ne '1')
  Write-Host "[android] Emulator booted."
}

# --- 4. Run tauri android dev ------------------------------------------------
Write-Host "[android] Starting tauri android dev..."
& npx tauri android dev
