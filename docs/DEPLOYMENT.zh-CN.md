# Yeomai Lore 线上部署文档

> 更新时间：2026-11-17
> 代码基线：当前 `main` 分支统一入口实现
> Lore 版本：`0.14.0`

`yeomai-lore-web:1.1.4` 只是本地标签，不能保证与当前源码一致。部署前必须重新构建镜像，并记录镜像 ID、构建时间和 SHA-256。

## 1. 端口

使用 `scripts/run-docker.sh` 直接运行单镜像时，宿主机只发布统一入口：

```text
3000:3000/tcp
3000:3000/udp
```

浏览器使用 `http://localhost:3000`，Lore Desktop/CLI 使用
`lore://localhost:3000`。容器内的统一入口在 TCP `3000` 上区分普通 HTTP
和 Lore gRPC，在 UDP `3000` 上转发 Lore QUIC。

无论使用“frp + Nginx”还是“同机直接部署”，公网建议只开放：

| 端口 | 协议 | 用途 |
|---|---|---|
| `80` | TCP | ACME 验证和 HTTP 跳转 HTTPS |
| `443` | TCP + UDP | 门户 HTTPS、OIDC、Lore gRPC 和 QUIC |

以下端口只供服务器本机或私有网络使用：

| 端口 | 协议 | 用途 |
|---|---|---|
| `3000` | TCP + UDP | 容器统一入口，只供 Nginx 或 UDP 端口转发使用 |
| `4000` | TCP | 门户 API，只应在容器内部访问 |
| `41337` | TCP + UDP | Lore gRPC 与 QUIC，只应在容器内部访问 |
| `41339` | TCP | Lore HTTP 内容接口，只应在容器内部访问 |
| `41340` | TCP | Next.js Web 内部监听端口 |
| `50051` | TCP | Registry/User gRPC，只应在容器或受控网络内部访问 |

远端 frp 上的 `3000/TCP` 只供公网服务器本机 Nginx 访问。公网 HTTPS 与
`lores://` 使用同一个域名；Lore QUIC 的 UDP 流量转发到统一入口
`3000/UDP`。

## 2. 容器目录映射

只映射两个持久化目录：

```text
宿主机 data 目录  -> /data
宿主机 certs 目录 -> /certs
```

首次启动后，宿主机 `data` 目录应包含：

```text
data/
  config/
    .env
    local.toml
  imports/
  keys/
    oidc-private.pem
  lore/
    store/
      immutable/
      mutable/
  portal.sqlite
```

`certs` 目录应包含：

```text
certs/
  ca.crt
  ca.key
  grpc.crt
  grpc.key
  lore.crt
  lore.key
```

- `ca.*`、`grpc.*`：内部 API 和 `50051` 使用。
- `lore.crt`、`lore.key`：Lore 公网 QUIC 证书。

统一入口使用一个域名时，例如 `lore.example.com`，Nginx HTTPS 与 Lore
QUIC 必须使用同一域名的证书。同一份正式证书可以同时交给 Nginx 和 Lore
容器，但两个位置仍需分别配置。

`lore.crt` 应放在证书链中服务器证书的前面，并包含中间证书；`lore.key` 必须与证书匹配。证书续期后需同步替换这两个文件并重启容器。


## 3. Docker 环境变量

镜像不要求用户在 Docker 管理页面逐项填写内部环境变量。

`.env` 由容器首次启动时自动写入宿主机 `data/config/.env`。

配置优先级需要区分：

- `.env`：首次启动默认值，以及 API 地址、存储、证书和密钥等进程级配置。
- SQLite：完成安装向导后，站点名称、Web 公开地址和 Lore 公开地址以数据库为准。
- `local.toml`：API 每次启动自动生成，不是持久配置入口。

因此，对已初始化站点，修改 `.env` 中的 `APP_PUBLIC_URL` 或 `LORE_PUBLIC_URL` 后，仅重启容器不会覆盖数据库中的旧地址。

从旧版本升级时，API 会在启动阶段读取 SQLite 中的
`web_public_url` 和 `lore_public_url`。如果两者主机不同，会保留原 Lore
主机，并使用 Web 端口统一两者：

```text
https://lore-web.example.com
+ lores://lore-server.example.com
=> https://lore-server.example.com
   lores://lore-server.example.com:443
```

迁移只更新 `system_settings.web_public_url` 和 `lore_public_url`，不会删除
或改写用户、组织、权限、仓库映射和 Lore 数据。`local.toml` 随后按迁移后的
设置重新生成。
`config/.env` 是首次安装的引导配置，已有数据库运行时以 SQLite 为准，不需要
为了这次迁移手工改 `.env`。OIDC issuer 会变为迁移后的 Web 地址，旧令牌和
客户端登录状态需要重新登录。Lore 证书必须覆盖迁移后的统一主机名。

迁移前必须完成以下预检：

1. 停止应用，备份 `/data/portal.sqlite`、`/data/lore/store/`、
   `/data/keys/oidc-private.pem`、`/data/config/.env` 和 `/certs/`。
2. 对数据库副本执行完整性检查：

   ```bash
   sqlite3 portal.sqlite 'PRAGMA quick_check; PRAGMA foreign_key_check;'
   ```

3. 确认统一域名已解析到当前服务器，且 Nginx 使用该域名同时承载 Web 与
   Lore gRPC。
4. 确认 `/certs/lore.crt` 的 SAN 和私钥覆盖统一域名。外部主机迁移时，
   API 会在写入数据库前校验证书；证书缺失或不匹配会阻止迁移和启动。
5. 确认 `443/TCP` 与 `443/UDP` 已按统一入口配置。

启动后验证：

```bash
sqlite3 /data/portal.sqlite \
  "SELECT key,value FROM system_settings
    WHERE key IN ('web_public_url','lore_public_url',
                  'legacy_web_public_url','legacy_lore_public_url');"

sqlite3 /data/portal.sqlite \
  "SELECT version,applied_at FROM schema_migrations
    WHERE version='site_addresses_unified_v2';"
```

地址发生迁移时会撤销旧的浏览器会话和 OAuth Refresh Token，并递增用户的
`oauth_epoch`，因此旧 JWT、CLI 和 Desktop 身份需要重新登录。这是预期行为，
不会影响仓库或数据库中的业务数据。


## 4. 宿主机 `data/config/.env` 文件修改

- 建立一个统一域名站点，例如 `lore.example.com`
- Web 与 Lore 共用该域名，生产配置可做如下修改：

```dotenv
APP_PUBLIC_URL=https://lore.example.com
LORE_PUBLIC_URL=lores://lore.example.com
LORE_INTERNAL_URL=lore://localhost:41337
LORE_QUIC_TLS_CERT_FILE=/certs/lore.crt
LORE_QUIC_TLS_KEY_FILE=/certs/lore.key

SMTP_URL=
SMTP_FROM="Yeomai Lore <noreply@example.com>"
```

说明：

- `APP_PUBLIC_URL` 与 `LORE_PUBLIC_URL` 使用同一主机名，通过 `https://`
  与 `lores://` 区分协议。
- 首次安装前可修改这些默认值；完成安装后，站点地址以 SQLite 中的 `web_public_url` 和 `lore_public_url` 为准。
- 当前没有安装完成后的站点地址编辑页面。生产环境必须在安装向导中一次填写正确。
- 首次管理员由 `/setup` 安装向导创建。`BOOTSTRAP_ADMIN_*` 不会在运行时自动创建管理员，不应写入部署步骤。
- SMTP 建议在“管理 → SMTP 邮箱”中配置并启用；该设置会加密保存到 SQLite。
- SMTP 未配置时，密码重置链接可能写入 API 日志，但不适合作为生产投递方案。邀请在 SMTP 未启用时不会发送邮件。

## 5. 自动生成的 `data/config/local.toml`

`local.toml` 由 API 在启动时根据 SQLite 站点设置和进程级配置自动重写。不要手工编辑该文件，否则下一次启动会覆盖修改。

主要生成来源：

| TOML 配置 | 来源 |
|---|---|
| `jwt_issuer`、`token_exchange_issuer`、`resource_template` | SQLite 中的 Web 公开地址 |
| `jwk.endpoint` | 容器内部 API 地址 |
| `server.quic.certificate` | `LORE_QUIC_TLS_CERT_FILE`、`LORE_QUIC_TLS_KEY_FILE` |
| `immutable_store.local.path`、`mutable_store.local.path` | `LORE_STORAGE_PATH` |
| `user_url` | 当前固定为 `https://localhost:50051` |

生产环境应生成以下关键值：

```toml
[environment.endpoint]
user_url = "https://localhost:50051"

[server.auth]
jwt_issuer = "https://lore.example.com"
jwt_audience = ["lore-portal"]
jwt_typ = "at+jwt"
resource_claim = "resources"
permission_claim = "permission"
resource_id_claim = "resource_id"
resource_id_template = "urc-{id}"

[server.auth.jwk]
endpoint = "http://localhost:4000/.well-known/jwks.json"

[server.auth.oidc]
client_id = "lore-cli"
scopes = ["openid", "offline_access"]
preferred = true
token_exchange_issuer = "https://lore.example.com"
resource_template = "https://lore.example.com/lore/repositories/{id}"

[server.http]
host = "0.0.0.0"
port = 41339

[server.quic.certificate]
cert_file = "/certs/lore.crt"
pkey_file = "/certs/lore.key"

[immutable_store.local]
path = "/data/lore/store"
flush_delay_seconds = 2

[mutable_store.local]
path = "/data/lore/store"
flush_delay_seconds = 2
```

### 5.1 必须对齐的配置

```text
APP_PUBLIC_URL
= jwt_issuer
= token_exchange_issuer
= resource_template 的前缀
```

线上值必须全部是：

```text
https://lore.example.com
```

`jwk.endpoint` 是容器内部请求，可以保持：

```text
http://localhost:4000/.well-known/jwks.json
```

### 5.2 `user_url` 当前限制

当前配置：

```toml
user_url = "https://localhost:50051"
```

现有单管理员、仓库创建、认证、clone、分支、历史测试可以通过。

但 `user_url` 会被 Lore 服务端通告给客户端。未来如果公网客户端执行跨用户身份解析，`localhost:50051` 会指向客户端自己的电脑，可能失败。

完整的多用户公网部署需要为 `50051` 提供客户端可访问的安全 gRPC 入口，或者通过 Nginx 对 UserService/Registry gRPC 路径做受控转发。

### 5.3 公开 QUIC 证书

默认使用 `lore.crt` 和 `lore.key`。如果确实要使用其他文件名，应修改 `.env`：

```dotenv
LORE_QUIC_TLS_CERT_FILE=/certs/fullchain.pem
LORE_QUIC_TLS_KEY_FILE=/certs/privkey.pem
```

修改后重启容器，让 API 重新生成 `local.toml`，再让 Lore 读取新证书。

权限建议：

```bash
chmod 0644 <宿主机 certs 目录>/lore.crt
chmod 0600 <宿主机 certs 目录>/lore.key
```

宝塔/aaPanel 上的证书通常位于：

```text
/www/server/panel/vhost/cert/lore.example.com/fullchain.pem
/www/server/panel/vhost/cert/lore.example.com/privkey.pem
```

公开证书可由 aaPanel 托管的 Lore 站点证书复制而来，但容器内文件名默认为 `lore.crt` 和 `lore.key`。也可以直接在安装向导中上传证书和私钥，安装程序会验证域名和密钥并写入配置路径。

站点初始化完成后，可在“管理 → 系统 → 证书”中通过文件上传重新更换公钥证书和私钥。“管理 → 系统 → 设置”和证书页面都提供“重启 Lore 服务”按钮，用于加载新证书或运行配置。

## 6. 公网转发与直接部署

### 6.1 使用 frpc

宿主机 frpc 需要转发统一入口的 TCP 与 UDP，不能只配置 TCP。

示例使用 TOML 格式，具体语法按当前 frp 版本调整：

```toml
[[proxies]]
name = "lore-entry-tcp"
type = "tcp"
localIP = "127.0.0.1"
localPort = 3000
remotePort = 3000

[[proxies]]
name = "lore-entry-udp"
type = "udp"
localIP = "127.0.0.1"
localPort = 3000
remotePort = 3000
```

如果 frpc 使用 INI 格式，应创建两个独立 proxy：

- 一个 `type=tcp`，转发统一入口 `3000/TCP`。
- 一个 `type=udp`，转发统一入口 `3000/UDP`。

TCP 远端端口只供公网服务器 Nginx 使用；UDP 远端端口必须由公网服务器
转发到 Lore 客户端可访问的 `443/UDP`。

### 6.2 不配置 frps，直接部署在同一台服务器

Docker、Nginx 和公网 IP 在同一台服务器时，不需要安装 frpc/frps。Nginx 直接连接 Docker 发布到本机的端口：

```text
浏览器 -> Nginx 443/TCP -> 127.0.0.1:3000/TCP -> Web/API
Lore 客户端 -> Nginx 443/TCP -> 127.0.0.1:3000/TCP -> Lore gRPC
Lore 客户端 -> 公网 443/UDP -> 127.0.0.1:3000/UDP -> Lore QUIC
```

Web 与 Lore 使用同一个域名：

```text
lore.example.com
```

直接部署时，TCP 统一入口只绑定回环地址，UDP 统一入口发布到公网 `443`：

```bash
docker run -d \
  --name yeomai-lore-web \
  --restart unless-stopped \
  --stop-timeout 30 \
  -p 127.0.0.1:3000:3000/tcp \
  -p 443:3000/udp \
  -v /path/to/data:/data \
  -v /path/to/certs:/certs \
  yeomai-lore-web:1.1.4
```

其中：

- `127.0.0.1:3000/TCP` 只供同机 Nginx 访问统一入口。
- `443/UDP` 对公网发布，供 Lore QUIC 连接。
- `4000`、`41337`、`41339`、`41340`、`50051` 不发布到宿主机。

第 7 节 Nginx 的 Web 与 gRPC upstream 都是 `127.0.0.1:3000`。如果
Nginx 运行在另一个容器中，`127.0.0.1` 会指向 Nginx 容器自身，此时应改用
同一个 Docker 网络中的服务名，或受信任的宿主机私有地址。

如果已有容器使用旧端口映射，应先确认数据卷路径，再停止并重建容器。不要删除 `/data`、`/certs` 或宿主机持久化目录。

## 7. Nginx 配置

统一入口使用同一个域名。Nginx 先终结 TLS，再按请求类型把普通 HTTP 和
Lore gRPC 都转发到本机统一入口 `3000/TCP`：

必须删除或缩小 aaPanel 自动生成的：

```nginx
location /.well-known {
    allow all;
}
```

这个规则会拦截整个 `/.well-known`，导致 OIDC Discovery 返回 Nginx 404。

推荐配置：

```nginx
server {
    listen 80;
    server_name lore.example.com;

    location ^~ /.well-known/acme-challenge/ {
        allow all;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    http2 on;
    server_name lore.example.com;

    ssl_certificate     /www/server/panel/vhost/cert/lore.example.com/fullchain.pem;
    ssl_certificate_key /www/server/panel/vhost/cert/lore.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # Lore gRPC 服务、健康检查和 reflection 路径。
    location ~ ^/(epic_urc|lore\.|grpc\.) {
        grpc_pass grpc://127.0.0.1:3000;
        grpc_set_header Host $host;
        grpc_set_header X-Real-IP $remote_addr;
        grpc_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        grpc_set_header X-Forwarded-Proto $scheme;
        grpc_read_timeout 3600s;
        grpc_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

如果证书验证目录位于网站根目录，`acme-challenge` 的 `root` 应与 aaPanel
实际目录一致。

验证：

```bash
curl -i https://lore.example.com/.well-known/openid-configuration
```

必须返回 `HTTP 200` 和 JSON，`issuer` 必须是：

```text
https://lore.example.com
```

修改后执行：

```bash
nginx -t
nginx -s reload
```

## 8. 首次部署步骤

### 8.1 导入镜像

在飞牛宿主机执行：

```bash
docker load -i yeomai-lore-web-1.1.4-linux-amd64.tar.gz
```

确认镜像：

```bash
docker image inspect yeomai-lore-web:1.1.4 \
  --format '{{.Id}} {{.Architecture}}'
```

### 8.2 创建宿主机目录

```text
<宿主机 data 目录>
<宿主机 certs 目录>
```

使用飞牛 Docker 管理界面映射：

```text
<宿主机 data 目录>  -> /data
<宿主机 certs 目录> -> /certs
```

不要添加单独的 `/data/lore` 映射。

### 8.3 启动容器

推荐配置：

```text
容器名：yeomai-lore-web
镜像：yeomai-lore-web:1.1.4
重启策略：unless-stopped
端口：
  127.0.0.1:3000:3000/tcp
  443:3000/udp
```

容器首次启动会自动创建：

```text
/data/config/.env
/data/config/local.toml
```

首次部署不要手工编辑 `local.toml`。启动后访问：

```text
https://lore.example.com/setup
```

在安装向导中填写站点名称、统一站点地址、管理员账户和访问策略。本地可填写
`localhost:3000`，向导会生成 `http://localhost:3000` 和
`lore://localhost:3000`；公网可填写 `lore.example.com`，向导会生成
`https://lore.example.com` 和 `lores://lore.example.com`。公网域名会要求
粘贴匹配的证书和私钥。

安装完成后的按钮只重启 Lore 服务，用于加载新的 `local.toml` 和 QUIC 证书。修改 `.env`、代码或镜像后仍需停止并重新创建容器。

### 8.4 配置公网转发

使用 frpc 时配置两个 proxy：

```text
统一入口: 3000/TCP
统一入口: 3000/UDP
```

不使用 frps、Nginx 与 Docker 直接运行在同一台服务器时，跳过本节，按第 6.2 节使用回环地址发布端口。

### 8.5 配置 Nginx

统一域名 `lore.example.com` 的普通 Web 请求：

```text
全部普通 Web 请求 -> 127.0.0.1:3000
```

同一域名的 Lore gRPC 请求：

```text
gRPC -> grpc_pass grpc://127.0.0.1:3000
```

### 8.6 配置证书

把公网域名证书复制到宿主机 `certs` 目录：

```text
lore.crt
lore.key
```

保留内部证书：

```text
ca.crt
ca.key
grpc.crt
grpc.key
```

重启容器后，自动生成的 `local.toml` 默认指向：

```toml
cert_file = "/certs/lore.crt"
pkey_file = "/certs/lore.key"
```

## 9. 登录流程

### 9.1 浏览器登录

先打开：

```text
https://lore.example.com/login
```

使用管理员账号登录。

### 9.2 CLI/Desktop 设备登录

如果 Desktop 提示 `Not authenticated`，删除远端配置或重启 Desktop 并不会自动产生令牌，必须完成设备授权。

在终端执行：

```bash
./scripts/lore auth login lores://lore.example.com \
  --no-browser \
  --log-level debug
```

命令会输出：

```text
Login at: https://lore.example.com/device?user_code=XXXX-XXXX
Code: XXXX-XXXX
```

打开登录地址并批准设备。成功后检查：

```bash
./scripts/lore auth list
```

生产身份应显示：

```text
Auth URL: oidc+https://lore.example.com
Domains: lore.example.com
```

如果出现旧令牌：

```text
Auth URL: oidc+http://localhost:3000
Domains: localhost
```

登录域名校验可能拒绝旧令牌。不要复用旧令牌，执行：

```bash
./scripts/lore auth logout \
  --auth-url oidc+https://lore.example.com
```

然后重新登录。

## 10. 已修复的关键问题

### 10.1 OIDC issuer 不一致

错误：

```text
OIDC discovery document names issuer 'https://lore.example.com',
but jwt_issuer expects 'http://localhost:3000'
```

修复方式：

- 在首次安装向导中填写正确的 Web 公开地址。
- 数据库已初始化时，不能只修改 `.env` 或 `local.toml`；必须先修正 SQLite 中的站点设置，再重启容器。
- API 启动后会重新生成以下值，无需手工维护：

```toml
jwt_issuer = "https://lore.example.com"
token_exchange_issuer = "https://lore.example.com"
resource_template = "https://lore.example.com/lore/repositories/{id}"
```

### 10.2 `/.well-known` 被 Nginx 静态目录拦截

错误：

```text
OIDC discovery endpoint returned error
status: 404
server: nginx
```

修复：

- 删除覆盖整个 `/.well-known` 的静态 `location`。
- 只保留 `/.well-known/acme-challenge/`。
- 其他 `/.well-known` 请求走门户代理。

### 10.3 JWT 域名只包含 localhost

错误：

```text
JWT acceptable domains ["localhost"] does not contain "lore.example.com"
```

根因：

- 旧代码把内部 `LORE_HTTP_URL=http://localhost:41339` 的主机名写进 JWT `root_domains`。
- 本机开发时公开域名也是 `localhost`，所以问题没有暴露。
- Web 与 Lore 现在共用 `lore.example.com`，令牌签发域名和
  `root_domains` 必须都使用该主机名。

修复：

- 登录令牌和仓库令牌都从 `LORE_PUBLIC_URL` 推导 `root_domains`。
- `issuer` 使用 Web 公开地址，`root_domains` 使用 Lore 服务域名：

```text
issuer:      https://lore.example.com
root_domains: ["lore.example.com"]
```

必须使用包含该修复的新镜像。旧镜像即使重新登录，仍会生成 `root_domains=["localhost"]`。

### 10.4 QUIC 开发证书

错误或现象：

```text
Peer certificate: CN=host.docker.internal
Verification error
```

修复方式：

- 默认把正式证书写入 `/certs/lore.crt`，私钥写入 `/certs/lore.key`。
- 如果使用其他路径，设置 `LORE_QUIC_TLS_CERT_FILE` 和 `LORE_QUIC_TLS_KEY_FILE`。
- 不要手工编辑 `local.toml`；重启容器后由 API 重新生成。

验证：

```bash
/opt/homebrew/opt/openssl@3/bin/openssl s_client \
  -quic \
  -connect lore.example.com:443 \
  -servername lore.example.com \
  -alpn lore-storage/0.4 \
  -brief </dev/null
```

应显示：

```text
Peer certificate: CN=lore.example.com
Verification: OK
```

## 11. 线上验收命令

### 11.1 基础 Web 和 OIDC

```bash
curl -i https://lore.example.com/login
curl -i https://lore.example.com/health_check
curl -i https://lore.example.com/.well-known/openid-configuration
curl -i https://lore.example.com/.well-known/jwks.json
curl -s https://lore.example.com/api/v1/meta
```

`api/v1/meta` 应包含：

```json
"loreRemoteUrl":"lores://lore.example.com"
```

### 11.2 gRPC 和 QUIC

```bash
./scripts/lore repository list \
  lores://lore.example.com \
  --log-level debug

./scripts/lore repository info \
  lores://lore.example.com/admin/dserfgerf \
  --remote \
  --log-level debug
```

正常日志应包含：

```text
Selected identity admin, authenticated for lore.example.com
Success QUIC connecting
Got repository list
```

### 11.3 实际 clone

```bash
tmp="$(mktemp -d /tmp/lore-online-test.XXXXXX)"

./scripts/lore clone \
  lores://lore.example.com/admin/dserfgerf \
  "$tmp/repo" \
  --log-level debug

./scripts/lore branch list \
  --repository "$tmp/repo" \
  --remote

./scripts/lore history 10 \
  --repository "$tmp/repo" \
  --remote \
  --oneline

./scripts/lore status \
  --repository "$tmp/repo"
```

2026-11-13 的线上实测结果：

```text
仓库：admin/dserfgerf
默认分支：main
revision：1
文件：1/1，约 1.4 KiB
QUIC：连接和授权成功
工作区：Local branch in sync with remote
```

## 12. 常见错误排查

| 错误 | 原因 | 处理 |
|---|---|---|
| `h2 protocol error` | gRPC 请求被普通 `proxy_pass` 处理 | 使用 `grpc_pass grpc://127.0.0.1:3000` |
| `OIDC discovery ... 404` | Nginx 拦截了 `/.well-known` | 移除全局静态 `location /.well-known` |
| issuer 不一致 | SQLite 中的 Web 地址和 Lore `jwt_issuer` 不一致 | 修正安装时保存的 Web 公开地址，重启容器生成新 `local.toml` |
| `Not authenticated` | 没有当前 issuer 的真实登录令牌 | 完成设备登录，不要只删除远端配置 |
| JWT 域名只包含 localhost | 旧镜像使用了错误的 `LORE_HTTP_URL` | 更新镜像、退出旧令牌、重新登录 |
| QUIC 证书为 `host.docker.internal` | 证书路径仍指向开发证书 | 使用 `/certs/lore.crt`、`/certs/lore.key`，或设置对应的 `.env` 路径 |
| QUIC handshake timeout | `443/UDP` 未转发到统一入口 `3000/UDP` | 检查 frpc UDP proxy、Docker `443:3000/udp` 映射和云防火墙 |
| gRPC 502 | 统一入口或 Lore 进程未运行 | 检查 Nginx `grpc_pass grpc://127.0.0.1:3000`、容器日志和 `/health_check` |

## 13. 更新镜像

### 13.1 本地构建

```bash
docker build \
  --platform linux/amd64 \
  --pull \
  -f infra/app.Dockerfile \
  -t yeomai-lore-web:1.1.4 \
  .
```

构建后记录准确身份：

```bash
docker image inspect yeomai-lore-web:1.1.4 \
  --format '{{.Id}} {{.Created}} {{.Architecture}}'
```

### 13.2 导出和校验

```bash
docker save \
  -o dist/yeomai-lore-web-1.1.4-linux-amd64.tar \
  yeomai-lore-web:1.1.4

gzip -f dist/yeomai-lore-web-1.1.4-linux-amd64.tar

shasum -a 256 \
  dist/yeomai-lore-web-1.1.4-linux-amd64.tar.gz \
  > dist/yeomai-lore-web-1.1.4-linux-amd64.tar.gz.sha256
```

### 13.3 飞牛更新

```bash
docker load -i yeomai-lore-web-1.1.4-linux-amd64.tar.gz
```

镜像加载后必须重新创建容器，不能只执行 `docker restart` 使用旧镜像。

宿主机映射不变：

```text
宿主机 data 目录  -> /data
宿主机 certs 目录 -> /certs
```

升级前先备份整个 `data` 和 `certs` 目录。

## 14. 备份与恢复

最小安全备份内容包括：

```text
/data/lore/store/
/data/portal.sqlite
/data/keys/oidc-private.pem
/data/config/.env
frpc 配置
Nginx 统一域名配置
```

如果重新部署时会重新生成或上传与 `lore.example.com` 匹配的新证书，
`/certs/` 可以不备份。部署后必须同时确认 Nginx 的 HTTPS 证书和 Lore
QUIC 的 `/certs/lore.crt` 覆盖同一域名。

恢复时先停止容器，把目录放回原宿主机路径，再启动新容器。

不要删除：

```text
/data/keys/oidc-private.pem
```

否则 OIDC 签名私钥变化，现有令牌和客户端登录状态会失效。

## 15. 历史生产检查结果

以下是 2026-11-13 的线上只读验收结果，不代表 2026-11-14 之后的当前源码或新镜像：

- 门户登录页、静态资源、健康检查。
- OIDC Discovery、JWKS、设备授权。
- 公开 API 元数据。
- gRPC 认证。
- Lore 仓库列表、仓库详情。
- QUIC TLS 证书校验。
- 实际 clone、分支、历史、工作区同步。

当前仍需处理：

- 公网只保留 `443/TCP` 与 `443/UDP`；禁止公网访问 `3000`、`4000`、
  `41337`、`41339`、`41340` 和 `50051`。
- 定期同步续期后的证书到宿主机 `certs`。
- 修改默认管理员密码。
- 判断是否关闭公开注册。
- 若需要完整公网跨用户身份解析，规划 `user_url` 和 `50051` 的安全入口。
- 使用当前源码重新构建镜像，并在新的临时容器中重新执行本节验收。

本次验收没有执行创建、修改、提交、推送、删除或权限变更操作。

