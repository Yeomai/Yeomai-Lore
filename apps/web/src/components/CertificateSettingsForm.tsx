"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";
import { BrowserTime } from "./BrowserTime";
import { CertificateFileInputs } from "./CertificateFileInputs";

export interface CertificateDetails {
  configured: boolean;
  invalid: boolean;
  subject: string | null;
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  fingerprint256: string | null;
  ipAddresses: string[];
}

export interface CertificateSettings {
  lorePublicUrl: string;
  deploymentMode: "local" | "ip" | "domain";
  required: boolean;
  caAvailable: boolean;
  ipIssuanceAvailable: boolean;
  siteIpAddress: string | null;
  additionalIpAddresses: string[];
  certificate: CertificateDetails | null;
}

export function CertificateSettingsForm({
  settings,
}: {
  settings: CertificateSettings;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [certificateChain, setCertificateChain] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [fileInputVersion, setFileInputVersion] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [issuingIps, setIssuingIps] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [ipMessage, setIpMessage] = useState("");
  const [ipError, setIpError] = useState("");
  const { locale, messages } = useI18n();
  const m = messages.admin;
  const certificate = settings.certificate;
  const [ipAddresses, setIpAddresses] = useState(
    settings.additionalIpAddresses.join("\n"),
  );
  if (!settings.required && !settings.caAvailable) {
    return (
      <section className="panel">
        <p className="muted">{m.certificateLocalEmpty}</p>
      </section>
    );
  }

  async function upload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setUploading(true);
    setError("");
    setMessage("");
    try {
      await clientApi("/api/v1/admin/certificate", {
        method: "PUT",
        body: JSON.stringify({ certificateChain, privateKey }),
      });
      setMessage(m.certificateUploaded);
      setCertificateChain("");
      setPrivateKey("");
      setFileInputVersion((current) => current + 1);
      formRef.current?.reset();
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setUploading(false);
    }
  }

  async function restartLore() {
    setRestarting(true);
    setError("");
    setMessage("");
    try {
      await clientApi("/api/v1/system/restart-lore", {
        method: "POST",
      });
      setMessage(m.certificateRestarted);
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setRestarting(false);
    }
  }

  async function issueIpCertificate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIssuingIps(true);
    setIpError("");
    setIpMessage("");
    try {
      const result = await clientApi<{
        siteIpAddress: string;
        additionalIpAddresses: string[];
      }>(
        "/api/v1/admin/certificate/ips",
        {
          method: "POST",
          body: JSON.stringify({
            ipAddresses: ipAddresses
              .split(/[\s,]+/)
              .map((value) => value.trim())
              .filter(Boolean),
          }),
        },
      );
      setIpAddresses(result.additionalIpAddresses.join("\n"));
      await clientApi("/api/v1/system/restart-lore", {
        method: "POST",
      });
      setIpMessage(m.certificateIpsIssued);
      router.refresh();
    } catch (cause) {
      setIpError(localizeApiError(cause, messages));
    } finally {
      setIssuingIps(false);
    }
  }

  return (
    <div className="page-stack">
      <section className="panel">
        <h2>{m.certificateCurrent}</h2>
        {!certificate?.configured ? (
          <p className="muted">{m.certificateMissing}</p>
        ) : certificate.invalid ? (
          <p className="form-error">{m.certificateInvalid}</p>
        ) : (
          <dl className="profile-details">
            <div>
              <dt>{m.certificateSubject}</dt>
              <dd>{certificate.subject}</dd>
            </div>
            <div>
              <dt>{m.certificateIssuer}</dt>
              <dd>{certificate.issuer}</dd>
            </div>
            <div>
              <dt>{m.certificateValidFrom}</dt>
              <dd>
                {certificate.validFrom
                  ? <BrowserTime value={certificate.validFrom} locale={locale} />
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>{m.certificateValidTo}</dt>
              <dd>
                {certificate.validTo
                  ? <BrowserTime value={certificate.validTo} locale={locale} />
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>{m.certificateFingerprint}</dt>
              <dd>
                <code className="small-code">
                  {certificate.fingerprint256 ?? "—"}
                </code>
              </dd>
            </div>
          </dl>
        )}
      </section>

      {settings.caAvailable && settings.ipIssuanceAvailable ? (
        <section className="panel">
          <h2>{m.certificateCaTitle}</h2>
          <p className="muted">{m.certificateCaDescription}</p>
          <a
            className="button"
            href="/api/v1/admin/certificate/ca"
            download="Yeomai-Lore-CA.crt"
          >
            {m.certificateCaDownload}
          </a>
          <div className="ca-install-guides">
            <section>
              <h3>{m.certificateCaMacTitle}</h3>
              <ol>
                {m.certificateCaMacSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </section>
            <section>
              <h3>{m.certificateCaWindowsTitle}</h3>
              <ol>
                {m.certificateCaWindowsSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </section>
          </div>
        </section>
      ) : null}

      {settings.ipIssuanceAvailable ? (
        <details className="panel advanced-certificate-panel">
          <summary>{m.certificateIpsTitle}</summary>
          <div className="advanced-certificate-content">
            <p className="muted">{m.certificateIpsDescription}</p>
            <dl className="profile-details">
              <div>
                <dt>{m.certificateSiteIp}</dt>
                <dd>
                  <code>{settings.siteIpAddress}</code>
                </dd>
              </div>
            </dl>
            <form className="stack compact" onSubmit={issueIpCertificate}>
              <label>
                {m.certificateIpsLabel}
                <textarea
                  value={ipAddresses}
                  onChange={(event) =>
                    setIpAddresses(event.currentTarget.value)
                  }
                  placeholder="10.1.0.1"
                  rows={4}
                  disabled={issuingIps || restarting}
                />
              </label>
              <p className="field-hint">{m.certificateIpsHint}</p>
              <div className="button-row">
                <button
                  className="button primary"
                  disabled={issuingIps || restarting}
                >
                  {issuingIps
                    ? m.certificateIpsIssuing
                    : m.certificateIpsIssue}
                </button>
              </div>
              {ipError ? (
                <p className="form-error" role="alert">
                  {ipError}
                </p>
              ) : null}
              {ipMessage ? (
                <p className="notice" role="status">
                  {ipMessage}
                </p>
              ) : null}
            </form>
          </div>
        </details>
      ) : null}

      {settings.required ? (
        <section className="panel">
          <h2>{m.certificateTitle}</h2>
          <p className="muted">{m.certificateDescription}</p>
          <form ref={formRef} className="stack compact" onSubmit={upload}>
            <div className="certificate-fields">
              <CertificateFileInputs
                key={fileInputVersion}
                certificateChain={certificateChain}
                privateKey={privateKey}
                disabled={uploading || restarting}
                onChange={(field, value) => {
                  if (field === "certificateChain") {
                    setCertificateChain(value);
                  } else {
                    setPrivateKey(value);
                  }
                }}
              />
            </div>
            <div className="button-row">
              <button
                className="button primary"
                disabled={uploading || restarting}
              >
                {uploading ? m.certificateUploading : m.certificateUpload}
              </button>
              <button
                className="button"
                type="button"
                disabled={uploading || restarting}
                onClick={() => void restartLore()}
              >
                {restarting
                  ? m.certificateRestarting
                  : m.certificateRestart}
              </button>
            </div>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            {message ? (
              <p className="notice" role="status">
                {message}
              </p>
            ) : null}
          </form>
        </section>
      ) : null}
    </div>
  );
}
