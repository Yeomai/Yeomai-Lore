import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type {
  BranchSummary,
  RepositoryRecord,
  RepositoryTag,
  RevisionSummary,
  TreeNodeSummary,
} from "@lore-portal/shared";
import {
  isServiceReady,
  requirePageUser,
  serverApi,
  serverApiResponse,
} from "../../../../lib/api";
import { getI18n } from "../../../../i18n/server";
import {
  formatMessage,
  type Messages,
} from "../../../../i18n/messages";
import { CopyButton } from "../../../../components/CopyButton";
import { BrowserTime } from "../../../../components/BrowserTime";
import { ClearFileSelectionOnReload } from "../../../../components/ClearFileSelectionOnReload";
import {
  isMarkdownPath,
  MarkdownBody,
  MarkdownPreview,
} from "../../../../components/MarkdownPreview";
import { buildBranchRows } from "../../../../lib/branch-tree";
import { FileTreeContextMenu } from "../../../../components/FileTreeContextMenu";
import {
  buildDiffFileTree,
  type DiffTreeNode,
} from "../../../../lib/diff-tree";
import {
  buildCommitGraph,
  commitEdgePath,
  COMMIT_GRAPH_PADDING,
  COMMIT_LANE_WIDTH,
  COMMIT_ROW_HEIGHT,
  type CommitGraphRow,
} from "../../../../lib/commit-graph";
import {
  cachedValue,
  shouldRefreshServerCache,
} from "../../../../lib/server-cache";

interface DiffFile {
  path: string;
  pathFrom: string;
  action: "keep" | "add" | "delete" | "move" | "copy";
  type: "directory" | "file" | "link";
  automerged: boolean;
}

interface TextDiff {
  binary: boolean;
  truncated: boolean;
  linesAdded: number;
  linesDeleted: number;
  text: string;
  from: string | null;
  to: string | null;
}

interface FilePreview {
  kind: "text" | "image" | "unsupported";
  text?: string;
  src?: string;
}

interface ReadmePreviewData {
  path: string;
  content: string;
}

type SearchParams = Record<string, string | string[] | undefined>;

export default async function RepositoryPage({
  params,
  searchParams,
}: {
  params: Promise<{
    organizationSlug: string;
    repositorySlug: string;
  }>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePageUser();
  const requestHeaders = await headers();
  const forceRefresh = shouldRefreshServerCache(requestHeaders);
  if (!(await isServiceReady())) {
    redirect("/starting");
  }
  const { locale, messages } = await getI18n();
  const m = messages.repository;
  const route = await params;
  const query = await searchParams;
  const basePath = `/api/v1/repos/${encodeURIComponent(route.organizationSlug)}/${encodeURIComponent(route.repositorySlug)}`;
  const pagePath = `/r/${route.organizationSlug}/${route.repositorySlug}`;
  const [repositoryResponse, branchesResponse, tagsResponse, meta] =
    await Promise.all([
      cachedValue(`repository:${user.id}:${basePath}`, 600_000, () =>
        serverApi<{ repository: RepositoryRecord }>(basePath),
        { force: forceRefresh },
      ),
      cachedValue(`branches:${user.id}:${basePath}`, 600_000, () =>
        serverApi<{ branches: BranchSummary[] }>(`${basePath}/branches`),
        { force: forceRefresh },
      ),
      cachedValue(`tags:${user.id}:${basePath}`, 600_000, () =>
        serverApi<{ tags: RepositoryTag[] }>(`${basePath}/tags`),
        { force: forceRefresh },
      ),
      cachedValue(`meta:${user.id}`, 600_000, () =>
        serverApi<{ loreRemoteUrl: string }>("/api/v1/meta"),
        { force: forceRefresh },
      ),
    ]);
  const repository = repositoryResponse.repository;
  const branches = branchesResponse.branches;
  const tags = tagsResponse.tags;
  const branchRows = buildBranchRows(branches, repository.defaultBranchId);
  const selectedBranch =
    one(query.branch) ??
    branches.find((branch) => branch.id === repository.defaultBranchId)?.name ??
    branches[0]?.name ??
    repository.defaultBranchName;
  const requestedView = one(query.view);
  const mode =
    requestedView === "commit" ||
    requestedView === "diff" ||
    requestedView === "tags"
      ? requestedView
      : "tree";
  const commitTab = one(query.commits) === "list" ? "list" : "graph";
  const graphMode = mode === "commit" && commitTab === "graph";
  const revision = one(query.revision);
  const currentPath = one(query.path) ?? "";
  const selectedFile = one(query.file);
  const repositoryPath = `${repository.organizationSlug}/${repository.slug}`;
  const command = `lore clone ${meta.loreRemoteUrl}/${repositoryPath}`;

  const revisionPath = `${basePath}/${graphMode ? "revision-graph" : "revisions"}?${new URLSearchParams({
    branch: selectedBranch,
  })}`;
  const revisionsResponse = await cachedValue(
    `revisions:${user.id}:${revisionPath}`,
    600_000,
    () =>
      serverApi<{
        revisions: RevisionSummary[];
      }>(revisionPath),
    { force: forceRefresh },
  );
  const revisions = revisionsResponse.revisions;
  const selectedRevisionIndex = Math.max(
    0,
    revision
      ? revisions.findIndex((item) => item.signature === revision)
      : 0,
  );
  const selectedRevision = revisions[selectedRevisionIndex];
  const previousRevision =
    mode === "commit"
      ? revisions.find(
          (item) => item.signature === selectedRevision?.parents[0],
        ) ?? revisions[selectedRevisionIndex + 1]
      : revisions[selectedRevisionIndex + 1];
  const treeResponse =
    mode === "tree" && revisions.length > 0
      ? await cachedValue(
          `tree:${user.id}:${basePath}:${selectedBranch}:${currentPath}`,
          600_000,
          () =>
            serverApi<{ nodes: TreeNodeSummary[] }>(
              `${basePath}/tree?${new URLSearchParams({
                branch: selectedBranch,
                path: currentPath,
              })}`,
            ),
          { force: forceRefresh },
        )
      : { nodes: [] };
  const readmeNode =
    mode === "tree" && currentPath === ""
      ? treeResponse.nodes.find(
          (node) =>
            node.type === "file" &&
            basename(node.path).toLowerCase() === "readme.md",
        )
      : undefined;
  const readmePreview = readmeNode
    ? await cachedValue(
        `readme:${user.id}:${basePath}:${selectedBranch}:${readmeNode.path}`,
        600_000,
        () => loadFilePreview(basePath, selectedBranch, readmeNode.path),
        { force: forceRefresh },
      )
    : null;
  const readme: ReadmePreviewData | null =
    readmeNode &&
    readmePreview?.kind === "text" &&
    readmePreview.text !== undefined
      ? { path: readmeNode.path, content: readmePreview.text }
      : null;
  const diffFrom =
    mode === "commit"
      ? previousRevision?.signature
      : mode === "diff"
        ? one(query.from) ?? revisions[1]?.signature
        : undefined;
  const diffTo =
    mode === "commit"
      ? selectedRevision?.signature
      : mode === "diff"
        ? one(query.to) ?? revisions[0]?.signature
        : undefined;
  const diffResponse =
    (mode === "commit" || mode === "diff") && diffFrom && diffTo
      ? await serverApi<{
          files: DiffFile[];
          from: string | null;
          to: string | null;
        }>(
          `${basePath}/diff?${new URLSearchParams({
            ...(diffFrom ? { from: diffFrom } : {}),
            ...(diffTo ? { to: diffTo } : {}),
          })}`,
        )
      : null;
  const textDiff =
    mode === "diff" && selectedFile
      ? await serverApi<TextDiff>(
          `${basePath}/text-diff?${new URLSearchParams({
            branch: selectedBranch,
            path: selectedFile,
            ...(one(query.from) ? { from: one(query.from)! } : {}),
            ...(one(query.to) ? { to: one(query.to)! } : {}),
          })}`,
        )
      : null;
  const treeFilePath = mode === "tree" ? selectedFile : undefined;
  const filePreview = treeFilePath
    ? await cachedValue(
        `preview:${user.id}:${basePath}:${selectedBranch}:${treeFilePath}`,
        600_000,
        () => loadFilePreview(basePath, selectedBranch, treeFilePath),
        { force: forceRefresh },
      )
    : null;
  const hasRepositoryPreview = Boolean(
    readme || (selectedFile && filePreview),
  );
  return (
    <div className="page-stack">
      <ClearFileSelectionOnReload />
      <section className="repo-header">
        <div>
          <h1 className="repo-title">
            <Link href="/dashboard">{repository.organizationSlug}</Link>
            <span>/</span>
            <span>{repository.slug}</span>
          </h1>
          <p className="lede">
            {repository.description || m.noDescription}
          </p>
        </div>
        {repository.status !== "active" ? (
          <span className={`badge status-${repository.status}`}>
            {messages.status[repository.status]}
          </span>
        ) : null}
      </section>

      <section className="panel repo-main">
        <div className="repo-toolbar">
          <details className="repo-dropdown" data-dropdown>
            <summary>
              <strong>{selectedBranch}</strong>
            </summary>
            <div className="repo-dropdown-menu branch-dropdown-menu">
              <span className="repo-menu-label">{m.branches}</span>
              {branches.length === 0 ? (
                <span className="muted">
                  {repository.defaultBranchName}
                </span>
              ) : (
                branchRows.map((branch) => (
                  <a
                    className={`branch-menu-item ${
                      branch.name === selectedBranch ? "active" : ""
                    }`}
                    href={`${pagePath}?${new URLSearchParams({
                      branch: branch.name,
                      view: mode,
                      ...(mode === "tree" ? { path: "" } : {}),
                    })}`}
                    key={branch.id}
                    style={{ paddingLeft: `${10 + branch.depth * 20}px` }}
                  >
                    <span className="branch-menu-name">
                      <span className="branch-menu-caret">
                        {branch.hasChildren ? "▾" : "·"}
                      </span>
                      <span>{branch.name}</span>
                      {branch.id === repository.defaultBranchId ? (
                        <span className="badge">
                          {messages.common.defaultBranch}
                        </span>
                      ) : null}
                      {branch.name === selectedBranch ? (
                        <span className="branch-check">✓</span>
                      ) : null}
                    </span>
                    <code title={branch.id}>{branch.id}</code>
                  </a>
                ))
              )}
            </div>
          </details>
          <details className="repo-dropdown code-dropdown" data-dropdown>
            <summary>
              <strong>{m.code}</strong>
            </summary>
            <div className="repo-dropdown-menu repo-code-menu">
              <span className="repo-menu-label">{m.cloneCommand}</span>
              <code>{command}</code>
              <CopyButton value={command} />
            </div>
          </details>
        </div>
        <nav className="tabs">
            <Link
              className={mode === "tree" ? "active" : ""}
              href={`${pagePath}?${new URLSearchParams({
                branch: selectedBranch,
                view: "tree",
                path: currentPath,
              })}`}
            >
              {m.fileTree}
            </Link>
            <Link
              className={mode === "commit" ? "active" : ""}
              href={`${pagePath}?${new URLSearchParams({
                branch: selectedBranch,
                view: "commit",
              })}`}
            >
              {m.commit}
            </Link>
            <Link
              className={mode === "diff" ? "active" : ""}
              href={`${pagePath}?${new URLSearchParams({
                branch: selectedBranch,
                view: "diff",
              })}`}
            >
              {m.changes}
            </Link>
            {tags.length > 0 ? (
              <Link
                className={mode === "tags" ? "active" : ""}
                href={`${pagePath}?${new URLSearchParams({
                  branch: selectedBranch,
                  view: "tags",
                })}`}
              >
                {m.tags}
              </Link>
            ) : null}
        </nav>
        <div className="repo-view-content">
          {mode === "commit" ? (
            <CommitView
              revisions={revisions}
              revision={selectedRevision}
              diffResponse={diffResponse}
              pagePath={pagePath}
              branch={selectedBranch}
              commitTab={commitTab}
              messages={messages}
              locale={locale}
            />
          ) : mode === "tree" ? (
            <FileTreeView
              path={currentPath}
              repositorySlug={repository.slug}
              nodes={treeResponse.nodes}
              selectedFile={treeFilePath}
              pagePath={pagePath}
              basePath={basePath}
              branch={selectedBranch}
              messages={messages}
              locale={locale}
            />
          ) : mode === "tags" ? (
            <TagsView tags={tags} messages={messages} />
          ) : (
            <DiffView
              files={
                diffResponse?.files.filter(
                  (file) => file.type !== "directory",
                ) ?? []
              }
              selectedFile={selectedFile}
              textDiff={textDiff}
              from={diffResponse?.from ?? null}
              to={diffResponse?.to ?? null}
              pagePath={pagePath}
              branch={selectedBranch}
              messages={messages}
            />
          )}
        </div>
      </section>
      {hasRepositoryPreview ? (
        <div className="repo-preview-area">
          {selectedFile && filePreview ? (
            <FilePreviewPanel
              path={selectedFile}
              preview={filePreview}
              downloadHref={`${basePath}/blob?${new URLSearchParams({
                branch: selectedBranch,
                path: selectedFile,
                inline: "false",
              })}`}
              closeHref={`${pagePath}?${new URLSearchParams({
                branch: selectedBranch,
                view: "tree",
                path: currentPath,
              })}`}
              pagePath={pagePath}
              basePath={basePath}
              branch={selectedBranch}
              messages={messages}
            />
          ) : readme ? (
            <MarkdownPreview
              basePath={basePath}
              branch={selectedBranch}
              content={readme.content}
              pagePath={pagePath}
              path={readme.path}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TagsView({
  tags,
  messages,
}: {
  tags: RepositoryTag[];
  messages: Messages;
}) {
  const m = messages.repository;
  return (
    <div className="tag-list">
      {tags.map((tag) => (
        <article className="tag-row" key={tag.name}>
          <div>
            <strong>{tag.name}</strong>
            <span className="badge">
              {tag.annotated ? m.annotatedTag : m.lightweightTag}
            </span>
          </div>
          <p>{tag.message || m.noTagMessage}</p>
          <small>
            {tag.tagger} ·{" "}
            <Link
              href={`?${new URLSearchParams({
                branch: tag.branchName,
                view: "commit",
                revision: tag.revision,
              })}`}
            >
              <code>{tag.revision.slice(0, 12)}</code>
            </Link>
          </small>
        </article>
      ))}
    </div>
  );
}

function CommitView({
  revisions,
  revision,
  diffResponse,
  pagePath,
  branch,
  commitTab,
  messages,
  locale,
}: {
  revisions: RevisionSummary[];
  revision: RevisionSummary | undefined;
  diffResponse: {
    files: DiffFile[];
    from: string | null;
    to: string | null;
  } | null;
  pagePath: string;
  branch: string;
  commitTab: "graph" | "list";
  messages: Messages;
  locale: string;
}) {
  const m = messages.repository;
  const changedFiles =
    diffResponse?.files.filter((file) => file.type !== "directory") ?? [];
  if (!revision) {
    return <p className="empty-cell">{m.emptyRepository}</p>;
  }
  return (
    <div className="commit-layout">
      <section className="commit-history">
        <div className="commit-history-heading">
          <nav className="commit-view-tabs">
            <Link
              className={commitTab === "graph" ? "active" : ""}
              href={`${pagePath}?${new URLSearchParams({
                branch,
                view: "commit",
                commits: "graph",
                revision: revision.signature,
              })}`}
            >
              {m.commitGraph}
            </Link>
            <Link
              className={commitTab === "list" ? "active" : ""}
              href={`${pagePath}?${new URLSearchParams({
                branch,
                view: "commit",
                commits: "list",
                revision: revision.signature,
              })}`}
            >
              {m.commitHistory}
            </Link>
          </nav>
        </div>
        {commitTab === "graph" ? (
          <CommitGraph
            revisions={revisions}
            revision={revision}
            pagePath={pagePath}
            branch={branch}
            messages={messages}
            locale={locale}
          />
        ) : (
          <div className="commit-history-table">
          {revisions.map((item) => (
            <Link
              className={`commit-history-row ${
                item.signature === revision.signature ? "active" : ""
              }`}
              href={`${pagePath}?${new URLSearchParams({
                branch,
                view: "commit",
                revision: item.signature,
              })}`}
              key={item.signature}
              role="row"
            >
              <span role="cell">{item.message || m.noMessage}</span>
              <span role="cell">{item.committedBy || m.unknown}</span>
              <code role="cell">{item.signature.slice(0, 8)}</code>
              <BrowserTime
                value={item.timestamp}
                locale={locale}
                role="cell"
              />
            </Link>
          ))}
          </div>
        )}
      </section>
      <section className="commit-detail">
        <div className="commit-overview">
          <p className="eyebrow">
            {formatMessage(m.commitNumber, { number: revision.number })}
          </p>
          <h2>{revision.message || m.noMessage}</h2>
        </div>
        <div className="commit-changes">
          <div className="section-heading tight">
            <h3>{m.changedFiles}</h3>
            <span className="count">{changedFiles.length}</span>
          </div>
          {!diffResponse?.from || !diffResponse.to ? (
            <p className="muted">{m.firstRevision}</p>
          ) : changedFiles.length === 0 ? (
            <p className="muted">{m.noChangedFiles}</p>
          ) : (
            <div className="commit-file-list">
              {changedFiles.map((file) => (
                <Link
                  href={`${pagePath}?${new URLSearchParams({
                    branch,
                    view: "diff",
                    from: diffResponse.from!,
                    to: diffResponse.to!,
                    file: file.path,
                  })}`}
                  key={`${file.action}:${file.path}`}
                >
                  <span className={`change-kind ${file.action}`}>
                    {file.action === "keep"
                      ? "M"
                      : file.action.slice(0, 1).toUpperCase()}
                  </span>
                  <span>{file.path}</span>
                  <small>{changeActionLabel(file.action, messages)}</small>
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function CommitGraph({
  revisions,
  revision,
  pagePath,
  branch,
  messages,
  locale,
}: {
  revisions: RevisionSummary[];
  revision: RevisionSummary;
  pagePath: string;
  branch: string;
  messages: Messages;
  locale: string;
}) {
  const rows = buildCommitGraph(revisions);
  const rowIndex = new Map(rows.map((row, index) => [row.signature, index]));
  const laneCount = Math.max(1, ...rows.map((row) => row.lane + 1));
  const graphWidth = COMMIT_GRAPH_PADDING + laneCount * COMMIT_LANE_WIDTH;
  const graphHeight = rows.length * COMMIT_ROW_HEIGHT;

  return (
    <div
      className="commit-graph"
      style={
        {
          "--commit-graph-width": `${graphWidth}px`,
        } as React.CSSProperties
      }
    >
      <svg
        className="commit-graph-lines"
        width={graphWidth}
        height={graphHeight}
        viewBox={`0 0 ${graphWidth} ${graphHeight}`}
        aria-hidden="true"
      >
        {rows.flatMap((row, index) =>
          row.parentLanes.map((parent) => {
            const parentIndex = rowIndex.get(parent.signature);
            if (parentIndex === undefined) {
              return null;
            }
            const fromX =
              COMMIT_GRAPH_PADDING + row.lane * COMMIT_LANE_WIDTH;
            const toX =
              COMMIT_GRAPH_PADDING + parent.lane * COMMIT_LANE_WIDTH;
            const color = rows[parentIndex]!.color;
            return (
              <path
                d={commitEdgePath(fromX, toX, index, parentIndex)}
                stroke={color}
                key={`${row.signature}:${parent.signature}`}
              />
            );
          }),
        )}
      </svg>
      {rows.map((row) => (
        <CommitGraphLink
          row={row}
          active={row.signature === revision.signature}
          pagePath={pagePath}
          branch={branch}
          messages={messages}
          locale={locale}
          key={row.signature}
        />
      ))}
    </div>
  );
}

function CommitGraphLink({
  row,
  active,
  pagePath,
  branch,
  messages,
  locale,
}: {
  row: CommitGraphRow;
  active: boolean;
  pagePath: string;
  branch: string;
  messages: Messages;
  locale: string;
}) {
  const m = messages.repository;
  return (
    <Link
      className={`commit-graph-row ${active ? "active" : ""}`}
      href={`${pagePath}?${new URLSearchParams({
        branch,
        view: "commit",
        commits: "graph",
        revision: row.signature,
      })}`}
      scroll={false}
    >
      <span className="commit-graph-node-slot">
        <span
          className={`commit-graph-node ${
            row.parentLanes.length > 1 ? "merge" : ""
          }`}
          style={{
            left: COMMIT_GRAPH_PADDING + row.lane * COMMIT_LANE_WIDTH,
            backgroundColor: row.color,
            boxShadow: `0 0 0 1px ${row.color}`,
          }}
        />
      </span>
      <strong>{row.message || m.noMessage}</strong>
      <span className="commit-graph-user">
        <span>{(row.committedBy || m.unknown).slice(0, 1)}</span>
        {row.committedBy || m.unknown}
      </span>
      <code>{row.signature.slice(0, 10)}</code>
      <BrowserTime value={row.timestamp} locale={locale} />
    </Link>
  );
}

function FileTreeView({
  path,
  repositorySlug,
  nodes,
  selectedFile,
  pagePath,
  basePath,
  branch,
  messages,
  locale,
}: {
  path: string;
  repositorySlug: string;
  nodes: TreeNodeSummary[];
  selectedFile: string | undefined;
  pagePath: string;
  basePath: string;
  branch: string;
  messages: Messages;
  locale: string;
}) {
  const m = messages.repository;
  return (
    <div>
      <FileTreeContextMenu basePath={basePath} branch={branch} />
      {path ? (
        <div className="pathbar">
          <Link
            href={`${pagePath}?${new URLSearchParams({
              branch,
              view: "tree",
              path: "",
            })}`}
          >
            {repositorySlug}
          </Link>
          {path.split("/").filter(Boolean).map((segment, index, all) => {
            const nextPath = all.slice(0, index + 1).join("/");
            return (
              <span key={nextPath}>
                <span>/</span>
                <Link
                  href={`${pagePath}?${new URLSearchParams({
                    branch,
                    view: "tree",
                    path: nextPath,
                  })}`}
                >
                  {segment}
                </Link>
              </span>
            );
          })}
        </div>
      ) : null}
      <div>
        <div className="table-wrap file-list">
          <table>
            <colgroup>
              <col className="file-col-name" />
              <col className="file-col-size" />
              <col className="file-col-updated" />
              <col className="file-col-commit" />
            </colgroup>
            <thead>
              <tr>
                <th>{m.name}</th>
                <th>{m.size}</th>
                <th>{m.updated}</th>
                <th>{m.latestCommit}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr
                  className={selectedFile === node.path ? "selected" : ""}
                  key={`${node.type}:${node.path}`}
                  data-file-tree-kind={
                    node.type === "directory" ? "directory" : "file"
                  }
                  data-file-tree-path={node.path}
                >
                  <td>
                    {node.type === "directory" ? (
                      <Link
                        className="file-name directory"
                        title={basename(node.path)}
                        href={`${pagePath}?${new URLSearchParams({
                          branch,
                          view: "tree",
                          path: node.path,
                        })}`}
                      >
                        <FolderIcon />
                        <span>{basename(node.path)}</span>
                      </Link>
                    ) : (
                      <Link
                        className={`file-name ${node.type} ${
                          selectedFile === node.path ? "selected" : ""
                        }`}
                        title={basename(node.path)}
                        href={`${pagePath}?${new URLSearchParams({
                          branch,
                          view: "tree",
                          path,
                          file: node.path,
                        })}`}
                        scroll={false}
                      >
                        <span>{basename(node.path)}</span>
                      </Link>
                    )}
                  </td>
                  <td
                    title={
                      node.type === "file"
                        ? formatBytes(node.size, locale)
                        : undefined
                    }
                  >
                    {node.type === "file"
                      ? formatBytes(node.size, locale)
                      : "—"}
                  </td>
                  <td
                    title={
                      node.updatedAt
                        ? new Date(node.updatedAt).toISOString()
                        : undefined
                    }
                  >
                    {node.updatedAt
                      ? <BrowserTime value={node.updatedAt} locale={locale} />
                      : "—"}
                  </td>
                  <td
                    className="file-latest-commit"
                    title={node.updatedMessage}
                  >
                    {summarizeCommitMessage(node.updatedMessage)}
                  </td>
                </tr>
              ))}
              {nodes.length === 0 ? (
                <tr>
                  <td colSpan={4} className="empty-cell">
                    {m.emptyDirectory}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function FilePreviewPanel({
  path,
  preview,
  downloadHref,
  closeHref,
  pagePath,
  basePath,
  branch,
  messages,
}: {
  path: string;
  preview: FilePreview;
  downloadHref: string;
  closeHref: string;
  pagePath: string;
  basePath: string;
  branch: string;
  messages: Messages;
}) {
  const m = messages.repository;
  return (
    <section className="file-preview">
      <div className="file-preview-heading">
        <strong>{basename(path)}</strong>
        <div className="file-preview-actions">
          <a
            className="file-preview-download"
            href={downloadHref}
            download
            aria-label={messages.common.download}
            title={messages.common.download}
          >
            <DownloadIcon />
          </a>
          <Link
            className="file-preview-close"
            href={closeHref}
            scroll={false}
            aria-label={messages.common.close}
            title={messages.common.close}
          >
            <span aria-hidden="true">×</span>
          </Link>
        </div>
      </div>
      {preview.kind === "image" && preview.src ? (
        <div className="file-preview-image">
          <img src={preview.src} alt={path} />
        </div>
      ) : preview.kind === "text" ? (
        isMarkdownPath(path) ? (
          <MarkdownBody
            basePath={basePath}
            branch={branch}
            content={preview.text ?? ""}
            pagePath={pagePath}
            path={path}
          />
        ) : (
          <pre className="file-preview-text">{preview.text}</pre>
        )
      ) : (
        <p className="empty-cell">{m.previewUnsupported}</p>
      )}
    </section>
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="19"
      height="19"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      className="folder-icon"
      viewBox="0 0 18 16"
      width="18"
      height="16"
      aria-hidden="true"
    >
      <path
        d="M1.5 3.25c0-.69.56-1.25 1.25-1.25h4.1l1.65 1.75h6.75c.69 0 1.25.56 1.25 1.25v.75H1.5V3.25Z"
        fill="#4d91d8"
      />
      <path
        d="M1.5 5h15v7.75c0 .69-.56 1.25-1.25 1.25H2.75c-.69 0-1.25-.56-1.25-1.25V5Z"
        fill="#397fc8"
      />
    </svg>
  );
}

function DiffView({
  files,
  selectedFile,
  textDiff,
  from,
  to,
  pagePath,
  branch,
  messages,
}: {
  files: Array<{ path: string }>;
  selectedFile: string | undefined;
  textDiff: TextDiff | null;
  from: string | null;
  to: string | null;
  pagePath: string;
  branch: string;
  messages: Messages;
}) {
  const m = messages.repository;
  const tree = buildDiffFileTree(files);
  return (
    <div className="diff-layout">
      <div className="diff-files">
        <DiffFileTree
          nodes={tree}
          selectedFile={selectedFile}
          from={from}
          to={to}
          pagePath={pagePath}
          branch={branch}
        />
      </div>
      <div className="diff-content">
        {textDiff?.to ? (
          <div className="diff-inline-heading">
            <span>{textDiff.from ? m.comparing : m.createdIn}</span>
            <code>
              {textDiff.from
                ? `${textDiff.from.slice(0, 10)} → ${textDiff.to.slice(0, 10)}`
                : textDiff.to.slice(0, 10)}
            </code>
          </div>
        ) : null}
        {textDiff?.to ? (
          <>
            <div className="diff-summary">
              <strong>{selectedFile}</strong>
              <span className="added">+{textDiff.linesAdded}</span>
              <span className="removed">−{textDiff.linesDeleted}</span>
            </div>
            {textDiff.binary ? (
              <p className="empty-cell">{m.binaryDiff}</p>
            ) : textDiff.truncated ? (
              <p className="empty-cell">{m.largeDiff}</p>
            ) : (
              <pre className="diff-text">{colorDiff(textDiff.text)}</pre>
            )}
          </>
        ) : (
          <p className="empty-cell">
            {selectedFile ? m.noFileChanges : m.selectFile}
          </p>
        )}
      </div>
    </div>
  );
}

function DiffFileTree({
  nodes,
  selectedFile,
  from,
  to,
  pagePath,
  branch,
}: {
  nodes: DiffTreeNode[];
  selectedFile: string | undefined;
  from: string | null;
  to: string | null;
  pagePath: string;
  branch: string;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.type === "directory" ? (
          <details
            className="diff-tree-directory"
            open={
              selectedFile
                ? selectedFile.startsWith(`${node.path}/`)
                : false
            }
            key={node.path}
          >
            <summary title={node.path}>
              <FolderIcon />
              <span>{node.name}</span>
            </summary>
            <div className="diff-tree-children">
              <DiffFileTree
                nodes={node.children}
                selectedFile={selectedFile}
                from={from}
                to={to}
                pagePath={pagePath}
                branch={branch}
              />
            </div>
          </details>
        ) : (
          <Link
            href={`${pagePath}?${new URLSearchParams({
              branch,
              view: "diff",
              file: node.path,
              ...(from ? { from } : {}),
              ...(to ? { to } : {}),
            })}`}
            className={`diff-tree-file ${
              selectedFile === node.path ? "active" : ""
            }`}
            scroll={false}
            title={node.path}
            key={node.path}
          >
            <span>{node.name}</span>
          </Link>
        ),
      )}
    </>
  );
}

function colorDiff(text: string): React.ReactNode {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line, index) => {
    const className = line.startsWith("+")
      ? "diff-add"
      : line.startsWith("-")
        ? "diff-del"
        : line.startsWith("@@")
          ? "diff-hunk"
          : undefined;
    return (
      <span className={className} key={`${index}:${line.slice(0, 16)}`}>
        {line}
        {"\n"}
      </span>
    );
  });
}

function changeActionLabel(action: DiffFile["action"], messages: Messages) {
  const m = messages.repository;
  switch (action) {
    case "add":
      return m.actionAdded;
    case "delete":
      return m.actionDeleted;
    case "move":
      return m.actionMoved;
    case "copy":
      return m.actionCopied;
    default:
      return m.actionModified;
  }
}

const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const imageExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
]);

async function loadFilePreview(
  basePath: string,
  branch: string,
  filePath: string,
): Promise<FilePreview> {
  const query = new URLSearchParams({ branch, path: filePath });
  if (imageExtensions.has(extensionOf(filePath))) {
    query.set("inline", "true");
    return {
      kind: "image",
      src: `${basePath}/blob?${query}`,
    };
  }

  try {
    const response = await serverApiResponse(`${basePath}/blob?${query}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (contentLength > MAX_TEXT_PREVIEW_BYTES) {
      await response.body?.cancel();
      return { kind: "unsupported" };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (
      bytes.length > MAX_TEXT_PREVIEW_BYTES ||
      bytes.includes(0)
    ) {
      return { kind: "unsupported" };
    }
    const text = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/\r\n?/g, "\n");
    const controlCharacters = [...text].filter((character) => {
      const code = character.charCodeAt(0);
      return code < 9 || (code > 13 && code < 32);
    }).length;
    if (controlCharacters > Math.max(2, text.length * 0.01)) {
      return { kind: "unsupported" };
    }
    return { kind: "text", text };
  } catch {
    return { kind: "unsupported" };
  }
}

function extensionOf(filePath: string): string {
  const name = basename(filePath).toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index) : "";
}

function summarizeCommitMessage(message: string | undefined): string {
  if (!message?.trim()) {
    return "—";
  }
  const characters = Array.from(message.trim());
  return characters.length > 20
    ? `${characters.slice(0, 20).join("")}...`
    : characters.join("");
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function basename(value: string): string {
  return value.split("/").pop() ?? value;
}

function formatBytes(value: number, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  });
  if (value < 1024) return `${formatter.format(value)} B`;
  if (value < 1024 * 1024) {
    return `${formatter.format(value / 1024)} KiB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${formatter.format(value / (1024 * 1024))} MiB`;
  }
  return `${formatter.format(value / (1024 * 1024 * 1024))} GiB`;
}

