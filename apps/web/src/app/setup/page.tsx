import { redirect } from "next/navigation";
import { getSetupStatus } from "../../lib/api";
import { SetupForm } from "../../components/SetupForm";

export default async function SetupPage() {
  const status = await getSetupStatus();
  if (!status.required || !status.defaults) {
    redirect("/login");
  }
  return (
    <section className="auth-card setup-card">
      <SetupForm defaults={status.defaults} />
    </section>
  );
}
