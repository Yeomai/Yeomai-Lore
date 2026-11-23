"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import {
  formatMessage,
  localizeApiError,
} from "../i18n/messages";
import { BrowserTimeText } from "./BrowserTime";

export interface ManagedOAuthIdentity {
  id: string;
  clientId: string;
  scope: string;
  createdAt: string;
  sessionStartedAt: string;
  accessExpiresAt: string;
  expiresAt: string;
  deviceId: string | null;
  deviceCode: string | null;
  note: string | null;
  userAgent: string | null;
  lastIp: string | null;
  lastSeenAt: string | null;
}

export function OAuthIdentityManagement({
  identities,
  authUrl,
}: {
  identities: ManagedOAuthIdentity[];
  authUrl: string;
}) {
  const router = useRouter();
  const { messages } = useI18n();
  const m = messages.admin;
  const identitySignature = identities
    .map(
      (identity) =>
        `${identity.id}:${identity.accessExpiresAt}:${identity.expiresAt}`,
    )
    .sort()
    .join("|");

  useEffect(() => {
    let cancelled = false;
    async function syncIdentities() {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await clientApi<{
          identities: ManagedOAuthIdentity[];
        }>("/api/v1/auth/oauth-identities");
        if (cancelled) return;
        const nextSignature = response.identities
          .map(
            (identity) =>
              `${identity.id}:${identity.accessExpiresAt}:${identity.expiresAt}`,
          )
          .sort()
          .join("|");
        if (nextSignature !== identitySignature) {
          router.refresh();
        }
      } catch {
        // Keep the current view and retry on the next visibility or poll.
      }
    }
    const timer = window.setInterval(() => void syncIdentities(), 3000);
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void syncIdentities();
      }
    };
    window.addEventListener("focus", syncWhenVisible);
    document.addEventListener("visibilitychange", syncWhenVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", syncWhenVisible);
      document.removeEventListener("visibilitychange", syncWhenVisible);
    };
  }, [identitySignature, router]);

  return (
    <>
      <section className="panel oauth-identity-management">
        <div className="section-heading">
          <div>
            <h2>{m.oauthRefreshTokens}</h2>
            <p className="muted">{m.oauthRefreshTokenHint}</p>
          </div>
        </div>
        {identities.length === 0 ? (
          <p className="muted">{m.noOAuthRefreshTokens}</p>
        ) : (
          <div className="oauth-identity-list">
            {identities.map((identity) => (
              <OAuthIdentityRow identity={identity} key={identity.id} />
            ))}
          </div>
        )}
        {identities.length > 0 ? <RevokeAllOAuthIdentities /> : null}
      </section>
      <OAuthIdentityNote authUrl={authUrl} />
    </>
  );
}

function OAuthIdentityRow({
  identity,
}: {
  identity: ManagedOAuthIdentity;
}) {
  const router = useRouter();
  const { locale, messages } = useI18n();
  const m = messages.admin;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const deviceLabel =
    identity.note || identity.userAgent || m.unknownOAuthDevice;

  async function revoke() {
    setPending(true);
    setError("");
    try {
      await clientApi(
        `/api/v1/auth/oauth-identities/${encodeURIComponent(identity.id)}`,
        { method: "DELETE" },
      );
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  return (
    <article className="oauth-identity-card">
      <div className="oauth-identity-main">
        <div className="oauth-identity-title-row">
          <strong>{deviceLabel}</strong>
          <span className="badge status-active">{m.oauthActive}</span>
          <span className="badge">{identity.clientId}</span>
        </div>
        <div className="oauth-identity-details">
          <p title={identity.id}>
            {formatMessage(m.oauthSessionId, { id: identity.id })}
          </p>
          {identity.deviceCode ? (
            <p>{formatMessage(m.oauthDeviceCode, { code: identity.deviceCode })}</p>
          ) : null}
          <p>{formatMessage(m.oauthScope, { scope: identity.scope })}</p>
        </div>
        <small className="oauth-identity-timestamps">
          <span>
            <BrowserTimeText
              template={m.oauthSessionStartedAt}
              value={identity.sessionStartedAt}
              locale={locale}
            />
          </span>
          <span>
            <BrowserTimeText
              template={m.oauthCreatedAt}
              value={identity.createdAt}
              locale={locale}
            />
          </span>
          <span>
            <BrowserTimeText
              template={m.oauthAccessExpiresAt}
              value={identity.accessExpiresAt}
              locale={locale}
            />
          </span>
          <span>
            <BrowserTimeText
              template={m.oauthExpiresAt}
              value={identity.expiresAt}
              locale={locale}
            />
          </span>
          {identity.lastIp ? (
            <span>{formatMessage(m.oauthIp, { ip: identity.lastIp })}</span>
          ) : null}
        </small>
      </div>
      <div className="oauth-identity-actions">
        <details className="admin-action-menu" data-dropdown>
          <summary className="button small danger">
            {m.revokeOAuthSession}
          </summary>
          <div className="admin-action-panel danger-panel">
            <p>{m.revokeOAuthSessionDescription}</p>
            <button
              className="button small danger"
              type="button"
              disabled={pending}
              onClick={() => void revoke()}
            >
              {pending ? m.revokingOAuthIdentity : m.confirmRevokeOAuthSession}
            </button>
          </div>
        </details>
      </div>
      {error ? <p className="form-error oauth-identity-error">{error}</p> : null}
    </article>
  );
}

function RevokeAllOAuthIdentities() {
  const router = useRouter();
  const { messages } = useI18n();
  const m = messages.admin;
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function revoke() {
    setPending(true);
    setMessage("");
    setError("");
    try {
      const result = await clientApi<{ revokedCount: number }>(
        "/api/v1/auth/oauth-identities",
        { method: "DELETE" },
      );
      if (result.revokedCount > 0) {
        setMessage(
          formatMessage(m.revokedOAuthIdentities, {
            count: String(result.revokedCount),
          }),
        );
      }
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="oauth-identity-danger">
      <div>
        <strong>{m.revokeAllOAuthIdentities}</strong>
        <p>{m.revokeAllOAuthIdentitiesDescription}</p>
      </div>
      <details className="admin-action-menu" data-dropdown>
        <summary className="button small danger">
          {m.revokeAllOAuthIdentities}
        </summary>
        <div className="admin-action-panel danger-panel">
          <p>{m.revokeAllOAuthIdentitiesConfirm}</p>
          <button
            className="button small danger"
            type="button"
            disabled={pending}
            onClick={() => void revoke()}
          >
            {pending ? m.revokingOAuthIdentity : m.confirmRevokeAllOAuthIdentities}
          </button>
        </div>
      </details>
      {message ? <p className="notice">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </div>
  );
}

function OAuthIdentityNote({ authUrl }: { authUrl: string }) {
  const { messages } = useI18n();
  const m = messages.admin;
  const loginCommand = `lore auth logout --auth-url 'oidc+${authUrl.replace(/\/+$/, "")}'`;
  const windowsInstallCommand =
    "irm https://raw.githubusercontent.com/EpicGames/lore/main/scripts/install.ps1 | iex";
  const unixInstallCommand =
    "curl -fsSL https://raw.githubusercontent.com/EpicGames/lore/main/scripts/install.sh | bash";
  return (
    <section className="panel oauth-identity-note">
      <div className="section-heading">
        <h2>{m.oauthIdentityNoteTitle}</h2>
      </div>
      <ol className="oauth-identity-note-list">
        <li>
          <strong>{m.oauthIdentitySingleRemoteTitle}</strong>
          <p>{m.oauthIdentityNoteDescription}</p>
          <pre>
            <code>{loginCommand}</code>
          </pre>
          <p>{m.oauthIdentityCliInstallHint}</p>
          <strong>{m.oauthIdentityWindows}</strong>
          <pre>
            <code>{windowsInstallCommand}</code>
          </pre>
          <strong>{m.oauthIdentityMacLinux}</strong>
          <pre>
            <code>{unixInstallCommand}</code>
          </pre>
        </li>
        <li>
          <strong>{m.oauthIdentityAllRemotesTitle}</strong>
          <p>{m.oauthIdentityCredentialManagerPath}</p>
          <p>{m.oauthIdentityAllRemotesWarning}</p>
        </li>
      </ol>
    </section>
  );
}
