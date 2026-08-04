#!/bin/bash

# ================================
# E2EE Chat - Android APK build script
# ================================
# Prerequisites:
#   - Node.js + pnpm
# - Android Studio (built-in JDK 21)
# - Android SDK (installed via Android Studio)
#
# Default path (Windows):
#   Android Studio: D:\Program Files\Android\Android Studio
#   Android SDK:    %LOCALAPPDATA%\Android\Sdk

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Android Studio built-in JDK 21 path
STUDIO_JBR_WIN="D:/Program Files/Android/Android Studio/jbr"
STUDIO_JBR_WSL="/mnt/d/Program Files/Android/Android Studio/jbr"
ANDROID_SDK_PATH="${LOCALAPPDATA}/Android/Sdk"

setup_env() {
    local jbr_found=""
    if [ -f "${STUDIO_JBR_WIN}/bin/java.exe" ]; then
        export JAVA_HOME="${STUDIO_JBR_WIN}"
        jbr_found="win"
    elif [ -f "${STUDIO_JBR_WSL}/bin/java.exe" ]; then
        export JAVA_HOME="${STUDIO_JBR_WSL}"
        jbr_found="wsl"
    elif [ -n "$JAVA_HOME" ]; then
        jbr_found="env"
    elif command -v java &>/dev/null; then
        JAVA_HOME="$(dirname "$(dirname "$(command -v java)")")"
        export JAVA_HOME
        jbr_found="path"
    else
        log_error "not found JDK，Please install Android Studio or set JAVA_HOME"
        exit 1
    fi

    case "$jbr_found" in
        win) log_info "Use Android Studio JBR (Windows): $JAVA_HOME" ;;
        wsl) log_info "Use Android Studio JBR (WSL): $JAVA_HOME" ;;
        env) log_info "Use the system JAVA_HOME: $JAVA_HOME" ;;
        path) log_info "from java command inference JAVA_HOME: $JAVA_HOME" ;;
    esac

    if [ -z "$ANDROID_SDK_ROOT" ] && [ -z "$ANDROID_HOME" ]; then
        export ANDROID_SDK_ROOT="${ANDROID_SDK_PATH}"
    fi
    log_info "Android SDK: ${ANDROID_SDK_ROOT:-$ANDROID_HOME}"

    export PATH="$JAVA_HOME/bin:$PATH"

    java -version 2>&1 | head -1
}

build_web() {
    log_info "build Web Resources..."
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install
    npx quasar build -m capacitor -T android --skip-pkg
    log_info "Web Resource construction completed"
}

fix_agp_version() {
    # Android Studio supports up to AGP 8.12.1, Capacitor generates 8.13.0, which needs to be downgraded.
    local gradle_file="src-capacitor/android/build.gradle"
    if grep -q "gradle:8.13.0" "$gradle_file" 2>/dev/null; then
        sed -i 's/gradle:8\.13\.0/gradle:8.12.1/g' "$gradle_file"
        log_info "Already AGP version downgraded to 8.12.1（Compatible with current Android Studio）"
    fi
}

sync_android() {
    log_info "Sync to Android Project..."
    cd src-capacitor
    npx cap sync android
    cd ..
    fix_agp_version
    log_info "Synchronization completed"
}

build_apk() {
    log_info "build Android Debug APK..."
    cd src-capacitor/android

    if [ -f "gradlew.bat" ]; then
        cmd //c "$(cygpath -w "$(pwd)/gradlew.bat") assembleDebug"
    else
        chmod +x gradlew
        ./gradlew assembleDebug
    fi

    APK_PATH="app/build/outputs/apk/debug/app-debug.apk"
    if [ -f "$APK_PATH" ]; then
        mkdir -p ../../dist
        OUTPUT_APK="../../dist/yunChat-$(date +%Y%m%d%H%M%S)-debug.apk"
        cp "$APK_PATH" "$OUTPUT_APK"
        log_info "✓ APK Build successful: $OUTPUT_APK"
        ls -lh "$OUTPUT_APK"
    else
        log_error "APK not found，Build failed"
        exit 1
    fi
    cd ../..
}

build_release_apk() {
    log_info "build Android Release APK..."
    cd src-capacitor/android

    if [ -f "gradlew.bat" ]; then
        cmd //c "$(cygpath -w "$(pwd)/gradlew.bat") assembleRelease"
    else
        chmod +x gradlew
        ./gradlew assembleRelease
    fi

    APK_PATH="app/build/outputs/apk/release/app-release.apk"
    if [ ! -f "$APK_PATH" ]; then
        APK_PATH="app/build/outputs/apk/release/app-release-unsigned.apk"
    fi
    if [ -f "$APK_PATH" ]; then
        mkdir -p ../../dist
        OUTPUT_APK="../../dist/yunChat-$(date +%Y%m%d%H%M%S)-release.apk"
        cp "$APK_PATH" "$OUTPUT_APK"
        log_info "✓ Release APK: $OUTPUT_APK"
        log_warn "APK unsigned，Requires signature before publishing to Play Store"
        ls -lh "$OUTPUT_APK"
    else
        log_error "Release APK not found"
        exit 1
    fi
    cd ../..
}

open_studio() {
    local studio_win="D:/Program Files/Android/Android Studio/bin/studio64.exe"
    local studio_wsl="/mnt/d/Program Files/Android/Android Studio/bin/studio64.exe"
    if [ -f "$studio_win" ]; then
        log_info "in Android Studio Open project in..."
        "$studio_win" "$(pwd)/src-capacitor/android" &
    elif [ -f "$studio_wsl" ]; then
        log_info "in Android Studio Open project in..."
        "$studio_wsl" "$(pwd)/src-capacitor/android" &
    else
        log_warn "Please use it manually Android Studio open: $(pwd)/src-capacitor/android"
    fi
}

main() {
    MODE="${1:-debug}"

    echo ""
    echo "=========================================="
    echo "  E2EE Chat (Yunmi) - Android Application building"
    echo "=========================================="
    echo ""

    setup_env

    case "$MODE" in
        debug)
            build_web
            sync_android
            build_apk
            ;;
        release)
            build_web
            sync_android
            build_release_apk
            ;;
        sync)
            build_web
            sync_android
            ;;
        studio)
            build_web
            sync_android
            open_studio
            ;;
        apk-only)
            build_apk
            ;;
        *)
            echo "Usage: $0 [debug|release|sync|studio|apk-only]"
            echo ""
            echo "  debug     build Debug APK（Default）"
            echo "  release   build Release APK（unsigned）"
            echo "  sync      Sync only Web Resources arrive Android Project"
            echo "  studio    After synchronization Android Studio Open in"
            echo "  apk-only  only run Gradle build（skip Web compile）"
            exit 1
            ;;
    esac

    echo ""
    echo "=========================================="
    echo "  Build completed！"
    echo "=========================================="
    if [ "$MODE" = "debug" ] || [ "$MODE" = "apk-only" ]; then
        echo ""
        echo "Install to device: adb install dist/yunChat-*-debug.apk"
    fi
}

main "$@"
