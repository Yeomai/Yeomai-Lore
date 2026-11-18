"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { RepositoryRecord } from "@lore-portal/shared";
import type { Messages } from "../i18n/messages";
import { repositoryLabel } from "../lib/repository-label";
import { BrowserTime } from "./BrowserTime";
import { CreateRepositoryCard } from "./CreateRepositoryCard";

export interface DashboardRepository extends RepositoryRecord {
  sizeBytes: number | null;
  lastCommitAt: number | null;
}

export interface DashboardOrganization {
  id: string;
  slug: string;
  name: string;
}

type ViewMode = "cards" | "list";
const VIEW_STORAGE_KEY = "lore.dashboard.repositoryView";

export function DashboardRepositories({
  repositories,
  organizations,
  userId,
  username,
  locale,
  messages,
}: {
  repositories: DashboardRepository[];
  organizations: DashboardOrganization[];
  userId: string;
  username: string;
  locale: string;
  messages: Messages;
}) {
  const [view, setView] = useState<ViewMode>("cards");
  const m = messages.dashboard;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (saved === "cards" || saved === "list") {
        setView(saved);
      }
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }, []);

  function changeView(next: ViewMode) {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Keep the in-page toggle working when storage is unavailable.
    }
  }

  return (
    <section>
      <div className="section-heading repository-section-heading">
        <h2>{m.yourRepositories}</h2>
        <div
          className="repository-view-toggle"
          role="group"
          aria-label={m.repositoryView}
        >
          <button
            className={view === "cards" ? "active" : ""}
            type="button"
            aria-label={m.cardView}
            aria-pressed={view === "cards"}
            title={m.cardView}
            onClick={() => changeView("cards")}
          >
            <CardViewIcon />
          </button>
          <button
            className={view === "list" ? "active" : ""}
            type="button"
            aria-label={m.listView}
            aria-pressed={view === "list"}
            title={m.listView}
            onClick={() => changeView("list")}
          >
            <ListViewIcon />
          </button>
        </div>
      </div>

      {view === "cards" ? (
        <div className="repo-grid">
          <CreateRepositoryCard
            username={username}
            organizations={organizations}
          />
          {repositories.map((repository) => (
            <RepositoryCard
              key={repository.id}
              repository={repository}
              userId={userId}
              locale={locale}
              messages={messages}
            />
          ))}
        </div>
      ) : (
        <div className="repository-list">
          <CreateRepositoryCard
            username={username}
            organizations={organizations}
            view="list"
          />
          {repositories.map((repository) => (
            <RepositoryListRow
              key={repository.id}
              repository={repository}
              userId={userId}
              locale={locale}
              messages={messages}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RepositoryCard({
  repository,
  userId,
  locale,
  messages,
}: {
  repository: DashboardRepository;
  userId: string;
  locale: string;
  messages: Messages;
}) {
  return (
    <Link
      className="repo-card"
      href={`/r/${repository.organizationSlug}/${repository.slug}`}
    >
      <RepositoryTitle repository={repository} userId={userId} />
      <p aria-hidden={!repository.description}>
        {repository.description || "\u00A0"}
      </p>
      <RepositoryCardSummary
        repository={repository}
        locale={locale}
        messages={messages}
      />
      <div className="repo-meta">
        <span>{repository.defaultBranchName}</span>
        <span>{messages.status[repository.status]}</span>
      </div>
    </Link>
  );
}

function RepositoryListRow({
  repository,
  userId,
  locale,
  messages,
}: {
  repository: DashboardRepository;
  userId: string;
  locale: string;
  messages: Messages;
}) {
  return (
    <Link
      className="repository-list-row"
      href={`/r/${repository.organizationSlug}/${repository.slug}`}
    >
      <div className="repository-list-main">
        <RepositoryTitle repository={repository} userId={userId} />
        <p>{repository.description || "\u00A0"}</p>
      </div>
      <div className="repository-list-meta">
        <span>{formatBytes(repository.sizeBytes, locale)}</span>
        <span>
          {repository.lastCommitAt === null
            ? "—"
            : (
                <>
                  <BrowserTime
                    value={repository.lastCommitAt}
                    locale={locale}
                    kind="date"
                  />{" "}
                  {messages.dashboard.updated}
                </>
              )}
        </span>
        <span>{repository.defaultBranchName}</span>
        <span>{messages.status[repository.status]}</span>
      </div>
    </Link>
  );
}

function RepositoryTitle({
  repository,
  userId,
}: {
  repository: DashboardRepository;
  userId: string;
}) {
  return (
    <div className="repo-card-title-row">
      <h3>{repositoryLabel(repository, userId)}</h3>
      <span
        className={`status-dot ${repository.status}`}
        title={repository.status}
      />
    </div>
  );
}

function RepositoryCardSummary({
  repository,
  locale,
  messages,
}: {
  repository: DashboardRepository;
  locale: string;
  messages: Messages;
}) {
  return (
    <div className="repo-card-summary">
      <span>{formatBytes(repository.sizeBytes, locale)}</span>
      <span>
        {repository.lastCommitAt === null
          ? "—"
          : (
              <>
                <BrowserTime
                  value={repository.lastCommitAt}
                  locale={locale}
                  kind="date"
                />{" "}
                {messages.dashboard.updated}
              </>
            )}
      </span>
    </div>
  );
}

function CardViewIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="11" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="11" width="5" height="5" rx="1" />
      <rect x="11" y="11" width="5" height="5" rx="1" />
    </svg>
  );
}

function ListViewIcon() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="3" cy="4" r="1" />
      <circle cx="3" cy="9" r="1" />
      <circle cx="3" cy="14" r="1" />
      <path d="M6.5 4h9M6.5 9h9M6.5 14h9" />
    </svg>
  );
}

function formatBytes(value: number | null, locale: string): string {
  if (value === null) return "—";
  const formatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
  });
  if (value < 1024) return `${formatter.format(value)} B`;
  if (value < 1024 * 1024) return `${formatter.format(value / 1024)} KB`;
  if (value < 1024 * 1024 * 1024) {
    return `${formatter.format(value / (1024 * 1024))} MB`;
  }
  return `${formatter.format(value / (1024 * 1024 * 1024))} GB`;
}
