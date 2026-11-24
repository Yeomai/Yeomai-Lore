"use client";

import { useEffect, useState } from "react";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import {
  formatMessage,
  localizeApiError,
} from "../i18n/messages";

interface DeviceStatus {
  status: "pending" | "approved" | "denied" | "used" | "expired";
  clientId: string;
}

interface Approver {
  displayName: string;
  email: string;
  username: string;
}

export function DeviceApproval({
  initialCode,
  initialApprover,
  loginNext,
}: {
  initialCode: string;
  initialApprover: Approver | null;
  loginNext: string;
}) {
  const [status, setStatus] = useState<DeviceStatus["status"] | "">("");
  const [clientId, setClientId] = useState("");
  const [message, setMessage] = useState("");
  const [approver, setApprover] = useState(initialApprover);
  const [pendingAction, setPendingAction] = useState<"approve" | "deny" | null>(
    null,
  );
  const { messages } = useI18n();
  const m = messages.device;

  useEffect(() => {
    if (!initialCode) {
      setMessage(m.missingCode);
      return;
    }
    let cancelled = false;
    clientApi<DeviceStatus>(
      `/api/v1/auth/device/status?user_code=${encodeURIComponent(initialCode)}`,
    )
      .then((current) => {
        if (cancelled) return;
        setStatus(current.status);
        setClientId(current.clientId);
        if (current.status === "approved" || current.status === "used") {
          setMessage(m.approvalConfirmed);
        } else if (current.status === "pending") {
          setMessage(m.approvalRequired);
        } else {
          setMessage(current.status === "expired" ? m.expired : m.denied);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessage(localizeApiError(error, messages));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    initialCode,
    m.approvalRequired,
    m.approvalConfirmed,
    m.denied,
    m.expired,
    m.missingCode,
    messages,
  ]);

  useEffect(() => {
    if (status !== "approved" && status !== "used") {
      return;
    }
    const timer = window.setTimeout(() => window.close(), 1000);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") {
        void loadCurrentApprover();
      }
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  async function approve() {
    setPendingAction("approve");
    setMessage("");
    try {
      if (!(await requireCurrentApprover())) return;
      await clientApi("/api/v1/auth/device/approve", {
        method: "POST",
        body: JSON.stringify({ userCode: initialCode }),
      });
      setStatus("approved");
      setMessage(m.approvalConfirmed);
    } catch (error) {
      setMessage(localizeApiError(error, messages));
    } finally {
      setPendingAction(null);
    }
  }

  async function deny() {
    setPendingAction("deny");
    setMessage("");
    try {
      if (!(await requireCurrentApprover())) return;
      await clientApi("/api/v1/auth/device/deny", {
        method: "POST",
        body: JSON.stringify({ userCode: initialCode }),
      });
      setStatus("denied");
      setMessage(m.denied);
    } catch (error) {
      setMessage(localizeApiError(error, messages));
    } finally {
      setPendingAction(null);
    }
  }

  async function requireCurrentApprover(): Promise<Approver | null> {
    const current = await loadCurrentApprover();
    if (!current) setMessage(m.signInToApprove);
    return current;
  }

  async function loadCurrentApprover(): Promise<Approver | null> {
    try {
      const current = await clientApi<{ user: Approver | null }>(
        "/api/v1/auth/session",
      );
      setApprover(current.user);
      return current.user;
    } catch {
      setApprover(null);
      return null;
    }
  }

  return (
    <div className="stack">
      {clientId ? (
        <p className="muted">
          {formatMessage(m.requestedBy, { client: clientId })}
        </p>
      ) : null}
      {approver ? (
        <p className="muted">
          {formatMessage(m.approvalAccount, {
            name: approver.displayName,
            email: approver.email,
          })}
        </p>
      ) : null}
      {message ? <p className="muted">{message}</p> : null}
      {status === "pending" ? (
        approver ? (
          <div className="button-row">
            <button
              className="button primary"
              type="button"
              disabled={pendingAction !== null}
              onClick={() => void approve()}
            >
              {pendingAction === "approve" ? m.confirming : m.confirmLogin}
            </button>
            <button
              className="button danger"
              type="button"
              disabled={pendingAction !== null}
              onClick={() => void deny()}
            >
              {pendingAction === "deny" ? m.denying : m.denyLogin}
            </button>
          </div>
        ) : (
          <a
            className="button primary"
            href={`/login?next=${encodeURIComponent(loginNext)}`}
          >
            {m.signInToApprove}
          </a>
        )
      ) : null}
    </div>
  );
}
