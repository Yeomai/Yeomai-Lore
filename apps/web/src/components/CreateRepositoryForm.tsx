"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { formatMessage, localizeApiError } from "../i18n/messages";

export function CreateRepositoryForm({
  username,
  organizations,
}: {
  username: string;
  organizations: Array<{ id: string; slug: string; name: string }>;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [organizationId, setOrganizationId] = useState("");
  const { messages } = useI18n();
  const m = messages.repositoryForm;
  const selectedOrganization = organizations.find(
    (organization) => organization.id === organizationId,
  );
  const repositoryNamespace = selectedOrganization?.slug ?? username;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const organizationId = form.get("organizationId");
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
      router.push(
        `/r/${repository.organizationSlug}/${repository.slug}`,
      );
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="stack compact" onSubmit={submit}>
      <label>
        {m.slug}
        <input
          name="slug"
          placeholder={m.slugPlaceholder}
          pattern="[a-z0-9][a-z0-9._-]{0,62}"
          title={m.slugHint}
          required
        />
        <span className="field-hint">{m.slugHint}</span>
      </label>
      <label>
        {m.organization}
        <select
          name="organizationId"
          value={organizationId}
          onChange={(event) => setOrganizationId(event.target.value)}
        >
          <option value="">{m.personal}</option>
          {organizations.map((organization) => (
            <option key={organization.id} value={organization.id}>
              {organization.name} ({organization.slug})
            </option>
          ))}
        </select>
        <span className="field-hint">
          {formatMessage(m.destinationHint, {
            namespace: repositoryNamespace,
          })}
        </span>
      </label>
      <label>
        {m.description}
        <textarea
          name="description"
          placeholder={m.descriptionPlaceholder}
          maxLength={2000}
          rows={3}
        />
      </label>
      <label>
        {m.ignoreTemplate}
        <select name="ignoreTemplate" defaultValue="none">
          <option value="none">{m.ignoreTemplateNone}</option>
          <option value="unreal">{m.ignoreTemplateUnreal}</option>
          <option value="unity">{m.ignoreTemplateUnity}</option>
          <option value="nextjs">{m.ignoreTemplateNextjs}</option>
        </select>
        <span className="field-hint">{m.ignoreTemplateHint}</span>
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button className="button primary" disabled={pending}>
        {pending ? m.creating : m.create}
      </button>
    </form>
  );
}
