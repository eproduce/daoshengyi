# Answer me with HTML 集成评估（2026-10-08）

> 上游：<https://github.com/QingYunA/answer-me-with-html>（MIT）
> 问题：这个技能能整合进道生一吗？——能。本文给出事实、实测证据、真实摩擦点与分级方案。

## 0. 结论

| 判断 | 内容 |
| :--- | :--- |
| **能不能** | **能**。它属于「提示词技能 + 一条命令行」形态，与我们的技能库、内置工具、execpolicy、沙箱体系全部能对接 |
| **卡在哪** | 不在能力，在三个工程细节：① Node ≥ 20 运行时（我们 app 不自带）② 导入只搬 SKILL.md 正文、**不搬 `scripts/am.mjs`**，且 `${CLAUDE_SKILL_DIR}` 不会被替换 ③ 默认输出目录在路径白名单/沙箱外 + 每次渲染都要过命令审批 |
| **代价** | 🟢 方案 A：半天，零 Rust 改动，**本机今天就能用**；🟡 方案 B：1~2 天，内置工具 + 资源内嵌（推荐落地形态）；🔵 方案 C：随包 Node（体积代价，远期） |
| **额外收益** | 这个技能正好是 **O7 插件化 SDK** 的完整样本（技能携带脚本资源 + 变量替换 + 版本钉住 + 能力声明），可拿它把契约先定下来 |

## 1. 上游技能事实（已核实）

| 项目 | 值 |
| :--- | :--- |
| 仓库 / 许可 | `QingYunA/answer-me-with-html`，MIT，JavaScript，**2,306 star**，最近更新 2026-10-08（活跃） |
| 版本 / 包名 | `answer-me-with-html@0.4.15`，npm `bin`：`am`、`answer-me-with-html` |
| 自带 CLI | `skills/answer-me-with-html/scripts/am.mjs`，**471 KB 单文件**，内联 `@dagrejs/dagre` + `marked`，**零 npm 安装** |
| 运行要求 | **Node.js ≥ 20**（唯一硬依赖） |
| 技能目录内容 | `SKILL.md` + `references/{settings,video}.md` + `scripts/am.mjs` |
| 官方安装方式 | Claude Code：`claude plugin marketplace add` + `claude plugin install`；其它 agent：`npx -y skills add QingYunA/answer-me-with-html -g -y -a <agent>`；或手动放目录 |
| 工作方式 | **模型只写 Markdown 草稿**（3~8 个 panel），CLI 负责模板/配色/暗色/主题/**SVG 自动布局**/STE 受控写作检查 → 输出单文件离线 HTML |
| 输出 | 默认 `~/.answer-me-with-html/<dir>/<slug>-<时间戳>.html`（`AM_HOME` 可改），`-o <path>` 指定；`--no-open` 不弹浏览器 |
| 省 token（官方 benchmark） | 手写 HTML 平均 4,893 token → 草稿 **612 token（约 1/8）**；手写部分 83% 是 SVG 坐标 + CSS + 标签 |
| 组件语法 | `flow` / `sequence` / `tree` / `timeline` / `limits` / `annot` / `kv` / `callout` / `ask`，表格状态词 `ok` / `no` / `warn` 自动转徽标 |
| 交互契约 | 渲染失败回 `✗ L<行> [组件] …` + `Correct example:` → 改那一行重渲（最多 2 轮）；回复只给 2~3 行 + 页面 `file://` 链接 |

## 2. 本机实测证据（端到端已跑通）

```bash
node --version                       # v24.16.0        ← 满足 ≥20
gh api .../scripts/am.mjs → 471K     # 无需 npm install
node scripts/am.mjs --version        # 0.4.15

cat > draft.md <<'AM_EOF'
---
title: Agent 能否集成 HTML 讲解技能
lang: zh
---
结论：可以集成，前提是补齐 Node 运行时与命令入口。
## 集成链路
```flow
A -> B: 技能指令注入
B -> C: 模型写 Markdown 草稿
C -> D: am CLI 渲染
D -> E: 本机 HTML 页面
```
AM_EOF

node scripts/am.mjs render draft.md -o /tmp/amh/test.html --no-open
# ✓ /tmp/amh/test.html
#   sheet · blueprint · 2 panels · flow×1
#   STE ✓ 0 warnings
```

**实测结论**：单文件 CLI 独立可用、中文草稿渲染成功、`--no-open` 不打扰用户、**全程不需要装任何 npm 依赖**——对我们这种 registry 受限的环境反而是加分项。

## 3. 我们已有的对接面（逐条对应）

| 上游需要什么 | 道生一是否已有 | 位置 |
| :--- | :--- | :--- |
| 一个能跑 shell 的模型工具 | ✅ 有 | `run_command` 内置工具（`chat.ts` 的 `agentRunCommand`，走 `/bin/sh -c` 整条命令、60s 超时、execpolicy + 审批 + 审计 + 防休眠） |
| 把技能指令注入系统提示词 | ✅ 有 | `utils/skill-md.ts` `parseSkillMd` + `stores/skill.ts` + 路由/渐进披露（`chat.ts` 技能区块） |
| 从外部目录导入技能 | ✅ 有 | Rust `scan_external_skills`（`skill_import.rs`）+ `utils/skill-import.ts` `skillSourceSpecs`——已扫 `~/.claude/skills`、`~/.claude/commands`、`~/.codex/prompts`、`~/Documents/道生一技能`、工作区 `.cursor/rules` |
| 技能声明所需能力 | ✅ 有 | frontmatter `requires_tools` / `requires_servers` → 命中即自动激活工具 / 连 MCP，不可用会明说 |
| 参考文件（references） | ⚠️ 部分 | `Skill.references` 类型与注入已在 `chat.ts` 生效，但**外部导入不搬 references 目录** |
| 页面路径可点击打开 | ✅ 有 | `LOCAL_FILE_RE`（含 `:行号`）+ `file_exists` 校验 + `open_file`（优先 VSCode `code --goto`） |
| 命令白名单 / 免打扰 | ✅ 有 | `app_data/execpolicy.rules`（allow / deny / prompt，首条命中生效）+ `approvalMode`（manual / smart / on-failure / yolo） |
| 路径边界 | ✅ 有 | P-A8 `allowed_paths` 白名单 + 沙箱模式（`sandbox.rs` `wrap_argv`） |

## 4. 四个真实摩擦点（按影响排序）

### 4.1 Node 运行时（最大，也是唯一「分发级」障碍）

`am.mjs` 要 Node ≥ 20，我们 app **不带 Node**。你的 Mac 有 v24.16.0 → 立刻可用；打包给别人就一定踩。

对策（可组合）：① 探测 + 优雅降级（无 node 时明确提示，回退普通 Markdown 回答）；② 随包内置 Node（安装包 +50~100MB）；③ 引导页让用户自装 Node。

### 4.2 导入只搬正文，不搬脚本、不替换变量

`skill-import.ts` 只取 SKILL.md 的**文本**（≤256KB），而 SKILL.md 里到处是 `${CLAUDE_SKILL_DIR}/scripts/am.mjs`：

- 导入后这个变量**不会被替换** → 模型会照着跑一条**不存在的路径**（这正是「导入成功但一用就废」的典型坑）；
- `scripts/am.mjs` 不在导入范围内 → 技能目录必须**另行落地到磁盘**。

对策：A 方案在导入后编辑技能提示词，把绝对路径写死；B 方案由内置工具自己拼路径，模型连路径都不用知道。

### 4.3 命令审批与沙箱路径

- 默认输出 `~/.answer-me-with-html/` 落在 P-A8 白名单与沙箱模式之外 → 写失败 / 之后读不到；
- manual 审批模式下每次 `am render` 都要你点一次同意 → 它的「always-on（有结论就出页）」价值直接被磨没。

对策：`-o` 输出到工作区（或把该目录加进 `allowed_paths`）+ execpolicy 加 `allow node *am.mjs render*` 一条 + B 方案用专用内置工具绕开逐次审批。

### 4.4 技能生态没有我们的名字（但影响很小）

官方 `npx -y skills add ... -a <agent>` 只认 `claude-code` / `codex` / `cursor` / `opencode` / `pi` 等，**没有道生一**；而且它给「其它 agent」装到 `~/.agents/skills`，我们的扫描列表里**恰好没有这个目录**——加一行即可。

### 次要

`references/video.md` 涉及讲解视频 + 配音（ElevenLabs），我们不具备；页面在**系统浏览器**打开（非应用内 webview）；第三方技能内嵌要钉版本 + 记录上游 commit/hash（MIT 允许内嵌，保留版权声明）。

## 5. 方案与优先级

### 🟢 方案 A：纯配置接入（半天，零 Rust 改动，本机今天就能用）

1. 把技能目录放到 `~/Documents/道生一技能/answer-me-with-html/`（或 `~/.claude/skills/` 让现有扫描器直接命中）；
2. 技能库 → 外部导入 → 编辑其提示词：`${CLAUDE_SKILL_DIR}` 全部替换成绝对路径、强制 `--no-open`、`-o <工作区>/html/`；
3. frontmatter 补 `requires_tools: run_command`；
4. `execpolicy.rules` 加一条 `allow node <abs>/am.mjs render`；
5. 语义定位：这是**输出形态偏好**而非一次性任务 → 建议做成**模式**（`modes-catalog.ts` 加「HTML 讲解」）或全局开关，等价于上游的 always-on（我们没有 rules 文件约定，不照抄）。

**局限**：只在装了 Node 的机器可用；页面必须落在工作区才能点开。

### 🟡 方案 B：内置工具 + 资源内嵌（推荐落地形态，1~2 天）

- 新增内置工具 `answer_html`：入参 `{ title, markdown, outPath? }`；实现 = Rust 命令（**必须**走 `run_shell_command_with`，自动享沙箱/审计/超时）或前端「`write_file` 写草稿 → `run_command` 渲染」两步；
- 471KB `am.mjs` 作为 Tauri `bundle.resources` 内嵌 → 离线可用、不依赖用户装 npm 包；版本钉住 + 记录上游 commit；
- Rust 侧探测 node 及版本，缺失直接返回明确错误（不让模型瞎试）；
- 顺带补两个既有缺口：`skillSourceSpecs` 加 `~/.agents/skills`；技能导入支持携带 `references/`。

**好处**：无审批摩擦、无 heredoc 转义风险、路径受控、可被模式/技能自动触发；并符合既有教训——**新增任何「能执行外部命令」的工具，必须走统一命令管线，不许自己拼 shell 绕开沙箱**。

### 🔵 方案 C：远期

随包内置 Node（真正零外部依赖，代价是体积），或等 O7 插件 SDK 的「技能可携带可执行资源」契约确定后统一解决。

## 6. 与 O7 插件化 SDK 的关系（建议）

这个技能恰好是 O7 契约的**完整样本**：带脚本资源的技能、需要变量替换、需要版本钉住、需要路径白名单、需要能力声明。建议 O7 契约先定这三条：

1. 技能可以是**目录**，可携带非 `.md` 资源（`scripts/`、`references/`），导入时一起落地；
2. **变量替换表**（`${SKILL_DIR}` 等）由宿主注入，技能文本不依赖某一家 agent 的私有变量；
3. 技能里的可执行资源必须走**统一命令管线**（审计 / 沙箱 / 审批），不允许技能自行拼接绕行。

## 7. 明确不做的事

- 不自动改动用户的 rules 文件（上游自己也说不要自动加 always-on；我们也没有该约定）；
- 不自动执行 `npx skills add` / `am update`（供应链 + 网络受限）；
- 不代替用户弹浏览器（一律 `--no-open`，页面用我们自己的 `open_file` 打开）。

## 8. 三项决策（已定，2026-10-08）

1. **方案**：走 **B**（内置工具 + 资源内嵌），不走 A（纯配置）；§5 已按此实施。
2. **页面输出目录**：**道生一产物目录** —— `~/Documents/道生一产物/`
   （`workspace-write` 沙箱下改落 `<工作区>/道生一页面/`，因为沙箱不允许写产物目录；
   `read-only` 下明确拒绝并说明原因）。
3. **触发方式**：**每次显式要求** —— 用户明说「用 HTML / 网页 / 一页图形式回答」才出页；
   **不做 always-on 自动出页**（上游那套「有结论就附一页」不采用）。

## 9. 落地记录（2026-10-08，已实施并装机）

| 位置 | 内容 |
| :--- | :--- |
| `src-tauri/resources/am.mjs` | 内嵌 CLI（482,049 B / v0.4.15 / 上游 commit `d0add7e` / SHA-256 `c1fbbc9b…93cb`） |
| `src-tauri/resources/AM-MJS-NOTICE.md` | 版本、commit、哈希、MIT 许可证与升级步骤 |
| `src-tauri/tauri.conf.json` | `bundle.resources` 增加 `resources/am.mjs`（打包后落在 `Contents/Resources/resources/am.mjs`） |
| `src-tauri/src/answer_html.rs` | 新模块：CLI 定位 / Node 探测 / 草稿拼装 / 输出路径决策 / argv 渲染执行 + 9 单测 + 1 个 `#[ignore]` 真机 e2e |
| `src-tauri/src/lib.rs` | `mod answer_html`、注册命令、`artifact_root`/`sandbox_file_path` 提为 `pub(crate)` 复用 |
| `src/data/builtin-tools.ts` · `builtin-params.ts` · `src/stores/chat.ts` | 工具说明 / 参数 schema / 分发实现 / 系统提示词与「HTML 讲解页使用要点」 |
| `src/utils/skill-import.ts` | 顺带补 `~/.agents/skills` 扫描来源 |
| `tests/test-tools-contract.test.ts` | 新增 H（触发策略写死）/ I（渲染必须走宿主命令）两条契约断言 |
| `tests/test-skill-import.test.ts` | 同步来源列表断言 |

**验证**：`npm run ci:local` 8/8 全绿（vitest 612 / cargo 277 / clippy 0 告警）；真机 e2e 渲染成功；
包内 `am.mjs` 与仓库副本哈希一致、`node … --version` → 0.4.15；已装机 `/Applications/道生一.app`
（备份 `道生一.app.old-2319`），版本仍 `1.0.0-alpha.3`。

**与 §4 摩擦点的对应**：4.1 Node 运行时 → 探测 + 可读报错（未随包 Node，属方案 C）；
4.2 导入不搬脚本、变量不替换 → 绕过（自带 CLI，不走上游安装）；4.3 审批与沙箱路径 → 专用命令走统一
命令管线 + 输出落点随沙箱调整；4.4 技能生态名单 → `~/.agents/skills` 补进扫描来源。

**未做（明确不在本次范围）**：讲解视频 / 配音（`references/video.md`，依赖外部 TTS API）；
技能 `references/` 随导入落地（属 O7 契约范畴）。

### 9.1 真机实测反馈修复（2026-10-08 晚，已装机）

用户实机跑了一次「量子理论详解」页面，暴露三个真问题，全部修复并重新装机：

1. **产物落在了主目录**（`~/道生一页面/`，与「统一生成在道生一产物」的约定冲突）
   —— 原因是 `workspace-write` 档下原逻辑把默认输出改到 `<工作区>/道生一页面/`，而用户的工作区设的就是主目录。
   **改为恒定落 `~/Documents/道生一产物/`**，并把该命令的沙箱可写区**收敛到输出目录**
   （既不污染主目录，也不因此放开其它路径）；已把误落的两个 html 文件移回产物目录、删掉空目录。
2. **「无法打开产物」**（用户原文）—— 模型按上游惯例把产物写成 Markdown 链接
   `[标题](/Users/…/页面.html)`；marked 原样渲染成 `<a href="/Users/…">`，webview 把它当
   **本站相对路径**去导航（Tauri 里就是点击无反应 / 白屏）。修复：新增 `localPathFromHref`
   （href → 本地绝对文件路径；扩展名表**零漂移**复用 `LOCAL_FILE_RE`）+ `renderLocalFileLink` /
   `renderMarkdownLink` 纯函数，`ChatMessage.vue` 加 marked `link` renderer，把本地路径链接改造成
   `.local-file-link`（点击走 `file_exists` + `open_file`，存在性校验同样生效）；**裸路径与
   Markdown 链接共用同一实现**（以前是两套）。新增 11 条单测钉住（含百分号编码、`//host/…` 不误判）。
3. **页面里 LaTeX 变成源码** —— 渲染器不含 KaTeX/MathJax，首版 `$…$` 原样显示；模型靠自己
   grep 渲染器才发现（期间还白烧十几轮探索渲染器实现与应用安装目录）。修复：Rust 新增
   `latex_hits` / `latex_error`，**渲染前就拦下**并给出 Unicode 改写范例；工具说明与系统提示词
   同步补上「无数学引擎 → 用 Unicode 记号」「`timeline` 每行 `时间 | 标题 | 注释`」
   「**核验节制**：browser_navigate 打开一次即可，不要 grep 渲染器、不要反复截图 + OCR」。
4. 附带加固：`AM_HOME` 指向 `$TMPDIR/daoshengyi-am-home`（CLI 自身状态不污染主目录、也不受沙箱阻拦）；
   `run_render` 增加 envs 参数。

**验证**：`npm run ci:local` 8/8 全绿（vitest / cargo 278 / clippy 0）；真机 e2e
（带 AM_HOME 隔离）重跑通过；重新打包 → 资源哈希与前端资源表校验一致 → 装机
`/Applications/道生一.app`（回滚点 `.old-2355`）。

---

*核实命令与输出见 §2；上游元信息取自 GitHub API（2026-10-08）。*

---

## 9. 2026-10-21 增强：从「行业晚报」产物反推的报告能力

参考样本：`~/Documents/道生一产物/行业晚报_2026-10-18_离线自包含.html`（1.2 MB，别的 agent 生成）。
拆解后的关键事实：

| 维度 | 参考样本 | 我们当时的输出 |
| :--- | :--- | :--- |
| 体积 | 1.2 MB（ECharts 5.5.1 + GSAP + ScrollTrigger 全量内联） | ~70 KB（纯 CSS + 少量内联脚本） |
| 图表 | 9 个 ECharts 图（行业涨跌、情绪、库存、电价等） | 无数据图表 |
| 结构 | 总结 → 分行业 → 阅读笔记（类型分布）→ 明日展望 → 来源 | 面板式，长文默认 `sheet` 网格 |
| 数据纪律 | 每个价格/指数标来源；未核实数据不进正文 | 仅提示「注明来源」，无结构约束 |
| 交互 | 阅读进度条 + 滚动动画 + hover | 静态（可打印） |
| 离线 | 是（三方库全内联） | 是（零外部依赖） |

**结论**：值得学的是「图表 + 报告结构 + 数据纪律」，**不必照抄 1.1 MB 的 JS 运行时**。
ECharts/GSAP 的代价是：单页体积 ×17、依赖 JS、打印/PDF/邮件场景退化，且与「模型只写草稿」的省 token 设计冲突。

### 9.1 本次落地（代码）

1. **```chart 围栏块 → ECharts 图表**（`answer_html.rs`）
   - 支持 `bar / line / area / pie / donut / scatter / radar / gauge / heatmap / funnel`；
   - 高级图表可在块内**直接写 ECharts option JSON**（覆盖任意图表类型）；
   - 模型只写数据（`labels` + 多个 `series`），坐标、坐标轴、图例、提示框全部由渲染器生成；
   - **动效**：真正进入视口（`rootMargin: 0 0 -8%`）才初始化，入场 1s `cubicOut` +
     多系列逐条错峰 55ms，饼/环用 `scale` 展开；`?motion=off|on` 可覆盖，
     默认尊重 `prefers-reduced-motion`；
     **resize 不打断动画**：尺寸未变不动作，动画期间把 resize 延后到 `finished`；
   - **主题联动**：监听 `<html data-mode/data-theme>`，用**合并更新**只做 320ms 颜色过渡，
     不重播入场动画；断点（560px）变化时同样走合并更新；
   - **响应式**：`ResizeObserver` + `window.resize` 双监听；容器 < 560px 时自动收紧边距/字号、
     饼图标签移到扇区内部、拥挤的横轴标签旋转 30°；< 640px 时画布降为 280px；
   - `beforeprint` 自动 resize，打印/PDF 不错位。
2. **ECharts 内联，单文件离线**：`src-tauri/resources/echarts.min.js`（5.5.1，Apache-2.0，
   见 `ECHARTS-NOTICE.md`）。**仅当页面含 chart 块时**才内联，无图表页面体积不变。
3. **SVG 兜底**：ECharts 资源缺失时，`bar/line/area` 回退为纯 SVG；其他类型明确报错，
   不产出空白图。
4. **长报告自动 `doc` 模板**：草稿 ≥ 4 个 `## 面板` 时自动使用单栏阅读 + 目录；也可显式传 `template`。
5. **`theme` 参数**：透传 `auto|blueprint|shadcn|paper`。
6. **渲染后离线自检**：检测外部 `<script>/<link>/<img>/url(http…)` 引用，把 `warnings` 回传模型。
7. **报告写作规范**（工具描述 + 系统提示词）：结论先行并逐条给「影响」、数字带来源与时间、
   末尾固定 `## 数据来源与口径` + `## 观察清单`。
8. **预编译 Tailwind CSS（可选，自动开启）**：草稿里出现 `class="…"` 时自动内联
   `resources/tailwind.css`（Tailwind 3.4.19，MIT，约 435 KB；仅此时增加体积）。
   - 支持 flex/grid、间距、尺寸、排版、边框、圆角、阴影、透明度、默认调色板（22 色 × 11 阶）、
     品牌色 `ink/coal/panel/copper/amber/elec/mint/rust/dim`，以及 `sm/md/lg/xl/2xl` 与部分 `hover:`；
   - `preflight` 关闭（不重置 am.mjs 排版）、工具类带 `!important`（可覆盖局部样式）；
   - **任意值不参与运行时 JIT**：`w-[437px]` 这类请用 `style="width:437px"`（仅少量字号
     `text-[10px]`…`text-[16px]` 预编译）；
   - 显式 `tailwind: false` 可关闭；`tailwind: true` 可强制开启。
   示例：

```html
<div class="grid grid-cols-3 gap-4 p-5 rounded-xl border border-white/10 bg-panel">
  <div class="p-4 rounded-lg bg-copper/15 border border-copper/40">
    <div class="text-[11px] tracking-widest uppercase text-dim">Copper</div>
    <div class="text-3xl font-bold text-copper mt-1">38%</div>
  </div>
</div>
```

### 9.2 用法示例

````markdown
## 一、核心结论
- 铜：矿端扰动与过剩预期僵持，短期震荡（影响：冶炼利润承压）。
- 锂：现货加速探底，关注下周库存拐点（影响：板块估值继续压缩）。

## 二、本周涨跌
```chart
type: bar
title: 本周主力合约涨跌
unit: %
labels: 铜, 铝, 锂, 钨
series: 本周 = -2.1, -0.8, -4.3, -3.9
series: 上周 = 1.2, 0.4, -1.0, 0.6
```

## 三、品种占比
```chart
type: donut
title: 持仓分布
unit: %
labels: 铜, 铝, 锂, 钨
series: 占比 = 38, 27, 21, 14
```

## 四、事件与影响
...

## 五、数据来源与口径
- LME 官方收盘价（2026-10-17）……
- 国家统计局（2026-10-18 发布）……

## 六、观察清单
- 10/22 库存数据是否确认去库；
- 11 月长单谈判价格区间。
````

高级写法（任意 ECharts 图）：

````markdown
```chart
{"tooltip": {"trigger": "axis"}, "xAxis": {"type": "category", "data": ["A", "B"]},
 "yAxis": {"type": "value"}, "series": [{"type": "bar", "data": [3, 5]}]}
```
````

### 9.3 取舍

- **体积**：ECharts 约 1 MB，只随「含图表的页面」内联；Tailwind 约 435 KB，只在草稿含
  `class="…"`（或显式开启）时内联；纯文字报告仍是 ~70 KB。
- **不引用 CDN**：保证离线/内网/邮件附件可用，`offline_warnings` 会在出现外部资源时告警。
- **不内联 GSAP**：入场动画用 ECharts 自带 animation + IntersectionObserver 已足够；
  参考样本的 GSAP/ScrollTrigger 主要服务装饰性滚动效果，收益/体积比不划算。

---

## 11. 2026-10-28：升级到 0.5.10 + 补齐动效（回答「为什么没人家的动态效果和细节」）

用户对比后问：我们的产物为什么没有别人的动态效果好、细节也没有？**确实漏了，而且漏得比想象多。**

### 11.1 事实：内嵌 CLI 落后 12 个版本

内嵌的 `resources/am.mjs` 停在 **0.4.15（2026-10-08）**，而上游已经是 **0.5.10（2026-10-26）**。
这 18 天补的正是「细节」：

| 版本 | 我们缺的 |
| :--- | :--- |
| 0.5.0 | `er` 实体关系图（自动布局、鸭嘴基） |
| 0.5.1 | **散文里的数学**：`$…$` / `$$…$$` → Temml → MathML（离线） |
| 0.5.3 / 0.5.4 | 主题目录（`am theme add`）+ 自定义主题流程 |
| 0.5.5 | **原生 `chart` 组件**（表格语法 → SVG 图表，带图例/高亮/负值） |
| 0.5.6 | 文字缩放（`am config set scale 1.2`） |
| 0.5.7 | 草稿错误**一次全列**（原来只报第一条，白烧重渲轮次） |
| 0.5.8 | doc 页的**目录轨**（hover 显示标题） |
| 0.5.9 / 0.5.10 | `:::callout` 等 VitePress 写法 |
| 全程 | 子命令 `patch`（就地换一个面板）/ `video`（3b1b 讲解视频页）/ `serve` / `lint` / `theme` |

我们这边还因为老版本**自己写了补丁**：图表靠 ECharts 注入、LaTeX 直接**拦下来报错**
（当时渲染器没有数学引擎，写了也是源码）。这次一并校正。

### 11.2 已做

1. **换 0.5.10**（`--version` / commit / 字节数 / SHA-256 全部写进 `AM-MJS-NOTICE.md`）。
2. **数学放开**：删除「LaTeX 一律报错」的前置拦截；`\(…\)` / `\[…\]` 由宿主**归一化**成
   `$…$` / `$$…$$`（实测反斜杠定界符在 0.5.10 下会输出**空 `<math>`**，公式静默消失）。
3. **图表双语法**：我们的 `type:/labels:/series:` 走 ECharts（可交互、可缩放）；
   上游表格语法（`chart bar unit=ms` + `| p50 | p95`）**原样放行**交给页面自带 SVG 图表 —— 更轻。
4. **轻量动效层** `inject_motion`（约 3 KB）：阅读进度条 + 面板滚动入场（错峰 40ms）+ hover 抬升；
   尊重 `prefers-reduced-motion`，`@media print` 全部还原成静态，**没有 JS 时面板照常可见**
   （隐藏规则被 `.dsy-motion` 门控）。
5. 工具描述同步：数学写法、`er`、`:::`、动效已有（别自己写动画）、双图表语法。

### 11.3 关于 GSAP 的结论修正

原来（§9.3）写「不内联 GSAP —— ECharts 动画 + IntersectionObserver 已足够」。**不引 GSAP 不变**
（1.2 MB 的代价换来的是装饰性滚动效果，打印/PDF/邮件全退化），但「静态就够」这一步偏保守：
参考样本真正被感知的是**进度条 + 滚动入场 + hover**，这三件事用 3 KB CSS/JS 就能做到，
不需要 GSAP。现在补上了。

### 11.4 验证
- 单测 30 项（新增：数学归一化、原生图表放行、动效注入幂等/离线/reduced-motion/打印）。
- 真机 e2e（`cargo test --lib answer_html::tests::real_render -- --ignored`）：
  同一份草稿里同时含 flow + ECharts 图表 + 数学 + ER 图 → 渲染成功，
  产物含 `data-dsy-chart`、`<math>`、`am-er`、`dsy-motion-js`，且 `offline_warnings` 为空。

---

## 12. 2026-10-28（续）：图表「只用一种类型」+ 升级当天踩到的 CSP 坑

### 12.1 「一页只有一个图表类型」的根因在提示词

`answer_html` 的图表能力本身是全的（bar/line/area/pie/donut/scatter/radar/gauge/heatmap/funnel +
任意 ECharts option JSON），但**工具描述只列了型别，没教怎么选**，模型于是保守地全用 `bar`。
三处改动：

1. **选型表**（写进工具描述）：趋势→line/area；分类对比→bar；占比→pie/donut；
   **规模+增速→combo**；相关性→scatter；多维评分→radar；完成度→gauge；二维矩阵→heatmap；转化→funnel。
2. **新增 `type: combo`**：第一个 series 画柱（量），其余画线（率/趋势）—— 报告里最常见的
   「规模 + 增速」同图，此前只能手写 option JSON。
3. **硬性多样性要求**：一页 ≥2 张图时，除非数据形状相同，**不许全用同一种**；
   报告类草稿要求「每个有数据的板块至少 1 张图，全页至少 2 种类型」。

### 12.2 升级到 0.5.10 当天踩到的坑：严格 CSP 把注入脚本拦掉了

0.5.10 的页面自带一条 CSP：

```
default-src 'none'; script-src 'sha256-TPSD…' 'sha256-lPqF…'; style-src 'unsafe-inline'; …
```

`script-src` 只放行**它自己**两个内联脚本的 sha256。我们注入的 ECharts 初始化脚本与动效脚本
**不在名单里** → 浏览器直接拦掉（控制台：
`Executing inline script violates the following Content Security Policy directive`）。
表现非常有欺骗性：**页面不报错、只是图表空白、动效没有** —— 差点被当成「升级没效果」。

- 修复：`patch_csp_for_inline_scripts` 扫描页面里所有不带 `src` 的 `<script>`，
  算 `sha256 → base64` 追加进 `script-src`（保留原有哈希、去重、幂等）。
  不用 `'unsafe-inline'` —— 那等于把上游「页面自带 CSP」的设计废掉。
- 旧版本（0.4.15）产物没有 CSP，该函数对无 CSP 的页面原样返回，向后兼容。

### 12.3 视觉验收（Chromium 实测）

`render_chart_gallery_with_mixed_types`（ignored）在**一页**里放 line / donut / combo / heatmap / gauge
五张图，产物 1.18 MB（ECharts 内联），逐屏截图确认：折线双系列、环形图带百分比标注、
热力图带视觉映射条、仪表盘带指针与数值、CSP 无告警 —— 混排成立。

---

## 13. 2026-11-12：为什么我们的产物「死板老旧」——外部同类调研 + 设计元件层

用户反馈：我们生成的页面死板、老旧、不够生动，想问市面上同类插件里最好的是哪些、差在哪。

### 13.1 调研结论（含出处）

| 参考 | 是什么 | 真正让它好看的机制 |
|---|---|---|
| `QingYunA/answer-me-with-html`（6.2k★，我们内嵌的就是它） | 模型只写扩展 Markdown，CLI 负责全部视觉决策 | **justified 行布局（DP 求最优）+ 同页图形缩放比 ≤1.25×**；一套 11 档字阶；13 个语义 token 的三套主题（light/dark 各自设全）；图表选型有硬规则 |
| `anthropics/skills` → `frontend-design`（9.2 KB） | 设计主管人设的 skill | 先出「紧凑 token 系统」（4–6 个具名 hex + 字体角色 + ASCII 线框）再写代码；**把大胆花在一个地方**；页面上只留**一个**记忆点 |
| 同上 → `web-artifacts-builder` | React + Tailwind + shadcn 打包成单文件 | 唯一设计指令就是反 slop：「避免过度居中、紫色渐变、统一圆角、Inter 字体」 |
| 同上 → `canvas-design` | 海报/视觉方法论 | 先写「设计哲学」再视觉化；文字是稀有手势，不是段落 |
| 同上 → `theme-factory` | 10 套命名主题 | 把配色变成**有名字的选择题**，而不是让模型自由发挥 |
| Anthropic Artifacts 新版 craft 指南（泄漏，可信度中） | 交付物分级 | 每类交付物有固定「叙事原型」；打印/PDF 有具体数字（A4 794×1123、页边距 72px、measure 60–75 字符） |
| `heygen-com/hyperframes`（83k★） | HTML → 确定性视频 | 把「活」隔离到可 seek 的动画时间线，而不是给静态页乱加特效 |

**反直觉但一致的总结论**：这几份顶级实现**没有一份**在教「怎么加更多动效/渐变让它显得现代」。
`frontend-design`、Artifacts craft、am 的 `base.css`（44.5 KB 里只有 **1 个** `@keyframes`）三者独立收敛到同一句：

> 让生成页面显老的从来不是「动效不够」，而是**该做的选择被默认值替代了**。
> am 的「活」来自 ①可切换主题/明暗 ②数据高亮 ③可排序表格 ④把决策做进页面 —— 静态页面本身刻意安静。

### 13.2 我们真正的缺口

提示词层面我们其实已经很细（组件选型表、图表选型表、报告写法都在）。缺的是**元件**：
模型想表达「三个关键数字」「左右对照」「逐项对比的矩阵」时没有现成 class，只能自己在
` ```html ` 块里手写行内 style —— 于是每页都是「同圆角 + 同阴影 + 同一套间距」的卡片堆，
也就是业界点名的 **“SaaS 卡片套装”** 味。

### 13.3 已做

1. **`inject_design_kit`（Rust，约 3 KB 纯 CSS，无脚本 → 不触碰 CSP）**
   注入 `<style id="dsy-kit">`，元件全部走渲染器自己的语义 token（`--ink/--ink-2/--line/--fill/--accent/--ok/--err/--paper/--radius`），
   因此**自动跟随主题与明暗**：

   | 类 | 用途 |
   |---|---|
   | `.dsy-hero`（`<em>` 标重点）/ `.dsy-lede` / `.dsy-rule` | 结论页开场：一句判断 + 导语 + 发丝分隔 |
   | `.dsy-kpis > .dsy-kpi`（`<b>数字</b><small>说明</small>`，`.dsy-up/.dsy-down`） | KPI 条：1px 间隙 + 底衬线做分隔，**不用阴影和卡角** |
   | `.dsy-split` / `.dsy-grid2` / `.dsy-grid3` | 左右对照、2/3 栏自适应（≤720px 自动单栏） |
   | `.dsy-matrix`（`is-accent` 标推荐列） | 对比矩阵：发丝行线 + 顶部 2px 强调 |
   | `.dsy-tag` / `.dsy-note` / `.dsy-quote` | 标签 / 强结论 / 引述判断 |
   | `.dsy-meter`（`style="--v:72"`）/ `.dsy-spark` | 完成度条 / 迷你趋势线（内嵌 svg path） |

   全部尊重 `prefers-reduced-motion`，`@media print` 下禁用过渡并 `break-inside:avoid`；
   幂等注入，无 `</head>` 时前置。

2. **工具描述升级**：新增
   - **版式原型三选一**（结论页 / 对照决策页 / 讲解长文），并写明「同一种原型一页只用一次」；
   - **元件速查表**（上面那张，告诉模型「不要自己写 style」）；
   - **反 slop 自查清单**（卡片套装、紫/彩虹渐变、全大写 eyebrow、`A · B · C` 中点、无意义 `01/02/03`、
     emoji 当图标、圆角容器 + 左边框假 callout、Inter/Roboto/Arial、每板块 fade-up、每图补 `<details>` 数据表）。

3. **顺手修掉一条被漏掉的门禁失败**：`tests/test-agent-request.test.ts` 里给历史消息传了
   `tools`，而 `HistoryMessage` 没声明该字段 → `tsc -p tests` 一直红（我只跑过 `vue-tsc`，漏了门禁 ⑤）。
   现已在类型上声明 `tools?: readonly unknown[]` 并写清「卡片绝不能进模型上下文」的约束。

### 13.4 验证

- `npm run ci:local` **8/8 全过**（vitest 62 文件 / 847 项、eslint、prettier、vue-tsc+build、tests tsc、rustfmt、clippy -D warnings、cargo test 380 项）
- 新增 Rust 测试：元件层幂等 / 落在 `</head>` 前 / 无脚本无外链 / 11 个元件齐全 / 含 reduced-motion 与 print 分支 / 无 head 时前置
- 真机样板（`render_design_kit_demo_page`，默认 ignore）：渲染一页 KPI + 折线 + 对照矩阵 + 完成度条 + 迷你趋势 + donut，
  Chromium 截图确认——标题立得住、KPI 是发丝分隔而不是卡片、矩阵有推荐列高亮、图与文字同一节奏。

---

## 14. 2026-11-12：「补齐 Node 运行时与命令入口」——没装 Node 也能出页面

此前 `answer_html` 的前提是「本机有 Node ≥ 20」：只能靠 `node_candidates()` 去猜
Homebrew / nvm / volta / PATH 的位置，猜到就正常，猜不到整条能力不可用。而 Finder 启动的
app 只有 `/usr/bin:/bin:/usr/sbin:/sbin` ——「用户明明装了 Node 却没生效」是这类功能最常见的投诉。

### 14.1 做法：两条腿 + 一次校验

| 优先级 | 来源 | 说明 |
|---|---|---|
| ① | **本机已有 Node** | Homebrew / nvm / volta / `~/.local` / `n` / PATH，取版本最高且 ≥ 20 的 |
| ② | **自带受管运行时** | 首次需要时从 `nodejs.org/dist` 下载官方 tarball → **校验 SHASUMS256** → 只解出 `bin/node` |
| ③ | 两者都不可用 | 明确报错（含原因），让模型改用普通 Markdown，而不是瞎试 |

落盘位置：`<app_data>/runtime/node-v22.14.0/bin/node`（跟 app 走，卸载即清）。

**为什么按需下载而不是打进安装包**：官方 darwin-arm64 tarball ≈ 48 MB，dmg 会因此翻倍，
而绝大多数用户机器上本来就有 Node。按需下载是**一次性**成本，之后完全离线。

**安全**：只从 `nodejs.org` 取；`SHASUMS256.txt` 拿不到就**拒绝安装**（无法证明是官方二进制
就不执行）；校验失败删除临时包并中止；文件名**精确匹配**（清单里几十个平台包，取第一行等于没校验）。
不做镜像自动切换 —— 镜像的正确性无法自证。

**只解一个成员**：tarball 里有 ~5000 个文件（含 npm 与全部 `.d.ts`），我们只要 `bin/node`
（`am.mjs` 是单文件 CLI，不需要 npm），所以按成员过滤解包。

### 14.2 命令入口

| 命令 | 用途 |
|---|---|
| `ensure_html_runtime({ install?: bool })` | `install=false` → 查状态；`install=true` → 没有就下载安装 |
| 事件 `html-runtime-progress` | `{phase, received, total, message}`，phase ∈ start/downloading/verifying/extracting/ready |
| 工具 `answer_html` | 本机无 Node 时**自动走同一条自举路径**，成功后照常渲染 |

设置 → 本地 → **「产物渲染运行时（HTML 讲解页）」**：显示「已就绪：道生一自带 Node 22.14」
或「未安装——可在这里下载（约 48 MB）」+ 自带运行时目录，让 48 MB 的等待有解释。

### 14.3 验证

- 纯函数单测（`node_runtime`）：平台标记映射、官方 URL、SHASUMS 精确匹配（含「相似名字不能被前缀骗到」）、
  sha256 校验（真值 `sha256("hello")`）、受管路径按版本隔离
- **真机自举测试**（`live_download_verifies_and_runs_node`，默认 ignore）：
  真下载 48 MB → 校验 → 解出 → `node --version` 输出 `v22.14.0` → 二次调用命中缓存不重复下载。
  实测 **161 秒**完成（2026-11-12 首次跑）
- `npm run ci:local` 8/8 全过（vitest 62 文件 / 849 项、cargo test 385 项）
