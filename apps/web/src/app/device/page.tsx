import { getSession } from "../../lib/api";
import { getI18n } from "../../i18n/server";
import { DeviceApproval } from "../../components/DeviceApproval";

export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string | string[] }>;
}) {
  const value = (await searchParams).user_code;
  const userCode = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  const nextPath = `/device?user_code=${encodeURIComponent(userCode)}`;
  const sessionUser = await getSession();
  const { messages } = await getI18n();
  const m = messages.device;
  return (
    <section className="auth-card device-card">
      <p className="eyebrow">{m.eyebrow}</p>
      <h1>{m.title}</h1>
      <DeviceApproval
        initialCode={userCode}
        initialApprover={
          sessionUser
            ? {
                displayName: sessionUser.displayName,
                email: sessionUser.email,
                username: sessionUser.username,
              }
            : null
        }
        loginNext={nextPath}
      />
    </section>
  );
}
