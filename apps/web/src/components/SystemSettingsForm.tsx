"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";

export function SystemSettingsForm({
  userRegistrationEnabled,
  userInvitationsEnabled,
  loreVersion,
}: {
  userRegistrationEnabled: boolean;
  userInvitationsEnabled: boolean;
  loreVersion: string;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState({
    userRegistrationEnabled,
    userInvitationsEnabled,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [restarting, setRestarting] = useState(false);
  const [restartMessage, setRestartMessage] = useState("");
  const [restartError, setRestartError] = useState("");
  const { messages } = useI18n();
  const m = messages.admin;

  async function toggle(
    field: "userRegistrationEnabled" | "userInvitationsEnabled",
    nextEnabled: boolean,
  ) {
    const previous = settings;
    const next = { ...settings, [field]: nextEnabled };
    setSettings(next);
    setPending(true);
    setError("");
    try {
      await clientApi("/api/v1/admin/settings", {
        method: "PUT",
        body: JSON.stringify(next),
      });
      router.refresh();
    } catch (cause) {
      setSettings(previous);
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  async function restartLore() {
    setRestarting(true);
    setRestartError("");
    setRestartMessage("");
    try {
      await clientApi("/api/v1/system/restart-lore", {
        method: "POST",
      });
      setRestartMessage(m.loreRestarted);
      router.refresh();
    } catch (cause) {
      setRestartError(localizeApiError(cause, messages));
    } finally {
      setRestarting(false);
    }
  }

  return (
    <>
      <section className="panel settings-panel">
        <div className="setting-row">
          <div>
            <strong>{m.userRegistrationEnabled}</strong>
            <p>{m.userRegistrationEnabledDescription}</p>
          </div>
          <label className="settings-switch">
            <span className="sr-only">{m.userRegistrationEnabled}</span>
            <input
              type="checkbox"
              role="switch"
              checked={settings.userRegistrationEnabled}
              disabled={pending}
              onChange={(event) =>
                void toggle(
                  "userRegistrationEnabled",
                  event.currentTarget.checked,
                )
              }
            />
            <span className="settings-switch-track" aria-hidden="true" />
          </label>
        </div>
        <div className="setting-row">
          <div>
            <strong>{m.userInvitationsEnabled}</strong>
            <p>{m.userInvitationsEnabledDescription}</p>
          </div>
          <label className="settings-switch">
            <span className="sr-only">{m.userInvitationsEnabled}</span>
            <input
              type="checkbox"
              role="switch"
              checked={settings.userInvitationsEnabled}
              disabled={pending}
              onChange={(event) =>
                void toggle(
                  "userInvitationsEnabled",
                  event.currentTarget.checked,
                )
              }
            />
            <span className="settings-switch-track" aria-hidden="true" />
          </label>
        </div>
        {pending ? <p className="settings-status">{m.savingSetting}</p> : null}
        {error ? <p className="form-error">{error}</p> : null}
      </section>

      <section className="panel settings-panel">
        <div>
          <div className="lore-service-heading">
            <h2>{m.loreServiceControl}</h2>
            <span className="lore-service-version">
              lore v{loreVersion}
            </span>
          </div>
          <p className="muted">{m.restartLoreDescription}</p>
        </div>
        <div>
          <button
            className="button primary"
            type="button"
            disabled={restarting}
            onClick={() => void restartLore()}
          >
            {restarting ? m.restartingLore : m.restartLore}
          </button>
        </div>
        {restartMessage ? (
          <p className="notice" role="status">
            {restartMessage}
          </p>
        ) : null}
        {restartError ? (
          <p className="form-error" role="alert">
            {restartError}
          </p>
        ) : null}
      </section>
    </>
  );
}
