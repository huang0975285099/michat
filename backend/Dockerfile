FROM golang:1.25-alpine AS builder
WORKDIR /app
# Use a mainland China Go module proxy.
ENV GOPROXY=https://goproxy.cn,https://goproxy.io,direct
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/root/go/pkg/mod go mod download
COPY . .
RUN --mount=type=cache,target=/root/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server ./cmd/server

FROM alpine:3.19
RUN apk add --no-cache tzdata ca-certificates
ENV TZ=Asia/Shanghai
WORKDIR /app
COPY --from=builder /app/server .
# config.yaml is mounted through a Docker Compose volume and does not need to be copied.
EXPOSE 8888
CMD ["./server"]
