# Docker 持久化目录

此目录由 Compose 直接挂载，删除或覆盖会导致身份、数据库或仓库丢失。

- `site/`：映射到容器的 `/data`，包含 SQLite、OIDC 签名私钥和导入任务数据。
- `site/lore/`：Lore revision、分支和文件存储。
- `site/config/.env`：门户公开地址、管理员初始化和 SMTP 配置。
- `site/config/local.toml`：Lore 服务端认证、OIDC、公开地址和 QUIC 证书配置。
- `certs/`：内部 gRPC 与 Lore QUIC 证书。

首次克隆后这些目录已经存在。启动命令必须在仓库根目录执行，否则相对的宿主机路径会指向其他位置。

`site/config/.env` 是该部署的权威环境配置。修改后重启容器，不需要在 Docker
管理页面逐个填写这些变量。

## 最小安全备份

重新部署后若要继续使用现有仓库、用户、授权和站点配置，至少备份：

```text
site/lore/store/
site/portal.sqlite
site/keys/oidc-private.pem
site/config/.env
```

`site/keys/oidc-private.pem` 用于 OIDC/JWT 签名，也用于派生门户敏感配置的
AES 加密密钥。替换它会使旧 JWT 失效，并导致已保存的 SMTP 密码和邀请链接
密文无法解密。

如果重新部署时会重新生成或上传与 Lore 公开域名匹配的新证书，
`docker-data/certs/` 可以不备份。部署后必须确认 `lore.crt` 覆盖实际的
Lore 服务域名。`site/config/local.toml` 会自动重新生成；`site/imports/`
和 `site/run/` 也不需要包含在最小备份中。

备份 `portal.sqlite` 前应先停止 `app` 服务，确保 SQLite WAL 内容已经合并。
