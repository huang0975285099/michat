#!/bin/bash
# E2EE Chat 服务器端部署脚本
# 使用方法：./load.sh

set -e

REMOTE_DIR="/opt/e2eechat"

echo "========================================="
echo "  E2EE Chat 服务器端部署"
echo "========================================="

# 获取 MySQL root 密码
if [ -z "$MYSQL_ROOT_PASSWORD" ]; then
    read -rsp "请输入 yzs-mysql 的 root 密码: " MYSQL_ROOT_PASSWORD
    echo ""
fi

# 1. 建立共享网络，连接已有容器
echo ""
echo "[1/5] 初始化 Docker 网络..."
docker network inspect e2eechat-net >/dev/null 2>&1 || docker network create e2eechat-net
docker network connect e2eechat-net yzs-mysql 2>/dev/null || true
docker network connect e2eechat-net yzs-redis 2>/dev/null || true
echo "✅ 网络就绪"

# 2. 初始化数据库（幂等）
echo ""
echo "[2/5] 初始化数据库..."
docker exec -i yzs-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" <<SQL
CREATE DATABASE IF NOT EXISTS e2eechat CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'e2eechat'@'%' IDENTIFIED BY 'e2eechat123';
GRANT ALL PRIVILEGES ON e2eechat.* TO 'e2eechat'@'%';
FLUSH PRIVILEGES;
SQL
docker exec -i yzs-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" e2eechat \
    < "$REMOTE_DIR/backend/migrations/001_init.sql"
docker exec -i yzs-mysql mysql -uroot -p"$MYSQL_ROOT_PASSWORD" e2eechat \
    < "$REMOTE_DIR/backend/migrations/002_message_reads.sql"
echo "✅ 数据库就绪"

# 3. 构建并启动 e2eechat 容器
echo ""
echo "[3/5] 构建并启动服务..."
cd "$REMOTE_DIR"
docker compose up -d --build
echo "✅ 服务已启动"

# 4. 将 yzs-nginx 接入 e2eechat_default 网络，使其能访问 e2eechat-frontend-1
echo ""
echo "[4/5] 配置 yzs-nginx..."
docker network connect e2eechat_default yzs-nginx 2>/dev/null || true

# 注入 vhost 配置（SSL 证书已通过宿主机 volume 挂载，无需复制）
docker cp "$REMOTE_DIR/nginx-vhost/yb.yzs88.com.conf" yzs-nginx:/etc/nginx/conf.d/

# 测试配置并热重载
docker exec yzs-nginx nginx -t
docker exec yzs-nginx nginx -s reload
echo "✅ yzs-nginx 配置完成"

# 5. 查看状态
echo ""
echo "[5/5] 服务状态:"
docker compose ps

echo ""
echo "========================================="
echo "  部署完成！https://yb.yzs88.com"
echo "========================================="
echo ""
echo "常用命令:"
echo "  查看日志: docker compose -f $REMOTE_DIR/docker-compose.yml logs -f"
echo "  重启:     docker compose -f $REMOTE_DIR/docker-compose.yml restart"
echo "  停止:     docker compose -f $REMOTE_DIR/docker-compose.yml down"
