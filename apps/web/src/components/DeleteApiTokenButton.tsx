"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { clientApi } from "../lib/client-api";
import { useI18n } from "../i18n/client";
import { formatMessage, localizeApiError } from "../i18n/messages";

export function DeleteApiTokenButton({
  tokenId,
  tokenName,
}: {
  tokenId: string;
  tokenName: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const { messages } = useI18n();
  const m = messages.settings;

  async function remove() {
    if (
      !window.confirm(
        formatMessage(m.deleteTokenConfirmation, { name: tokenName }),
      )
    ) {
      return;
    }
    setPending(true);
    try {
      await clientApi(`/api/v1/auth/api-tokens/${tokenId}`, {
        method: "DELETE",
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
      {pending ? m.deletingToken : m.deleteToken}
    </button>
  );
}
