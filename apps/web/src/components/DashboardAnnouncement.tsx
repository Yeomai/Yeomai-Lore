"use client";

import { useEffect, useState } from "react";

const DISPLAY_MS = 3_000;

export function DashboardAnnouncement({
  announcement,
}: {
  announcement: string;
}) {
  const text = announcement.trim();
  const [visible, setVisible] = useState(Boolean(text));

  useEffect(() => {
    setVisible(Boolean(text));
    if (!text) return;
    const timeout = window.setTimeout(() => setVisible(false), DISPLAY_MS);
    return () => window.clearTimeout(timeout);
  }, [text]);

  if (!text || !visible) return null;

  return (
    <section
      className="dashboard-announcement"
      role="status"
      aria-live="polite"
    >
      {text}
    </section>
  );
}
