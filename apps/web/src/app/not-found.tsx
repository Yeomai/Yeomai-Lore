import Link from "next/link";
import { getI18n } from "../i18n/server";

export default async function NotFound() {
  const { messages } = await getI18n();
  const m = messages.notFound;
  return (
    <section className="auth-card">
      <p className="eyebrow">404</p>
      <h1>{m.title}</h1>
      <p className="lede">{m.description}</p>
      <Link className="button primary" href="/dashboard">
        {m.back}
      </Link>
    </section>
  );
}
