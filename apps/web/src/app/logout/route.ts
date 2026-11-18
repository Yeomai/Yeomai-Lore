import { redirect } from "next/navigation";
import { cookies } from "next/headers";

export async function POST() {
  const cookieStore = await cookies();
  const apiInternalUrl =
    process.env.API_INTERNAL_URL ?? "http://localhost:4000";
  await fetch(`${apiInternalUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: {
      cookie: cookieStore.toString(),
    },
  });
  cookieStore.delete("lore_portal_session");
  redirect("/login");
}
