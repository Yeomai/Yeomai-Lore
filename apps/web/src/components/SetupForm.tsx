"use client";

import { useState } from "react";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { formatMessage, localizeApiError } from "../i18n/messages";
import {
  classifySetupAddress,
  deriveUnifiedPublicAddress,
  needsLoreCertificate,
  toUnifiedSetupAddress,
  type SetupDeploymentMode,
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
  const initialMode =
    classifySetupAddress(defaults.webPublicUrl) ?? "local";
  const [deploymentMode, setDeploymentMode] =
    useState<SetupDeploymentMode>(initialMode);
  const [siteName, setSiteName] = useState(defaults.siteName);
  const [publicAddress, setPublicAddress] = useState(() =>
    initialMode === "local"
      ? "localhost:3000"
      : toUnifiedSetupAddress(defaults.webPublicUrl),
  );
  const [certificateChain, setCertificateChain] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [restartRequired, setRestartRequired] = useState(false);
  const [completed, setCompleted] = useState(false);
  const { messages } = useI18n();
  const m = messages.setup;
  const siteAddress =
    deploymentMode === "local" ? "localhost:3000" : publicAddress.trim();
  const derivedAddresses = deriveUnifiedPublicAddress(siteAddress);
  const detectedMode = classifySetupAddress(siteAddress);
  const addressMatchesMode =
    detectedMode === deploymentMode &&
    (deploymentMode === "local" || !siteAddress.startsWith("http://"));
  const showCertificate =
    deploymentMode === "domain" &&
    Boolean(
      derivedAddresses &&
        needsLoreCertificate(derivedAddresses.lorePublicUrl),
    );

  function selectDeploymentMode(nextMode: SetupDeploymentMode) {
    setDeploymentMode(nextMode);
    setError("");
    if (nextMode === "local") {
      setPublicAddress("localhost:3000");
    } else if (classifySetupAddress(publicAddress) !== nextMode) {
      setPublicAddress("");
    }
    if (nextMode !== "domain") {
      setCertificateChain("");
      setPrivateKey("");
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    if (!derivedAddresses || !addressMatchesMode) {
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
          publicAddress: siteAddress,
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

  if (completed) {
    return (
      <div className="setup-success">
        <h2>{m.completedTitle}</h2>
        <p>
          {restartRequired ? m.restartDescription : m.completedDescription}
        </p>
        <a className="button primary" href="/login">
          {m.goDashboard}
        </a>
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
        <div className="deployment-mode-fieldset">
          <span className="field-label">{m.deploymentMode}</span>
          <div className="deployment-mode-grid">
            {(
              [
                ["local", m.modeLocal, m.modeLocalHint],
                ["ip", m.modeIp, m.modeIpHint],
                ["domain", m.modeDomain, m.modeDomainHint],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                className={
                  deploymentMode === value
                    ? "deployment-mode-option is-selected"
                    : "deployment-mode-option"
                }
                key={value}
              >
                <input
                  type="radio"
                  name="deploymentMode"
                  value={value}
                  checked={deploymentMode === value}
                  onChange={() => selectDeploymentMode(value)}
                  disabled={pending}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{hint}</small>
                </span>
              </label>
            ))}
          </div>
        </div>
        <label>
          {m.siteName}
          <input
            value={siteName}
            onChange={(event) => setSiteName(event.currentTarget.value)}
            maxLength={80}
            required
          />
        </label>
        {deploymentMode === "local" ? (
          <div className="deployment-address-preview">
            <span className="field-label">{m.modeLocalAddress}</span>
            <code>http://localhost:3000</code>
            <code>lore://localhost:3000</code>
          </div>
        ) : (
          <label>
            {deploymentMode === "ip" ? m.ipAddress : m.domainAddress}
            <input
              value={publicAddress}
              onChange={(event) => setPublicAddress(event.currentTarget.value)}
              placeholder={
                deploymentMode === "ip"
                  ? "118.89.28.163:3000"
                  : "lore.example.com:3000"
              }
              aria-invalid={!derivedAddresses || !addressMatchesMode || undefined}
              required
            />
            <span className="field-hint">
              {deploymentMode === "ip"
                ? m.modeIpHint
                : m.modeDomainHint}
            </span>
          </label>
        )}
        <span
          className={
            derivedAddresses && addressMatchesMode
              ? "field-hint"
              : "form-error"
          }
          role={derivedAddresses && addressMatchesMode ? undefined : "alert"}
        >
          {derivedAddresses && addressMatchesMode
            ? formatMessage(m.addressPreview, {
                webUrl: derivedAddresses.webPublicUrl,
                loreUrl: derivedAddresses.lorePublicUrl,
              })
            : m.addressModeMismatch}
        </span>
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
