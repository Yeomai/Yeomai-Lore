"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";

export function InviteForm({
  organizations,
  showOrganization,
}: {
  organizations: Array<{ id: string; name: string }>;
  showOrganization: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    inviteUrl: string;
    emailSent: boolean;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [organizationId, setOrganizationId] = useState("");
  const { messages } = useI18n();
  const m = messages.inviteForm;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setPending(true);
    setError("");
    setResult(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await clientApi<{
        inviteUrl: string;
        emailSent: boolean;
      }>(
        "/api/v1/admin/invites",
        {
          method: "POST",
          body: JSON.stringify({
            email: form.get("email"),
            organizationId: organizationId || null,
            organizationRole: organizationId
              ? form.get("organizationRole")
              : "member",
          }),
        },
      );
      setResult(response);
      setOrganizationId("");
      formElement.reset();
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
        {m.email}
        <input name="email" type="email" required />
      </label>
      {showOrganization ? (
        <>
          <label>
            {m.organization}
            <select
              name="organizationId"
              value={organizationId}
              onChange={(event) =>
                setOrganizationId(event.currentTarget.value)
              }
            >
              <option value="">{m.noOrganization}</option>
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.name}
                </option>
              ))}
            </select>
          </label>
          {organizationId ? (
            <label>
              {m.organizationRole}
              <select name="organizationRole" defaultValue="member">
                <option value="member">{m.member}</option>
                <option value="admin">{m.admin}</option>
                <option value="owner">{m.owner}</option>
              </select>
            </label>
          ) : null}
        </>
      ) : null}
      {error ? <p className="form-error">{error}</p> : null}
      {result ? (
        <div className="notice" role="status">
          <p>{result.emailSent ? m.emailSubmitted : m.emailNotSent}</p>
          {m.inviteLink} <code>{result.inviteUrl}</code>
        </div>
      ) : null}
      <button className="button primary" disabled={pending}>
        {pending ? m.creating : m.submit}
      </button>
    </form>
  );
}
