"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatMessage } from "../i18n/messages";
import { useI18n } from "../i18n/client";
import { buildDiffFileTree } from "../lib/diff-tree";

type ViewMode = "list" | "tree";

export interface CommitChangedFile {
  path: string;
  action: "keep" | "add" | "delete" | "move" | "copy";
}

const FILE_VIEW_STORAGE_KEY = "lore.commitDetail.fileView";
const ACTION_LABELS: Record<CommitChangedFile["action"], string> = {
  keep: "Modify",
  add: "Add",
  delete: "Delete",
  move: "Move",
  copy: "Copy",
};

export function CommitChangedFiles({
  revisionNumber,
  revisionMessage,
  files,
  comparisonAvailable,
  selectedFile,
  pagePath,
  branch,
  revision,
  commitTab,
}: {
  revisionNumber: number;
  revisionMessage: string;
  files: CommitChangedFile[];
  comparisonAvailable: boolean;
  selectedFile: string | undefined;
  pagePath: string;
  branch: string;
  revision: string;
  commitTab: "graph" | "list";
}) {
  const { messages } = useI18n();
  const m = messages.repository;
  const [view, setView] = useState<ViewMode>("list");
  const tree = buildDiffFileTree(files);
  const filesByPath = new Map(files.map((file) => [file.path, file]));

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(FILE_VIEW_STORAGE_KEY);
      if (saved === "list" || saved === "tree") setView(saved);
    } catch {
      // Keep the in-page switch available when storage is restricted.
    }
  }, []);

  function changeView(next: ViewMode) {
    setView(next);
    try {
      window.localStorage.setItem(FILE_VIEW_STORAGE_KEY, next);
    } catch {
      // Keep the in-page switch available when storage is restricted.
    }
  }

  function fileHref(path: string) {
    return `${pagePath}?${new URLSearchParams({
      branch,
      view: "commit",
      commits: commitTab,
      revision,
      file: path,
    })}`;
  }

  return (
    <>
      <div className="commit-overview">
        <div>
          <p className="eyebrow">
            {formatMessage(m.commitNumber, { number: revisionNumber })}
          </p>
          <h2>{revisionMessage || m.noMessage}</h2>
        </div>
        <div
          className="repository-view-toggle commit-file-view-toggle"
          role="group"
          aria-label={m.fileListView}
        >
          <button
            className={view === "list" ? "active" : ""}
            type="button"
            aria-label={m.fileListView}
            aria-pressed={view === "list"}
            title={m.fileListView}
            onClick={() => changeView("list")}
          >
            <span className="commit-file-view-icon commit-file-view-icon-list" />
          </button>
          <button
            className={view === "tree" ? "active" : ""}
            type="button"
            aria-label={m.fileTreeView}
            aria-pressed={view === "tree"}
            title={m.fileTreeView}
            onClick={() => changeView("tree")}
          >
            <span className="commit-file-view-icon commit-file-view-icon-tree" />
          </button>
        </div>
      </div>
      <div className="commit-changes">
        <div className="section-heading tight">
          <h3>{m.changedFiles}</h3>
          <span className="count">{files.length}</span>
        </div>
        {!comparisonAvailable ? (
          <p className="muted">{m.firstRevision}</p>
        ) : files.length === 0 ? (
          <p className="muted">{m.noChangedFiles}</p>
        ) : view === "list" ? (
          <div className="commit-file-list">
            {files.map((file) => (
              <ChangedFileLink
                file={file}
                selectedFile={selectedFile}
                href={fileHref(file.path)}
                key={`${file.action}:${file.path}`}
              />
            ))}
          </div>
        ) : (
          <div className="commit-file-tree">
            <ChangedFileTree
              nodes={tree}
              filesByPath={filesByPath}
              selectedFile={selectedFile}
              fileHref={fileHref}
            />
          </div>
        )}
      </div>
    </>
  );
}

function ChangedFileTree({
  nodes,
  filesByPath,
  selectedFile,
  fileHref,
}: {
  nodes: ReturnType<typeof buildDiffFileTree>;
  filesByPath: Map<string, CommitChangedFile>;
  selectedFile: string | undefined;
  fileHref: (path: string) => string;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.type === "directory" ? (
          <details
            className="commit-file-tree-directory"
            open
            key={node.path}
          >
            <summary title={node.path}>
              <span className="commit-file-tree-folder-icon" />
              <span>{node.name}</span>
            </summary>
            <div className="commit-file-tree-children">
              <ChangedFileTree
                nodes={node.children}
                filesByPath={filesByPath}
                selectedFile={selectedFile}
                fileHref={fileHref}
              />
            </div>
          </details>
        ) : (
          <ChangedFileLink
            file={filesByPath.get(node.path) ?? { path: node.path, action: "keep" }}
            selectedFile={selectedFile}
            href={fileHref(node.path)}
            displayPath={node.name}
            key={node.path}
          />
        ),
      )}
    </>
  );
}

function ChangedFileLink({
  file,
  selectedFile,
  href,
  displayPath,
}: {
  file: CommitChangedFile;
  selectedFile: string | undefined;
  href: string;
  displayPath?: string;
}) {
  return (
    <Link
      className={selectedFile === file.path ? "active" : ""}
      href={href}
      scroll={false}
      title={file.path}
    >
      <span>{displayPath ?? file.path}</span>
      <span className={`change-kind ${file.action}`}>
        {ACTION_LABELS[file.action]}
      </span>
    </Link>
  );
}

