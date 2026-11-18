import { redirect } from "next/navigation";
import { getSession, getSetupStatus } from "../lib/api";

export default async function Home() {
  if ((await getSetupStatus()).required) {
    redirect("/setup");
  }
  redirect((await getSession()) ? "/dashboard" : "/login");
}
