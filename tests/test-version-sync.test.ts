import { it, expect } from "vitest";

// 版本号三处必须一致 —— 这不是洁癖：
// - `package.json` 决定 npm 侧；
// - `tauri.conf.json` 决定 .app / .dmg 的 CFBundleShortVersionString（用户看到的版本）；
// - `Cargo.toml` 决定 `env!("CARGO_PKG_VERSION")`（**设置页里显示的版本**、LSP clientInfo、诊断报告）。
// 实际踩过：发 alpha.6 时只改了前两处，结果信息面板仍报 alpha.5 —— 用户按「已装版本」判断
// 功能有没有生效，报错版本号会直接把排查带偏。所以这里用测试把三处钉在一起。
//
// 用 `import.meta.glob` 读原文而不是 `node:fs`：`tests/tsconfig.json` 是 `types: []`，
// 没有 @types/node，引 `node:fs` 会把 `npm run typecheck:tests` 直接打红。
const FILES = import.meta.glob(
  ["../package.json", "../src-tauri/tauri.conf.json", "../src-tauri/Cargo.toml"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

function raw(rel: string): string {
  const hit = Object.entries(FILES).find(([path]) => path.endsWith(rel));
  // 找不到就大声错：静默跳过 = 测试永远绿，等于没写
  if (!hit) throw new Error(`import.meta.glob 没抓到 ${rel}（文件改名或挪位置了？）`);
  return hit[1];
}

function packageVersion(): string {
  return JSON.parse(raw("package.json")).version as string;
}

function tauriVersion(): string {
  return JSON.parse(raw("tauri.conf.json")).version as string;
}

function cargoVersion(): string {
  // 只取 `[package]` 段里的 version，避免命中依赖表里的 version 键
  const block = /\[package\]([\s\S]*?)\n\[/.exec(raw("Cargo.toml"))?.[1] ?? "";
  const m = /\nversion\s*=\s*"([^"]+)"/.exec(block);
  if (!m) throw new Error("src-tauri/Cargo.toml 的 [package] 段里没找到 version");
  return m[1];
}

console.log("\n== 版本号一致性 ==");

it("package.json / tauri.conf.json / Cargo.toml 版本必须一致", () => {
  const pkg = packageVersion();
  const tauri = tauriVersion();
  const cargo = cargoVersion();
  expect(
    { tauri, cargo },
    `三处版本不一致 → package.json=${pkg} tauri.conf.json=${tauri} Cargo.toml=${cargo}`,
  ).toEqual({ tauri: pkg, cargo: pkg });
});

it("版本号形状像 semver（允许 -alpha.N 之类的预发布后缀）", () => {
  const v = packageVersion();
  expect(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v), `版本号形状可疑: ${v}`).toBe(true);
});
