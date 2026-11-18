import { cookies, headers } from "next/headers";
import {
  getMessages,
  supportedLocales,
  type Locale,
} from "./messages";

export const LOCALE_COOKIE = "locale";

export function isLocale(value: string | undefined): value is Locale {
  return supportedLocales.includes(value as Locale);
}

export async function getLocale(): Promise<Locale> {
  const cookieStore = await cookies();
  const selected = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isLocale(selected)) {
    return selected;
  }
  const acceptLanguage = (await headers()).get("accept-language") ?? "";
  return acceptLanguage.toLowerCase().includes("zh") ? "zh-CN" : "en";
}

export async function getI18n() {
  const locale = await getLocale();
  return { locale, messages: getMessages(locale) };
}
