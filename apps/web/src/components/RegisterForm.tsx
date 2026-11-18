"use client";

import { useState } from "react";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";

export function RegisterForm() {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const { messages } = useI18n();
  const m = messages.register;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await clientApi("/api/v1/auth/register", {
        method: "POST",
        body: JSON.stringify({
          username: form.get("username"),
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      window.location.replace("/dashboard");
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label>
        {m.username}
        <input
          name="username"
          autoComplete="username"
          pattern="[a-z0-9][a-z0-9_-]{2,31}"
          minLength={3}
          maxLength={32}
          required
        />
      </label>
      <label>
        {m.email}
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        {m.password}
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={6}
          maxLength={256}
          required
        />
        <small>{m.passwordHint}</small>
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button className="button primary" disabled={pending}>
        {pending ? m.creating : m.submit}
      </button>
    </form>
  );
}
