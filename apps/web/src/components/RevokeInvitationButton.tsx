"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";

export function RevokeInvitationButton({
  inviteId,
}: {
  inviteId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { messages } = useI18n();
  const m = messages.admin;

  async function revoke() {
    setPending(true);
    setError("");
    try {
      await clientApi(`/api/v1/admin/invites/${inviteId}`, {
        method: "DELETE",
      });
      router.refresh();
    } catch {
      setError(m.revokeFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        className="button danger small"
        type="button"
        disabled={pending}
        onClick={revoke}
      >
        {pending ? m.revoking : m.revoke}
      </button>
      {error ? <span className="form-error">{error}</span> : null}
    </>
  );
}
