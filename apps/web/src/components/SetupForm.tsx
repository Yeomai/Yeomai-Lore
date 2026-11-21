"use client";

import { useState } from "react";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { formatMessage, localizeApiError } from "../i18n/messages";
import {
  deriveUnifiedPublicAddress,
  needsLoreCertificate,
  toUnifiedSetupAddress,
} from "../lib/setup-address";
import { CertificateFileInputs } from "./CertificateFileInputs";

interface SetupDefaults {
  siteName: string;
  webPublicUrl: string;
  lorePublicUrl: string;
  userRegistrationEnabled: boolean;
  username: string;
  email: string;
  displayName: string;
}

export function SetupForm({ defaults }: { defaults: SetupDefaults }) {
  const [siteName, setSiteName] = useState(defaults.siteName);
  const [publicAddress, setPublicAddress] = useState(() =>
    toUnifiedSetupAddress(defaults.webPublicUrl),
  );
  const [certificateChain, setCertificateChain] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [restartRequired, setRestartRequired] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const { messages } = useI18n();
  const m = messages.setup;
  const derivedAddresses = deriveUnifiedPublicAddress(publicAddress);
  const showCertificate = derivedAddresses
    ? needsLoreCertificate(derivedAddresses.lorePublicUrl)
    : false;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    if (!derivedAddresses) {
      setError(m.addressInvalid);
      setPending(false);
      return;
    }
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");
    if (password !== confirmPassword) {
      setError(m.passwordsDoNotMatch);
      setPending(false);
      return;
    }
    try {
      const result = await clientApi<{
        ok: boolean;
        restartRequired: boolean;
      }>("/api/v1/setup", {
        method: "POST",
        body: JSON.stringify({
          siteName,
          publicAddress: publicAddress.trim(),
          username: form.get("username"),
          email: form.get("email"),
          displayName: form.get("displayName") || undefined,
          password,
          confirmPassword,
          userRegistrationEnabled:
            form.get("userRegistrationEnabled") === "on",
          certificateChain: showCertificate ? certificateChain : undefined,
          privateKey: showCertificate ? privateKey : undefined,
        }),
      });
      setRestartRequired(result.restartRequired);
      setCompleted(true);
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  async function restartBackend() {
    setRestarting(true);
    setError("");
    try {
      await clientApi("/api/v1/system/restart-lore", {
        method: "POST",
      });
      await clientApi("/api/v1/auth/logout", { method: "POST" });
      window.location.replace("/login");
    } catch (cause) {
      setError(localizeApiError(cause, messages));
      setRestarting(false);
    }
  }

  if (completed) {
    return (
      <div className="setup-success">
        <h2>{m.completedTitle}</h2>
        <p>
          {restartRequired ? m.restartDescription : m.completedDescription}
        </p>
        {restartRequired ? (
          <>
            {restarting ? (
              <p className="settings-status">{m.restarting}</p>
            ) : (
              <button
                className="button primary"
                type="button"
                onClick={() => void restartBackend()}
              >
                {m.restartService}
              </button>
            )}
          </>
        ) : (
          <a className="button primary" href="/dashboard">
            {m.goDashboard}
          </a>
        )}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <h1>{m.title}</h1>
      <p className="lede">{m.description}</p>
      <form className="stack setup-form" onSubmit={submit}>
      <fieldset>
        <legend>{m.siteSection}</legend>
        <label>
          {m.siteName}
          <input
            value={siteName}
            onChange={(event) => setSiteName(event.currentTarget.value)}
            maxLength={80}
            required
          />
        </label>
        <label>
          {m.webAddress}
          <input
            value={publicAddress}
            onChange={(event) => setPublicAddress(event.currentTarget.value)}
            placeholder="localhost:3000"
            aria-invalid={!derivedAddresses || undefined}
            required
          />
          <span className="field-hint">{m.webAddressHint}</span>
          <span
            className={derivedAddresses ? "field-hint" : "form-error"}
            role={derivedAddresses ? undefined : "alert"}
          >
            {derivedAddresses
              ? formatMessage(m.addressPreview, {
                  webUrl: derivedAddresses.webPublicUrl,
                  loreUrl: derivedAddresses.lorePublicUrl,
                })
              : m.addressInvalid}
          </span>
        </label>
        {showCertificate ? (
          <div className="certificate-fields">
            <p className="field-hint">{m.certificateDescription}</p>
            <CertificateFileInputs
              certificateChain={certificateChain}
              privateKey={privateKey}
              disabled={pending}
              onChange={(field, value) => {
                if (field === "certificateChain") {
                  setCertificateChain(value);
                } else {
                  setPrivateKey(value);
                }
              }}
            />
          </div>
        ) : null}
      </fieldset>

      <fieldset>
        <legend>{m.adminSection}</legend>
        <label>
          {m.username}
          <input
            name="username"
            defaultValue={defaults.username}
            autoComplete="username"
            pattern="[a-z0-9][a-z0-9_-]{2,31}"
            required
          />
        </label>
        <label>
          {m.email}
          <input
            name="email"
            type="email"
            defaultValue={defaults.email}
            autoComplete="email"
            required
          />
        </label>
        <label>
          {m.displayName}
          <input
            name="displayName"
            defaultValue={defaults.displayName}
            maxLength={80}
            autoComplete="name"
          />
        </label>
        <label>
          {m.password}
          <span className="password-input-wrap">
            <input
              name="password"
              type={showPassword ? "text" : "password"}
              minLength={6}
              maxLength={256}
              autoComplete="new-password"
              required
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
          <span className="field-hint">{m.passwordHint}</span>
        </label>
        <label>
          {m.confirmPassword}
          <span className="password-input-wrap">
            <input
              name="confirmPassword"
              type={showConfirmation ? "text" : "password"}
              minLength={6}
              maxLength={256}
              autoComplete="new-password"
              required
            />
            <button
              className="password-visibility"
              type="button"
              onClick={() => setShowConfirmation((visible) => !visible)}
              aria-label={
                showConfirmation
                  ? messages.login.hidePassword
                  : messages.login.showPassword
              }
            >
              <PasswordVisibilityIcon visible={showConfirmation} />
            </button>
          </span>
        </label>
      </fieldset>

      <fieldset>
        <legend>{m.accessSection}</legend>
        <label className="checkbox-label">
          <input
            name="userRegistrationEnabled"
            type="checkbox"
            defaultChecked={defaults.userRegistrationEnabled}
          />
          <span>
            <strong>{m.allowRegistration}{" "}</strong>
            <span className="field-hint">{m.registrationHint}</span>
          </span>
        </label>
      </fieldset>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="button primary" disabled={pending}>
        {pending ? m.submitting : m.submit}
      </button>
      </form>
    </>
  );
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
