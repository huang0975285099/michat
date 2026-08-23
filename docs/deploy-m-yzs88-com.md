# m.yzs88.com 部署说明

## 目标

- 服务器：`112.18.238.6`
- SSH 用户默认值：`test`
- 部署目录默认值：`/home/test/e2eechat`
- 域名：`m.yzs88.com`
- Compose 项目名：`e2eechat`

部署栈拥有独立的 MySQL 与 Redis 数据卷，不连接或修改服务器已有的
`ukeysystemv2-*`、`recordingservice-*`、`agent-*` 容器。

## 上线前条件

1. 将 `m.yzs88.com` 的公共 DNS A 记录改为 `112.18.238.6`。
2. 确认服务器可以接收入站 TCP 80、TCP 443、TCP/UDP 3478，以及
   UDP 49160-49200。主机没有防火墙时，Compose 发布端口会创建监听；
   如果端口仍无法从公网访问，需要在运营商、路由器或云平台边界放行。
3. 将部署机的 SSH 公钥加入服务器 `test` 用户的 `authorized_keys`，或在
   脚本运行时输入 SSH 密码。可通过 `SSH_KEY` 指定独立部署密钥。
4. 复制 `.env.example` 为 `.env`，确认 `MYSQL_USER`，并为以下字段填写
   非空随机值：`JWT_SECRET`、`MYSQL_PASSWORD`、`MYSQL_ROOT_PASSWORD`、
   `TURN_SECRET`。
5. 保证 `ssl/m.yzs88.com.pem` 与 `ssl/m.yzs88.com.key` 存在且匹配。

`.env`、证书私钥、构建目录均被 Git 忽略。发布脚本会把远程 `.env` 和
私钥权限设置为 `0600`。

## 部署

在有 Bash、Docker、SSH 和 SCP 的构建机上，从仓库根目录执行：

```bash
./build.sh
```

如服务器用户或目录不同，通过环境变量覆盖：

```bash
REMOTE_USER=test \
REMOTE_IP=112.18.238.6 \
REMOTE_DIR=/home/test/e2eechat \
SSH_KEY=~/.ssh/michat_deploy_ed25519 \
./build.sh
```

脚本会构建并上传两个应用镜像，在服务器校验 Compose 与 Nginx 配置，
然后启动 MySQL、Redis、后端、前端、TLS 边缘代理和 coturn。首次启动会
由 MySQL 镜像创建数据库和应用账号，后端负责表结构迁移。

## 验收

服务器内执行：

```bash
cd /home/test/e2eechat
docker compose ps
curl -fsS http://127.0.0.1/api/version
curl -kfsS https://127.0.0.1/api/version
```

DNS 生效后在外部网络执行：

```bash
curl -fsSI http://m.yzs88.com
curl -fsS https://m.yzs88.com/api/version
```

HTTP 请求应跳转到 HTTPS，HTTPS API 应返回版本信息。音视频通话还应在
两个不同 NAT 网络的客户端之间做一次真实通话验收，以覆盖 TURN 中继。

## 运维

查看状态和日志：

```bash
cd /home/test/e2eechat
docker compose ps
docker compose logs --tail=100 backend edge coturn
```

停止应用但保留数据：

```bash
docker compose down
```

不要在正常更新时使用 `docker compose down -v`；`-v` 会删除本部署的
MySQL 与 Redis 数据卷。
