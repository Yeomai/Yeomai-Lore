"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  RepositoryImportPhase,
  RepositoryImportStatus,
} from "@lore-portal/shared";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { formatMessage, localizeApiError } from "../i18n/messages";
import { BrowserTime } from "./BrowserTime";

interface ImportJob {
  id: string;
  actorUserId: string;
  actorUsername: string;
  targetRepositoryId: string | null;
  sourceKind: "url";
  sourceValue: string;
  provider: "github" | "gitea";
  includeTags: boolean;
  targetOrganizationSlug: string;
  targetSlug: string;
  sourceDefaultBranch: string | null;
  status: RepositoryImportStatus;
  phase: RepositoryImportPhase;
  totalCommits: number;
  importedCommits: number;
  totalBytes: number;
  importedBytes: number;
  errorMessage: string;
  queuePosition: number | null;
  requestedAt: string;
  createdAt: string;
  finishedAt: string | null;
}

export function RepositoryImportPanel({
  organizations,
  username,
  imports,
  canChooseOrganization,
}: {
  organizations: Array<{ id: string; slug: string; name: string }>;
  username: string;
  imports: ImportJob[];
  canChooseOrganization: boolean;
}) {
  const router = useRouter();
  const { locale, messages } = useI18n();
  const m = messages.admin;
  const form = messages.repositoryForm;
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const [httpsAuth, setHttpsAuth] = useState<"none" | "token">("none");

  useEffect(() => {
    if (!imports.some((job) => job.status === "queued" || job.status === "running")) {
      return;
    }
    const timer = window.setInterval(() => router.refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [imports, router]);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const data = new FormData(formElement);
    const credentials =
      httpsAuth === "token"
        ? {
            type: "https-token" as const,
            token: String(data.get("token") ?? ""),
          }
        : undefined;
    setPending("create");
    setError("");
    try {
      const organizationId = data.get("organizationId");
      await clientApi("/api/v1/repository-imports", {
        method: "POST",
        body: JSON.stringify({
          sourceValue: data.get("sourceValue"),
          includeTags: data.get("includeTags") === "on",
          ...(credentials ? { credentials } : {}),
          ...(organizationId ? { organizationId } : {}),
          slug: data.get("slug"),
          description: data.get("description"),
        }),
      });
      formElement.reset();
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending("");
    }
  }

  async function cancel(id: string) {
    setPending(id);
    setError("");
    try {
      await clientApi(`/api/v1/repository-imports/${id}/cancel`, {
        method: "POST",
      });
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending("");
    }
  }

  async function clean(id: string) {
    if (!window.confirm(m.confirmCleanImport)) return;
    setPending(id);
    setError("");
    try {
      await clientApi(`/api/v1/repository-imports/${id}`, {
        method: "DELETE",
      });
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending("");
    }
  }

  return (
    <>
      <section className="panel">
        <h2>{m.importsTitle}</h2>
        <p className="field-hint">{m.importDesignDifferenceHint}</p>
        <form className="stack compact" onSubmit={create}>
          <label>
            {m.importSourceValue}
            <input
              name="sourceValue"
              placeholder={m.importUrlPlaceholder}
              required
            />
          </label>
          <label>
            {m.importAuthentication}
            <select
              value={httpsAuth}
              onChange={(event) =>
                setHttpsAuth(event.currentTarget.value as typeof httpsAuth)
              }
            >
              <option value="none">{m.importPublicRepository}</option>
              <option value="token">{m.importAccessToken}</option>
            </select>
          </label>
          {httpsAuth === "token" ? (
            <>
              <label>
                {m.importGitToken}
                <input
                  name="token"
                  type="password"
                  required
                  autoComplete="new-password"
                />
              </label>
            </>
          ) : null}
          <label className="checkbox-label">
            <input name="includeTags" type="checkbox" />
            <span>{m.importTags}</span>
          </label>
          <span className="field-hint">{m.importOptionalModulesHint}</span>
          {canChooseOrganization ? (
            <label>
              {form.owner}
              <select name="organizationId" defaultValue="">
                <option value="">
                  {formatMessage(form.personalSpace, { username })}
                </option>
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              {form.owner}
              <input
                value={formatMessage(form.personalSpace, { username })}
                readOnly
              />
            </label>
          )}
          <label>
            {form.slug}
            <input
              name="slug"
              placeholder={form.slugPlaceholder}
              pattern="[a-z0-9][a-z0-9._-]{0,62}"
              title={form.slugHint}
              required
            />
            <span className="field-hint">{form.slugHint}</span>
          </label>
          <label>
            {form.description}
            <textarea name="description" rows={3} maxLength={2000} />
          </label>
          {error ? <p className="form-error">{error}</p> : null}
          <button className="button primary" disabled={pending === "create"}>
            {pending === "create" ? m.importing : m.queueImport}
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>{m.importJobs}</h2>
          <span className="count">{imports.length}</span>
        </div>
        {imports.length === 0 ? (
          <p className="muted">{m.noImportJobs}</p>
        ) : (
          <div className="import-job-list">
            {imports.map((job) => {
              const active = job.status === "queued" || job.status === "running";
              const mirroring = job.status === "running" && job.phase === "mirroring";
              const partial =
                job.status === "succeeded" &&
                job.importedCommits < job.totalCommits;
              const progress =
                mirroring && job.totalBytes > 0
                  ? Math.min(95, (job.importedBytes / job.totalBytes) * 100)
                  : job.totalCommits > 0
                  ? Math.min(100, (job.importedCommits / job.totalCommits) * 100)
                  : 0;
              return (
                <article className="import-job" key={job.id}>
                  <div className="import-job-heading">
                    <strong>
                      {job.targetOrganizationSlug}/{job.targetSlug}
                    </strong>
                    <span
                      className={`badge ${
                        partial ? "import-partial" : `import-${job.status}`
                      }`}
                    >
                      {partial
                        ? m.importStatusPartial
                        : m.importStatus[job.status]}
                    </span>
                  </div>
                  <p className="import-source" title={job.sourceValue}>
                    {job.sourceValue}
                  </p>
                  <div
                    className={`import-progress-track ${
                      mirroring && job.totalBytes === 0 ? "indeterminate" : ""
                    }`}
                  >
                    <span style={{ width: `${progress}%` }} />
                  </div>
                  <div className="import-job-meta">
                    <span>{m.importProviders[job.provider]}</span>
                    <span>{m.importPhase[job.phase]}</span>
                    {canChooseOrganization ? (
                      <span>
                        {formatMessage(m.importRequestedBy, {
                          username: job.actorUsername,
                        })}
                      </span>
                    ) : null}
                    {active ? (
                      <span>
                        {formatMessage(m.importQueuePosition, {
                          position: String(job.queuePosition ?? 1),
                        })}
                      </span>
                    ) : null}
                    {mirroring ? (
                      <span>
                        {m.importMirroringWait} ·{" "}
                        {formatMessage(m.importDownloadedBytes, {
                          size: formatBytes(job.importedBytes),
                        })}
                      </span>
                    ) : partial ? (
                      <span>
                        {formatMessage(m.importProgressPartial, {
                          done: String(job.importedCommits),
                          total: String(job.totalCommits),
                          missing: String(
                            job.totalCommits - job.importedCommits,
                          ),
                        })}
                      </span>
                    ) : (
                      <span>
                        {formatMessage(m.importProgress, {
                          done: String(job.importedCommits),
                          total: String(job.totalCommits),
                        })}
                      </span>
                    )}
                    <BrowserTime value={job.createdAt} locale={locale} />
                  </div>
                  {job.errorMessage ? (
                    <p className="form-error">
                      {job.errorMessage === "Import cancelled"
                        ? m.importStopped
                        : job.errorMessage}
                    </p>
                  ) : null}
                  <div className="button-row">
                    <a
                      className="button small"
                      href={`/api/v1/repository-imports/${job.id}/report`}
                    >
                      {m.importReport}
                    </a>
                    {active ? (
                      <button
                        className="button small danger"
                        type="button"
                        disabled={pending === job.id}
                        onClick={() => void cancel(job.id)}
                      >
                        {pending === job.id
                          ? m.stoppingImport
                          : m.stopImport}
                      </button>
                    ) : null}
                    {job.targetRepositoryId && job.status === "succeeded" ? (
                      <a
                        className="button small primary"
                        href={`/r/${job.targetOrganizationSlug}/${job.targetSlug}`}
                      >
                        {m.openRepository}
                      </a>
                    ) : null}
                    {!active ? (
                      <button
                        className="button small"
                        type="button"
                        disabled={pending === job.id}
                        onClick={() => void clean(job.id)}
                      >
                        {pending === job.id ? m.cleaningImport : m.cleanImport}
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}
