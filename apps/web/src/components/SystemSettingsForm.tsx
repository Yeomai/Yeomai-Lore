"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { localizeApiError } from "../i18n/messages";

export function SystemSettingsForm({
  userRegistrationEnabled,
  userInvitationsEnabled,
  regularUserQuotaEnabled,
  regularUserMaxRepositories,
  regularUserMaxSizeBytes,
  regularUserImportMaxBytes,
  regularUserRepositoryCleanupHours,
  loginAnnouncement,
  loreVersion,
}: {
  userRegistrationEnabled: boolean;
  userInvitationsEnabled: boolean;
  regularUserQuotaEnabled: boolean;
  regularUserMaxRepositories: number;
  regularUserMaxSizeBytes: number;
  regularUserImportMaxBytes: number;
  regularUserRepositoryCleanupHours: number;
  loginAnnouncement: string;
  loreVersion: string;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState({
    userRegistrationEnabled,
    userInvitationsEnabled,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [quotaMessage, setQuotaMessage] = useState("");
  const initialQuotaSettings = {
    enabled: regularUserQuotaEnabled,
    maxRepositories: regularUserMaxRepositories,
    maxSizeMiB: regularUserMaxSizeBytes / 1024 ** 2,
    importMaxMiB: regularUserImportMaxBytes / 1024 ** 2,
    cleanupHours: regularUserRepositoryCleanupHours,
  };
  const [quotaSettings, setQuotaSettings] = useState(initialQuotaSettings);
  const [savedQuotaSettings, setSavedQuotaSettings] = useState(
    initialQuotaSettings,
  );
  const [announcement, setAnnouncement] = useState(loginAnnouncement);
  const [savedAnnouncement, setSavedAnnouncement] =
    useState(loginAnnouncement);
  const [announcementMessage, setAnnouncementMessage] = useState("");
  const [announcementError, setAnnouncementError] = useState("");
  const [restarting, setRestarting] = useState(false);
  const [restartMessage, setRestartMessage] = useState("");
  const [restartError, setRestartError] = useState("");
  const { messages } = useI18n();
  const m = messages.admin;

  function requestBody(
    next = settings,
    quotas = quotaSettings,
    announcementValue = savedAnnouncement,
  ) {
    return {
      ...next,
      regularUserQuotaEnabled: quotas.enabled,
      regularUserMaxRepositories: quotas.maxRepositories,
      regularUserMaxSizeBytes: Math.round(quotas.maxSizeMiB * 1024 ** 2),
      regularUserImportMaxBytes: Math.round(
        quotas.importMaxMiB * 1024 ** 2,
      ),
      regularUserRepositoryCleanupHours: quotas.cleanupHours,
      loginAnnouncement: announcementValue,
    };
  }

  async function toggleQuota(nextEnabled: boolean) {
    const next = {
      ...quotaSettings,
      enabled: nextEnabled,
    };
    setQuotaSettings(next);
    setQuotaMessage("");
    if (nextEnabled || !savedQuotaSettings.enabled) return;
    setPending(true);
    setError("");
    try {
      await clientApi("/api/v1/admin/settings", {
        method: "PUT",
        body: JSON.stringify(
          requestBody(settings, next, savedAnnouncement),
        ),
      });
      setSavedQuotaSettings(next);
      setQuotaMessage(m.quotaSaved);
      router.refresh();
    } catch (cause) {
      setQuotaSettings(savedQuotaSettings);
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  async function saveQuotas(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setQuotaMessage("");
    try {
      await clientApi("/api/v1/admin/settings", {
        method: "PUT",
        body: JSON.stringify(
          requestBody(settings, quotaSettings, savedAnnouncement),
        ),
      });
      setSavedQuotaSettings(quotaSettings);
      setQuotaMessage(m.quotaSaved);
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  async function saveAnnouncement(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextAnnouncement = announcement.trim();
    setPending(true);
    setAnnouncementError("");
    setAnnouncementMessage("");
    try {
      await clientApi("/api/v1/admin/settings", {
        method: "PUT",
        body: JSON.stringify(
          requestBody(settings, savedQuotaSettings, nextAnnouncement),
        ),
      });
      setAnnouncement(nextAnnouncement);
      setSavedAnnouncement(nextAnnouncement);
      setAnnouncementMessage(m.announcementSaved);
      router.refresh();
    } catch (cause) {
      setAnnouncement(savedAnnouncement);
      setAnnouncementError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

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
        body: JSON.stringify(
          requestBody(next, savedQuotaSettings, savedAnnouncement),
        ),
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
        <div>
          <h2>{m.loginAnnouncementTitle}</h2>
          <p className="muted">{m.loginAnnouncementDescription}</p>
        </div>
        <form className="stack compact" onSubmit={saveAnnouncement}>
          <label>
            {m.loginAnnouncementLabel}
            <textarea
              rows={4}
              maxLength={2000}
              value={announcement}
              disabled={pending}
              placeholder={m.loginAnnouncementPlaceholder}
              onChange={(event) => {
                setAnnouncement(event.currentTarget.value);
                setAnnouncementMessage("");
                setAnnouncementError("");
              }}
            />
          </label>
          <p className="field-hint">
            {m.loginAnnouncementHint} {announcement.length}/2000
          </p>
          <div>
            <button className="button primary" disabled={pending}>
              {pending ? m.savingAnnouncement : m.saveAnnouncement}
            </button>
          </div>
          {announcementMessage ? (
            <p className="notice" role="status">
              {announcementMessage}
            </p>
          ) : null}
          {announcementError ? (
            <p className="form-error" role="alert">
              {announcementError}
            </p>
          ) : null}
        </form>
      </section>

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
        <div className="setting-row">
          <div>
            <strong>{m.enableRegularUserQuota}</strong>
          </div>
          <label className="settings-switch">
            <span className="sr-only">{m.enableRegularUserQuota}</span>
            <input
              type="checkbox"
              role="switch"
              checked={quotaSettings.enabled}
              disabled={pending}
              onChange={(event) =>
                void toggleQuota(event.currentTarget.checked)
              }
            />
            <span className="settings-switch-track" aria-hidden="true" />
          </label>
        </div>
        {quotaSettings.enabled ? (
          <div>
            <h2>{m.regularUserQuotaTitle}</h2>
            <p className="muted">{m.regularUserQuotaDescription}</p>
          </div>
        ) : null}
        <form className="stack compact" onSubmit={saveQuotas}>
          {quotaSettings.enabled ? (
            <>
              <div className="setup-form-grid">
                <label>
                  {m.regularUserMaxRepositories}
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={quotaSettings.maxRepositories}
                    disabled={pending}
                    onChange={(event) =>
                      setQuotaSettings((current) => ({
                        ...current,
                        maxRepositories: Math.max(
                          0,
                          Number(event.currentTarget.value) || 0,
                        ),
                      }))
                    }
                  />
                </label>
                <label>
                  {m.regularUserCleanupHours}
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={quotaSettings.cleanupHours}
                    disabled={pending}
                    onChange={(event) =>
                      setQuotaSettings((current) => ({
                        ...current,
                        cleanupHours: Math.max(
                          0,
                          Number(event.currentTarget.value) || 0,
                        ),
                      }))
                    }
                  />
                </label>
                <label>
                  {m.regularUserMaxSizeMiB}
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={quotaSettings.maxSizeMiB}
                    disabled={pending}
                    onChange={(event) =>
                      setQuotaSettings((current) => ({
                        ...current,
                        maxSizeMiB: Math.max(
                          0,
                          Number(event.currentTarget.value) || 0,
                        ),
                      }))
                    }
                  />
                </label>
                <label>
                  {m.regularUserImportMaxMiB}
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={quotaSettings.importMaxMiB}
                    disabled={pending}
                    onChange={(event) =>
                      setQuotaSettings((current) => ({
                        ...current,
                        importMaxMiB: Math.max(
                          0,
                          Number(event.currentTarget.value) || 0,
                        ),
                      }))
                    }
                  />
                </label>
              </div>
              <p className="field-hint">{m.regularUserQuotaZeroHint}</p>
            </>
          ) : null}
          {quotaSettings.enabled ? (
            <div>
              <button className="button primary" disabled={pending}>
                {pending ? m.savingQuota : m.saveQuota}
              </button>
            </div>
          ) : null}
          {quotaMessage ? (
            <p className="notice" role="status">
              {quotaMessage}
            </p>
          ) : null}
        </form>
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
