"use client";

import { useEffect } from "react";
import { useI18n } from "../i18n/client";

export function ServiceStarting() {
  const { messages } = useI18n();
  const m = messages.startup;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function check() {
      try {
        const response = await fetch("/api/v1/ready", {
          cache: "no-store",
        });
        if (response.ok && !cancelled) {
          window.location.replace("/dashboard");
          return;
        }
      } catch {
        // The API may still be starting.
      }
      if (!cancelled) {
        timer = setTimeout(check, 1_000);
      }
    }

    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <section className="auth-card">
      <h1>{m.title}</h1>
      <p className="lede">{m.description}</p>
      <p className="settings-status">{m.waiting}</p>
    </section>
  );
}
