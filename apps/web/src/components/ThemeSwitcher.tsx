"use client";

import { useEffect, useState } from "react";
import { useI18n } from "../i18n/client";

type Theme = "light" | "dark";

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<Theme>("light");
  const { messages } = useI18n();
  const m = messages.common;

  useEffect(() => {
    setTheme(
      document.documentElement.dataset.theme === "dark" ? "dark" : "light",
    );
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("lore-portal-theme", next);
    } catch {
      // Theme still applies for the current page when storage is unavailable.
    }
    setTheme(next);
  }

  const label = theme === "dark" ? m.themeLight : m.themeDark;
  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
    >
      <img src="/theme.png" alt="" aria-hidden="true" />
    </button>
  );
}
