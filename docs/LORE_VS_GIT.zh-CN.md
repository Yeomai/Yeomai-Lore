# Lore 与 Git 命令对照

本文以 **Lore 0.14.0** 和官方 0.14.0 文档为准，按功能对 Lore 与 Git 的常用命令进行对照。

## 总体结论

Lore 的日常工作流与 Git 很像，但不是 Git 的命令替代品。二者都采用内容寻址、Merkle 树、修订 DAG、分支指针和三方合并。

Lore 的主要差异是：

- 以集中式服务器作为仓库权威来源。
- 默认为二进制优先。
- 默认稀疏检出，并按需下载分片。
- 使用分片级去重，不依赖 Git LFS。
- 在服务端原生提供多租户权限、分支保护和文件锁。

官方文档也明确说明，Lore 没有发明内容寻址、Merkle DAG、分支指针或三方合并。它的差异化来自将这些能力组合成一套面向大型二进制仓库的系统。

## 功能分类对照

| 功能 | Git 常用命令 | Lore 对应命令 | 关系与关键区别 |
|---|---|---|---|
| 创建仓库 | `git init` | `lore repository create` | 类似初始化。Lore 通常会同时初始化服务器仓库和本地工作区，并支持仓库简介、显式 ID、VFS 和共享存储。 |
| 克隆仓库 | `git clone` | `lore clone`、`lore repository clone` | 概念相似。Lore 默认稀疏并按需获取，支持 view、layer、预取、依赖选择和共享存储。 |
| 仓库信息 | `git remote -v`、`git config` | `lore repository info/list/config get` | Lore 没有独立的 `remote` 命令，远程地址保存在 `.lore/config.toml` 中。 |
| 删除仓库 | Git 本身没有统一的服务器删除命令 | `lore repository delete` | Lore 将仓库管理纳入 CLI。 |
| 查看状态 | `git status` | `lore status`、`lore status --scan` | 名字相似，行为不同。Lore 默认只读取已经标记的 dirty 状态，不扫描文件系统；要发现外部修改必须使用 `--scan`。 |
| 标记变更 | 主要依靠 `git status` 和 `git add` | `lore dirty` | Lore 的显式标记步骤，只标记某个路径可能发生变化，不读取内容，也不暂存。 |
| 暂存变更 | `git add`、`git rm`、`git mv` | `lore stage`、`lore stage move`、`lore dirty move/copy` | Lore 使用一个 `stage` 命令处理新增、修改和删除；目录暂存默认只处理已经标记为 dirty 的文件。 |
| 取消暂存 | `git restore --staged`、`git reset` | `lore unstage` | 概念相似，但 Lore 将取消暂存和恢复工作区文件拆分为不同命令。 |
| 提交 | `git commit` | `lore commit`、`lore revision commit` | 工作流相似。Lore 修订还有递增编号和哈希签名，提交消息作为参数传入。 |
| 修改提交 | `git commit --amend` | `lore revision amend` | 语义明显不同。Lore 的 amend 只修改最近一次提交的消息，不重新打包文件内容。 |
| 查看历史 | `git log`、`git show` | `lore history`、`lore revision info` | `history` 接近 `log`，但没有完全等同于 `git show` 的单一命令。 |
| 查看差异 | `git diff`、`git show` | `lore diff`、`lore revision diff`、`lore branch diff`、`lore file diff` | Lore 的分类更细，可按工作区、修订、分支或文件分别比较。 |
| 文件历史与作者 | `git log -- path`、`git blame` | `lore file history`、`lore file audit` | `file audit` 按行追溯最后修改该行的修订，接近 Git blame。 |
| 创建分支 | `git branch`、`git switch -c` | `lore branch create` | Lore 创建分支后会直接切换工作区，不同于 `git branch` 只创建引用。 |
| 切换分支 | `git checkout`、`git switch` | `lore branch switch` | 默认会同步远端该分支的最新状态；使用 `--local` 才保持本地 latest。 |
| 分支管理 | `git branch -d/-m` 等 | `lore branch list/info/archive/reset/protect/latest` | Lore 使用归档代替普通删除，并原生支持保护分支和 latest 指针历史。 |
| 合并 | `git merge` | `lore branch merge`、`merge start`、`merge into` | 都使用三方合并。Lore 将开始合并、解决冲突、重启、放弃以及直接合入目标分支拆成子命令。 |
| 冲突处理 | `git add`、`git merge --abort` | `lore branch merge resolve mine/theirs`、`unresolve`、`abort` | Lore 可以明确选择自己的版本或对方版本；二进制冲突通常需要在两个版本中选择。 |
| 拉取更新 | `git fetch` 加 `git pull` | `lore sync` | 官方术语表将 `sync` 定义为 Git pull 的 Lore 对应物，会拉取远端修订并合并为合并修订。 |
| 推送 | `git push` | `lore push`、`lore branch push` | 概念相似。Lore 上传去重后的分片；发生分支竞争时，可以要求服务端快进合并。 |
| 恢复工作区文件 | `git restore`、`git reset --hard` | `lore reset`、`lore file reset` | 丢弃指定路径的本地修改；`--purge` 还能清理 view 内的未跟踪文件，接近部分 `git clean`。 |
| 移动分支指针 | `git reset --soft/mixed/hard` | `lore branch reset` | 只重置分支的本地 latest 指针，不等同于 Git 的三种 reset 模式。 |
| 还原历史修订 | `git revert` | `lore revision revert` | 概念相似，都会创建一个抵消旧修订的新修订。 |
| 拣选提交 | `git cherry-pick` | `lore revision cherry-pick` | 概念相似，同样支持冲突解决流程。 |
| 二分查找 | `git bisect` | `lore revision bisect` | 类似，但 Lore 使用非交互方式，要求指定已知正常修订和已知异常修订。 |
| 恢复当前修订为 latest | 没有完全对应的命令 | `lore revision restore` | 不要将其理解为 `git restore`，它操作的是修订与分支 latest。 |
| 元数据 | `git notes`、`git config`、`git tag` | `repository/branch/revision/file metadata` | Lore 原生支持仓库、分支、修订和文件四级键值元数据。 |
| 版本标签 | `git tag` | Lore 0.14.0 没有版本 tag 命令 | 元数据不能直接视为 Git tag；`file dependency --tag` 也不是版本标签。 |
| 临时保存工作 | `git stash` | Lore 0.14.0 没有 stash 命令 | 需要提交到分支，或使用独立的工作实例。 |
| 变基 | `git rebase` | Lore 0.14.0 没有公开 rebase 命令 | 可以通过 cherry-pick 等操作重组修订，但这不属于 rebase。 |
| 子模块 | `git submodule`、`git subtree` | `lore link` | 只是近似能力。Lore link 引用另一个仓库的指定子树和修订，并随父修订提交。 |
| 本地叠加内容 | Git 没有完全对应的机制 | `lore layer` | 只存在于当前机器，不写入任何修订；两台机器上的同一修订可以有不同的 layer。 |
| 多工作区 | `git worktree` | `shared-store` 配合多次 `lore clone` | 更接近多个平等的实例共享一套底层存储，不像 Git 那样区分主仓库和附属 worktree。 |
| 稀疏检出 | `git sparse-checkout`、partial clone | view、lazy fetch、`--prefetch`、VFS | Lore 默认就采用稀疏和按需获取，不是可选优化。 |
| 大文件 | Git LFS 或外部系统 | 原生文件分片与分片去重 | 二进制和大文件是 Lore 的底层一等对象，不依赖 LFS。 |
| 文件依赖选择 | 没有原生对应机制 | `lore file dependency add/remove/list` | 支持沿依赖关系选择性 clone 和 sync，并可按 tag 过滤。 |
| 文件锁定 | Git 核心无锁，通常使用 Git LFS lock | `lore lock acquire/status/query/release` | Lore 原生提供锁，但官方说明其属于咨询性锁，不会强制阻止 push 或修改。 |
| 完整性检查 | `git fsck`、`git gc` | `lore repository verify/dump/gc` | Lore 可以按状态或分片验证，并支持自动修复。 |
| 彻底清除内容 | Git 需要 `filter-repo` 等外部工具 | `lore file obliterate` | 清除分片载荷但保留地址结构，不等同于在新提交中删除文件。 |
| 身份登录 | Git credential helper | `lore login`、`lore auth login/info/list/logout/clear` | Lore 将认证和服务端令牌纳入 CLI。 |
| 后台服务 | Git 通常没有这种客户端服务模型 | `lore service start/stop/status/run` | Lore 可以由常驻服务执行客户端操作。 |

## 最需要避免的 Git 直觉

1. `lore status` 不会默认扫描磁盘。外部修改文件后，通常需要使用 `lore status --scan`。
2. `lore stage` 暂存的是路径意图，不会像 Git index 一样锁定当时的文件内容。真正提交时会读取文件当前内容。
3. `lore branch create` 会创建并切换到新分支，不是单纯创建一个引用。
4. `lore revision amend` 只能修改提交消息。
5. `lore sync` 才是 Git `pull` 的总对应物。Lore 没有独立的 `fetch` 和 `pull` 命令。
6. `lore revision restore` 不是 `git restore`。
7. Lore 分支名称之外还有稳定的分支 ID，因此界面中显示 UUID 属于 Lore 自身模型的一部分。
8. Lore 0.14.0 没有 `tag`、`stash`、`rebase`、`pull`、`fetch`、`remote` 这些 Git 同名顶层命令。

## Lore 的差异化能力

更准确地说，Lore 并不是每项能力都属业内首创，而是以下能力由 Lore 原生提供并深度联动：

- `link`：将另一个仓库的子树挂载到当前仓库，同时形成独立的访问控制边界。
- `layer`：在当前机器上叠加内容，不污染任何修订。
- 文件依赖图：按依赖关系执行部分 clone 或 sync。
- 分片级内容寻址：大二进制文件只上传发生变化的分片。
- 默认稀疏、按需加载：操作成本跟随工作集，而不是仓库总大小。
- 共享存储与平等实例：多个工作区共享一份分片存储。
- 四级元数据：仓库、分支、修订和文件均可附加结构化数据。
- 服务端原生 ACL、分支保护和文件锁。
- `file audit`、`file obliterate`、`repository verify --heal` 等原生审计与完整性能力。

## 官方依据

- [Lore CLI 命令参考](https://github.com/EpicGames/lore/blob/v0.14.0/docs/reference/lore-cli-commands.md)
- [Lore 与 Git 官方比较](https://github.com/EpicGames/lore/blob/v0.14.0/docs/explanation/system-design.md)
- [Lore 术语表](https://github.com/EpicGames/lore/blob/v0.14.0/docs/glossary.md)
- [Lore 快速入门](https://github.com/EpicGames/lore/blob/v0.14.0/docs/tutorials/quickstart.md)

