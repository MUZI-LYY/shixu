#!/bin/bash
# Package the approved PNG into native macOS sizes; no image content changes.
set -euo pipefail
root_dir="$(cd "$(dirname "$0")/.." && pwd)"
icon_dir="$(mktemp -d "${TMPDIR:-/tmp}/shixu-icons.XXXXXX")"
trap 'rm -rf "$icon_dir"' EXIT
mkdir "$icon_dir/Shixu.iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$root_dir/build/shixu-icon.png" --out "$icon_dir/Shixu.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$root_dir/build/shixu-icon.png" --out "$icon_dir/Shixu.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$icon_dir/Shixu.iconset" -o "$root_dir/build/shixu-icon.icns"
