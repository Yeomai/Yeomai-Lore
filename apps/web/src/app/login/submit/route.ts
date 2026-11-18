import { safeLoginRedirect } from "../../../lib/login-redirect";

const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://localhost:4000";

export async function POST(request: Request) {
  const form = await request.formData();
  const nextPath = safeLoginRedirect(
    form.get("next")?.toString(),
  );
  const response = await fetch(`${apiInternalUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      identifier: form.get("identifier"),
      password: form.get("password"),
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const query = new URLSearchParams({ loginError: "1" });
    if (nextPath !== "/dashboard") query.set("next", nextPath);
    return redirectTo(`/login?${query.toString()}`);
  }

  const cookie = response.headers.get("set-cookie");
  return redirectTo(nextPath, cookie);
}

function redirectTo(location: string, cookie?: string | null): Response {
  const headers = new Headers({ location });
  if (cookie) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}
