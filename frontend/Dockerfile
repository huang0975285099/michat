FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
RUN pnpm config set registry https://registry.npmmirror.com
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    --mount=type=cache,target=/app/node_modules/.cache \
    npx quasar build -m pwa

FROM nginx:latest
COPY --from=builder /app/dist/pwa /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80