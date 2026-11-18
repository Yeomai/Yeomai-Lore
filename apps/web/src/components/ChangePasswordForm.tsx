"use client";

import { useState } from "react";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";

function PasswordField(input: {
  label: string;
  name: string;
  autoComplete: string;
  minLength?: number;
  maxLength?: number;
  showLabel: string;
  hideLabel: string;
}) {
  const [visible, setVisible] = useState(false);

  return (
    <label>
      {input.label}
      <span className="password-input-wrap">
        <input
          name={input.name}
          type={visible ? "text" : "password"}
          autoComplete={input.autoComplete}
          minLength={input.minLength}
          maxLength={input.maxLength}
          required
        />
        <button
          className="password-visibility"
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? input.hideLabel : input.showLabel}
          aria-pressed={visible}
          title={visible ? input.hideLabel : input.showLabel}
        >
          {visible ? (
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
  );
}

export function ChangePasswordForm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const { messages } = useI18n();
  const m = messages.admin;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setSuccess("");
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmNewPassword = String(form.get("confirmNewPassword") ?? "");
    if (newPassword !== confirmNewPassword) {
      setError(m.newPasswordsDoNotMatch);
      setPending(false);
      return;
    }
    try {
      await clientApi("/api/v1/auth/password", {
        method: "PUT",
        body: JSON.stringify({
          oldPassword: form.get("oldPassword"),
          newPassword,
          confirmNewPassword,
        }),
      });
      formElement.reset();
      setSuccess(m.passwordUpdated);
      window.location.replace("/login?passwordChanged=1");
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="panel profile-card password-card">
      <h2>{m.changePassword}</h2>
      <p className="muted">{m.changePasswordDescription}</p>
      <form className="stack compact" onSubmit={submit}>
        <PasswordField
          label={m.oldPassword}
          name="oldPassword"
          autoComplete="current-password"
          showLabel={m.showPassword}
          hideLabel={m.hidePassword}
        />
        <PasswordField
          label={m.newPassword}
          name="newPassword"
          autoComplete="new-password"
          minLength={6}
          maxLength={256}
          showLabel={m.showPassword}
          hideLabel={m.hidePassword}
        />
        <PasswordField
          label={m.confirmNewPassword}
          name="confirmNewPassword"
          autoComplete="new-password"
          minLength={6}
          maxLength={256}
          showLabel={m.showPassword}
          hideLabel={m.hidePassword}
        />
        {error ? (
          <p className="form-error" role="alert" aria-live="assertive">
            {error}
          </p>
        ) : null}
        {success ? <p className="notice">{success}</p> : null}
        <button className="button primary" disabled={pending}>
          {pending ? m.updatingPassword : m.updatePassword}
        </button>
      </form>
    </section>
  );
}
