import { assetPath } from "./assetPath.mjs";

export const DOWNLOAD_URL = "https://github.com/MUZI-LYY/shixu/releases/latest";
export const GITHUB_URL = "https://github.com/MUZI-LYY/shixu";

export type MediaKind = "image" | "video";

export type MediaItem = {
  id: string;
  src: string;
  fallbackSrc: string;
  kind: MediaKind;
  alt: string;
};

export type TabItem = {
  id: "todo" | "clipboard" | "notes" | "links" | "recordings" | "credentials";
  eyebrow: string;
  title: string;
  description: string;
  capture: string;
  capturePoster: string;
  captureKind: MediaKind;
  accent: string;
};

export const NAV_ITEMS = [
  ["GITHUB", GITHUB_URL],
  ["FEATURES", "#features"],
  ["TABS", "#tabs"],
] as const;

export const MARQUEE_ITEMS: MediaItem[] = [
  { id: "todo", src: assetPath("/product-captures/todo.webp"), fallbackSrc: "", kind: "image", alt: "上游 TO-DO Panel 界面参考 · 待办完整面板" },
  { id: "clipboard", src: assetPath("/product-captures/clipboard.webp"), fallbackSrc: "", kind: "image", alt: "上游 TO-DO Panel 界面参考 · 剪贴完整面板" },
  { id: "notes", src: assetPath("/product-captures/notes.webp"), fallbackSrc: "", kind: "image", alt: "上游 TO-DO Panel 界面参考 · 笔记完整面板" },
  { id: "links", src: assetPath("/product-captures/links.webp"), fallbackSrc: "", kind: "image", alt: "上游 TO-DO Panel 界面参考 · 链接完整面板" },
  { id: "recordings", src: assetPath("/product-captures/recordings.webp"), fallbackSrc: "", kind: "image", alt: "上游 TO-DO Panel 界面参考 · 录制完整面板" },
  { id: "credentials", src: assetPath("/product-captures/credentials.webp"), fallbackSrc: "", kind: "image", alt: "上游 TO-DO Panel 界面参考 · 密钥完整面板" },
];

export const CAPABILITIES = [
  ["01", "贴顶待命", "需要时展开，用完即收起。"],
  ["02", "语音待办", "按住说话，松开生成预览，确认后保存。"],
  ["03", "待整理", "临时想法与会议结果，先记下再整理。"],
  ["04", "本地录音", "主动开启，可选实时转写。"],
  ["05", "会议与日程", "整理会议行动项，确认后安排到 Mac 日历。"],
  ["06", "本地工作区", "资料保存在本机；转写与模型功能按配置使用云服务。"],
] as const;

export const TAB_ITEMS: TabItem[] = [
  { id: "todo", eyebrow: "PLAN THE DAY", title: "待办", description: "四个可改名工作流，按截止时间排序，并在到期前一小时提醒。", capture: assetPath("/tab-captures/todo.mp4"), capturePoster: assetPath("/product-captures/todo.webp"), captureKind: "video", accent: "red" },
  { id: "clipboard", eyebrow: "CAPTURE FAST", title: "剪贴", description: "按需启用的本机剪贴历史，支持文本、图片、收藏与快速复制。", capture: assetPath("/tab-captures/clipboard.mp4"), capturePoster: assetPath("/product-captures/clipboard.webp"), captureKind: "video", accent: "amber" },
  { id: "notes", eyebrow: "THINK IN TEXT", title: "笔记", description: "首页随手写，保存后进入资料库继续编辑、搜索与重命名。", capture: assetPath("/tab-captures/notes.mp4"), capturePoster: assetPath("/product-captures/notes.webp"), captureKind: "video", accent: "green" },
  { id: "links", eyebrow: "SAVE THE WEB", title: "链接", description: "粘贴公开网址，自动补全标题、图标和分组。", capture: assetPath("/tab-captures/links.mp4"), capturePoster: assetPath("/product-captures/links.webp"), captureKind: "video", accent: "blue" },
  { id: "recordings", eyebrow: "RECORD THE MOMENT", title: "录制", description: "主动点击才启用麦克风，本地保存并可选实时转写。", capture: assetPath("/tab-captures/recordings.mp4"), capturePoster: assetPath("/product-captures/recordings.webp"), captureKind: "video", accent: "rose" },
  { id: "credentials", eyebrow: "KEEP IT SAFE", title: "密钥", description: "账号、密码与 API Key 由系统安全存储加密。", capture: assetPath("/tab-captures/credentials.mp4"), capturePoster: assetPath("/product-captures/credentials.webp"), captureKind: "video", accent: "violet" },
];
