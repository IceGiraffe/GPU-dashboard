import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GPU Cluster Dashboard",
  description: "Track current GPU usage and collect self-reported workloads.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
