"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { formatMessage, localizeApiError } from "../i18n/messages";

interface OrganizationActionMember {
  userId: string;
  username: string;
  displayName: string;
  role: string;
}

export function OrganizationActions({
  organization,
  currentUserId,
}: {
  organization: {
    id: string;
    slug: string;
    role: string;
    repositoryCount: number;
    members: OrganizationActionMember[];
  };
  currentUserId: string;
}) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState("");
  const [error, setError] = useState("");
  const { messages } = useI18n();
  const m = messages.admin;
  const pending = Boolean(pendingAction);
  const canDelete =
    organization.role === "owner" ||
    organization.role === "admin" ||
    organization.role === "global-admin";
  const canLeave = organization.role === "member";
  const canTransfer =
    organization.role === "owner" || organization.role === "global-admin";
  const transferCandidates = organization.members.filter(
    (member) => member.userId !== currentUserId,
  );

  async function execute(
    action: string,
    path: string,
    init?: RequestInit,
  ) {
    setPendingAction(action);
    setError("");
    try {
      await clientApi(path, init);
      router.refresh();
    } catch (cause) {
      setError(localizeApiError(cause, messages));
    } finally {
      setPendingAction("");
    }
  }

  function deleteOrganization(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void execute("delete", `/api/v1/orgs/${organization.id}`, {
      method: "DELETE",
      body: JSON.stringify({ confirmation: form.get("confirmation") }),
    });
  }

  function leaveOrganization(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void execute(
      "leave",
      `/api/v1/orgs/${organization.id}/members/me`,
      { method: "DELETE" },
    );
  }

  function transferOwnership(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void execute("transfer", `/api/v1/orgs/${organization.id}/owner`, {
      method: "POST",
      body: JSON.stringify({ userId: form.get("userId") }),
    });
  }

  if (!canDelete && !canLeave && !canTransfer) {
    return null;
  }

  return (
    <div className="organization-actions">
      {canTransfer ? (
        <details className="admin-action-menu" data-dropdown>
          <summary className="button small">{m.transferOwnership}</summary>
          <div className="admin-action-panel">
            <p>{m.transferOwnershipDescription}</p>
            {transferCandidates.length === 0 ? (
              <p className="form-error">{m.noTransferCandidates}</p>
            ) : (
              <form className="stack compact" onSubmit={transferOwnership}>
                <label>
                  {m.newOwner}
                  <select
                    name="userId"
                    defaultValue=""
                    required
                    disabled={pending}
                  >
                    <option value="" disabled>
                      {m.selectNewOwner}
                    </option>
                    {transferCandidates.map((member) => (
                      <option key={member.userId} value={member.userId}>
                        {member.displayName} ({member.username})
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button small primary"
                  disabled={pending}
                >
                  {pendingAction === "transfer"
                    ? m.transferringOwnership
                    : m.transferOwnership}
                </button>
              </form>
            )}
          </div>
        </details>
      ) : null}

      {canLeave ? (
        <details className="admin-action-menu" data-dropdown>
          <summary className="button small">{m.leaveOrganization}</summary>
          <div className="admin-action-panel">
            <p>{m.leaveOrganizationDescription}</p>
            <form onSubmit={leaveOrganization}>
              <button className="button small danger" disabled={pending}>
                {pendingAction === "leave"
                  ? m.leavingOrganization
                  : m.confirmLeaveOrganization}
              </button>
            </form>
          </div>
        </details>
      ) : null}

      {canDelete ? (
        <details className="admin-action-menu" data-dropdown>
          <summary className="button small danger">
            {m.deleteOrganization}
          </summary>
          <div className="admin-action-panel danger-panel">
            <p>{m.deleteOrganizationDescription}</p>
            {organization.repositoryCount > 0 ? (
              <p className="form-error">
                {formatMessage(m.deleteOrganizationBlocked, {
                  count: organization.repositoryCount,
                })}
              </p>
            ) : null}
            <form className="stack compact" onSubmit={deleteOrganization}>
              <label>
                {formatMessage(m.deleteOrganizationConfirmation, {
                  slug: organization.slug,
                })}
                <input
                  name="confirmation"
                  placeholder={organization.slug}
                  autoComplete="off"
                  disabled={pending || organization.repositoryCount > 0}
                  required
                />
              </label>
              <button
                className="button small danger"
                disabled={pending || organization.repositoryCount > 0}
              >
                {pendingAction === "delete"
                  ? m.deletingOrganization
                  : m.confirmDeleteOrganization}
              </button>
            </form>
          </div>
        </details>
      ) : null}

      {error ? (
        <p className="form-error organization-action-error">{error}</p>
      ) : null}
    </div>
  );
}
