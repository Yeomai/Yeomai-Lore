import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession, getSetupStatus, serverApi } from "../../lib/api";
import { getI18n } from "../../i18n/server";
import { LoginForm } from "../../components/LoginForm";
import { safeLoginRedirect } from "../../lib/login-redirect";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    passwordChanged?: string | string[];
    loginError?: string | string[];
    accountDeleted?: string | string[];
    next?: string | string[];
  }>;
}) {
  const query = await searchParams;
  const nextPath = safeLoginRedirect(query.next);
  if ((await getSetupStatus()).required) {
    redirect("/setup");
  }
  if (await getSession()) {
    redirect(nextPath);
  }
  const { messages } = await getI18n();
  const m = messages.login;
  const meta = await serverApi<{ userRegistrationEnabled: boolean }>(
    "/api/v1/meta",
  );
  const changed = query.passwordChanged;
  const passwordChanged = Array.isArray(changed)
    ? changed[0] === "1"
    : changed === "1";
  const failed = query.loginError;
  const loginFailed = Array.isArray(failed)
    ? failed[0] === "1"
    : failed === "1";
  const deleted = query.accountDeleted;
  const accountDeleted = Array.isArray(deleted)
    ? deleted[0] === "1"
    : deleted === "1";
  return (
    <div className="login-page">
      <section className="auth-card">
        <h1 className="login-card-title">{m.title}</h1>
        {passwordChanged ? (
          <p className="notice">{m.passwordChanged}</p>
        ) : null}
        {accountDeleted ? <p className="notice">{m.accountDeleted}</p> : null}
        {loginFailed ? (
          <p className="form-error" role="alert">
            {messages.apiErrors.invalidCredentials}
          </p>
        ) : null}
        <LoginForm nextPath={nextPath} />
        <div className="auth-links">
          {meta.userRegistrationEnabled ? (
            <Link href="/register">{m.register}</Link>
          ) : null}
          <Link href="/reset-password">{m.forgotPassword}</Link>
        </div>
      </section>
    </div>
  );
}
