"use client";

import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from "react";
import { useI18n } from "../i18n/client";
import { DeleteRepositoryForm } from "./DeleteRepositoryForm";
import { DeleteRepositoryGrantButton } from "./DeleteRepositoryGrantButton";
import { GrantAccessForm } from "./GrantAccessForm";

interface RepositoryGrant {
  subjectType: "user" | "team";
  subjectId: string;
  subjectName: string;
  permission: "read" | "write" | "admin";
}

export function RepositoryGrantsDialog({
  basePath,
  grants,
  currentUserId,
  ownerUserId,
}: {
  basePath: string;
  grants: RepositoryGrant[];
  currentUserId: string;
  ownerUserId: string | null;
}) {
  const { messages } = useI18n();
  const m = messages.repository;
  return (
    <RiskDialog
      title={m.grants}
      triggerClassName="button small"
      triggerLabel={m.grants}
    >
      <div className="simple-list">
        {grants.length === 0 ? (
          <p className="muted">{messages.admin.noGrants}</p>
        ) : (
          grants.map((grant) => (
            <div
              className="simple-row"
              key={`${grant.subjectType}:${grant.subjectId}`}
            >
              <div>
                <strong>{grant.subjectName}</strong>
                <small>
                  {grant.subjectType === "user"
                    ? messages.common.userSubject
                    : messages.common.teamSubject}
                </small>
              </div>
              <div className="simple-row-actions">
                <span className="badge">
                  {messages.grantForm[grant.permission]}
                </span>
                {grant.subjectType !== "user" ||
                (grant.subjectId !== currentUserId &&
                  grant.subjectId !== ownerUserId) ? (
                  <DeleteRepositoryGrantButton
                    basePath={basePath}
                    subjectType={grant.subjectType}
                    subjectId={grant.subjectId}
                    subjectName={grant.subjectName}
                  />
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
      <GrantAccessForm basePath={basePath} />
    </RiskDialog>
  );
}

export function DeleteRepositoryDialog({
  basePath,
  repositoryName,
  redirectTo,
}: {
  basePath: string;
  repositoryName: string;
  redirectTo: string;
}) {
  const { messages } = useI18n();
  const m = messages.repository;
  return (
    <RiskDialog
      title={m.deleteTitle}
      triggerClassName="button small danger"
      triggerLabel={m.deleteButton}
      danger
    >
      <p className="muted">{m.deleteDescription}</p>
      <DeleteRepositoryForm
        basePath={basePath}
        repositoryName={repositoryName}
        redirectTo={redirectTo}
      />
    </RiskDialog>
  );
}

function RiskDialog({
  title,
  triggerLabel,
  triggerClassName,
  description,
  danger = false,
  children,
}: {
  title: string;
  triggerLabel: string;
  triggerClassName: string;
  description?: string;
  danger?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { messages } = useI18n();

  useEffect(
    () => () => document.body.classList.remove("modal-open"),
    [],
  );

  function open() {
    document.body.classList.add("modal-open");
    dialogRef.current?.showModal();
  }

  function close() {
    dialogRef.current?.close();
    document.body.classList.remove("modal-open");
  }

  return (
    <>
      <button
        className={triggerClassName}
        type="button"
        onClick={open}
        aria-haspopup="dialog"
      >
        {triggerLabel}
      </button>
      <dialog
        ref={dialogRef}
        className={`risk-dialog ${danger ? "danger-dialog" : ""}`}
        aria-labelledby={titleId}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
        onClose={() => document.body.classList.remove("modal-open")}
      >
        <div className="risk-dialog-content">
          <div className="risk-dialog-heading">
            <div>
              <p className="eyebrow">
                {danger ? messages.repository.deleteEyebrow : messages.repository.grants}
              </p>
              <h2 id={titleId}>{title}</h2>
              {description ? <p className="muted">{description}</p> : null}
            </div>
            <button
              className="dialog-close"
              type="button"
              onClick={close}
              aria-label={messages.common.close}
            >
              ×
            </button>
          </div>
          {children}
        </div>
      </dialog>
    </>
  );
}
