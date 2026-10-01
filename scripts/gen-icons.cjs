const sharp = require("sharp");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ICONS_DIR = path.join(ROOT, "src-tauri", "icons");

// ── macOS 图标网格（Apple HIG）──────────────────────────────────────────────
// 官方网格：1024×1024 画布里，图形本体是 824×824 的圆角方块（占 80.47%），
// 四周留 ~10% 透明边距，圆角半径 185.4（≈ 本体的 22.37%）。
// 不按这个网格画（直接把圆角方块铺满整张画布）→ 图标在 Dock / 启动台 / 访达里
// 会比别的 App 明显「胖一圈」，圆角也显得更方，一眼看出不是原生 App（2026-10-02 修）。
const MAC_BODY = 824 / 1024; // 本体占画布比例
const MAC_RADIUS = 185.4 / 824; // 圆角 / 本体
// 非 macOS（Windows / Linux / 运行时 PNG）沿用原来的满布构图，避免影响那两个平台
const FULL_RADIUS = 14 / 64;

/**
 * 道生一图标：点上横下，意境图标。
 * @param {number} size 边长（像素）
 * @param {string} filename 输出文件名（相对 icons 目录）
 * @param {{macGrid?: boolean}} [opts] macGrid=true 时按 macOS 网格留白
 */
async function generateIcon(size, filename, opts = {}) {
  const { macGrid = false } = opts;
  const body = macGrid ? size * MAC_BODY : size;
  const off = (size - body) / 2;
  const rx = body * (macGrid ? MAC_RADIUS : FULL_RADIUS);

  // 图形本体用 64 单位坐标系描述，再整体缩放到 body（满布时 scale = size/64，与旧构图完全一致）
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0f0f1a"/>
        <stop offset="100%" stop-color="#1a1a30"/>
      </linearGradient>
    </defs>
    <rect x="${off}" y="${off}" width="${body}" height="${body}" rx="${rx.toFixed(3)}" fill="url(#bg)"/>
    <g transform="translate(${off} ${off}) scale(${body / 64})">
      <!-- 点 — 道 -->
      <circle cx="32" cy="18" r="3.5" fill="#f0f0ff" opacity="0.9"/>
      <!-- 一 — 生一 -->
      <rect x="16" y="34" width="32" height="5" rx="2.5" fill="#f0f0ff" opacity="0.85"/>
    </g>
  </svg>`;

  await sharp(Buffer.from(svg)).png().toFile(path.join(ICONS_DIR, filename));
  console.log(`  ${filename} (${size}x${size}${macGrid ? "，macOS 网格" : ""})`);
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

  console.log("\n生成 .icns (macOS app icon，按 macOS 图标网格留白)...");
  const { execSync } = require("child_process");
  const iconset = path.join(ICONS_DIR, "icon.iconset");
  execSync(`rm -rf "${iconset}" && mkdir -p "${iconset}"`);

  // 标准 iconset 槽位：16/32/128/256/512 + 各自 @2x（512@2x = 1024，即 Apple 的母版尺寸）。
  // 旧代码里的 64 不是标准槽位，iconutil 会丢弃 → 去掉，避免生成无用文件。
  const macSizes = [16, 32, 128, 256, 512];
  for (const s of macSizes) {
    await generateIcon(s, `icon.iconset/icon_${s}x${s}.png`, { macGrid: true });
    await generateIcon(s * 2, `icon.iconset/icon_${s}x${s}@2x.png`, { macGrid: true });
    console.log(`  icon_${s}x${s}.png / @2x`);
  }

  execSync(`iconutil -c icns "${iconset}" -o "${path.join(ICONS_DIR, "icon.icns")}"`);
  execSync(`rm -rf "${iconset}"`);
  console.log("  icon.icns ✅");

  // 托盘图标（macOS 菜单栏模板图：纯黑图形 + 透明背景，icon_as_template 让系统
  // 自动适配深/浅色菜单栏——固定白底在深色菜单栏下会变成白块，模板图才是正确做法）
  console.log("\n生成托盘图标（macOS 模板图）...");
  const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <!-- 道（点） -->
    <circle cx="32" cy="20" r="5" fill="#000000"/>
    <!-- 一（横条） -->
    <rect x="13" y="37" width="38" height="6" rx="3" fill="#000000"/>
  </svg>`;
  await sharp(Buffer.from(traySvg))
    .resize(32, 32)
    .png()
    .toFile(path.join(ICONS_DIR, "tray-icon.png"));
  console.log("  tray-icon.png (32x32 模板图) ✅");

  console.log("\n全部完成！");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
