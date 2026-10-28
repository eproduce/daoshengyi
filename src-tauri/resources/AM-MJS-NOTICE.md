# `am.mjs` 第三方组件说明（Answer me with HTML）

本目录下的 `am.mjs` 是**第三方开源组件的原样内嵌副本**（vendored copy），用于内置工具
`answer_html`（道生一「方案 B」：CLI 随包分发、离线可用、无需用户安装 npm 包）。

| 项目 | 值 |
| :--- | :--- |
| 上游仓库 | <https://github.com/QingYunA/answer-me-with-html> |
| 上游文件 | `skills/answer-me-with-html/scripts/am.mjs` |
| 上游版本 | `0.5.10`（`node am.mjs --version`） |
| 上游 commit | `f82dd6dce3ca95b0e565f8cffaf5eba23f4c995f`（2026-10-26） |
| 拉取日期 | 2026-10-28 |
| 字节数 | 981,515 |
| SHA-256 | `5e08fda8e976927b16596624cf605e5aadd77828ee690a412b5a9a96584d4f2c` |

> **0.4.15 → 0.5.10 升级（2026-10-28）**：这次跳 12 个版本，拿回了上游这 18 天加的东西 ——
> `$…$` / `$$…$$` 数学（Temml → MathML，离线）、原生 `chart` 组件（SVG）、`er` 实体关系图、
> `:::` 块语法（VitePress/Docusaurus 写法）、主题目录、文字缩放、doc 目录轨、一次列出全部草稿错误，
> 以及 `patch` / `video` / `serve` / `theme` / `lint` 子命令。我们这侧仍只用 `render`
> （图表的 ECharts 注入仍在宿主侧做，见下文），所以升级是行为兼容的。
| 许可证 | MIT |

## 许可证（MIT，原文摘要）

```
MIT License

Copyright (c) 2026 Answer me with HTML contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 本仓库对它的改动

**没有改动**：文件按上游原样内嵌（上面的 SHA-256 可与上游对应 commit 校验）。
道生一这侧的适配全部在宿主代码里完成（`src-tauri/src/answer_html.rs`）：

- 草稿由宿主写到临时文件（**不走 heredoc**），CLI 以 argv 形态调用；
- 强制 `--no-open`（不在用户屏幕上弹浏览器）；
- 走统一命令管线（沙箱 `wrap_argv_auto` + 超时 + `log_tool_call` 审计）。

## 升级方式

```bash
gh api repos/QingYunA/answer-me-with-html/contents/skills/answer-me-with-html/scripts/am.mjs \
  --jq '.content' | base64 -d > src-tauri/resources/am.mjs
shasum -a 256 src-tauri/resources/am.mjs   # 更新本文件的版本/commit/哈希三行
node src-tauri/resources/am.mjs --version  # 确认版本号
```

升级后请跑一次真实渲染（见 `docs/ANSWER_ME_WITH_HTML_INTEGRATION.md`）再提交。
