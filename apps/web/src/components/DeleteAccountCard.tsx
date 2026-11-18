"use client";

import { useState } from "react";
import { useI18n } from "../i18n/client";
import { clientApi } from "../lib/client-api";
import { localizeApiError } from "../i18n/messages";

export function DeleteAccountCard() {
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { messages } = useI18n();
  const m = messages.admin;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmation !== "DELETE") return;
    setPending(true);
    setError("");
    try {
      await clientApi("/api/v1/auth/account", {
        method: "DELETE",
        body: JSON.stringify({ confirmation }),
      });
      window.location.replace("/login?accountDeleted=1");
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="panel account-deletion-card">
      <p className="eyebrow">{m.accountDangerZone}</p>
      <h2>{m.deleteAccount}</h2>
      <p className="muted">{m.deleteAccountDescription}</p>
      <form className="stack compact" onSubmit={submit}>
        <label>
          {m.deleteAccountConfirmation}
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder="DELETE"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="button danger"
          disabled={pending || confirmation !== "DELETE"}
        >
          {pending ? m.deletingAccount : m.confirmDeleteAccount}
        </button>
      </form>
    </section>
  );
}
