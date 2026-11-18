import { AcceptInviteForm } from "../../components/AcceptInviteForm";
import { getI18n } from "../../i18n/server";
import { serverApi } from "../../lib/api";

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const tokenValue = (await searchParams).token;
  const token = Array.isArray(tokenValue) ? tokenValue[0] : tokenValue;
  const { messages } = await getI18n();
  const m = messages.acceptInvite;
  let valid = false;
  if (token) {
    try {
      await serverApi(
        `/api/v1/auth/invite?token=${encodeURIComponent(token)}`,
      );
      valid = true;
    } catch {
      valid = false;
    }
  }
  return (
    <section
      className={`auth-card${token && valid ? "" : " invite-invalid-card"}`}
    >
      <h1 className={token && valid ? undefined : "invite-invalid-title"}>
        {token && valid ? m.title : m.invalidTitle}
      </h1>
      {token && valid ? (
        <AcceptInviteForm token={token} />
      ) : (
        <p className="muted">
          {token ? m.invalidToken : m.missingToken}
        </p>
      )}
    </section>
  );
}
