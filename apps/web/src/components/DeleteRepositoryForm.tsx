"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { formatMessage, localizeApiError } from "../i18n/messages";

export function DeleteRepositoryForm({
  basePath,
  repositoryName,
  redirectTo = "/dashboard",
}: {
  basePath: string;
  repositoryName: string;
  redirectTo?: string;
}) {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const { messages } = useI18n();
  const m = messages.repository;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await clientApi(basePath, {
        method: "DELETE",
        body: JSON.stringify({ confirmation }),
      });
      router.push(redirectTo);
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
        {formatMessage(m.deleteConfirmation, { name: repositoryName })}
        <input
          name="confirmation"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          placeholder={repositoryName}
          autoComplete="off"
          required
        />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button
        className="button danger"
        disabled={pending || confirmation !== repositoryName}
      >
        {pending ? m.deleting : m.deleteButton}
      </button>
    </form>
  );
}
