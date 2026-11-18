"use client";

import { useState } from "react";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";

export function LoginForm({ nextPath = "/dashboard" }: { nextPath?: string }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const { messages } = useI18n();
  const m = messages.login;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await clientApi("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({
          identifier: form.get("identifier"),
          password: form.get("password"),
        }),
      });
      window.location.replace(nextPath);
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="stack"
      method="post"
      action="/login/submit"
      onSubmit={submit}
    >
      <input name="next" type="hidden" value={nextPath} />
      <label>
        {m.identifier}
        <input name="identifier" autoComplete="username" required />
      </label>
      <label>
        {m.password}
        <span className="password-input-wrap">
          <input
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
          />
          <button
            className="password-visibility"
            type="button"
            onClick={() => setShowPassword((visible) => !visible)}
            aria-label={showPassword ? m.hidePassword : m.showPassword}
            title={showPassword ? m.hidePassword : m.showPassword}
          >
            {showPassword ? (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m3 3 18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.2A10.7 10.7 0 0 1 12 4c5.4 0 9 5 9 8a6.6 6.6 0 0 1-1.3 3.7M6.6 6.7C4.4 8.2 3 10.5 3 12c0 3 3.6 8 9 8 1.4 0 2.7-.4 3.8-.9" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 12c0-3 3.6-8 9-8s9 5 9 8-3.6 8-9 8-9-5-9-8Z" />
                <circle cx="12" cy="12" r="2.7" />
              </svg>
            )}
          </button>
        </span>
      </label>
      {error ? (
        <p className="form-error" role="alert" aria-live="assertive">
          {error}
        </p>
      ) : null}
      <button className="button primary" disabled={pending}>
        {pending ? m.pending : messages.common.signIn}
      </button>
    </form>
  );
}
