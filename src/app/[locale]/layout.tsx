import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { isLocale, locales, routing } from "../../i18n/routing";
import { Fraunces, IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";
import "../globals.css";
import { PwaShell } from "../../components/PwaShell";
import { StoreHydrator } from "../../components/StoreHydrator";
import { BackendDataProvider } from "../../lib/context/BackendDataContext";
import { SessionBanner } from "../../components/SessionBanner";
import { Toaster } from "../../components/toast/Toaster";
import { ContractErrorOverlay } from "../../components/ContractErrorOverlay";
import { QueryProvider } from "../../components/QueryProvider";
import { SpotFeedProvider } from "../../lib/context/SpotFeedContext";
import { NetworkMismatchBanner } from "../../components/NetworkMismatchBanner";
import { SorobanEventBridge } from "../../components/SorobanEventBridge";
import { CommandLayer } from "../../components/command/CommandLayer";
import { TransactionTracker } from "../../components/TransactionTracker";
import { THEME_INIT_SCRIPT } from "../../lib/theme";

const fraunces = Fraunces({
  subsets: ["latin"], weight: ["400","500","600","700"],
  variable: "--font-fraunces", display: "swap",
});
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"], weight: ["400","500","600","700"],
  variable: "--font-plex-sans", display: "swap",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"], weight: ["400","500","600","700"],
  variable: "--font-jetbrains-mono", display: "swap",
});

type LayoutParams = { params: Promise<{ locale: string }> };

const localePath = (locale: string) => (locale === routing.defaultLocale ? "/" : `/${locale}`);

export async function generateMetadata({ params }: LayoutParams): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "metadata" });
  return {
    title: t("title"),
    description: t("description"),
    manifest: "/manifest.webmanifest",
    keywords: ["options", "calls", "puts", "derivatives", "stellar", "soroban", "defi", "black-scholes"],
    // hreflang for the locale roots. Every page also gets per-URL
    // `Link: <…>; rel="alternate"; hreflang=…` headers from the next-intl
    // middleware (routing.alternateLinks).
    alternates: {
      canonical: localePath(locale),
      languages: {
        ...Object.fromEntries(locales.map((l) => [l, localePath(l)])),
        "x-default": "/",
      },
    },
    openGraph: { locale },
  };
}

// viewportFit: "cover" is what makes env(safe-area-inset-*) non-zero on iOS —
// required for the bottom sheet / bottom status bar to clear the home
// indicator. Pinch-zoom is deliberately left enabled (accessibility).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#14130F",
};

export default async function LocaleLayout({ children, params }: { children: React.ReactNode } & LayoutParams) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  setRequestLocale(locale);
  // All namespaces go to the client provider for now. Per-route splitting
  // (pick() per layout) is noted as a follow-up in docs/i18n.md.
  const messages = await getMessages();

  // Per-request CSP nonce from src/middleware.ts (#117). Next applies it to
  // its own scripts automatically. Pass `nonce` to any <Script> added here.
  // Reading headers() is what opts every page into dynamic rendering, which
  // a nonce needs: a prerendered page would carry a stale nonce and its
  // scripts would be blocked (see docs/security-headers.md).
  const nonce = (await headers()).get("x-nonce");
  if (!nonce && process.env.NODE_ENV === "production") {
    console.warn("[csp] no x-nonce request header — is src/middleware.ts running for this route?");
  }

  return (
    // suppressHydrationWarning: the theme script below sets data-theme on <html>
    // before React hydrates, so the attribute differs from the server markup.
    <html lang={locale} className={`${fraunces.variable} ${plexSans.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <body>
        <script nonce={nonce ?? undefined} dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
          <StoreHydrator />
          <Toaster />
          <SessionBanner />
          <ContractErrorOverlay />
          <QueryProvider>
            <SpotFeedProvider>
              <BackendDataProvider>
                <NetworkMismatchBanner />
                <SorobanEventBridge>
                  <CommandLayer>{children}</CommandLayer>
                </SorobanEventBridge>
              </BackendDataProvider>
              <PwaShell />
            </SpotFeedProvider>
          </QueryProvider>
          <TransactionTracker />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
