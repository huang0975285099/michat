---
name: build-release
description: Build and package Yunmi app — upgrade version, build EXE (Tauri NSIS) and APK (Android). Use when the user asks to upgrade version, package, build release, build apk, build exe, or ship. Do not use for dev builds or web-only builds.
---

# Yunmi Build & Release

## Version Upgrade

**Do NOT bump the version unless the user explicitly asks to upgrade the version.** "打包最新 exe 和 apk" / "package the latest" means build from current code at the current version — never treat "latest" as a version-bump request. If ambiguous, ask first.

When upgrading the version (e.g. 1.2.4 → 1.2.5), update **all 7 places** — the 5 client build files **and the 2 server-advertised fields**:

| File | Field |
|------|-------|
| `frontend/package.json` | `"version"` |
| `frontend/src-capacitor/package.json` | `"version"` |
| `frontend/src-tauri/Cargo.toml` | `version =` |
| `frontend/src-tauri/Cargo.lock` | `version =` (under `[[package]] name = "yunmi"`) |
| `frontend/src-capacitor/android/app/build.gradle` | `versionName` **and** `versionCode` (increment by 1) |
| `docker-compose.yml` | `APP_LATEST_VERSION` (production source of truth for `/api/version`) |
| `backend/config.yaml` | `version.latest` (local/dev value; compose env overrides it in production) |

`tauri.conf.json` reads version from `../package.json` — no change needed there.

The `build-release.ps1` script validates that `package.json` version matches Android `versionName`; mismatch will throw.

**Do NOT stop at the binaries.** The upgrade prompt is entirely server-driven: the client calls `GET /api/version` once at app startup and compares its own `APP_VERSION` with `latest`. If the server still advertises the old version, old clients see nothing — building the installer locally publishes nothing. See [Publishing](#publishing-server-side-steps) below.

## Build Commands

### One-shot (EXE + APK)

```powershell
cd d:\project\michat\frontend
.\build-release.cmd -SkipTests
```

Drop `-SkipTests` to run lint + all test suites before building.

### EXE only (Tauri NSIS)

```powershell
cd d:\project\michat\frontend
pnpm run build:tauri
```

Output: `frontend/src-tauri/target/release/bundle/nsis/Yunmi_<version>_x64-setup.exe`

### APK only (Android release)

**Preferred — use Git Bash directly** (avoids `build-android.cmd` path issues).

When running from an agent/background terminal, MSYS bash may inherit an invalid stdout handle and die immediately with `echo: write error: Bad file descriptor` (exit 1, no visible output). Always redirect output to a log file in that case:

```powershell
cd d:\project\michat\frontend
& "D:\Program Files\Git\bin\bash.exe" "./build-android.sh" release *> .\build-android.log
```

Then poll `build-android.log` to watch progress. (Interactive terminals usually work without the redirect.)

Or if `build-android.cmd` finds Git Bash correctly:

```powershell
cd d:\project\michat\frontend
.\build-android.cmd release
```

Output: `frontend/dist/yunChat-<timestamp>-release.apk`

### APK debug

```powershell
& "D:\Program Files\Git\bin\bash.exe" "D:\project\michat\frontend\build-android.sh" debug
```

## Known Pitfalls

### 1. build-android.cmd cannot find Git Bash

`build-android.cmd` looks for Git Bash at `D:\Program Files\Git\bin\bash.exe` or `C:\Program Files\Git\bin\bash.exe`. If Git is installed elsewhere, set the `GIT_BASH` environment variable:

```powershell
$env:GIT_BASH = "C:\Your\Path\to\git\bin\bash.exe"
```

**Workaround**: Call `build-android.sh` directly via Git Bash (see commands above). This bypasses the cmd wrapper entirely.

When `build-release.ps1` fails at the APK step due to this issue, the EXE is already built successfully — just run the APK build separately via Git Bash.

### 2. AGP version too high for Android Studio

Capacitor generates AGP 8.13.0 in `src-capacitor/android/build.gradle`, but Android Studio may only support up to 8.12.1. The `build-android.sh` script has `fix_agp_version()` that auto-downgrades. If running Gradle manually without the script, apply the fix:

```
sed -i 's/gradle:8\.13\.0/gradle:8.12.1/g' src-capacitor/android/build.gradle
```

### 3. Android signing prerequisites

Release APK signing requires:
- `frontend/yunChat.jks` — the keystore file
- `frontend/src-capacitor/android/keystore.properties` — store password, key alias, key password

Without these, Gradle produces an unsigned APK (`app-release-unsigned.apk`).

### 4. Rust/Tauri build prerequisites

- `cargo` must be on PATH (or at `%USERPROFILE%\.cargo\bin\cargo.exe`)
- Rust edition 2021, rust-version 1.77.2 minimum
- Release profile uses `lto = true`, `codegen-units = 1`, `opt-level = "s"` — compile time is ~2-3 min

### 5. JDK for Android

Android Studio's bundled JBR (JDK 21) is at `D:\Program Files\Android\Android Studio\jbr`. The `build-android.sh` script auto-detects this. If Android Studio is installed elsewhere, set `JAVA_HOME` manually.

## Post-Build

Copy release files to `dist/` and `downloads/` with canonical names:

```powershell
# EXE
Copy-Item "frontend\src-tauri\target\release\bundle\nsis\Yunmi_<version>_x64-setup.exe" "frontend\dist\yunChat.exe" -Force
Copy-Item "frontend\src-tauri\target\release\bundle\nsis\Yunmi_<version>_x64-setup.exe" "downloads\yunChat.exe" -Force

# APK
Copy-Item "frontend\dist\yunChat-<timestamp>-release.apk" "frontend\dist\yunChat.apk" -Force
Copy-Item "frontend\dist\yunChat-<timestamp>-release.apk" "downloads\yunChat.apk" -Force

# SHA256 checksums
$files = @("downloads\yunChat.exe", "downloads\yunChat.apk")
$lines = foreach ($f in $files) { $h = (Get-FileHash $f -Algorithm SHA256).Hash.ToLower(); "$h  $(Split-Path $f -Leaf)" }
[System.IO.File]::WriteAllText("downloads\SHA256SUMS.txt", ($lines -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
```

## Publishing (server-side steps)

The in-app upgrade prompt reads `GET /api/version` (served by `backend/internal/handler/version.go`, values injected by `main.go` from env / `config.yaml`). Shipping a release requires all of:

1. **Advertise the new version** — `docker-compose.yml` `APP_LATEST_VERSION` (and `backend/config.yaml` `version.latest`). Env vars are read once at process start, so the backend container must be recreated (`docker compose up -d backend`).
2. **Upload the installers** — `APP_WINDOWS_UPDATE_URL` / `APP_APK_UPDATE_URL` point at fixed canonical names (`/download/yunChat.exe`, `/download/yunChat.apk`), nginx-served from `/usr/share/nginx/html/download/`. Copy the freshly built `downloads/yunChat.exe` and `downloads/yunChat.apk` there, otherwise users are prompted to update and then download the previous build.
3. **Verify** — `curl https://m.yzs88.com:8088/api/version` must return the new `latest`.

Behavior of `getUpdateStatus(current, latest, min_supported)`: `current < min_supported` → forced update; `current < latest` → "available" banner (native clients only); equal/greater → no prompt. So users on the version being replaced see nothing until `APP_LATEST_VERSION` is bumped. The check runs once at app startup — users must restart the app (or use "检查更新" in ProfilePage) to see it.

## Output Files

| Name | Location | Description |
|------|----------|-------------|
| `yunChat.exe` | `dist/`, `downloads/` | Windows NSIS installer |
| `yunChat.apk` | `dist/`, `downloads/` | Android release APK (signed) |
| `SHA256SUMS.txt` | `dist/`, `downloads/` | SHA256 checksums for both |
