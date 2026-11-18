"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function LoginNavLink({ label }: { label: string }) {
  const pathname = usePathname();
  if (pathname === "/login" || pathname === "/register") return null;
  return <Link href="/login">{label}</Link>;
}
