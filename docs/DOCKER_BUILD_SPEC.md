# Docker 打包规范

Docker 镜像是生产交付物，不只是开发环境的打包结果。镜像设计必须同时考虑
运行时内存、磁盘占用、启动开销和故障恢复能力，不能因为构建方便而把开发工具
长期留在运行镜像中。

## Portal API 必须编译为 JavaScript

- Portal API 在镜像构建阶段编译并打包为 `apps/server/dist/index.js`。
- 运行阶段必须使用 `node dist/index.js` 启动，不得使用 `tsx src/index.ts`。
- 最终镜像不得包含 `tsx` loader、esbuild 服务、TypeScript、Vitest 或其他仅用于
  构建和测试的开发依赖。
- Docker 构建使用 `pnpm deploy --prod --legacy` 创建独立 runtime 目录，只复制
  编译产物、生产依赖，以及运行所需的 migrations、proto 和模板资源。
- esbuild 只允许作为构建期工具，不允许在容器运行期间保持后台 service。

该规范可避免长期保留 `tsx` 父进程、TypeScript loader 和 esbuild service，历史
估算可节省约 10–30 MiB。当前冷启动测试中，容器内存占用从 285.6 MiB 降至
238 MiB，减少约 47.6 MiB。

## Lore Server 内存与服务裁剪

`loreserver` 属于官方服务，不得通过修改官方二进制的方式做私有内存优化。需要
裁剪功能时，只能使用 Lore 官方支持的配置项。

Lore 官方允许关闭未使用的公共 gRPC 服务：

```toml
[server.grpc_public_services.admin_service]
enabled = false

[server.grpc_public_services.notification_service]
enabled = false

[server.grpc_public_services.lock_service]
enabled = false
```

当前**不自动关闭**这三个服务。`AdminService`、Desktop 通知和 Lore 文件锁仍可能
被 Lore CLI 或 Desktop 功能调用，贸然关闭可能造成兼容性或功能回归。

只有在以下条件全部满足后，才可以在生产部署中关闭对应服务：

1. 日志和客户端功能验证确认该服务确实未被使用。
2. 不依赖 Lore CLI 的管理员运维接口。
3. 不依赖 Desktop 的通知能力。
4. 不依赖 Lore 文件锁或相关未合并冲突处理流程。
5. 完成仓库打开、同步、推送、分支和冲突处理的回归测试。

其他 Lore 内存优化也应优先使用官方配置，例如在小型单节点部署中评估
`[server.quic] num_sockets`。该参数涉及并发吞吐与内存的权衡，必须经过真实仓库
负载测试，不能在未验证的情况下直接收紧。

## 构建检查清单

- Portal API 构建产物是 JavaScript。
- 运行命令是 `node dist/index.js`。
- 最终镜像中不存在 `tsx`、esbuild、TypeScript 和 Vitest。
- 使用生产依赖，不复制完整 monorepo workspace。
- migrations、proto 和模板资源在最终目录中可访问。
- 容器冷启动后 API、Web 和 Lore 健康检查均返回成功。
- Lore 服务启停通过官方配置控制，不修改官方二进制。
