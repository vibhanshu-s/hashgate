import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { HASHGATE, REPO_URL } from "@/lib/config";
import { Logo } from "@/components/Logo";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono-jb" });

export const metadata: Metadata = {
  title: "Hashgate — post-quantum session keys for AI payment agents",
  description:
    "Give an AI agent a tUSD8 budget on QDay Aevum, authorised by hash-based one-time signatures instead of ECDSA. Caps, expiry, payee allowlists and instant revoke, enforced on-chain.",
};
export const viewport: Viewport = { themeColor: "#0a0c0f", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="min-h-screen font-sans">
        <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur">
          <nav className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight" aria-label="Hashgate home">
              <Logo /> <span>Hashgate</span>
            </Link>
            <div className="flex items-center gap-1 text-sm sm:gap-2">
              <Link href="/console" className="rounded-lg px-2.5 py-1.5 text-mute hover:text-ink">Console</Link>
              <Link href="/activity" className="rounded-lg px-2.5 py-1.5 text-mute hover:text-ink">Activity</Link>
              <a href={REPO_URL} className="hidden rounded-lg px-2.5 py-1.5 text-mute hover:text-ink sm:inline" target="_blank" rel="noreferrer">GitHub</a>
              <span className="chip ml-1 hidden md:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-mint" /> Aevum testnet</span>
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 pb-20">{children}</main>
        <footer className="border-t border-line py-8 text-xs text-dim">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 sm:flex-row sm:justify-between">
            <span>Testnet only. Test tokens, no real value. MIT licensed.</span>
            <span className="mono break-all">Hashgate {HASHGATE}</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
