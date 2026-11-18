"use client";

import { useState } from "react";
import { useI18n } from "../i18n/client";

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const { messages } = useI18n();
  return (
    <button
      type="button"
      className="copy-button"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? messages.common.copied : messages.common.copy}
    </button>
  );
}
