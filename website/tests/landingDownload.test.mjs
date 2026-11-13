import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

const moduleUrl = new URL("../app/landingDownload.mjs", import.meta.url);

test("latest release selection returns the installable Apple Silicon DMG", async () => {
  assert.ok(existsSync(moduleUrl), "landingDownload.mjs must resolve the current installable asset");
  const { selectMacDownloadUrl } = await import(moduleUrl.href);
  const release = {
    tag_name: "v1.0.4",
    assets: [
      {
        name: "Shixu-1.0.2-arm64.dmg.sha256",
        content_type: "application/octet-stream",
        state: "uploaded",
        browser_download_url: "https://example.com/checksum",
      },
      {
        name: "Shixu-1.0.2-arm64.dmg",
        content_type: "application/x-apple-diskimage",
        state: "uploaded",
        browser_download_url: "https://example.com/Shixu-1.0.2-arm64.dmg",
      },
      {
        name: "Shixu-1.0.4-arm64.dmg",
        content_type: "application/x-apple-diskimage",
        state: "uploaded",
        browser_download_url: "https://example.com/Shixu-1.0.4-arm64.dmg",
      },
    ],
  };

  assert.equal(selectMacDownloadUrl(release), "https://example.com/Shixu-1.0.4-arm64.dmg");
});

test("latest release selection safely falls back when no DMG is published", async () => {
  const { selectMacDownloadUrl } = await import(moduleUrl.href);
  assert.equal(selectMacDownloadUrl({ assets: [] }), null);
  assert.equal(selectMacDownloadUrl(null), null);
});

test("download never selects another version or upstream installer", async () => {
  const { selectMacDownloadUrl, LATEST_RELEASE_API_URL } = await import(moduleUrl.href);
  assert.equal(LATEST_RELEASE_API_URL, "https://api.github.com/repos/MUZI-LYY/shixu/releases/latest");
  const assets = ["Shixu-0.2.0-arm64.dmg", "TO-DO-Panel-0.2.1-arm64.dmg"].map(name => ({name, state:"uploaded", browser_download_url:`https://example.com/${name}`}));
  assert.equal(selectMacDownloadUrl({tag_name:"v0.2.1", assets}), null);
});
