"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";

export function AcceptInviteForm({ token }: { token: string }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const { messages } = useI18n();
  const m = messages.acceptInvite;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await clientApi("/api/v1/auth/accept-invite", {
        method: "POST",
        body: JSON.stringify({
          token,
          username: form.get("username"),
          displayName: form.get("displayName"),
          password: form.get("password"),
        }),
      });
      router.push("/dashboard");
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label>
        {m.username}
        <input
          name="username"
          autoComplete="username"
          pattern="[a-z0-9][a-z0-9_-]{2,31}"
          required
        />
      </label>
      <label>
        {m.displayName}
        <input name="displayName" autoComplete="name" required />
      </label>
      <label>
        {m.password}
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={6}
          required
        />
      </label>
      {error ? <p className="form-error">{error}</p> : null}
      <button className="button primary" disabled={pending}>
        {pending ? m.creating : m.submit}
      </button>
    </form>
  );
}
