import type { Metadata, Viewport } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-mono",
  display: "swap",
});

const description =
  "S+ is an open-source, local-first code reviewer. A deterministic Rust engine your coding agent (Claude Code, Codex, OpenCode) calls over MCP — it reviews only new lines, proves every finding, maps the blast radius across files, and learns the noise you dismiss. Nothing leaves your machine.";

export const metadata: Metadata = {
  metadataBase: new URL("https://splus.sh"),
  title: "S+ — precision-first, local code review",
  description,
  icons: { icon: "/favicon.svg" },
  openGraph: {
    type: "website",
    url: "https://splus.sh",
    title: "S+ — only the comments worth reading",
    description,
    images: ["/og.svg"],
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = { themeColor: "#0a0a0a" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`js ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
