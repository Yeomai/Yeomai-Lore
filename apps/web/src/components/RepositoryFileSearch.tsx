"use client";

import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { searchFilePaths } from "../lib/file-search";
import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";

interface FileIndexResponse {
  revision: string | null;
  entries: string[];
  truncated: boolean;
}

export function RepositoryFileSearch({
  basePath,
  pagePath,
  branch,
}: {
  basePath: string;
  pagePath: string;
  branch: string;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState<FileIndexResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const { messages } = useI18n();
  const m = messages.repository;
  const deferredQuery = useDeferredValue(query);
  const results = searchFilePaths(index?.entries ?? [], deferredQuery);

  function openSearch() {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    setOpen(true);
    setQuery("");
    setActiveIndex(0);
    setError("");
    const requestId = ++requestIdRef.current;
    setLoading(true);
    clientApi<FileIndexResponse>(
      `${basePath}/file-index?${new URLSearchParams({ branch })}`,
    )
      .then((response) => {
        if (requestId === requestIdRef.current) setIndex(response);
      })
      .catch((cause: unknown) => {
        if (requestId === requestIdRef.current) {
          setError(localizeApiError(cause, messages));
        }
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }

  function closeSearch() {
    dialogRef.current?.close();
  }

  function openResult(path: string) {
    const slash = path.lastIndexOf("/");
    const directory = slash < 0 ? "" : path.slice(0, slash);
    const href = `${pagePath}?${new URLSearchParams({
      branch,
      view: "tree",
      path: directory,
      file: path,
    })}`;
    closeSearch();
    router.push(href);
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.key.toLocaleLowerCase() !== "t"
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, button, [contenteditable='true']",
        )
      ) {
        return;
      }
      event.preventDefault();
      openSearch();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    if (!open) return;
    document.body.classList.add("modal-open");
    inputRef.current?.focus();
    return () => document.body.classList.remove("modal-open");
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [deferredQuery]);

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) =>
        results.length === 0 ? 0 : (index + 1) % results.length,
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) =>
        results.length === 0
          ? 0
          : (index - 1 + results.length) % results.length,
      );
    } else if (event.key === "Enter" && results[activeIndex]) {
      event.preventDefault();
      openResult(results[activeIndex]!.path);
    }
  }

  return (
    <>
      <button
        className="file-search-trigger"
        type="button"
        onClick={openSearch}
        aria-haspopup="dialog"
      >
        <SearchIcon />
        <span>{m.goToFile}</span>
        <kbd>T</kbd>
      </button>
      <dialog
        ref={dialogRef}
        className="file-search-dialog"
        aria-labelledby="file-search-title"
        onClick={(event) => {
          if (event.target === event.currentTarget) closeSearch();
        }}
        onClose={() => {
          setOpen(false);
          document.body.classList.remove("modal-open");
        }}
      >
        <div className="file-search-content">
          <label className="file-search-input">
            <SearchIcon />
            <span className="sr-only" id="file-search-title">
              {m.goToFile}
            </span>
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={onInputKeyDown}
              placeholder={m.fileSearchPlaceholder}
              autoComplete="off"
            />
            <button
              className="file-search-close"
              type="button"
              onClick={closeSearch}
              aria-label={messages.common.close}
            >
              ×
            </button>
          </label>
          <div className="file-search-results" role="listbox">
            {loading ? (
              <p className="muted">{m.loadingFileIndex}</p>
            ) : error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : deferredQuery.trim() && results.length === 0 ? (
              <p className="muted">{m.noMatchingFiles}</p>
            ) : index?.truncated ? (
              <p className="file-search-warning">{m.fileIndexTruncated}</p>
            ) : null}
            {!loading && !error
              ? results.map((result, index) => (
                  <button
                    className={`file-search-result ${
                      index === activeIndex ? "active" : ""
                    }`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    key={result.path}
                    onClick={() => openResult(result.path)}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <FileIcon />
                    <HighlightedPath
                      path={result.path}
                      indices={result.indices}
                    />
                  </button>
                ))
              : null}
          </div>
        </div>
      </dialog>
    </>
  );
}

function HighlightedPath({
  path,
  indices,
}: {
  path: string;
  indices: number[];
}) {
  const marked = new Set(indices);
  return (
    <span className="file-search-path">
      {path.split("").map((character, index) =>
        marked.has(index) ? (
          <mark key={index}>{character}</mark>
        ) : (
          <span key={index}>{character}</span>
        ),
      )}
    </span>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6Z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}
