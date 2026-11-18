"use client";

import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "../i18n/client";
import {
  localeNames,
  supportedLocales,
  type Locale,
} from "../i18n/messages";

export function LocaleSwitcher() {
  const router = useRouter();
  const { locale, messages } = useI18n();
  const [pending, startTransition] = useTransition();
  const detailsRef = useRef<HTMLDetailsElement>(null);

  function selectLocale(nextLocale: Locale) {
    detailsRef.current?.removeAttribute("open");
    if (nextLocale === locale) return;
    document.cookie = `locale=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
    startTransition(() => router.refresh());
  }

  return (
    <div className={`locale-switcher ${pending ? "pending" : ""}`}>
      <details className="locale-dropdown" data-dropdown ref={detailsRef}>
        <summary aria-label={messages.common.language}>
          <LocaleFlag locale={locale} />
          <span className="locale-current-text">{localeNames[locale]}</span>
          <ChevronIcon />
        </summary>
        <div
          className="locale-menu"
          role="listbox"
          aria-label={messages.common.language}
        >
          {supportedLocales.map((value) => (
            <button
              className={`locale-option ${
                value === locale ? "active" : ""
              }`}
              type="button"
              role="option"
              aria-selected={value === locale}
              key={value}
              onClick={() => selectLocale(value)}
            >
              <LocaleFlag locale={value} />
              <span>{localeNames[value]}</span>
              {value === locale ? <CheckIcon /> : null}
            </button>
          ))}
        </div>
      </details>
    </div>
  );
}

function LocaleFlag({ locale }: { locale: Locale }) {
  if (locale === "zh-CN") {
    return (
      <svg className="locale-flag" viewBox="0 0 24 16" aria-hidden="true">
        <rect width="24" height="16" rx="2" fill="#de2910" />
        <path
          d="m5 3 0.7 1.5 1.7 0.2-1.2 1.2 0.3 1.7-1.5-0.8-1.5 0.8 0.3-1.7-1.2-1.2 1.7-0.2z"
          fill="#ffde00"
        />
      </svg>
    );
  }
  return (
    <svg className="locale-flag" viewBox="0 0 24 16" aria-hidden="true">
      <rect width="24" height="16" rx="2" fill="#fff" />
      {[0, 2, 4, 6, 8, 10, 12].map((y) => (
        <rect key={y} y={y} width="24" height="1.2" fill="#b22234" />
      ))}
      <rect width="10" height="8.4" fill="#3c3b6e" />
      <path
        d="M1 1.5h1M4 1.5h1M7 1.5h1M2.5 3.2h1M5.5 3.2h1M1 4.9h1M4 4.9h1M7 4.9h1M2.5 6.6h1M5.5 6.6h1"
        stroke="#fff"
        strokeWidth="0.7"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="locale-chevron" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="locale-check" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3 8.5 3 3 7-7" />
    </svg>
  );
}
