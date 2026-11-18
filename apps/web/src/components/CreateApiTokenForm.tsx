"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";

export function CreateApiTokenForm() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const { messages } = useI18n();
  const m = messages.settings;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await clientApi<{ token: string }>(
        "/api/v1/auth/api-tokens",
        {
          method: "POST",
          body: JSON.stringify({ name: form.get("name") }),
        },
      );
      setToken(response.token);
      formElement.reset();
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    }
  }

  return (
    <form className="stack compact" onSubmit={submit}>
      <label>
        {m.tokenName}
        <input name="name" placeholder={m.tokenPlaceholder} required />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      {token ? (
        <div className="notice">
          {m.copyNow}
          <code className="token-value">{token}</code>
        </div>
      ) : null}
      <button className="button primary">{m.create}</button>
    </form>
  );
}
