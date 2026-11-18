"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";

export function OrganizationMemberForm({
  organizationId,
}: {
  organizationId: string;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const { messages } = useI18n();
  const m = messages.admin;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await clientApi(`/api/v1/orgs/${organizationId}/members`, {
        method: "POST",
        body: JSON.stringify({
          email: form.get("email"),
          role: form.get("role"),
        }),
      });
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="row-form admin-member-form" onSubmit={submit}>
      <input
        name="email"
        type="email"
        placeholder={m.memberEmail}
        autoComplete="email"
        required
      />
      <select name="role" defaultValue="member">
        <option value="member">{messages.common.member}</option>
        <option value="admin">{messages.common.admin}</option>
        <option value="owner">{messages.common.owner}</option>
      </select>
      <button className="button" disabled={pending}>
        {pending ? m.addingMember : m.addMember}
      </button>
      {error ? <span className="form-error">{error}</span> : null}
    </form>
  );
}
