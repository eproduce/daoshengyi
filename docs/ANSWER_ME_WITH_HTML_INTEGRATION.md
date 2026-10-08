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

---

*核实命令与输出见 §2；上游元信息取自 GitHub API（2026-10-08）。*
