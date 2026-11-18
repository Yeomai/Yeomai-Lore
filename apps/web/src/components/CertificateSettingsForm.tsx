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
}

export interface CertificateSettings {
  lorePublicUrl: string;
  required: boolean;
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
  const [restarting, setRestarting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const { locale, messages } = useI18n();
  const m = messages.admin;
  if (!settings.required) {
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

  const certificate = settings.certificate;

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
    </div>
  );
}
