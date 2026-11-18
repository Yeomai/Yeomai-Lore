import {
  CompleteResetForm,
  RequestResetForm,
} from "../../components/ResetPasswordForms";
import { getI18n } from "../../i18n/server";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const tokenValue = (await searchParams).token;
  const token = Array.isArray(tokenValue) ? tokenValue[0] : tokenValue;
  const { messages } = await getI18n();
  const m = messages.resetPassword;
  return (
    <section className="auth-card">
      <p className="eyebrow">{m.eyebrow}</p>
      <h1>{token ? m.chooseTitle : m.resetTitle}</h1>
      {token ? <CompleteResetForm token={token} /> : <RequestResetForm />}
    </section>
  );
}
