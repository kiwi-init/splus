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
  "splus drops a deterministic, local code-review engine into the coding agent you already run — Claude Code, Codex, OpenCode. It reads your diff, proves what's broken, and hands back only what's worth fixing. Open source (MIT), runs on your machine, no new subscription. A Kiwi Init tool.";

export const metadata: Metadata = {
  metadataBase: new URL("https://splus.sh"),
  title: "splus — juice your coding agent",
  description,
  icons: { icon: "/favicon.svg" },
  openGraph: {
    type: "website",
    url: "https://splus.sh",
    title: "splus — don't pay for another agent",
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
