import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession, getSetupStatus, serverApi } from "../../lib/api";
import { getI18n } from "../../i18n/server";
import { RegisterForm } from "../../components/RegisterForm";

export default async function RegisterPage() {
  if ((await getSetupStatus()).required) {
    redirect("/setup");
  }
  if (await getSession()) {
    redirect("/dashboard");
  }
  const { messages } = await getI18n();
  const m = messages.register;
  const meta = await serverApi<{ userRegistrationEnabled: boolean }>(
    "/api/v1/meta",
  );
  if (!meta.userRegistrationEnabled) {
    return (
      <section className="auth-card">
        <p className="eyebrow">{m.eyebrow}</p>
        <h1>{m.disabledTitle}</h1>
        <p className="lede">{m.disabledDescription}</p>
        <div className="auth-links">
          <Link href="/login">{m.signIn}</Link>
        </div>
      </section>
    );
  }
  return (
    <section className="auth-card">
      <p className="eyebrow">{m.eyebrow}</p>
      <h1>{m.title}</h1>
      <p className="lede">{m.description}</p>
      <RegisterForm />
      <div className="auth-links">
        <Link href="/login">{m.signIn}</Link>
      </div>
    </section>
  );
}
