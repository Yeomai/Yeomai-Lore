"use client";

import { createContext, useContext, type ReactNode } from "react";
import { getMessages, type Locale, type Messages } from "./messages";

const I18nContext = createContext<{
  locale: Locale;
  messages: Messages;
} | null>(null);

export function I18nProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  return (
    <I18nContext.Provider
      value={{ locale, messages: getMessages(locale) }}
    >
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return value;
}
