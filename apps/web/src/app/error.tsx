"use client";

import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { messages } = useI18n();
  const m = messages.error;
  return (
    <section className="auth-card">
      <p className="eyebrow">{m.eyebrow}</p>
      <h1>{m.title}</h1>
      <p className="form-error">
        {localizeApiError(error, messages)}
      </p>
      <button className="button primary" onClick={reset}>
        {m.retry}
      </button>
    </section>
  );
}
