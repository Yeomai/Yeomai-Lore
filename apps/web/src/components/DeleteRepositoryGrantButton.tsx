"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { formatMessage, localizeApiError } from "../i18n/messages";

export function DeleteRepositoryGrantButton({
  basePath,
  subjectType,
  subjectId,
  subjectName,
}: {
  basePath: string;
  subjectType: "user" | "team";
  subjectId: string;
  subjectName: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const { messages } = useI18n();
  const m = messages.grantForm;

  async function remove() {
    if (
      !window.confirm(
        formatMessage(m.revokeConfirmation, { name: subjectName }),
      )
    ) {
      return;
    }
    setPending(true);
    try {
      await clientApi(`${basePath}/grants`, {
        method: "DELETE",
        body: JSON.stringify({ subjectType, subjectId }),
      });
      router.refresh();
    } catch (error) {
      window.alert(localizeApiError(error, messages));
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      className="button small danger"
      type="button"
      disabled={pending}
      onClick={() => void remove()}
    >
      {pending ? m.revoking : m.revoke}
    </button>
  );
}
