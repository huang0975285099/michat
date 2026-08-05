#!/bin/bash

# E2EE Chat 构建与部署脚本
# 用法：
#   ./build.sh                 # 构建并发布前后端
#   ./build.sh backend         # 仅构建并发布后端
#   ./build.sh frontend        # 仅构建并发布前端
#   ./build.sh all --package   # 发布并额外生成离线部署包

set -Eeuo pipefail

export DOCKER_BUILDKIT=1

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

VERSION=$(date +%Y%m%d%H%M%S)
OUTPUT_DIR="./dist"
MODE="all"
CREATE_PACKAGE=false

REMOTE_USER="root"
REMOTE_IP="47.108.52.145"
REMOTE_DIR="/opt/e2eechat"

usage() {
    cat <<'EOF'
用法: ./build.sh [all|backend|frontend] [--package]

  all        构建并发布前后端（默认）
  backend    仅构建并发布后端
  frontend   仅构建并发布前端
  --package  额外生成离线部署压缩包
EOF
}

parse_args() {
    for arg in "$@"; do
        case "$arg" in
            all|backend|frontend) MODE="$arg" ;;
            --package) CREATE_PACKAGE=true ;;
            -h|--help) usage; exit 0 ;;
            *) log_error "未知参数: $arg"; usage; exit 1 ;;
        esac
    done
}

clean() {
    log_info "准备构建目录..."
    rm -rf -- "$OUTPUT_DIR"
    mkdir -p "$OUTPUT_DIR"
}

build_backend() {
    log_info "构建后端镜像 e2eechat-backend:$VERSION..."
    docker build -t "e2eechat-backend:$VERSION" -t e2eechat-backend:latest ./backend
    docker save "e2eechat-backend:$VERSION" | gzip > "$OUTPUT_DIR/e2eechat-backend.tar.gz"
    log_info "后端镜像已导出"
}

build_frontend() {
    log_info "构建前端镜像 e2eechat-frontend:$VERSION..."
    docker build -t "e2eechat-frontend:$VERSION" -t e2eechat-frontend:latest ./frontend
    docker save "e2eechat-frontend:$VERSION" | gzip > "$OUTPUT_DIR/e2eechat-frontend.tar.gz"
    log_info "前端镜像已导出"
}

copy_configs() {
    cp docker-compose.yml "$OUTPUT_DIR/"
    cp backend/config.prod.yaml "$OUTPUT_DIR/config.prod.yaml"
    cp -r nginx-vhost "$OUTPUT_DIR/nginx-vhost"
}

create_load_script() {
    cat > "$OUTPUT_DIR/load.sh" <<'LOADSCRIPT'
#!/bin/bash
set -Eeuo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

REMOTE_DIR="/opt/e2eechat"
INIT_MARKER="$REMOTE_DIR/.server-initialized"
DEPLOY_BACKEND=false
DEPLOY_FRONTEND=false
BACKEND_LOADED=""
FRONTEND_LOADED=""

if [[ $EUID -ne 0 ]]; then
    log_error "需要 root 权限运行"
    exit 1
fi

load_image() {
    local archive="$1"
    gunzip -c "$archive" | docker load | sed -n 's/^Loaded image: //p' | tail -n 1
}

if [[ -f e2eechat-backend.tar.gz ]]; then
    log_info "加载后端镜像..."
    BACKEND_LOADED=$(load_image e2eechat-backend.tar.gz)
    docker tag "$BACKEND_LOADED" e2eechat-backend:latest
    DEPLOY_BACKEND=true
fi

if [[ -f e2eechat-frontend.tar.gz ]]; then
    log_info "加载前端镜像..."
    FRONTEND_LOADED=$(load_image e2eechat-frontend.tar.gz)
    docker tag "$FRONTEND_LOADED" e2eechat-frontend:latest
    DEPLOY_FRONTEND=true
fi

if ! $DEPLOY_BACKEND && ! $DEPLOY_FRONTEND; then
    log_error "没有找到待部署的镜像包"
    exit 1
fi

log_info "确保 Docker 网络可用..."
docker network inspect e2eechat-net >/dev/null 2>&1 || docker network create e2eechat-net >/dev/null
docker network connect e2eechat-net yzs-mysql 2>/dev/null || true
docker network connect e2eechat-net yzs-redis 2>/dev/null || true

# 数据库账号只在服务器首次部署时初始化；表结构迁移由后端 AutoMigrate 负责。
if [[ ! -f "$INIT_MARKER" ]]; then
    log_info "首次部署：初始化数据库账号..."
    MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD:-}"
    if [[ -z "$MYSQL_ROOT_PASSWORD" && -f "$REMOTE_DIR/.env" ]]; then
        MYSQL_ROOT_PASSWORD=$(grep '^MYSQL_ROOT_PASSWORD=' "$REMOTE_DIR/.env" | cut -d'=' -f2- || true)
    fi
    if [[ -z "$MYSQL_ROOT_PASSWORD" ]]; then
        read -rsp "请输入 yzs-mysql 的 root 密码: " MYSQL_ROOT_PASSWORD
        echo
        read -rp "是否保存密码到 $REMOTE_DIR/.env？[y/N] " SAVE_PW
        if [[ "$SAVE_PW" =~ ^[Yy]$ ]]; then
            printf 'MYSQL_ROOT_PASSWORD=%s\n' "$MYSQL_ROOT_PASSWORD" > "$REMOTE_DIR/.env"
            chmod 600 "$REMOTE_DIR/.env"
        fi
    fi
    docker exec -i yzs-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS e2eechat CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'e2eechat'@'%' IDENTIFIED BY 'e2eechat123';
GRANT ALL PRIVILEGES ON e2eechat.* TO 'e2eechat'@'%';
FLUSH PRIVILEGES;
SQL
    touch "$INIT_MARKER"
fi

log_info "更新服务（不中断未变更的容器）..."
if $DEPLOY_BACKEND && $DEPLOY_FRONTEND; then
    docker compose up -d --force-recreate
elif $DEPLOY_BACKEND; then
    docker compose up -d --no-deps --force-recreate backend
else
    docker compose up -d --no-deps --force-recreate frontend
fi

# 仅当 Nginx 配置内容变化时才复制并重载。
NGINX_SOURCE="$REMOTE_DIR/nginx-vhost/yb.yzs88.com.conf"
NGINX_HASH_FILE="$REMOTE_DIR/.nginx-vhost.sha256"
if [[ -f "$NGINX_SOURCE" ]]; then
    NEW_NGINX_HASH=$(sha256sum "$NGINX_SOURCE" | awk '{print $1}')
    OLD_NGINX_HASH=$(cat "$NGINX_HASH_FILE" 2>/dev/null || true)
    if [[ "$NEW_NGINX_HASH" != "$OLD_NGINX_HASH" ]]; then
        log_info "Nginx 配置有变化，正在更新..."
        docker network connect e2eechat_default yzs-nginx 2>/dev/null || true
        docker cp "$NGINX_SOURCE" yzs-nginx:/etc/nginx/conf.d/
        docker exec yzs-nginx nginx -t
        docker exec yzs-nginx nginx -s reload
        printf '%s' "$NEW_NGINX_HASH" > "$NGINX_HASH_FILE"
    fi
fi

check_service() {
    local service="$1"
    local container_id
    container_id=$(docker compose ps -q "$service")
    if [[ -z "$container_id" ]]; then
        log_error "$service 容器不存在"
        return 1
    fi

    for _ in {1..15}; do
        if [[ $(docker inspect -f '{{.State.Status}}' "$container_id") == "running" ]]; then
            sleep 2
            if [[ $(docker inspect -f '{{.State.Status}}' "$container_id") == "running" ]]; then
                log_info "$service 运行正常"
                return 0
            fi
        fi
        sleep 2
    done

    log_error "$service 启动失败，最近日志如下："
    docker compose logs --tail=80 "$service" || true
    return 1
}

log_info "检查部署状态..."
$DEPLOY_BACKEND && check_service backend
$DEPLOY_FRONTEND && check_service frontend

log_info "清理本次更新组件的旧镜像..."
if $DEPLOY_BACKEND; then
    docker images e2eechat-backend --format '{{.Repository}}:{{.Tag}}' \
        | grep -v ':latest$' | grep -vF "$BACKEND_LOADED" \
        | xargs -r docker rmi 2>/dev/null || true
fi
if $DEPLOY_FRONTEND; then
    docker images e2eechat-frontend --format '{{.Repository}}:{{.Tag}}' \
        | grep -v ':latest$' | grep -vF "$FRONTEND_LOADED" \
        | xargs -r docker rmi 2>/dev/null || true
fi
docker image prune -f >/dev/null

docker compose ps
log_info "部署完成：https://yb.yzs88.com"
LOADSCRIPT

    chmod +x "$OUTPUT_DIR/load.sh"
}

create_package() {
    if $CREATE_PACKAGE; then
        local package_name="e2eechat-deploy-$VERSION.tar.gz"
        log_info "生成离线部署包 $package_name..."
        tar -czf "$package_name" -C "$OUTPUT_DIR" .
    fi
}

upload() {
    log_info "上传发布文件到 ${REMOTE_USER}@${REMOTE_IP}:${REMOTE_DIR}/ ..."
    # 先删除旧镜像包，避免单组件发布误加载上一次遗留的另一个组件。
    ssh "${REMOTE_USER}@${REMOTE_IP}" \
        "mkdir -p '${REMOTE_DIR}' && rm -f '${REMOTE_DIR}/e2eechat-backend.tar.gz' '${REMOTE_DIR}/e2eechat-frontend.tar.gz'"

    local files=(
        "$OUTPUT_DIR/config.prod.yaml"
        "$OUTPUT_DIR/docker-compose.yml"
        "$OUTPUT_DIR/load.sh"
        "$OUTPUT_DIR/nginx-vhost"
    )
    [[ -f "$OUTPUT_DIR/e2eechat-backend.tar.gz" ]] && files+=("$OUTPUT_DIR/e2eechat-backend.tar.gz")
    [[ -f "$OUTPUT_DIR/e2eechat-frontend.tar.gz" ]] && files+=("$OUTPUT_DIR/e2eechat-frontend.tar.gz")
    [[ -f ".env" ]] && files+=(".env")

    scp -C -r "${files[@]}" "${REMOTE_USER}@${REMOTE_IP}:${REMOTE_DIR}/"
    ssh "${REMOTE_USER}@${REMOTE_IP}" "chmod +x '${REMOTE_DIR}/load.sh'"
}

deploy() {
    log_info "执行远程部署..."
    ssh "${REMOTE_USER}@${REMOTE_IP}" "cd '${REMOTE_DIR}' && ./load.sh"
}

main() {
    parse_args "$@"

    if ! command -v docker >/dev/null 2>&1; then
        log_error "Docker 未安装"
        exit 1
    fi

    echo
    echo "=========================================="
    echo "  E2EE Chat - $MODE 发布"
    echo "=========================================="
    echo

    clean
    case "$MODE" in
        all) build_backend; build_frontend ;;
        backend) build_backend ;;
        frontend) build_frontend ;;
    esac
    copy_configs
    create_load_script
    create_package
    upload
    deploy
}

main "$@"
