# Tailwind CSS (MIT)

- File: `tailwind.css` (precompiled, minified, 3.4.19)
- Config used for the build: `tailwind.config.cjs`
- Upstream: https://github.com/tailwindlabs/tailwindcss
- License: MIT

## What is compiled in

`tailwind.css` is a **precompiled subset** (no runtime compiler, no CDN):

- `corePlugins.preflight = false` —— 不重置页面基础样式，避免破坏 am.mjs 的排版；
- `important = true` —— 工具类可覆盖页面内既有样式；
- safelist 覆盖：间距/尺寸/布局（flex/grid）/排版/边框/圆角/阴影/透明度/
  默认调色板（22 色 × 11 阶）以及品牌色（ink/coal/panel/copper/amber/elec/mint/rust/dim）；
- 响应式前缀 `sm/md/lg/xl/2xl` 覆盖布局与常用排版；部分颜色/背景/边框带 `hover:`。

## Limits

任意值（如 `w-[437px]`）只有少量字号（`text-[10px]`…`text-[16px]`）被编译；
其它任意值请用行内 `style="..."`，不要期待 JIT 在运行时生成。

## Rebuild

```bash
# 在装有 tailwindcss@3.4.19 的环境
tailwindcss -c src-tauri/resources/tailwind.config.cjs \
  -i /tmp/tw.css -o src-tauri/resources/tailwind.css --minify
# /tmp/tw.css 内容：@tailwind utilities;
```
