"use client";

import { useState } from "react";
import { useI18n } from "../i18n/client";

export function CertificateFileInputs({
  certificateChain,
  privateKey,
  disabled = false,
  onChange,
}: {
  certificateChain: string;
  privateKey: string;
  disabled?: boolean;
  onChange: (field: "certificateChain" | "privateKey", value: string) => void;
}) {
  const [certificateName, setCertificateName] = useState("");
  const [privateKeyName, setPrivateKeyName] = useState("");
  const { messages } = useI18n();
  const m = messages.setup;

  async function selectFile(
    field: "certificateChain" | "privateKey",
    file: File | undefined,
  ) {
    if (field === "certificateChain") {
      setCertificateName(file?.name ?? "");
    } else {
      setPrivateKeyName(file?.name ?? "");
    }
    onChange(field, file ? await file.text() : "");
  }

  return (
    <>
      <label className="certificate-file-field">
        <span>{m.certificateChain}</span>
        <span className="button certificate-file-button">
          {m.chooseCertificateFile}
          <input
            className="sr-only"
            type="file"
            accept=".pem,.crt,.cer,application/x-pem-file,text/plain"
            disabled={disabled}
            required={!certificateChain}
            onChange={(event) => {
              void selectFile("certificateChain", event.currentTarget.files?.[0]);
            }}
          />
        </span>
        <span className="field-hint">
          {certificateName || m.certificateFileHint}
        </span>
      </label>
      <label className="certificate-file-field">
        <span>{m.privateKey}</span>
        <span className="button certificate-file-button">
          {m.choosePrivateKeyFile}
          <input
            className="sr-only"
            type="file"
            accept=".pem,.key,application/x-pem-file,text/plain"
            disabled={disabled}
            required={!privateKey}
            onChange={(event) => {
              void selectFile("privateKey", event.currentTarget.files?.[0]);
            }}
          />
        </span>
        <span className="field-hint">
          {privateKeyName || m.privateKeyHint}
        </span>
      </label>
    </>
  );
}
