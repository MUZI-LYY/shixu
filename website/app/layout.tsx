import type { Metadata, Viewport } from "next";
import "./globals.css";
import { assetPath } from "./assetPath.mjs";

const title = "拾序 — Mac 个人事务工作台";
const description = "面向 Mac Apple Silicon 的个人工作台，支持语音待办、待整理、会议整理、每日安排和确认后写入日历。";

export const metadata: Metadata = {
  metadataBase: new URL("https://muzi-lyy.github.io/shixu/"),
  title,
  description,
  applicationName: "拾序",
  keywords: ["拾序", "macOS 刘海", "Mac 待办", "本地工作台", "Apple Silicon"],
  icons: { icon: [{ url: assetPath("/favicon.png"), type: "image/png" }], shortcut: assetPath("/favicon.png"), apple: assetPath("/favicon.png") },
  openGraph: {
    type: "website",
    locale: "zh_CN",
    siteName: "拾序",
    title,
    description,
    images: [{ url: assetPath("/favicon.png"), width: 1024, height: 1024, alt: "拾序深色发光图标" }],
  },
  twitter: { card: "summary", title, description, images: [assetPath("/favicon.png")] },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "dark", themeColor: "#000000" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
