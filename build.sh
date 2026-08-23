#!/usr/bin/env bash

# E2EE Chat build and deployment script for m.yzs88.com.
#
# Usage:
#   ./build.sh                 # build and deploy backend + frontend
#   ./build.sh backend         # build and deploy backend only
#   ./build.sh frontend        # build and deploy frontend only
#   ./build.sh all --package   # also create an offline deployment archive
#
# Override the SSH target when needed:
#   SSH_KEY=~/.ssh/michat_deploy_ed25519 REMOTE_USER=test SSH_PORT=2202 ./build.sh

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

REMOTE_USER="${REMOTE_USER:-test}"
REMOTE_IP="${REMOTE_IP:-112.18.238.6}"
REMOTE_DIR="${REMOTE_DIR:-/home/test/e2eechat}"
SSH_PORT="${SSH_PORT:-2202}"
SSH_KEY="${SSH_KEY:-}"
SSH_ARGS=(-p "$SSH_PORT")
SCP_ARGS=(-P "$SSH_PORT")

usage() {
    cat <<'EOF'
Usage: ./build.sh [all|backend|frontend] [--package]

  all        Build and deploy backend and frontend (default)
  backend    Build and deploy only the backend
  frontend   Build and deploy only the frontend
  --package  Also create an offline deployment archive
EOF
}

parse_args() {
    for arg in "$@"; do
        case "$arg" in
            all|backend|frontend) MODE="$arg" ;;
            --package) CREATE_PACKAGE=true ;;
            -h|--help) usage; exit 0 ;;
            *) log_error "Unknown argument: $arg"; usage; exit 1 ;;
        esac
    done
}

require_file() {
    if [[ ! -f "$1" ]]; then
        log_error "Missing required file: $1"
        exit 1
    fi
}

require_env_key() {
    local key="$1"
    if ! grep -Eq "^${key}=.+" .env; then
        log_error ".env is missing a non-empty ${key}. See .env.example."
        exit 1
    fi
}

preflight() {
    local command_name
    for command_name in docker ssh scp gzip tar; do
        if ! command -v "$command_name" >/dev/null 2>&1; then
            log_error "Required command is not installed: $command_name"
            exit 1
        fi
    done

    require_file .env
    require_file ssl/m.yzs88.com.pem
    require_file ssl/m.yzs88.com.key
    for key in JWT_SECRET MYSQL_PASSWORD MYSQL_ROOT_PASSWORD TURN_SECRET; do
        require_env_key "$key"
    done

    if [[ -n "$SSH_KEY" ]]; then
        require_file "$SSH_KEY"
        SSH_ARGS+=(-i "$SSH_KEY")
        SCP_ARGS+=(-i "$SSH_KEY")
    fi

    if command -v openssl >/dev/null 2>&1; then
        openssl x509 -in ssl/m.yzs88.com.pem -noout -checkend 86400 >/dev/null || {
            log_error "The m.yzs88.com certificate is invalid or expires within 24 hours."
            exit 1
        }
    else
        log_warn "openssl is unavailable; certificate expiry will be checked by nginx on the server."
    fi
}

clean() {
    log_info "Preparing build directory..."
    rm -rf -- "$OUTPUT_DIR"
    mkdir -p "$OUTPUT_DIR"
}

build_backend() {
    log_info "Building e2eechat-backend:$VERSION..."
    docker build -t "e2eechat-backend:$VERSION" -t e2eechat-backend:latest ./backend
    docker save "e2eechat-backend:$VERSION" e2eechat-backend:latest | gzip > "$OUTPUT_DIR/e2eechat-backend.tar.gz"
}

build_frontend() {
    log_info "Building e2eechat-frontend:$VERSION..."
    docker build -t "e2eechat-frontend:$VERSION" -t e2eechat-frontend:latest ./frontend
    docker save "e2eechat-frontend:$VERSION" e2eechat-frontend:latest | gzip > "$OUTPUT_DIR/e2eechat-frontend.tar.gz"
}

copy_configs() {
    cp docker-compose.yml "$OUTPUT_DIR/"
    cp .env "$OUTPUT_DIR/.env"
    mkdir -p "$OUTPUT_DIR/deploy" "$OUTPUT_DIR/nginx-vhost" "$OUTPUT_DIR/ssl" "$OUTPUT_DIR/downloads"
    cp deploy/config.yaml "$OUTPUT_DIR/deploy/config.yaml"
    cp nginx-vhost/m.yzs88.com.conf "$OUTPUT_DIR/nginx-vhost/m.yzs88.com.conf"
    cp ssl/m.yzs88.com.pem "$OUTPUT_DIR/ssl/m.yzs88.com.pem"
    cp ssl/m.yzs88.com.key "$OUTPUT_DIR/ssl/m.yzs88.com.key"
    chmod 600 "$OUTPUT_DIR/.env" "$OUTPUT_DIR/ssl/m.yzs88.com.key"
}

create_load_script() {
    cat > "$OUTPUT_DIR/load.sh" <<'LOADSCRIPT'
#!/usr/bin/env bash
set -Eeuo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

cd "$(dirname "$0")"

for path in .env docker-compose.yml deploy/config.yaml nginx-vhost/m.yzs88.com.conf \
    ssl/m.yzs88.com.pem ssl/m.yzs88.com.key; do
    if [[ ! -f "$path" ]]; then
        log_error "Missing deployment file: $path"
        exit 1
    fi
done

chmod 600 .env ssl/m.yzs88.com.key
mkdir -p downloads

if [[ -f e2eechat-backend.tar.gz ]]; then
    log_info "Loading backend image..."
    gunzip -c e2eechat-backend.tar.gz | docker load >/dev/null
fi

if [[ -f e2eechat-frontend.tar.gz ]]; then
    log_info "Loading frontend image..."
    gunzip -c e2eechat-frontend.tar.gz | docker load >/dev/null
fi

if [[ ! -f e2eechat-backend.tar.gz && ! -f e2eechat-frontend.tar.gz ]]; then
    log_error "No application image archives were uploaded."
    exit 1
fi

log_info "Validating Compose and nginx configuration..."
docker compose config --quiet
docker compose pull mysql redis edge coturn
docker compose run --rm --no-deps edge nginx -t

log_info "Starting the isolated e2eechat stack..."
docker compose up -d --remove-orphans

wait_for_service() {
    local service="$1"
    local container_id state health
    container_id=$(docker compose ps -q "$service")
    if [[ -z "$container_id" ]]; then
        log_error "$service container was not created."
        return 1
    fi

    for _ in {1..40}; do
        state=$(docker inspect -f '{{.State.Status}}' "$container_id")
        health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")
        if [[ "$state" == "running" && ("$health" == "healthy" || "$health" == "none") ]]; then
            log_info "$service is ready."
            return 0
        fi
        if [[ "$state" == "exited" || "$state" == "dead" ]]; then
            break
        fi
        sleep 3
    done

    log_error "$service failed to become ready. Recent logs:"
    docker compose logs --tail=100 "$service" || true
    return 1
}

for service in mysql redis backend frontend edge coturn; do
    wait_for_service "$service"
done

log_info "Running local HTTPS smoke test..."
docker compose exec -T edge wget --no-check-certificate -q -O /dev/null https://127.0.0.1/api/version

log_info "Removing old untagged images without touching other running services..."
docker image prune -f >/dev/null

docker compose ps
log_info "Deployment complete: https://m.yzs88.com:8088"
LOADSCRIPT

    chmod +x "$OUTPUT_DIR/load.sh"
}

create_package() {
    if $CREATE_PACKAGE; then
        local package_name="e2eechat-deploy-$VERSION.tar.gz"
        log_info "Creating offline package $package_name (contains the private TLS key; store securely)..."
        tar -czf "$package_name" -C "$OUTPUT_DIR" .
        chmod 600 "$package_name"
    fi
}

upload() {
    log_info "Uploading release to ${REMOTE_USER}@${REMOTE_IP}:${REMOTE_DIR}/ ..."
    ssh "${SSH_ARGS[@]}" "${REMOTE_USER}@${REMOTE_IP}" "mkdir -p '${REMOTE_DIR}' && chmod 700 '${REMOTE_DIR}' && rm -f '${REMOTE_DIR}/e2eechat-backend.tar.gz' '${REMOTE_DIR}/e2eechat-frontend.tar.gz'"
    scp -C -r "${SCP_ARGS[@]}" "$OUTPUT_DIR/." "${REMOTE_USER}@${REMOTE_IP}:${REMOTE_DIR}/"
    ssh "${SSH_ARGS[@]}" "${REMOTE_USER}@${REMOTE_IP}" "chmod 600 '${REMOTE_DIR}/.env' '${REMOTE_DIR}/ssl/m.yzs88.com.key' && chmod +x '${REMOTE_DIR}/load.sh'"
}

deploy() {
    log_info "Executing remote deployment..."
    ssh "${SSH_ARGS[@]}" "${REMOTE_USER}@${REMOTE_IP}" "cd '${REMOTE_DIR}' && ./load.sh"
}

main() {
    parse_args "$@"
    preflight

    log_info "Target: ${REMOTE_USER}@${REMOTE_IP}:${SSH_PORT}${REMOTE_DIR} (mode: $MODE)"
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
