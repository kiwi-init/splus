import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});
const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

const description =
  "S+ is a deterministic-first code reviewer. It reviews only new lines, proves every finding, maps the blast radius across files, and learns the noise your team dismisses. Maximum signal, noise on the floor.";

export const metadata: Metadata = {
  metadataBase: new URL("https://splus.sh"),
  title: "S+ — precision-first code review",
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

export const viewport: Viewport = {
  themeColor: "#070a09",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // `js` enables the reveal-on-scroll hidden state before paint (no flash).
  return (
    <html lang="en" className={`js ${mono.variable} ${sans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
