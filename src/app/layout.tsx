import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tidemark — a watchlist that measures change in sigmas, not percents",
  description:
    "A market watchlist that tells you what meaningfully changed since you last looked, and stays quiet when nothing did.",
  applicationName: "Tidemark",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // One committed look, so one theme colour.
  themeColor: "#0a0c0d",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
