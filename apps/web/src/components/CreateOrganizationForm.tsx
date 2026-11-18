"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";

export function CreateOrganizationForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const { messages } = useI18n();
  const m = messages.organizationForm;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await clientApi("/api/v1/orgs", {
        method: "POST",
        body: JSON.stringify({
          slug: form.get("slug"),
          name: form.get("name"),
        }),
      });
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="row-form" onSubmit={submit}>
      <input name="name" placeholder={m.namePlaceholder} required />
      <input
        name="slug"
        placeholder={m.slugPlaceholder}
        pattern="[a-z0-9][a-z0-9-]{1,62}"
        required
      />
      <button className="button" disabled={pending}>
        {pending ? m.creating : m.create}
      </button>
      {error ? <span className="form-error">{error}</span> : null}
    </form>
  );
}
