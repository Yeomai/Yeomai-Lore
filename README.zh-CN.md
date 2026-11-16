# Yeomai Lore

[English](README.md) | [简体中文](README.zh-CN.md)

这是一个面向 [Epic Games Lore](https://github.com/EpicGames/lore) 的自托管 Web 控制平面。当前原型提供内置账户、组织与仓库 ACL、Lore Tier 2 授权、仓库创建、分支与修订历史、文件浏览、下载、文本差异、邀请、API 令牌和审计记录。

本项目不是 Gitea 兼容实现，目前不提供 Git 或 SSH 远程仓库、Git Actions、拉取请求、Issue 或 Wiki 页面。当前里程碑是 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) 中描述的 0–2 阶段纵向切片。

## 架构

```text
浏览器 / Lore Desktop / Lore CLI
              |
              v
     统一入口 3000/TCP + 3000/UDP
       |                    |
       | HTTP               | Lore gRPC / QUIC
       v                    v
Next.js Web 41340/TCP   Lore Server 41337/TCP+UDP
       |
       v
Fastify API 4000/TCP
```

SQLite 负责身份、组织成员关系、仓库授权、邀请、API 令牌和审计事件。仓库标识、分支、修订、文件树、内容和锁由 Lore 负责。默认数据库是启用 WAL 的单个文件 `data/local/portal.sqlite`。

浏览器不会获得 Lore 存储凭据。API 会把用户登录会话交换为仓库级 JWT，其中的操作权限严格来自 SQLite 中的 ACL 状态。

Web 界面支持英文和简体中文。首次访问时根据浏览器的 `Accept-Language` 选择语言，用户显式选择后保存在 `locale` Cookie 中。所有语言文案都集中在 `apps/web/src/i18n/messages.ts`；新增语言只需要增加一份词典和对应的 locale 标记，无需复制页面组件。

## 本地运行

前置条件：

- macOS 或 Linux。
- Node.js 22+、pnpm、Git 和 OpenSSL。
- `3000` TCP/UDP、`41340`、`4000`、`50051`、`41337` TCP/UDP 和 `41339` 端口可用。

### 端口暴露标准

支持的部署模型允许外部 Lore Desktop 和 Lore CLI 客户端连接服务器。在该模型下，只向宿主机或私有部署网络之外暴露以下端口：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| `3000` | TCP + UDP | 统一入口：HTTP Web、Lore gRPC 和 QUIC |

浏览器访问 `http://localhost:3000`，Lore Desktop/CLI 访问
`lore://localhost:3000`。两者使用相同主机名和端口，统一入口根据 TCP
协议选择 Web 或 Lore gRPC，并将 UDP 转发给 Lore QUIC。

其余端口属于内部实现细节：

| 端口 | 协议 | 调用方 |
| --- | --- | --- |
| `41340` | TCP | 统一入口访问 Next.js Web，仅内部可见 |
| `4000` | TCP | Next.js 代理及 Lore JWK/API 访问 |
| `41337` | TCP + UDP | 统一入口访问 Lore gRPC 与 QUIC，仅内部可见 |
| `41339` | TCP | 后端访问 Lore 内容 |
| `50051` | TCP | Lore Server 仓库注册表 gRPC |

不要直接公开 `4000`、`41337`、`41339`、`41340` 或 `50051`。容器部署时，
这些端口只能通过私有容器网络访问；原生本地开发时，应通过宿主机防火墙阻止
外部访问。

镜像的 `EXPOSE` 元数据也只声明 `3000/TCP` 和 `3000/UDP`。Docker/Portainer
默认只需要建立这两个宿主机端口映射，其余内部端口不映射。

`3000` 必须同时开放 TCP 和 UDP。TCP 同时承载普通 HTTP 与基于 HTTP/2 的
gRPC，UDP 承载 Lore QUIC。

如果由反向代理终结 TLS，应把 `443/TCP` 和 `443/UDP` 都映射到统一入口
`3000`。公共 HTTPS 与 `lores://` 可以使用同一个主机名。

```bash
corepack enable
pnpm install
pnpm dev:local
```

打开 <http://localhost:3000>。

`pnpm dev:local` 会自动创建 SQLite 表结构，将固定版本的官方 Lore Server 和 CLI 下载到 `data/local/bin`，生成内部 TLS 证书，并以原生进程方式启动全部应用。无需 PostgreSQL、Redis 或 Docker daemon。

首次访问会进入安装向导，用来设置第一个管理员、统一站点地址和初始注册策略。
本地可填写 `localhost:3000`，向导会派生 `http://localhost:3000` 和
`lore://localhost:3000`；公网域名会派生 `https://` 和 `lores://` 地址。
提交表单后才会创建管理员；管理员不会自动加入组织，系统也不会自动创建组织。

默认地址为 Web 管理端 `http://localhost:3000` 和 Lore 客户端
`lore://localhost:3000`。两者共用主机名和端口；生产环境使用 `lores://`
时需要填写匹配的公钥证书和私钥。日志位于 `data/local/logs/`。

项目固定使用 Lore `0.13.0`。包装脚本会下载发布版可执行文件，而不是将平台相关二进制提交到仓库：

```bash
./scripts/lore --version
./scripts/loreserver --version
```

## 创建第一个仓库

使用项目提供的 CLI：

```bash
./scripts/lore auth login lore://localhost:3000
```

打开命令输出的设备授权地址，登录并批准请求。然后在 Web UI 中创建仓库，并推送第一个修订：

如果 CLI 流程需要通过内部 gRPC 用户目录解析其他用户，请让该进程信任生成的开发 CA：

```bash
export SSL_CERT_FILE="$PWD/data/dev-certs/ca.crt"
```

```bash
./scripts/lore clone lore://localhost:3000/default/my-project
cd my-project
printf 'hello\n' > README.md
../scripts/lore stage README.md
../scripts/lore commit "Initial revision"
../scripts/lore push
```

随后门户会显示分支、修订历史、文件树、可下载的 Blob 和文本差异。

### OAuth 身份与审批行为

- 一个 OAuth 身份会话对应一台已认证设备上的一个用户，其 Refresh Token 由该设备访问的所有仓库共用。
- 如果 Lore Desktop 重复发起 Device Flow，而同一设备仍存在有效 OAuth 会话，服务端会静默完成认证并沿用原 OAuth 会话。建立、打开、同步和推送仓库都不会再次要求审批。
- 新的 OAuth 身份会话初始 Refresh Token 有效期为 90 天；仅当当前剩余有效期少于 30 天时，同设备静默恢复才在当前过期时间上增加 30 天。
- 普通 Access Token 刷新只轮换 Refresh Token，不会把它恢复为完整有效期。身份会话从首次认证起最多只能延长到 3 年。
- 新设备、被撤销的 OAuth 身份或无法唯一确定的设备身份仍需要审批。
- 设备审批状态接口是只读公开接口，不要求网页登录。重复打开同一审批链接只会显示现有结果，不会再次发起审批。
- Device Flow 仍处于 `pending` 时，未登录的浏览器需要先登录，之后才显示批准和拒绝按钮。批准与拒绝操作仍然受网页登录保护。
- 审批完成后页面不跳转，只显示“审批已确认，请关闭页面”，并在 1 秒后尝试关闭浏览器页面。若浏览器禁止关闭，审批结果会继续保留。
- 仅清除本地 Lore 凭据不会撤销服务端 OAuth 会话。需要在同一台电脑上切换用户时，应先在网页端撤销当前 OAuth 身份，再执行文档中的 Lore logout 命令。

### 空仓库初始化策略

- 通过门户或其 API 创建且未选择忽略模板的仓库，由服务端在返回前自动生成一个仅含 metadata 的首个 revision。该 revision 记录 `initialized=true`，仓库内容树保持为空。
- 通过 Lore Desktop 直接创建的仓库，门户只负责注册。服务端不会额外生成首个 revision，也不会主动触发 Sync；首次提交仍由 Desktop 完成。
- 当 Desktop 创建的空仓库尚未产生任何 revision 时，其 Sync 可能显示 `No remote configured`。这是 Lore Desktop `0.13.0` 的客户端缺陷，服务端有意不为 Desktop 创建的仓库增加绕过处理。

## 导入已有 Git 仓库

所有已登录用户都可以使用 **管理 → 仓库导入**。普通用户的导入目标固定为本人命名空间；管理员还可以选择自己可管理的组织。支持用户输入的 `http://`、`https://` 或 `git://` 克隆地址。私有 HTTP(S) 仓库仅支持访问令牌；不接受本地路径、SSH URL 或私钥凭据。

系统会自动识别 GitHub.com 和自托管 Gitea；提供访问令牌时会调用对应服务商 API 校验令牌并解析用户名。Git 标签可作为可选导入项。本版本不导入 Wiki、Issue、拉取请求、Release 或里程碑。

所有用户和管理员共用同一个导入队列，全站同一时刻只运行一个导入任务，其余任务按服务端收到请求的时间顺序等待。每个普通用户同一时刻最多只能有一个排队中或运行中的任务，已有任务结束前不能再次提交；管理员不设排队数量上限。普通用户只能查看和管理自己发起的任务，管理员可以查看和管理全局任务。失败或取消的导入会删除未完成的目标仓库，但保留任务日志和警告报告。终止状态的导入记录可以从任务列表清理；成功导入会保留仓库，同时删除任务元数据和日志。

分支、双父修订合并、作者元数据、Git SHA 映射和标签会被保留。LFS 指针会作为普通文件保存，子模块会被跳过，Octopus Merge 以带警告的尽力方式导入。

### 当前正式导入方案

导入器只在首个提交物化完整工作树；后续提交根据 Git diff 仅更新和暂存变更路径，避免每个提交都重新解压并扫描整个仓库。

该方案定为当前正式方案：完整保留 Git 历史，同时保持与 Lore CLI、工作区行为和 Lore 版本边界较低耦合。

### 未来待探索方案

以下方案待 Lore 正式发布后继续探索：

长期来看最快的方法是不经过 Git 工作区和 Lore CLI 磁盘操作，直接：

- 读取 Git tree/blob 对象。
- 将文件内容写入 Lore 存储。
- 直接构造 Lore revision state、父 revision 和 metadata。
- 通过 Lore API 提交 state。

这样连文件物化都可以省掉，但需要深入对接 Lore 内部 revision-tree API，改造量最大，也更容易受 Lore 版本变化影响。

配置、保证范围和当前限制请参阅 [docs/GIT_IMPORT.md](docs/GIT_IMPORT.md)。

在 macOS 上可以通过 shell alias 简化路径：

```bash
alias lore="$PWD/scripts/lore"
```

## 开发

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm --filter @lore-portal/web build
```

在运行 `pnpm dev:local` 的终端中按 `Ctrl-C` 可停止全部应用进程。

## Docker

准备 `.env` 后，可以使用 Compose 构建并启动单节点部署：

```bash
docker compose build
docker compose up -d
```

门户 Web、API 和 Lore Server 打包在 `yeomai-lore-web` 单一应用镜像中；Lore Server 二进制在构建时直接从官方 `ghcr.io/epicgames/lore/loreserver:0.13.0` 镜像提取。SQLite 面向单节点门户；未来多节点部署应改用网络数据库。

Portal API 会在构建镜像时打包为 `apps/server/dist/index.js`，运行时使用 `node dist/index.js`。最终运行镜像不包含 `tsx`、esbuild、TypeScript、Vitest 等仅用于开发的依赖。

Docker 镜像的生产打包与内存约束见 [docs/DOCKER_BUILD_SPEC.md](docs/DOCKER_BUILD_SPEC.md)。

所有持久化数据直接映射到仓库内的 `docker-data/`，不依赖隐藏的 Docker 命名卷：

```text
docker-data/
  site/          SQLite、身份签名私钥、导入任务，映射到 /data
  site/lore/     Lore 仓库、分支、revision 和文件
  site/config/.env          门户运行环境配置
  site/config/local.toml    Lore 服务端认证配置
  certs/         内部 gRPC 与 Lore QUIC 证书
```

这些目录已在仓库中建立。完整备份可以直接复制整个 `docker-data/`；恢复时在启动前放回同一位置。不要在 `docker-data/` 之外启动 Compose，否则相对路径会指向其他目录。

### 最小安全备份

如果只需要在重新部署后继续使用现有仓库、用户、授权和站点配置，至少备份以下内容：

```text
docker-data/site/lore/store/
docker-data/site/portal.sqlite
docker-data/site/keys/oidc-private.pem
docker-data/site/config/.env
```

- `site/lore/store/` 保存 Lore 仓库的提交、分支、文件树和文件内容。
- `site/portal.sqlite` 保存用户、组织、仓库 ID/名称映射、权限、站点设置、OAuth 和导入记录。
- `site/keys/oidc-private.pem` 用于 OIDC/JWT 签名，同时也是门户敏感配置 AES 加密密钥的派生来源。替换它会使旧 JWT 失效，并导致已保存的 SMTP 密码密文和邀请链接密文无法解密。
- `site/config/.env` 保存公开地址、证书路径和进程级运行配置。

如果重新部署时会重新生成或上传与 Lore 公开域名匹配的新证书，则 `docker-data/certs/` 可以不备份。此处指的是 Lore QUIC/gRPC 使用的 `/certs`，与 Web 站点的普通 HTTPS 证书相互独立。部署后必须确认 `lore.crt` 覆盖实际 Lore 服务域名；否则 Lore 客户端连接会因证书不匹配而失败。

`site/config/local.toml` 会在启动时重新生成。`site/imports/` 和 `site/run/`
也不需要包含在上述最小备份中。

备份 SQLite 前应先停止 `app` 服务，确保 WAL 内容已经合并，避免只复制主数据库文件而遗漏最近提交。

不使用 Compose、直接运行镜像时，使用显式卷映射：

```bash
pnpm run run:docker
```

脚本固定使用以下 `-v` 映射，并在启动前生成或校验证书：

```text
./docker-data/site   -> /data
./docker-data/certs  -> /certs
```

`/data/lore` 是 `/data` 的子目录，不需要再次单独映射。

首次启动会自动生成 `docker-data/site/config/.env`，站点地址和第一个管理员在安装向导中设置。API 会在每次启动时根据持久化设置生成 `local.toml`，因此修改自定义地址或 Lore 证书后需要重启容器生效。

升级旧版本时，如果 SQLite 中的 `web_public_url` 和 `lore_public_url`
使用了不同主机，API 会在启动时保留原 Lore 主机，并把 Web 与 Lore 地址都
迁移到该统一主机和 Web 端口。迁移只更新 `system_settings`，不会修改用户、
仓库、权限或 Lore 存储。`config/.env` 只作为新安装的引导配置；已有数据库
运行时会以 SQLite 设置覆盖 `.env` 中的公开地址。迁移会改变 OIDC issuer，
旧登录令牌需要重新登录。
迁移还会撤销旧浏览器会话和 OAuth Refresh Token，并递增用户的
`oauth_epoch`，避免旧域名凭证继续被使用。

`.env` 是该部署的进程级环境配置；对于已初始化站点，公开地址仍以 SQLite
中的设置为准。不需要在 Docker 管理页面重复填写这些变量。

单独运行镜像不会自动根据宿主机当前目录创建映射；必须使用上述脚本或采用等价的 `docker run -v` 参数。

## 当前边界

- Lore 尚未达到 1.0。项目固定使用 `0.13.0`；升级前必须运行协议和认证回归测试。
- 原生本地配置为单节点模式并使用本地 Lore 存储，不具备高可用能力。
- 可以在安装引导中配置 SMTP，密码会加密后保存到 SQLite。未配置 SMTP 时，邀请和密码重置链接会写入 API 日志，仅适合本地测试。
- 固定版本的 Lore Server 尚未实现 `ThinClient.ContentDiff`。门户在 API 中基于 Lore Blob 计算有大小限制的文本差异；二进制文件和大于 2 MiB 的文件不会生成文本差异。
- Git 导入是初始单节点实现。可恢复导入、私有 Git 凭据、持续 Git 同步、在线编辑、变更请求、Issue、Wiki、Release、搜索、项目、包注册表、Webhook、TOTP 和完整生产加固仍属于后续阶段。
- 本地内部 gRPC 和 Lore QUIC 共用持久化的开发证书；`lore://` 会跳过服务端证书验证。生产环境必须换用域名证书、安装 CA 并使用 `lores://`。

## 验证

当前实现已经通过以下检查：

- `pnpm typecheck`
- `pnpm test`
- `pnpm test:gateway`
- `pnpm --filter @lore-portal/web build`
- 官方 Lore CLI `0.13.0` 的设备登录、仓库克隆、暂存、提交和推送
- 门户针对 Lore `0.13.0` 的分支、修订、文件树、Blob 和文本差异查询
- 跨用户 ACL 检查：授权前不可访问，授权后仓库只读可见

分阶段计划和待完成工作请参阅 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。
