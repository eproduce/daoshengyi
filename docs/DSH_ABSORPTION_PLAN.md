# DeepSeek Harness 吸收开发计划

> 对象：`deepseek-ai/deepseek-harness`（DSH，MIT，TypeScript，约 22.6 万星）
> 官方定位：**"Everything is a Plugin"** —— 基于 [Cordis](https://github.com/cordiverse/cordis) 的插件内核，
> 模型、工具、沙箱、会话存储、UI、甚至 agent loop 本身都是插件。
> 生态：`awesome-dsh-plugin` 收录 1500+ 插件（社区 `dsh-plugin` topic 2600+ 仓库）。
> 本文只吸收**能力与机制**，不吸收皮肤/宠物/壁纸/桌面壳等外观类插件。

## 0. 先对齐：我们已经有的（不需要重复吸收）

| DSH 生态能力 | 我们的对应实现 |
| --- | --- |
| 工具渐进披露（`tool_search` + deferred catalog） | `src/utils/tool-search.ts`(BM25) + `tool-schema.ts` 的 `catalog/activateCatalogTool` |
| 工具 schema 瘦身（巨型 MCP schema 多轮有损压缩） | `src/utils/tool-schema-compact.ts` |
| 自动压缩 + 交接摘要（compaction / handoff） | `chat.ts` 的 `compressConversation` + `maybeAutoCompact`（≥82%） |
| 审批模式 / 沙箱模式 | `ApprovalMode(never/on-request/on-failure/untrusted)`、macOS Seatbelt `sandbox.rs` |
| **权限预设层**（`dsh-permission-presets`：把沙箱 + 审批捆成具名档位，客户端只给一个选择器；`custom` 为保留的派生名） | `src/utils/permission-presets.ts` + 输入栏「工作区 → 控制范围」（2026-09-23 吸收；与 DSH 同名的 `workspace-write` / `danger-full-access` 档位） |
| 工作区作为**一等概念**（`SandboxExecutionPolicy.workspaceRoot` 总是被携带，即使当前模式不消费它） | `settings.workspace`（全局默认）+ **会话级覆盖**（`conversations.workspace`，三态：跟随全局 / 本会话指定 / 本会话不限定）；提示词**无条件**注入【当前工作区】 |
| 目标常驻（goal） | `src/utils/goals.ts` + `get_goal/create_goal/update_goal` |
| 子代理 / 多代理 | `subagent_delegate` / `subagent_parallel` / `list_agents` / `interrupt_agent` |
| 会话全文检索、记忆、技能库、定时任务、IM 网关 | `api/search.ts`、`MemoryPanel`、`SkillManager`、`ScheduledTasks`、`ImGatewayPanel` |
| 浏览器自动化、PTY、Codex `apply_patch`、diff 确认与撤销 | `browser.rs`、`pty.rs`、`codex-patch.ts`、`DiffConfirmDialog`/`UndoPanel` |

结论：**架构层面已吸收**。剩下的高价值缺口集中在「**确定性能力下沉**」「**可靠性门禁**」「**上下文经济学**」三类。

## P0（本轮开始，纯前端可验证、零依赖、低风险）

### P0-1 确定性工具集（10 个）
- 来源：`omdsh-dev/dsh-toolkit`（time/encoding/json/calculator/csv/regex/markdown/diff/stat/schema）、
  `dsh-unitverse`/`dsh-units`（单位换算）、`dsh-tool-*` 系列、`jean3690/dsh-devtoolbox`（35 个纯客户端工具）。
- 动机：模型口算/口述换算/手写正则**容易算错和编造**，这类任务必须下沉到代码，结果可复现。
- 落点：`src/utils/deterministic-tools.ts`（+ `unit-convert.ts`、`text-diff.ts`、`json-schema-lite.ts`），
  在 `chat.ts` 的 `callBuiltinTool` 里以**一个 case 组**统一分发（`runDeterministicTool`）。
- 工具：`calc`、`convert_unit`、`time_convert`、`csv_query`、`json_query`、`regex_test`、
  `hash_encode`、`stats_describe`、`diff_text`、`schema_validate`。
- 验收：单元测试覆盖每个工具的边界（含除零、非法正则、单位歧义、时区/DST、CSV 引号转义）。

### P0-2 工具结果「内容感知压缩」+ 密钥脱敏
- 来源：`YuanyuanMa03/dsh-funnel`（保错误行 + 首尾 + 落盘定位）、`toolshrink`、`giter00/dsh-headroom`、
  `dsh-secret-redactor` / `secret-guard` / `dsh-mask`（PII/密钥掩码）。
- 动机：现有 `foldToolResult` 只做「首 4000 + 尾 1200 + 落盘」，中段信息（错误、失败用例）会被埋掉；
  且工具输出（网页/命令）可能带出密钥 → 必须**在进上下文之前**脱敏。
- 落点：`src/utils/secret-redact.ts`、`src/utils/tool-result-reduce.ts`；改 `chat.ts::foldToolResult`
  为「脱敏 → 内容感知压缩 → 超预算才落盘（落盘存脱敏后完整原文）」。
- 验收：单测证明①错误行永不丢失 ②重复行/栈帧/通过用例被折叠并计数 ③密钥形态被掩码 ④原文不落明文密钥。

### P0-3 上下文成本审计（Context Doctor）
- 来源：`Zhenyu98/dsh-context-doctor`（指令链/技能目录/工具 schema 的 token 成本、重复与冲突检测）。
- 动机：我们已有 `tokens.ts` 与 schema 压缩，但**没有地方回答「上下文的钱花在哪」**，导致「加 skill/加 MCP → 悄悄吃掉窗口」。
- 落点：`src/utils/context-audit.ts` + `SettingsDialog`/`AuditPanel` 一个分区（系统提示、技能、工具 schema、记忆、历史各自的 token 与占比 + 重复项提示）。
- 验收：单测（比例计算、重复检测、空态）+ 面板可见。

### P0-4 危险命令语义门禁 + 删除进回收站
- 来源：`JohnXu22786/safety-net`、`azazo1/dsh-write-protect`、`x2802490130-prog/dsh-shield`、`LWLAymh/dsh-edit-guardian`。
- 动机：现在靠「命令策略 + 用户点确认」，但**没有语义级高危识别**（`rm -rf /`、`git reset --hard`、
  `git push --force`、`dd of=/dev/`、`mkfs`、`chmod -R 777 /`、`curl|bash`、`shutdown`）。
  `delete_file` 也是真删。
- 落点：`src/utils/danger-rules.ts`（规则表 + 命中的中文解释 + 必须人工确认/直接拒绝两级），
  接入 `chat.ts::gateAgentCommand` 与 `delete_file`；删除改写为移动到 `<app_data>/trash/`（可恢复）。
- 验收：单测覆盖每条规则与「误报抑制」（`rm -rf node_modules` 只警告不拒绝）。

### P0-5 验证凭据（Verification Receipts）
- 来源：`pavangupta352/stalegreen`（测试/类型检查/lint/构建的声明必须由「新鲜凭据」支撑）、
  `bpc-oss/dsh-verification`（完成门禁需真实工具证据）、`PerryLink/dsh-doublecheck`。
- 动机：模型常声称「测试通过」，但实际未运行或运行后又改了文件 —— 这是最伤信任的失败模式。
- 落点：`src/utils/verify-receipts.ts`（记录 run_tests/命令的 kind/时间/结果/文件指纹）+
  回合收尾检查：若回复文本含「测试/typecheck/lint/build 通过」类断言而凭据缺失或**早于最后一次写文件** → 插一条纠偏提示。
- 验收：单测（凭据新鲜度、失效判定、无断言不打扰）+ 真实回合观察。

### P0-6 预算护栏（Budget Guard）
- 来源：`PerryLink/dsh-budget`、`hugo`/`dsh-save-money`、`dsh-rate-limiter`（预警/阻断/排队）。
- 动机：`UsageStats` 只能看不能拦；长任务可能一次烧掉整周额度。
- 落点：`src/utils/budget.ts`（会话/日/月预算 + 80% 预警 + 100% 阻断或降级提示），接入 `UsageStats` 与发送前检查。
- 验收：单测（阈值、跨日重置、无预算不打扰）。

## P1（P0 合并后启动）

| # | 能力 | 来源 | 要点 |
| --- | --- | --- | --- |
| P1-1 | 工具调用自愈 | `merenguesL/dsh-tool-normalizer`（错误率 7.95%→2.20%） | 参数别名映射、类型纠正、路径越界钳制、缺参从上下文补全 |
| P1-2 | 哈希锚定编辑 | `Rianico/dsh-better-edit` | 每行 3 字符内容哈希，按哈希定位编辑，拒绝过期锚点 |
| P1-3 | 生命周期钩子 | `truelove-dreamer/dsh-plugin-hooks`、`hookkit` | 事件→（工具/shell/HTTP）→（注入上下文/拒绝/通知），配置驱动 |
| P1-4 | 声明式权限规则 | `PerryLink/dsh-permission-rules` | allow/deny/ask 规则匹配工具名+参数+路径，dry-run + 热重载 |
| P1-5 | 压缩阶梯 | `savageops/dsh-rich-indexing`（30/50/70/90） | 替代单一 82% 阈值；每档把确定性关键词索引写入检查点 |
| P1-6 | 自动续跑规则表 | `weibaohui/dsh-continue` | 按失败类型（限流/额度/鉴权/上下文溢出/崩溃）路由到退避重试/换模型/压缩后继续/止损通知 |
| P1-7 | 决策日志 | `yuyolin/dsh-decision-log` | `DECISIONS.md` 记录「选了什么+为什么」，下次会话自动注入摘要，避免反复推翻 |
| P1-8 | 输出风格 | `PerryLink/dsh-output-styles` | 6 种内置输出风格 + 渲染器注册表（与 personas 正交） |
| P1-9 | 技能生态 | `dsh-skills-hub`/`skill-mover`/`dsh-skill-browser` | 从 Claude Code/Codex/Cursor 目录导入 SKILL.md；技能失败台账 + 用量计分 |
| P1-10 | 会话 FTS 增强 | `zn-Dk/dsh-session-explorer`、`sessionQuery` | 结果集按会话分组、精确片段、去重（fork/续写） |

## P2（按需）

16. 代码知识图谱（`JohnXu22786/codegraph`、`lemonxiny55/dsh-code-index`）：tree-sitter 符号/调用/影响面 + 仓库地图。
17. 数据库只读连接器（`dsh-sql`、`db-connector`）：SQLite/PG/MySQL，schema 内省 + 只读 + 审计 + 写入审批。
18. 文档 → Markdown（`markitdown`、`dsh-pdf`、`dsh-uni-doc`、`MinerU`）与文献引用（`dsh-cite`，GB/T 7714）。
19. 生成式 UI（`dsh-genui`、`dsh-visualize`、`dsh-artifacts`）：沙箱 iframe 内渲染图表/表单/HTML 卡片。
20. 观测导出（`loongsuite/dsh-plugin` OTLP、`PerryLink/dsh-fast` 缓存诊断）：token/时延/缓存命中率导出与看板。
21. 多模态扩展（`dsh-vision-analysis` 8 种分析模式、`dsh-tool-imagegen` 生图 + 审批门禁）。
22. IM 渠道扩展（对照 `534119219/dsh-messaging` 的 27 平台清单补齐网关）。

## 不吸收

- 外观类（皮肤/主题/壁纸/桌面宠物/粒子背景/字体切换/移动端 UI 皮肤）。
- 桌面壳类（Windows/macOS 启动器、托盘、开机自启）—— 我们已是原生 Tauri 桌面应用。
- 提示词注入式「越狱/人格扮演」合集。
- 把 UI 折叠、导航栏、便签等纯前端微交互逐个照搬（我们按需自研 UI，避免碎片化）。

## 执行纪律

- 每批改动必须六道门禁全绿：`cargo check` · `npx vue-tsc --noEmit` · `npx vite build` ·
  `npm test` · `cargo test --lib` · `cargo clippy --all-targets -- -D warnings`。
- 纯前端工具优先（无 Rust 风险），每批带单测；工具类改动必须同步
  `data/builtin-tools.ts`（描述）+ `data/builtin-params.ts`（参数 schema）+ `chat.ts`（执行分支）三处。
