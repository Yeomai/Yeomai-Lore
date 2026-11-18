import type { Metadata } from "next";
import Link from "next/link";
import { getSession, serverApi } from "../lib/api";
import { getI18n } from "../i18n/server";
import { I18nProvider } from "../i18n/client";
import { LocaleSwitcher } from "../components/LocaleSwitcher";
import { AutoCloseDropdowns } from "../components/AutoCloseDropdowns";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { UserMenu } from "../components/UserMenu";
import { LoginNavLink } from "../components/LoginNavLink";
import versionInfo from "../../version.json";
import "./globals.css";
import "./scrollbars.css";

export async function generateMetadata(): Promise<Metadata> {
  const siteName = await serverApi<{ siteName: string }>("/api/v1/meta")
    .then((meta) => meta.siteName)
    .catch(() => "Yeomai Lore");
  return {
    title: {
      default: siteName,
      template: `%s · ${siteName}`,
    },
    description: "Self-hosted web portal for Lore repositories",
    icons: {
      icon: [{ url: "/logo.jpg", type: "image/jpeg" }],
      shortcut: "/logo.jpg",
      apple: "/logo.jpg",
    },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await getSession().catch(() => null);
  const meta = await serverApi<{ siteName: string; loreVersion: string }>(
    "/api/v1/meta",
  ).catch(() => ({
    siteName: "Yeomai Lore",
    loreVersion: process.env.LORE_VERSION ?? "0.14.0",
  }));
  const { locale, messages } = await getI18n();
  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{document.documentElement.dataset.theme=localStorage.getItem('lore-portal-theme')==='dark'?'dark':'light'}catch{document.documentElement.dataset.theme='light'}",
          }}
        />
      </head>
      <body>
        <I18nProvider locale={locale}>
          <AutoCloseDropdowns />
          <header className="topbar">
            <div className="brand-group">
              <Link className="brand" href={user ? "/dashboard" : "/login"}>
                <img
                  className="brand-mark"
                  src="/logo.jpg"
                  alt=""
                  aria-hidden="true"
                />
                <span>{meta.siteName}</span>
              </Link>
              <span
                className="brand-version"
                title={messages.layout.supportedLoreVersion}
              >
                lore {meta.loreVersion}
              </span>
            </div>
            <nav>
              <span className="internal-version">
                {messages.layout.internalVersion
                  .replace("{version}", versionInfo.version)
                  .replace("{build}", String(versionInfo.internalBuild))
                  .replace("{time}", versionInfo.builtAt)}
              </span>
              {user ? (
                <>
                  <Link href="/dashboard">{messages.common.repositories}</Link>
                  <Link href="/admin">{messages.common.management}</Link>
                </>
              ) : (
                <LoginNavLink label={messages.common.signIn} />
              )}
              <LocaleSwitcher />
              <ThemeSwitcher />
              {user ? (
                <UserMenu
                  displayName={user.displayName}
                  email={user.email}
                />
              ) : null}
            </nav>
          </header>
          <main className="shell">{children}</main>
          <footer className="footer">
            {messages.layout.description} ·{" "}
            <a href="https://github.com/EpicGames/lore">EpicGames/lore</a>
          </footer>
        </I18nProvider>
      </body>
    </html>
  );
}
