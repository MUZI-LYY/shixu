# 拾序网站源码

基于 TO-DO Panel 网站改造，沿用原设计和 MIT 归属。本期只维护源码，不自动部署 GitHub Pages；`.github/workflows/pages.yml` 仅支持手动触发。

- 下载入口：[拾序 GitHub Releases](https://github.com/MUZI-LYY/shixu/releases/latest)
- 当前安装包：Mac Apple Silicon 试用版，无 Windows 安装包下载入口。
- 网站图标已替换为确认的拾序深色发光 Logo。
- 现有产品截图与录屏来自上游界面，页面已标注为参考，不代表当前拾序的完整功能或测试结果。
- 当前实际能力与限制以根目录 README 和 Release 说明为准。
- Node.js 22.13.0+。

```bash
npm ci
npm test
npm run lint
npm run build
npm run dev
```

页面内容位于 `app/`，公开素材位于 `public/`。下载按钮读取本仓库的 latest Release，只选择与版本标签匹配的 `Shixu-<version>-arm64.dmg`；找不到时进入 Release 页面，不下载上游或其他版本文件。
