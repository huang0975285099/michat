#!/bin/bash

# ================================
# E2EE Chat - Android APK 构建脚本
# ================================
# 前置要求:
#   - Node.js + pnpm
#   - Android Studio (内置 JDK 21)
#   - Android SDK (通过 Android Studio 安装)
#
# 默认路径（Windows）:
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

# Android Studio 内置 JDK 21 路径
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
        log_error "未找到 JDK，请安装 Android Studio 或设置 JAVA_HOME"
        exit 1
    fi

    case "$jbr_found" in
        win) log_info "使用 Android Studio JBR (Windows): $JAVA_HOME" ;;
        wsl) log_info "使用 Android Studio JBR (WSL): $JAVA_HOME" ;;
        env) log_info "使用系统 JAVA_HOME: $JAVA_HOME" ;;
        path) log_info "从 java 命令推断 JAVA_HOME: $JAVA_HOME" ;;
    esac

    if [ -z "$ANDROID_SDK_ROOT" ] && [ -z "$ANDROID_HOME" ]; then
        export ANDROID_SDK_ROOT="${ANDROID_SDK_PATH}"
    fi
    log_info "Android SDK: ${ANDROID_SDK_ROOT:-$ANDROID_HOME}"

    export PATH="$JAVA_HOME/bin:$PATH"

    java -version 2>&1 | head -1
}

build_web() {
    log_info "构建 Web 资源..."
    pnpm install --frozen-lockfile 2>/dev/null || pnpm install
    npx quasar build -m capacitor -T android --skip-pkg
    log_info "Web 资源构建完成"
}

fix_agp_version() {
    # Android Studio 最高支持 AGP 8.12.1，Capacitor 生成的是 8.13.0，需降级
    local gradle_file="src-capacitor/android/build.gradle"
    if grep -q "gradle:8.13.0" "$gradle_file" 2>/dev/null; then
        sed -i 's/gradle:8\.13\.0/gradle:8.12.1/g' "$gradle_file"
        log_info "已将 AGP 版本降级为 8.12.1（兼容当前 Android Studio）"
    fi
}

sync_android() {
    log_info "同步到 Android 项目..."
    cd src-capacitor
    npx cap sync android
    cd ..
    fix_agp_version
    log_info "同步完成"
}

build_apk() {
    log_info "构建 Android Debug APK..."
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
        log_info "✓ APK 构建成功: $OUTPUT_APK"
        ls -lh "$OUTPUT_APK"
    else
        log_error "APK 未找到，构建失败"
        exit 1
    fi
    cd ../..
}

build_release_apk() {
    log_info "构建 Android Release APK..."
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
        log_warn "APK 未签名，需签名后才能发布到 Play Store"
        ls -lh "$OUTPUT_APK"
    else
        log_error "Release APK 未找到"
        exit 1
    fi
    cd ../..
}

open_studio() {
    local studio_win="D:/Program Files/Android/Android Studio/bin/studio64.exe"
    local studio_wsl="/mnt/d/Program Files/Android/Android Studio/bin/studio64.exe"
    if [ -f "$studio_win" ]; then
        log_info "在 Android Studio 中打开项目..."
        "$studio_win" "$(pwd)/src-capacitor/android" &
    elif [ -f "$studio_wsl" ]; then
        log_info "在 Android Studio 中打开项目..."
        "$studio_wsl" "$(pwd)/src-capacitor/android" &
    else
        log_warn "请手动用 Android Studio 打开: $(pwd)/src-capacitor/android"
    fi
}

main() {
    MODE="${1:-debug}"

    echo ""
    echo "=========================================="
    echo "  E2EE Chat (云密) - Android 应用构建"
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
            echo "用法: $0 [debug|release|sync|studio|apk-only]"
            echo ""
            echo "  debug     构建 Debug APK（默认）"
            echo "  release   构建 Release APK（未签名）"
            echo "  sync      仅同步 Web 资源到 Android 项目"
            echo "  studio    同步后在 Android Studio 中打开"
            echo "  apk-only  仅运行 Gradle 构建（跳过 Web 编译）"
            exit 1
            ;;
    esac

    echo ""
    echo "=========================================="
    echo "  构建完成！"
    echo "=========================================="
    if [ "$MODE" = "debug" ] || [ "$MODE" = "apk-only" ]; then
        echo ""
        echo "安装到设备: adb install dist/yunChat-*-debug.apk"
    fi
}

main "$@"
