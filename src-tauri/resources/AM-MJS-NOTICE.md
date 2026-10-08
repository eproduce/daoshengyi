# `am.mjs` 第三方组件说明（Answer me with HTML）

本目录下的 `am.mjs` 是**第三方开源组件的原样内嵌副本**（vendored copy），用于内置工具
`answer_html`（道生一「方案 B」：CLI 随包分发、离线可用、无需用户安装 npm 包）。

| 项目 | 值 |
| :--- | :--- |
| 上游仓库 | <https://github.com/QingYunA/answer-me-with-html> |
| 上游文件 | `skills/answer-me-with-html/scripts/am.mjs` |
| 上游版本 | `0.4.15`（`node am.mjs --version`） |
| 上游 commit | `d0add7ec67fd51704321ec0295ede1563f8297be`（2026-10-08） |
| 拉取日期 | 2026-10-08 |
| 字节数 | 482,049 |
| SHA-256 | `c1fbbc9bfea2855ea654f1d453da372b2a2d3f62cb19eae77461ab0a7a7493cb` |
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
