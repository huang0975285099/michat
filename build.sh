#!/bin/bash

# ================================
# E2EE Chat - 本地构建镜像脚本
# ================================

set -e

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

clean() {
    log_info "清理旧的构建文件..."
    rm -rf $OUTPUT_DIR
    mkdir -p $OUTPUT_DIR
}

build_backend() {
    log_info "构建后端镜像 e2eechat-backend:$VERSION..."
    docker build -t e2eechat-backend:$VERSION -t e2eechat-backend:latest ./backend

    log_info "导出后端镜像..."
    docker save e2eechat-backend:$VERSION -o $OUTPUT_DIR/e2eechat-backend.tar
    gzip -f $OUTPUT_DIR/e2eechat-backend.tar

    log_info "后端镜像构建完成: $OUTPUT_DIR/e2eechat-backend.tar.gz"
}

build_frontend() {
    log_info "构建前端镜像 e2eechat-frontend:$VERSION..."
    docker build -t e2eechat-frontend:$VERSION -t e2eechat-frontend:latest ./frontend

    log_info "导出前端镜像..."
    docker save e2eechat-frontend:$VERSION -o $OUTPUT_DIR/e2eechat-frontend.tar
    gzip -f $OUTPUT_DIR/e2eechat-frontend.tar

    log_info "前端镜像构建完成: $OUTPUT_DIR/e2eechat-frontend.tar.gz"
}

copy_configs() {
    log_info "复制配置文件..."
    cp docker-compose.yml $OUTPUT_DIR/
    cp backend/config.prod.yaml $OUTPUT_DIR/config.prod.yaml
    cp -r nginx-vhost $OUTPUT_DIR/nginx-vhost
    cp -r backend/migrations $OUTPUT_DIR/migrations
    log_info "配置文件复制完成"
}

create_load_script() {
    cat > $OUTPUT_DIR/load.sh << 'LOADSCRIPT'
#!/bin/bash

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

REMOTE_DIR="/opt/e2eechat"

if [[ $EUID -ne 0 ]]; then
    log_error "需要 root 权限运行"
    exit 1
fi

if [ -z "$MYSQL_ROOT_PASSWORD" ]; then
    if [ -f "$REMOTE_DIR/.env" ]; then
        MYSQL_ROOT_PASSWORD=$(grep '^MYSQL_ROOT_PASSWORD=' "$REMOTE_DIR/.env" | cut -d'=' -f2-)
    fi
fi
if [ -z "$MYSQL_ROOT_PASSWORD" ]; then
    read -rsp "请输入 yzs-mysql 的 root 密码: " MYSQL_ROOT_PASSWORD
    echo ""
    read -rp "是否保存密码到 $REMOTE_DIR/.env？[y/N] " SAVE_PW
    if [[ "$SAVE_PW" =~ ^[Yy]$ ]]; then
        echo "MYSQL_ROOT_PASSWORD=$MYSQL_ROOT_PASSWORD" > "$REMOTE_DIR/.env"
        chmod 600 "$REMOTE_DIR/.env"
        log_info "密码已保存到 $REMOTE_DIR/.env"
    fi
fi

log_info "加载 Docker 镜像..."
BACKEND_LOADED=$(gunzip -c e2eechat-backend.tar.gz | docker load | grep -oP '(?<=Loaded image: ).*')
FRONTEND_LOADED=$(gunzip -c e2eechat-frontend.tar.gz | docker load | grep -oP '(?<=Loaded image: ).*')

log_info "镜像加载完成: $BACKEND_LOADED, $FRONTEND_LOADED"

log_info "设置 latest 标签..."
docker tag "$BACKEND_LOADED" e2eechat-backend:latest
docker tag "$FRONTEND_LOADED" e2eechat-frontend:latest

docker images | grep e2eechat

log_info "初始化 Docker 网络..."
docker network inspect e2eechat-net >/dev/null 2>&1 || docker network create e2eechat-net
docker network connect e2eechat-net yzs-mysql 2>/dev/null || true
docker network connect e2eechat-net yzs-redis 2>/dev/null || true
log_info "网络就绪"

log_info "初始化数据库..."
docker exec -i yzs-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS e2eechat CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'e2eechat'@'%' IDENTIFIED BY 'e2eechat123';
GRANT ALL PRIVILEGES ON e2eechat.* TO 'e2eechat'@'%';
FLUSH PRIVILEGES;
SQL
docker exec -i yzs-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" e2eechat \
    < "$REMOTE_DIR/migrations/001_init.sql" 2>/dev/null || true
docker exec -i yzs-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" e2eechat \
    < "$REMOTE_DIR/migrations/002_message_reads.sql" 2>/dev/null || true
log_info "数据库就绪"

log_info "停止旧容器..."
docker compose down 2>/dev/null || true

log_info "启动服务..."
docker compose up -d

log_info "配置 yzs-nginx..."
docker network connect e2eechat_default yzs-nginx 2>/dev/null || true
docker cp "$REMOTE_DIR/nginx-vhost/yb.yzs88.com.conf" yzs-nginx:/etc/nginx/conf.d/
docker exec yzs-nginx nginx -t
docker exec yzs-nginx nginx -s reload
log_info "yzs-nginx 配置完成"

log_info "清理旧镜像..."
docker image prune -f
OLD_BACKEND=$(docker images e2eechat-backend --format '{{.Repository}}:{{.Tag}}' | grep -v latest | grep -v "$BACKEND_LOADED" || true)
OLD_FRONTEND=$(docker images e2eechat-frontend --format '{{.Repository}}:{{.Tag}}' | grep -v latest | grep -v "$FRONTEND_LOADED" || true)
for img in $OLD_BACKEND $OLD_FRONTEND; do
    docker rmi "$img" 2>/dev/null && log_info "已删除旧镜像: $img" || true
done
docker image prune -f

log_info "部署完成！https://yb.yzs88.com"
docker compose ps
LOADSCRIPT

    chmod +x $OUTPUT_DIR/load.sh
    log_info "加载脚本创建完成: $OUTPUT_DIR/load.sh"
}

package() {
    log_info "打包发布文件..."
    tar -czvf e2eechat-deploy-$VERSION.tar.gz -C $OUTPUT_DIR .
    log_info "发布包创建完成: e2eechat-deploy-$VERSION.tar.gz"

    echo ""
    echo "=========================================="
    echo "构建完成！"
    echo "=========================================="
    echo ""
    ls -lh $OUTPUT_DIR/
    ls -lh e2eechat-deploy-$VERSION.tar.gz
    echo ""
    echo "部署步骤:"
    echo "  1. 上传: scp e2eechat-deploy-$VERSION.tar.gz root@47.109.67.6:/opt/e2eechat/"
    echo "  2. 解压: cd /opt/e2eechat && tar -xzf e2eechat-deploy-$VERSION.tar.gz && ./load.sh"
    echo "  3. 上传SSL证书: scp ssl/yb.yzs88.com.pem ssl/yb.yzs88.com.key root@47.109.67.6:/etc/nginx/ssl/"
    echo "  4. 加载: ./load.sh"
    echo ""
}

main() {
    echo ""
    echo "=========================================="
    echo "  E2EE Chat - 本地构建"
    echo "=========================================="
    echo ""

    if ! command -v docker &> /dev/null; then
        log_error "Docker 未安装"
        exit 1
    fi

    clean
    build_backend
    build_frontend
    copy_configs
    create_load_script
    package
}

main "$@"