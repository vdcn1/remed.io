import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "remed.io — check two remedies together",
  description: "Check whether two medicines, supplements, or remedies interact.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
