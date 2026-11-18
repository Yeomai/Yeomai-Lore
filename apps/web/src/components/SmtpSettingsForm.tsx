"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";

export interface SmtpSettingsView {
  enabled: boolean;
  host: string;
  port: number;
  security: "starttls" | "ssl" | "none";
  username: string;
  password: string;
  fromName: string;
  fromEmail: string;
}

export function SmtpSettingsForm({
  settings,
  hasPassword: initialHasPassword,
}: {
  settings: SmtpSettingsView;
  hasPassword: boolean;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [enabled, setEnabled] = useState(settings.enabled);
  const [hasPassword, setHasPassword] = useState(initialHasPassword);
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [testError, setTestError] = useState("");
  const { messages } = useI18n();
  const m = messages.admin;
  const setupMessages = messages.setup;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!formRef.current) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const response = await clientApi<{ hasPassword: boolean }>(
        "/api/v1/admin/smtp",
        {
          method: "PUT",
          body: JSON.stringify(payload(new FormData(formRef.current))),
        },
      );
      setHasPassword(response.hasPassword);
      if (passwordRef.current) passwordRef.current.value = "";
      setSaved(true);
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    if (!formRef.current || !enabled) return;
    setTesting(true);
    setTestResult("");
    setTestError("");
    const form = new FormData(formRef.current);
    const recipientEmail = String(form.get("smtpTestRecipient") ?? "").trim();
    const body = payload(form);
    if (!recipientEmail) {
      setTestError(setupMessages.smtpRecipientRequired);
      setTesting(false);
      return;
    }
    if (body.username && !body.password && !hasPassword) {
      setTestError(m.smtpPasswordRequired);
      setTesting(false);
      return;
    }
    try {
      await clientApi("/api/v1/admin/smtp/test", {
        method: "POST",
        body: JSON.stringify({ ...body, recipientEmail }),
      });
      setTestResult(setupMessages.smtpTestSuccess);
    } catch (cause) {
      setTestError(localizeApiError(cause, messages));
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="panel">
      <form className="stack" ref={formRef} onSubmit={save}>
        <label className="checkbox-label">
          <input
            name="smtpEnabled"
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.currentTarget.checked)}
          />
          <span>
            <strong>{setupMessages.smtpEnable}</strong>
            <span className="field-hint">{setupMessages.smtpHint}</span>
          </span>
        </label>

        {enabled ? (
          <div className="smtp-fields">
            <div className="setup-form-grid">
              <label>
                {setupMessages.smtpHost}
                <input
                  name="smtpHost"
                  defaultValue={settings.host}
                  placeholder="smtp.example.com"
                  required
                />
              </label>
              <label>
                {setupMessages.smtpPort}
                <input
                  name="smtpPort"
                  type="number"
                  min={1}
                  max={65535}
                  defaultValue={settings.port}
                  required
                />
              </label>
            </div>
            <label>
              {setupMessages.smtpSecurity}
              <select
                name="smtpSecurity"
                defaultValue={settings.security}
              >
                <option value="starttls">{setupMessages.smtpStarttls}</option>
                <option value="ssl">{setupMessages.smtpSsl}</option>
                <option value="none">{setupMessages.smtpNone}</option>
              </select>
            </label>
            <label>
              {setupMessages.smtpUsername}
              <input
                name="smtpUsername"
                defaultValue={settings.username}
                placeholder="name@qq.com"
                autoComplete="username"
              />
              <span className="field-hint">
                {setupMessages.smtpAccountHint}
              </span>
            </label>
            <label>
              {setupMessages.smtpPassword}
              <span className="password-input-wrap">
                <input
                  ref={passwordRef}
                  name="smtpPassword"
                  type={showPassword ? "text" : "password"}
                  maxLength={1024}
                  placeholder={hasPassword ? "••••••••" : undefined}
                  required={!hasPassword}
                  autoComplete="new-password"
                />
                <button
                  className="password-visibility"
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  aria-label={
                    showPassword
                      ? messages.login.hidePassword
                      : messages.login.showPassword
                  }
                >
                  <PasswordVisibilityIcon visible={showPassword} />
                </button>
              </span>
              <span className="field-hint">
                {hasPassword
                  ? m.smtpPasswordConfigured
                  : setupMessages.smtpAuthorizationCodeHint}
              </span>
            </label>
            <label>
              {setupMessages.smtpFromName}
              <input
                name="smtpFromName"
                defaultValue={settings.fromName}
                maxLength={80}
              />
            </label>
            <div className="smtp-test-row">
              <label className="smtp-test-recipient">
                {setupMessages.smtpRecipientEmail}
                <input
                  name="smtpTestRecipient"
                  type="email"
                  placeholder="recipient@example.com"
                />
              </label>
              <button
                className="button"
                type="button"
                disabled={testing}
                onClick={() => void test()}
              >
                {testing
                  ? setupMessages.smtpTesting
                  : setupMessages.smtpTest}
              </button>
            </div>
            {testResult ? (
              <p className="settings-status smtp-test-status">{testResult}</p>
            ) : null}
            {testError ? (
              <p className="form-error smtp-test-status" role="alert">
                {testError}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="button-row">
          <button className="button primary" type="submit" disabled={saving}>
            {saving ? m.savingSmtp : m.saveSmtp}
          </button>
        </div>
        {saved ? <p className="settings-status">{m.smtpSaved}</p> : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}

function payload(form: FormData) {
  const username = String(form.get("smtpUsername") ?? "");
  return {
    enabled: form.get("smtpEnabled") === "on",
    host: String(form.get("smtpHost") ?? ""),
    port: Number(form.get("smtpPort") ?? 587),
    security: String(form.get("smtpSecurity") ?? "ssl"),
    username,
    password: String(form.get("smtpPassword") ?? ""),
    fromName: String(form.get("smtpFromName") ?? ""),
    fromEmail: username,
  };
}

function PasswordVisibilityIcon({ visible }: { visible: boolean }) {
  return visible ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m3 3 18 18M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 4.2A10.7 10.7 0 0 1 12 4c5.4 0 9 5 9 8a6.6 6.6 0 0 1-1.3 3.7M6.6 6.7C4.4 8.2 3 10.5 3 12c0 3 3.6 8 9 8 1.4 0 2.7-.4 3.8-.9" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 12c0-3 3.6-8 9-8s9 5 9 8-3.6 8-9 8-9-5-9-8Z" />
      <circle cx="12" cy="12" r="2.7" />
    </svg>
  );
}
