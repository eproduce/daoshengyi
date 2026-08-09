const sharp = require("sharp");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ICONS_DIR = path.join(ROOT, "src-tauri", "icons");

// 道生一：点上横下，意境图标
async function generateIcon(size, filename) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0f0f1a"/>
        <stop offset="100%" stop-color="#1a1a30"/>
      </linearGradient>
    </defs>
    <rect width="64" height="64" rx="14" fill="url(#bg)"/>
    <!-- 点 — 道 -->
    <circle cx="32" cy="18" r="3.5" fill="#f0f0ff" opacity="0.9"/>
    <!-- 一 — 生一 -->
    <rect x="16" y="34" width="32" height="5" rx="2.5" fill="#f0f0ff" opacity="0.85"/>
  </svg>`;

  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path.join(ICONS_DIR, filename));
  console.log(`  ${filename} (${size}x${size})`);
}

async function main() {
  console.log("生成道生一图标...\n");

  // 主图标
  await generateIcon(64, "64x64.png");
  await generateIcon(32, "32x32.png");
  await generateIcon(128, "128x128.png");
  await generateIcon(256, "128x128@2x.png");
  await generateIcon(256, "icon.png");

  // Windows 磁贴
  await generateIcon(30, "Square30x30Logo.png");
  await generateIcon(44, "Square44x44Logo.png");
  await generateIcon(71, "Square71x71Logo.png");
  await generateIcon(107, "Square107x107Logo.png");
  await generateIcon(150, "Square150x150Logo.png");
  await generateIcon(284, "Square284x284Logo.png");
  await generateIcon(50, "StoreLogo.png");

  console.log("\n生成 .icns (macOS app icon)...");
  const { execSync } = require("child_process");
  const iconset = path.join(ICONS_DIR, "icon.iconset");
  execSync(`rm -rf "${iconset}" && mkdir -p "${iconset}"`);

  const macSizes = [16, 32, 64, 128, 256, 512];
  for (const s of macSizes) {
    const s2x = s * 2;
    await generateIcon(s, `icon.iconset/icon_${s}x${s}.png`);
    await generateIcon(s * 2, `icon.iconset/icon_${s}x${s}@2x.png`);
    console.log(`  icon_${s}x${s}.png / @2x`);
  }

  execSync(`iconutil -c icns "${iconset}" -o "${path.join(ICONS_DIR, "icon.icns")}"`);
  execSync(`rm -rf "${iconset}"`);
  console.log("  icon.icns ✅");

  console.log("\n全部完成！");
}

main().catch(e => { console.error(e); process.exit(1); });
