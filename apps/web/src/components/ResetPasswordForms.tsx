"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";

export function RequestResetForm() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const { messages } = useI18n();
  const m = messages.resetPassword;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      await clientApi<{ ok: boolean; message: string }>(
        "/api/v1/auth/password-reset/request",
        {
          method: "POST",
          body: JSON.stringify({ email: form.get("email") }),
        },
      );
      setMessage(m.requestSent);
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label>
        {m.email}
        <input name="email" type="email" required />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      {message ? <p className="notice">{message}</p> : null}
      <button className="button primary">{m.send}</button>
    </form>
  );
}

export function CompleteResetForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const { messages } = useI18n();
  const m = messages.resetPassword;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await clientApi("/api/v1/auth/password-reset/complete", {
        method: "POST",
        body: JSON.stringify({
          token,
          password: form.get("password"),
        }),
      });
      router.push("/login");
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label>
        {m.newPassword}
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={6}
          required
        />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button className="button primary">{m.submit}</button>
    </form>
  );
}
