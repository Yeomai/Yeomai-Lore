"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { formatMessage, localizeApiError } from "../i18n/messages";

interface OrganizationOption {
  id: string;
  slug: string;
  name: string;
}

export function CreateRepositoryCard({
  username,
  organizations,
  view = "cards",
}: {
  username: string;
  organizations: OrganizationOption[];
  view?: "cards" | "list";
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const { messages } = useI18n();
  const dashboard = messages.dashboard;
  const formMessages = messages.repositoryForm;
  const selectedOrganization = organizations.find(
    (organization) => organization.id === organizationId,
  );
  const repositoryNamespace = selectedOrganization?.slug ?? username;

  function openDialog() {
    setError("");
    dialogRef.current?.showModal();
  }

  function closeDialog() {
    if (!pending) {
      dialogRef.current?.close();
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const repository = await clientApi<{
        organizationSlug: string;
        slug: string;
      }>("/api/v1/repos", {
        method: "POST",
        body: JSON.stringify({
          ...(organizationId ? { organizationId } : {}),
          slug: form.get("slug"),
          description: form.get("description"),
          ignoreTemplate: form.get("ignoreTemplate"),
        }),
      });
      dialogRef.current?.close();
      router.push(`/r/${repository.organizationSlug}/${repository.slug}`);
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        className={`repo-card create-repo-card ${
          view === "list" ? "repo-list-create" : ""
        }`}
        type="button"
        onClick={openDialog}
      >
        <div className="repo-card-head">
          <span className="create-repo-plus" aria-hidden="true">
            +
          </span>
        </div>
        <h3>{dashboard.newRepositoryEyebrow}</h3>
      </button>

      <dialog
        ref={dialogRef}
        className="repo-dialog"
        aria-labelledby="create-repository-title"
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}
      >
        <form className="repo-dialog-content" onSubmit={submit}>
          <div className="repo-dialog-heading">
            <div>
              <h2 id="create-repository-title">{formMessages.create}</h2>
              <p className="muted">
                {formatMessage(formMessages.destinationHint, {
                  namespace: repositoryNamespace,
                })}
              </p>
            </div>
            <button
              className="dialog-close"
              type="button"
              onClick={closeDialog}
              aria-label={messages.common.close}
            >
              ×
            </button>
          </div>

          <label>
            {formMessages.slug}
            <input
              name="slug"
              placeholder={formMessages.slugPlaceholder}
              pattern="[a-z0-9][a-z0-9._-]{0,62}"
              title={formMessages.slugHint}
              maxLength={63}
              autoComplete="off"
              spellCheck={false}
              required
            />
            <span className="field-hint">{formMessages.slugHint}</span>
          </label>

          <label>
            {formMessages.organization}
            <select
              name="organizationId"
              value={organizationId}
              onChange={(event) => setOrganizationId(event.target.value)}
            >
              <option value="">{formMessages.personal}</option>
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name} ({organization.slug})
                </option>
              ))}
            </select>
          </label>

          <label>
            {formMessages.description}
            <textarea
              name="description"
              placeholder={formMessages.descriptionPlaceholder}
              maxLength={2000}
              rows={4}
            />
          </label>

          <label>
            {formMessages.ignoreTemplate}
            <select name="ignoreTemplate" defaultValue="none">
              <option value="none">{formMessages.ignoreTemplateNone}</option>
              <option value="unreal">{formMessages.ignoreTemplateUnreal}</option>
              <option value="unity">{formMessages.ignoreTemplateUnity}</option>
              <option value="nextjs">{formMessages.ignoreTemplateNextjs}</option>
            </select>
            <span className="field-hint">
              {formMessages.ignoreTemplateHint}
            </span>
          </label>

          {error ? <p className="form-error">{error}</p> : null}

          <div className="button-row dialog-actions">
            <button
              className="button"
              type="button"
              onClick={closeDialog}
              disabled={pending}
            >
              {messages.common.cancel}
            </button>
            <button className="button primary" disabled={pending}>
              {pending ? formMessages.creating : formMessages.create}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
