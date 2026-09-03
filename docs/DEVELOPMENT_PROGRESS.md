# 道生一 · 开发进度

> 按时间记录已完成功能、修复与验证结果，便于回溯与跨会话续接。配套《开发计划》`DEVELOPMENT_PLAN.md`。
>
> **最后更新：2026-09-04**

---

## 2026-09-04

### ✅ 工作流接入 Agent Phase 2：运行轨迹采集 + 自优化（workflow_improve）
> 接 09-03 Phase 1（workflow_list / workflow_create / workflow_run）。目标：让 agent 能基于真实运行历史**复盘失败并自我优化**工作流。
- **轨迹采集（引擎层）**：`workflow-engine.ts` `executeWorkflow` 返回新增 `trace`（逐节点 `{nodeId,label,type,status:done|error|skipped,durationMs,output}`，含耗时统计）——执行处打点：跳过分支、condition 提前 continue、done 尾、catch 错误各 push 一条。
- **持久化（Rust）**：
  - `workflow_runs` 表加 `trace TEXT DEFAULT ''` 列 + `Database::new` 迁移（`ALTER TABLE ... ADD COLUMN` 幂等）；`WorkflowRunRow` 加 `trace`；`wf_run_add` 增 `trace` 参数。
  - 新增 `wf_runs_for(wf_id, limit)`（按工作流取历史，供自优化读取失败轨迹）+ lib.rs 命令 `workflow_runs_for`（`workflow_run_add` 命令同步加 `trace: Option<String>`）。
- **执行端接入 trace**：chat.ts `workflow_run` 与 WorkflowDialog `recordRun` 都记录 trace（输出截 400 字符防撑库）。
- **自优化工具 `workflow_improve`**（内置工具 + 提示词同步 + callBuiltinTool case）：
  - 定位工作流 → 拉最近 ≤6 次运行（含失败/被跳过节点摘要）→ 让辅助/编程模型（`getRoutedAuxConfig("coding")`，chat_once、temperature 0.2、thinking off）产出改进后的工作流 JSON（提示词强约束：修复失败节点/换工具/加分支/细化提示词；无问题则原样返回）→ `extractJsonBlock` 提取 → `validateWorkflowGraph` 校验 → 与现图比对，**未变则不动**，变了才 `workflow_save` 覆盖保存并记录一条 `status='improved'` 历史（新旧节点数/新增移除）。
  - 改动说明结构化返回：新增/移除节点列表。
- **测试**：Rust 更新 workflow_run_history 用例（trace 回读 + wf_runs_for 过滤/倒序/删流不影响）→ cargo test 80；前端 +6（trace：正常 done+耗时、error 带错误、skipped 分支）→ npm test 全绿；vite build 通过；tauri dev 自动重建（30s）无错误、应用运行正常
- **注**：workflow_improve 是「覆盖保存 + 运行历史留痕」模式（无跨版本回滚）；保存后用 workflow_run 验证效果。**待做**：Phase 3「任务类型 ↔ 工作流」记忆（episodic 提炼 + 向量检索 + 自动建议）

### ✅ 工作流接入 Agent Phase 3：任务类型 ↔ 工作流的处理模式记忆
> 接 09-04 Phase 2。目标：让 agent「处理某类任务时自动想起对应工作流」——把「任务类型 → 已沉淀工作流」的映射变成**跨会话记忆**，同类任务不再从零规划。
- **纯函数（workflow-engine.ts，可测）**：`workflowKeywords(graph)`（聚合节点类型/label/工具名/提示词/文本片段成可检索文本）、`queryTokens(text)`（ASCII 小写词 + 中文整段/2/3 字窗）、`scoreTaskAgainstWorkflow(graph, task)`（命中查询词加权占比 0..1，长词加权）。
- **新内置工具（builtin-tools + 提示词同步 + callBuiltinTool case）**：
  - `workflow_suggest(task, limit?)`：对已保存工作流按任务文本打分排序，返回候选 + 相关度 % + 流程链（label → …）；未命中提示「全新且会重复→create+remember」。
  - `workflow_remember(task_type, workflow_name)`：校验工作流存在后，把 `任务类型「X」可复用已沉淀工作流「Y」…` 存为**长期记忆事实（fact_type='workflow'，重要度 6）**——复用既有记忆体系：对话首轮相关记忆自动注入 → 以后遇到同类任务系统自动想起；6 避开用户画像高重要度(≥7)过滤，不污染画像。
- **提示词引导**（工作流使用要点新增）：接任务先判断是否命中处理模式（记忆里有「任务→工作流」或 workflow_suggest 命中 → workflow_run；全新可重复 → create + remember）。
- **记忆 UI**：`memory-format.ts` TYPE_LABEL 增 `workflow: "工作流"`（面板/注入来源标注友好显示）。
- **测试 +6**（workflowKeywords 聚合 / queryTokens 中文词窗+ascii / 同类任务得分高 / 无关 0 / 部分命中居中）→ npm test 245 全绿；vite build 通过
- **经验**：queryTokens 只产整段 + 2/3 字窗，4 字词不成独立 token——测试断言别要求完整 4 字词，改用 2 字窗/ascii 词断言；跨任务匹配打分用「共享词窗加权占比」足够（工作流数量小，无需先向量化）。
- **待做（远期）**：工作流 embedding 向量检索（数量大了再上）；会话结束把「成功工具序列」自动提炼成候选工作流（episodic→graph）；workflow_improve 跨版本回滚。

---

## 2026-09-03

### ✅ O1 / O2 / O3 OpenClaw 能力整合首批 🟢 落地（全部推送 GitHub，main @ 360b53f）
- **O2 SSRF 防护**（新建 `src-tauri/src/ssrf.rs` 纯函数自研，commit 1d4d858）：
  - `SsrfPolicy`（`deny_private` 默认 true + `allow_hosts` / `allow_private_hosts` 白名单；存 app_settings 三字段 `ssrf_*`，serde default 兼容旧配置，前端 appSettings.ts 同步）
  - 纯函数：`is_private_ip`（IPv4 私有/环回/链路本地/未指定/广播 + IPv6 环回/ULA/链路本地 `fe80::/10` 位运算/未指定/组播）、`extract_host`（去 scheme/userinfo/端口/IPv6 括号）、`host_match`（子域通配）、`check_url`（IP 字面量直接判；域名 DNS 解析后按 IP 校验，缓解 DNS rebinding；allow_private_hosts 命中仍拦环回/链路本地最危险段）
  - 接入 `fetch_page` 命令（加 db State + `ssrf_policy(db)` 读配置）：命中返回「目标地址 X 为内网/保留地址，已按 SSRF 策略拦截」
  - 单测 6 项（保留段/白名单/deny 关闭/域名解析 localhost 拦截）→ cargo test 80 全绿
  - 注：`Ipv4Addr::is_reserved` / `Ipv6Addr::is_link_local` 均为 unstable/改名 API → 用稳定方法 + 位运算替代
- **O3 会话级工具集**（复用 S4 queue_turn + fork 基建，commit 5f43303）：
  - 后端：db.rs `ensure_conversation`（幂等建空会话行 + 单测）、lib.rs `ensure_conversation_cmd` 注册
  - 前端：模块级 `sessionBusy` Set + `markSessionDone`（queue-turn-done/error 到达清除）；`callBuiltinTool` 加 3 个内置工具——`session_spawn`（建 🧵 命名子会话并投递 queue_turn，不切换当前会话，返回 session_id）、`session_status`（执行中/已完成 + 消息数 + 最近结果前 600 字）、`session_resume`（轮询等待最长约 4 分钟取回完整结果，用户停止时可中断）；builtin-tools.ts + getMcpToolsPrompt 提示词同步（含「后台子会话使用要点」）；子会话以 🧵 前缀出现在左侧历史、可点击查看/续聊
- **O1 智能上下文压缩**（commit 360b53f）：
  - 超长裁剪处（MAX_SEND_CHARS=120 万字符）由「粗暴从最早删」改为**两级**：先拉该会话 summaries 覆盖范围，优先删除「已被自动摘要覆盖（compaction）」的最老段——摘要已作为【对话摘要】注入 volatileCtx 作补偿，避免粗暴砍掉还有价值的原文；无覆盖或删尽仍超长，回退粗暴裁剪保底
  - 压缩产物复用既有 `summaries` 表（conversation_id / msg_range / created_at，与设计的 conversation_compactions 同构）落库复用、不重算；摘要 LLM 提炼由既有 maybeSummarize 承担，不额外烧 token
  - 构建历史时并行 `rustOrig` 记录每条历史对应原始消息序号，用于定位覆盖段
- **验证**：vue-tsc / npm test / cargo test 80 全绿；按 O1→O2→O3 顺序逐一推送 GitHub

### ✅ 推送与 IM 聊天合并 + 工作流接入 Agent（Phase 1，2026-09-03 续）
- **推送/IM 合并**：`send_im`（webhook 推送）与 IM 网关的配置/入口重叠 → 合并为单一「即时聊天」面板 + 统一 `im_config` 数据模型——`ImConfig` 去掉 `#[serde(rename_all="camelCase")]`（修复与前端 snake_case 键不匹配的隐藏 bug：真凭据下 `from_value().unwrap_or_default()` 会整份回退 Default、网关读不到配置）+ 新增 `feishu_webhook/wecom_webhook/dingtalk_webhook/dingtalk_secret` 四字段（`#[serde(default)]`）；`settings.rs decrypt_settings` 末尾做旧平铺字段→im_config 幂等迁移（`mem::take` + 清空，仅 im_config 已解成对象时迁移防解密失败误吞）；`ImGatewayPanel` 加「主动推送（Webhook）」区块；`SettingsDialog` 删「推送」Tab（按钮/脚本/Send 图标/SettingsTabId 的 push 全清）；`chat.ts send_im` 从 imConfig 读 webhook（旧平铺字段过渡回退），错误提示改「设置 → 即时聊天」。cargo test 80 / npm test / vite build 全绿
- **工作流接入 Agent（Phase 1）**：可视化工作流从「用户手动搭的画布」变成「agent 可执行 / 可生成的可复用技能」——
  - `workflow-engine.ts` 新增 `validateWorkflowGraph` 纯函数（节点数 / 类型 / label / 缺配置 / 重复或悬空引用 / 自环 / 环拓扑检测）
  - `builtin-tools.ts` + `getMcpToolsPrompt` 注入 3 个内置工具：`workflow_list`（列已存工作流）、`workflow_create`（agent 把多步骤/可复用任务抽象成 DAG JSON，`validateWorkflowGraph` 校验通过后 `workflow_save` 落库）、`workflow_run`（按名/id 执行，复用 `executeWorkflow`——LLM 节点走 chat_once（`store.getAuxConfig()`）、工具节点走 `callMcpTool`，与 WorkflowDialog 同款运行时；执行后 `workflow_run_add` 记录历史）
  - `callBuiltinTool` 加 3 个 case；提示词加「工作流使用要点」（多步骤且可能重复 → 先 workflow_create 固化、之后 workflow_run 复用；一次性任务不建）
  - 测试 +10（validateWorkflowGraph 合法/空/缺配置/悬空引用/环/重复 id/非法类型）→ npm test 通过；vite build 全绿
- **待做（下一步）**：Phase 2 工作流运行轨迹采集 + `workflow_improve` 自优化 + 版本化；Phase 3 「任务类型↔工作流」记忆（episodic 提炼 + 向量检索 + 自动建议）——设计见上文会话「工作流融入 agent 模式」

---

## 2026-09-02

### ✅ 设置面板暗色模式白底浅字修复 + 撤销气泡遮挡技能库按钮修复
- **背景**：①设置面板部分 tab（记忆/撤销/审计/即时聊天等）在暗色模式下仍为白色背景、文字浅淡看不清；②对话界面右下角的「撤销」悬浮气泡遮挡输入区右下角的「技能库」按钮
- **根因**：
  1. **主题变量缺失**：`main.css` 主题变量未定义 `--bg-input` / `--text` / `--border` / `--bg-soft` / `--bg` 这些别名，而 MemoryPanel / UndoPanel / AuditPanel / ImGatewayPanel / DiffConfirmDialog 等大量使用 `var(--bg-input, #fff)`、`var(--text, #222)`、`var(--border, #ddd)` 回退写法 → 永远回退到浅色默认 → 暗色下白底浅字
  2. **MemoryPanel 硬编码**：`.memory-stats__type` / `.memory-profile__chip` / `.memory-badge` 直接写死 `#fff` / `#f0f0f0` / `#333` / `#555`
  3. **撤销气泡定位**：UndoBubble `position: fixed; right:18px; bottom:18px` 正好悬浮在输入条区域内，盖住右下角「技能库」按钮
- **修复**：
  1. `main.css`：light / dark 两个主题块各补 5 个别名变量（`--bg-input` / `--bg-soft` / `--text` / `--border` / `--bg`），一次性修复所有用回退写法的组件
  2. `MemoryPanel.vue`：3 处硬编码白底/浅字改为主题变量（`var(--bg-input)` / `var(--bg-soft)` / `var(--text)` / `var(--text-secondary)`）
  3. `UndoBubble.vue`：气泡 `bottom: 18px → 96px`（输入条约 82px 高，上移到输入条上方，不再遮挡技能库按钮）
- **验证**：浏览器（Vite 1420 端口）暗色主题下实测——记忆 / 撤销 / 审计 三个 tab 的输入框、按钮、统计区均为暗色背景、浅灰文字，白底问题消失；get_errors 无错误；撤销气泡位置经代码核算在输入条上方

### ✅ 暗色主题遗漏补修：黑字按钮 / 白底输入框（2026-09-02 第二轮）
- **背景**：首轮补别名变量后，用户反馈「有些按钮在暗色背景下文字是黑色的，快看不到了」；浏览器 computed-style 全量扫描确认仍有遗漏
- **根因（扫描定位 16 处低对比度）**：
  1. **4 个按钮类缺显式 color**：`.memory-btn` / `.im-btn` / `.ap-btn` / `.up-btn` 用 `var(--bg-input, #fff)` 作背景（补变量后 dark 下变深），但**无 color 声明** → 继承默认黑字 → 深底黑字
  2. **无样式定义的按钮类**：`.btn-ghost`（知识库「刷新知识库列表」、PtyPanel「终止」）全项目无定义 → 浏览器默认浅底黑字；PtyPanel `.btn-secondary`（「启动」）因 SettingsDialog 样式 scoped 不穿透子组件 → 同样浏览器默认
  3. **无样式的 textarea**：SettingsDialog 权限 tab「禁用工具/路径白名单」2 个 textarea 无 class → 浏览器默认白底黑字
- **修复**：
  1. `.memory-btn` / `.im-btn` / `.ap-btn` / `.up-btn` 各补 `color: var(--text)`
  2. SettingsDialog 补 `.btn-ghost` 主题样式（transparent 底 + `var(--text-secondary)` 字 + hover 变主色）；PtyPanel 补 `.btn-secondary` / `.btn-ghost` 主题样式（`var(--bg-secondary)` + `var(--text-primary)`）
  3. SettingsDialog 权限 tab 2 个 textarea 补 `class="form-textarea"`（复用已有主题样式）
- **验证**：浏览器复扫低对比度元素 16 → 2（仅剩 `im-btn--danger` / `ap-btn--danger` 刻意的红色 danger 语义色，非 bug）；权限 / 终端 / 即时聊天 三个 tab 截图实测——按钮与输入框均为深色底 + 浅色字；get_errors 无错误

### ✅ 中文拼音输入法按 Enter 误发送修复（2026-09-02）
- **背景**：用户反馈「中文拼音输入的时候按 Enter 键会错误地发送还没输入完成的内容」——输入法组词/候选阶段按 Enter 确认拼音时，`@keydown` 把 Enter 当成了发送快捷键
- **根因**：`ChatInput.vue` 的 `<textarea>` 只绑了 `@keydown="handleKeydown"`，`handleKeydown` 中 Enter 分支（`if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }`）没有检查输入法组合状态，也未监听 composition 事件 → 拼音上屏的 Enter 被误判为发送
- **修复**（`ChatInput.vue`）：
  1. 新增 `composing` ref，textarea 模板补 `@compositionstart="composing = true" @compositionend="composing = false"`
  2. `handleKeydown` 顶部定义 `const imeEnter = composing.value || e.isComposing;`，**slash 命令 Enter 分支与发送 Enter 分支都加 `!imeEnter`**（原生 `e.isComposing` + composition 事件双保险，兼容部分 webview 中 isComposing 不可靠的情况）
- **验证**：浏览器（Vite 1420 端口）Playwright 实测——模拟 compositionstart + isComposing 的 keydown Enter，输入文本完整保留、未触发发送（bugPresent=false）；正常输入不受影响；get_errors 无错误

### ✅ 中文拼音误发送修复·第二轮加强（2026-09-03，WKWebView 候选 Enter 时序）
- **背景**：第一轮修复后用户实测 **macOS 系统「简体拼音」候选列表开着按 Enter** 仍误发送——说明 isComposing + composition 事件拦截不住这个场景
- **根因**：Tauri 桌面是 **WKWebView（Safari 内核）**，拼音候选按 Enter 确认上屏时，`keydown Enter` 常在 `compositionend` **之后**才派发、且无组合标记（`isComposing=false`、`keyCode=13`），JS 收到的就是一个「普通 Enter」，无法从事件自身区分
- **修复**（`ChatInput.vue` 三重判定 + 时间窗，全部无损）：
  1. IME 判定扩为 `composing.value || e.isComposing || e.keyCode === 229`——229 是 WebKit 对「输入法处理中按键」的传统标记，覆盖 isComposing 不可靠的内核
  2. `@input` 改命名函数 `onInput`：`InputEvent.isComposing` 为 true 时同步置位 composing（覆盖 WebView 只派 input 不派 compositionstart 的情况）
  3. **时间窗**：`onCompositionEnd` 记录 `lastImeEndAt`；发送分支若距上次组合结束 **<200ms** 则吞掉这一次 Enter（`lastImeEndAt` 置 0 只吞一次）——候选确认 Enter 的残余 keydown 即落在此窗内，不发送；正常发送不受影响
- **验证**：浏览器四场景实测全过——①候选确认残余 Enter（compositionend 后紧接 keyCode13 Enter）被吞 ②正常 Enter 仍发送 ③keyCode 229 拦截 ④isComposing=true 拦截；vue-tsc / npm test 全绿；用户桌面实测「候选状态按 Enter 不发消息」确认修复

---

## 2026-09-01

### ✅ 扫描版/图片型 PDF 读取不到内容修复（OCR 自动兜底）
- **背景**：用户上传体检报告 PDF（扫描件/图片型，数值表格是图片不是文字层），agent 生成的网页里「实际值」全标「待补充」，并声称「原始报告仅标注血常规 26 项全部正常，具体数值未提供」
- **根因**：①`read_attachment` 的 PDF 分支用 `pdf_extract::extract_text_from_mem` 提取文字——扫描件 PDF 提取不到数值表格（只有零星文字层/水印）；②前端只注入前 2500 字符预览 + 提示 `pdf_read` 分段读取；③`read_pdf_part`（pdf_read 底层）同样用 `pdf_extract::extract_text`，也读不到扫描件 → agent 拿不到数值，只能标「待补充」
- **修复**：
  1. **`ocr_tool.swift` 支持 PDF**：`import PDFKit`，PDF 输入时用 `PDFDocument` 逐页 `page.thumbnail(of:for:)` 以 ~2.5x（≈250 DPI）渲染成位图 → `NSBitmapImageRep` → Vision `VNRecognizeTextRequest`（zh-Hans+en-US）OCR，每页前带「【第 N 页】」标记；图片输入保持原行为
  2. **`read_attachment` 自动 OCR 兜底**（改 async + 注入 AppHandle）：PDF 提取文本 `< 80 字符`（判定扫描件）时调 `run_ocr` 对整份 PDF 识别，返回全文 +「（注：该 PDF 为扫描件，以上内容由本地 OCR 识别）」标记；失败/非 macOS 回退原文本
  3. **`read_pdf_part` 同样兜底**（改 async + AppHandle）：文字层过短时先 OCR 全文再分段，保证 `pdf_read` 工具对扫描件可用 → agent 可分段读完整份报告
  4. **新增 `pdf_ocr` 命令** + 提取公共 `run_ocr(app, paths)` helper，`ocr_image_file` 重构复用
  5. **CI**：build-macos.yml swiftc 编译加 `-framework PDFKit -framework AppKit`（Swift 自动链接保险）
- **验证**：`swiftc -O` 编译无警告；实测含中文截图图片 OCR 正常（原功能未破坏）、sips 转出的图片型 PDF OCR 输出带「【第 1 页】」的完整识别文字；`cargo check` 通过；`tauri dev` 自动重建重启
- **经验**：扫描件 PDF 用 `pdf_extract` 必然提取不到文字，必须「渲染页面 → OCR」兜底；附件读取（read_attachment）与按需分段读取（pdf_read）两条路径都要兜底，模型才能读到完整内容

### ✅ write_file 大 content 工具调用被截断修复（分段写入引导）
- **背景**：agent 把整份体检报告 HTML 塞进一个 `write_file` 的 `content` 一次性写入，回复正文出现「工具调用被截断了，我需要重新输出完整的 HTML 内容…」——文件从未真正写入
- **根因**：模型单次输出有 token 上限，超大 content 的 `<tool_call>{"server":"app","tool":"write_file","arguments":{"content":"<完整HTML>"}}</tool_call>` 写到一半被截断、`</tool_call>` 未闭合 → `hasCompleteToolCall` false → 工具不执行；重试仍再截断（死循环）。且 agent 那段「我要重新输出完整 HTML」是空洞过程声明，`isVagueBody` 动作词列表（访问/获取/查看…）不含「输出/写/整理」没拦住
- **修复**（chat.ts）：
  1. **提示词强制分段写入**：fileRule「文件导出规范」新增「长文件必须分段写入」——禁止一次性塞进单个 write_file 的 content；正确做法：①write_file 写开头骨架（末尾放唯一占位 `<!--MORE-->`，HTML 根标签先闭合）；②insert_string 逐段追加 `{anchor:"<!--MORE-->", position:"before", new_text:"<下一段>\n<!--MORE-->"}`；③最后一次不留占位收尾；每次 ≤2500 字符。write_file 内置工具描述也加同款提示
  2. **截断针对性修正指令**：主循环 hasToolCallIntent 分支新增 `isBigWriteFile` 检测（含 write_file + `"content":` 且已输出 >2000 字符仍无闭合 = 大 content 截断）→ 注入分段写入指令（而非让它重试一次性大输出）
  3. **isVagueBody 动作词扩充**：引导词加「重新」，动作词加「输出|写|写入|整理|生成|拼|创建|保存|补全|重新输出」——拦截「我要重新输出完整 HTML」这类空洞声明
- **验证**：npm test 全过、vue-tsc --noEmit 0 错误、Vite HMR 自动热更新
- **经验**：模型单次输出有上限，任何「一次塞整份大文件」的 write_file 必然被截断，必须在提示词层强制「骨架 + insert_string 分段追加」；截断时不能只让模型重试，要针对性引导改策略

---

## 2026-08-30

### ✅ 工作流拖拽新增修复 + 界面现代化 + 颜色统一（WorkflowDialog）
- **背景**：用户反馈「拖拽是可以了，但是拖拽新增没有生效，而且界面很老旧」——点击添加可用，但把节点拖到画布放手不新增节点；界面停留在旧样式
- **根因①（vue-flow store 不共享）**：`useVueFlow()` 在组件顶层（无 `<VueFlowProvider>`）调用时按 `storage.getId()` 分配 id 创建**独立空 store**；`<VueFlow>` 内部又是另一个 store → `screenToFlowCoordinate` 基于空 viewport 返回无效坐标，拖拽落点节点落在不可见位置。`addNode` 直接 `nodes.value.push` 外部 ref 也绕过 store 正规流程
- **根因②（WKWebView HTML5 拖放不派发 drop）**：Tauri macOS 运行时是 WKWebView，`draggable` + 自定义 `DataTransfer` MIME 的拖放存在兼容性问题——dragstart 能触发（节点"拖得起来"），但 drop 经常不派发，表现为「放手就失效」
- **修复**（WorkflowDialog.vue）：
  1. `useVueFlow("workflow")` 与 `<VueFlow id="workflow">` 用**相同 id** 共享同一 store；`addNode` 改用 store 的 **`addNodes([...])`** 标准 API
  2. **改用 mouse 事件自建拖拽**（跨 WebView 100% 可靠）：`mousedown` 记录类型 → `mousemove` 超 4px 判定拖动 → `mouseup` 落在画布矩形内则 `screenToFlowCoordinate` 换算坐标并 `addNode`；不用 preventDefault（否则会阻止 click 导致"点击添加"失效），按钮文字选中用 `user-select:none` 解决
  3. **拖拽视觉反馈**：`mousedown/move` 时显示跟随鼠标的半透明**节点影像**（`.wf-drag-preview`，图标 + 类型名），移入画布时画布高亮（`.wf-canvas--dragover`）
- **颜色统一**（新增 `src/data/workflow-colors.ts`）：palette 图例按钮、画布节点（`WorkflowNodeView`）、拖拽影像三处**共用 `WORKFLOW_NODE_COLORS`** 单一色板（text 绿 / llm 蓝 / tool 橙 / condition 紫 / code 青 / end 灰），彻底消除颜色漂移
- **界面现代化**：全套 `.wf-*` 样式改用主题变量 + 阴影/圆角/过渡；头部 accent 渐变底、运行按钮主色高亮；palette 按钮带类型色左边条 + lucide 图标 + 拖拽抓取光标；画布点阵网格背景；inspector 卡片化；打开动画
- **验证**：Playwright 真实鼠标/事件模拟确认拖拽全程（预览影像 → 画布高亮 → 落点创建）、点击添加、三处颜色 RGB 逐一一致；vue-tsc + npm test（19 + 224 + 25）全过

### ✅ 表格竖线渲染修复（normalizeMath 三层处理 + 系统提示引导）
- **背景**：模型在 Markdown 表格单元格写数学公式 `$|G|$`（绝对值/集合/范数），`|` 是 GFM 表格列分隔符 → marked 切碎单元格（单元格只剩孤立 `$` 或内容错乱）；且此前的 lookbehind 正则曾导致 WKWebView 白屏（ES2018 不支持）
- **修复**（ChatMessage.vue `normalizeMath`，全程禁用 lookbehind）：
  1. `$...$`/`$$...$$` 内 `|` → `\vert `（KaTeX 渲染 `∣`；**必须带尾随空格**，否则 `\vertG` 被解析成不存在的命令 vertG）
  2. `$` 外**紧贴非空白的** `|`（绝对值 `|x|`）→ `\|`（marked 表格内按转义竖线处理、不切分，显示仍为 `|`）
  3. 列分隔符（`| A |` 两侧空白/行边界）保留；公式段/代码块用占位符（`\u0000m`/`\u0000b`）保护
- **边界**：内容竖线**两侧空白**（`{x | x ∈ G}`、`| a |`）与列分隔符外观相同，预处理无法可靠区分 → 系统提示新增引导：表格单元格内**禁止字面 `|`**，用 `$...$` 公式或中文描述
- **验证**：端到端脚本（normalizeMath + marked + katex）确认普通表格/`$`外绝对值/`$`内公式/普通段落全对；vue-tsc + npm test 224 全过

### ✅ 浏览器工具路由容错（resolveToolServer）
- **背景**：模型调用 `puppeteer_navigate` 报「未知内置工具」——tool_call 的 `server` 字段为空/`default`/`app` 时被映射到内置工具分支，而 puppeteer_* 不在内置工具清单（fetch_page/web_search/list_dir 等）
- **修复**（chat.ts）：新增 `resolveToolServer()`——server 是 app/builtin/缺省时：①工具名在已连接 MCP 工具缓存中 → 路由到真实服务器；②`puppeteer_*`/`__connect__` 在缓存中找不到 → 找已启用浏览器服务器（`isBrowserServer`）路由过去；③未连接则由 callMcpTool 走按需激活（`enabled && !connected` 自动连接）。接入主 ReAct 循环 + 子代理循环 + callMcpTool 的 app 分支
- **效果**：模型无需精确写对服务器名，只要工具名对（`puppeteer_*`）就能自动路由并触发连接；`__connect__` 也容错
- **验证**：vue-tsc + npm test 224 全过

### ✅ 设置面板下拉框统一 + 停止按钮线性图标
- **下拉框**（main.css 全局 `select` 样式 + 6 个组件清理）：`appearance:none` 去默认外观 + 自定义 SVG 箭头 + 主题变量（深浅色自适应）；清理 SettingsDialog/MemoryPanel/AuditPanel/WorkflowDialog/ScheduledTasks/ImGatewayPanel 的硬编码 fallback（`#ddd`/`#fff`）与**覆盖箭头的 `background:` 简写**（改 `background-color`）
- **停止按钮**（App.vue / ChatInput.vue）：emoji `⏹` → lucide `Square` / 内联 SVG 线性图标 + 红色警示交互（hover 填充/上浮/缩放）
- **验证**：浏览器 computed style 确认所有下拉框统一（appearance:none + 箭头 + 主题色）；vue-tsc + npm test 224 全过

### ✅ 借鉴 Hermes Agent：货币 $ 转义 + KaTeX LRU 缓存
- **调研**：对比 OpenAI Codex（TUI，pulldown-cmark 事件流、**不渲染公式**，靠 `\|` 转义）与 Hermes Agent（桌面端 **remark-math + rehype-katex** AST 层，`normalizeProseMath` 转义货币 `$`、`katex-memo` LRU 缓存）——我们的 marked 自定义 katex tokenizer 扩展与 AST 层思路一致
- **货币转义**（ChatMessage.vue `normalizeMath`）：公式段占位保护后，`$`+数字（`$5`/`$100`/`$1,000.50`）→ `\$`，避免被当公式起点。替换串 `"\\$$$1"` = 字面反斜杠 + `$$`（字面$）+ `$1`（捕获组）；注意 `"\\$$1"` 会解析成固定 `\$1` 丢失数字（踩坑）
- **KaTeX LRU 缓存**（katex-marked.ts）：`renderKatex` 加 512 条 LRU（key=`displayMode:tex`），流式渲染只重渲染真正变化的新公式，避免每 delta 全量重渲染（数学密集回复性能优化）
- **验证**：`$100`→`\$100`→渲染 `$100`、`$1,000.50` 正确、`$x^2$`/`$5x^2+3x$`/`$$...$$` 公式不受影响；vue-tsc + npm test 224 全过

### ✅ 表格/公式渲染增强：全角竖线 + 表格裸数学自动包裹（2026-08-30 追加）
- **背景**：用户反馈导数表/积分表仍混乱——① 模型有时用全角竖线 `｜`（GFM 表格只认半角 `|`，表格不识别）；② 公式写裸文本（`x^n`、`1/x`、`√(1-x^2)`、`∫…`）未用 `$...$` → 不渲染 KaTeX；③ KaTeX 不认 Unicode `√`/`−`/`≠` 等
- **修复**（ChatMessage.vue normalizeMath + wrapBareMathInTables）：
  - 全角竖线 `｜`(U+FF5C) → 半角 `|` 且**两侧补空格**（` | `）→ 成为合法列分隔符；补空格是关键——直接转 `|` 会因紧贴内容被内容竖线转义误判成 `\|` 破坏表格
  - **表格单元格裸数学自动包裹**：识别表格块（表头 + 分隔行）→ 按 `|` 拆单元格 → 单元格「纯数学且含强特征（`^`/`√`/`∫`/`∑`/`∞`/`π`/`≠`/`≤`/`≥`/`−`/希腊字母/函数词 ln·sin·cos·tan 等）」→ 自动包 `$...$` 让 KaTeX 渲染；含中文/已是 `$...$` 的单元格跳过（误判防护：普通段落不处理）
  - 包公式前 Unicode → KaTeX 命令：`√(...)`→`\sqrt{...}`、`−`→`-`、`∞`→`\infty`、`∑`→`\sum`、`≠`→`\neq`、`≤`→`\le`、`≥`→`\ge`、markdown 转义竖线 `\|`→`\vert`（否则成双竖线范数）
  - 系统提示（chat.ts）强化：列分隔符用半角 `|`（勿全角 `｜`）、所有数学一律 `$...$` 包裹、单元格内禁止换行
- **验证**：导数表 13 个 KaTeX 节点（`x^n`→`xⁿ`、`n x^{n-1}`→`n xⁿ⁻¹`、`1/√(1-x^2)`→`1/√(1-x²)`、`ln x`/`sin x`/`sec^2 x` 全渲染）；全角竖线积分表 14 节点（`∫ x^n dx`、`ln |x|+C`→`ln∣x∣+C`、`n ≠ −1`→`n \neq -1`）；普通段落 `v^2`/`1/x` 不误包、`$x^2$` 公式不受影响；vue-tsc + npm test 224 全过
- **⚠️ 修复（同日）**：用户实测**无空格分隔行 `|---|---|`** 的导数表仍裸文本——根因：**内容竖线转义**（处理 `|x|` 绝对值时把紧贴非空白的 `|` → `\|`）**误伤表格分隔行**（`|---|` 的 `|` 紧贴 `-`）→ 分隔行被转成 `\|---\|` → `wrapBareMathInTables` 识别不了表格块 → 裸数学包裹失效。这是"正则顾此失彼"的典型。修复：内容竖线转义前**先占位保护表格分隔行**（整行只含 `| - : 空格` 的 `/^\s*\|?[\s:|-]+\|?\s*$/gm`），转义后恢复。修复后无空格/带空格分隔行、全角竖线、绝对值单元格全部正常

### ✅ 重构：normalizeMath 抽取独立模块 + 建立全面渲染测试套件（2026-08-30）
- **抽取**：`src/utils/markdown-math.ts`——把 ChatMessage.vue 内联的数学/表格预处理（normalizeMath + protectCodeSpans + wrapBareMathInTables 等）抽成独立可测试模块，ChatMessage.vue 改为 import；处理顺序用注释固化（保护代码块 → 全角竖线 → 公式 → 分隔行 → 内容竖线 → 货币 → 裸数学包裹）
- **顺带修复**：wrapBareMathInTables **表头也做裸数学包裹**（纯数学表头如「∫ x dx」渲染 KaTeX；含中文表头安全跳过）
- **测试**：新增 `scripts/test-markdown-math.mts`（25 用例），接入 `npm test`——覆盖表格结构（带空格/无空格 `|---|`/对齐 `:---:`/全角竖线/多列/含中文）、公式（`$...$`/`$$...$$`/`\(\)`/`\[\]`/货币）、裸数学（上标/根号/积分/函数词/绝对值/≠）、误判防护（普通段落/代码块/URL/行内代码）
- **验证**：`vue-tsc` + `npm test`（224 + 25）全过；已推送

---

## 2026-08-29

### ✅ 修复：Puppeteer 仍用不存在的 Edge 路径（catalog 硬编码挡住多内核选择）
- **现象**：本机只有 Google Chrome（默认浏览器）、无 Edge，但 puppeteer_navigate 报 `Tried to find the browser at the configured path (/Applications/Microsoft Edge.app/...), but no executable was found`
- **根因**：`mcp-catalog.ts` 的 puppeteer 条目 `env` 里**硬编码了 Edge 路径** `PUPPETEER_EXECUTABLE_PATH`；而 `applyPuppeteerEnv` 逻辑是「env 已存在则尊重」→ catalog 的 Edge 被当作"用户配置"，**多内核选择逻辑根本没机会执行** → 永远用 Edge → 本机无 Edge 就启动失败
- **修复**：
  - `mcp.ts applyPuppeteerEnv`：对 puppeteer 服务器，`PUPPETEER_EXECUTABLE_PATH` **始终走多内核选择**——先 `isFile()` 校验现有路径是否真实存在，不存在则用 `resolveBrowserPath`（探测已装浏览器 + browserEngine 设置 + 系统默认 + 推荐序）覆盖；仅用户手动配置的真实路径才尊重
  - `mcp-catalog.ts`：puppeteer 条目**移除硬编码 Edge 路径**，仅保留视口 `PUPPETEER_LAUNCH_OPTIONS`，描述改为「自动选择本机已安装的 Chromium 系内核」
- **验证**：本机实测——仅 Chrome（默认）存在、Edge 缺失；swift `LSCopyDefaultApplicationURLForURL` 返回 `/Applications/Google Chrome.app`（证明 Rust `system_default_browser` 判定正确）→ `detect_browsers` 返回 chrome(is_default) → `applyPuppeteerEnv` 用 Chrome 路径。vue-tsc + npm test 226 全过

### ✅ 修复：McpSettings 插件面板不适配深浅色（硬编码深色 → 主题变量）
- **现象**：用户反馈插件面板颜色不协调（浅色主题下出现深色卡片块），且插件行文字疑似不可见
- **根因**：McpSettings 样式多处**硬编码深色值**不随主题变化——尤其浏览器内核区块 `.mcp-browser` 用了**不存在的变量 `--bg-soft`**（main.css 无此变量），回退到硬编码 `#0d0d1a` 深色背景 + `#ddd` 浅色文字；`.mcp-input` 也是 `#0d0d1a`/`#ddd`/`#333` 硬编码深色。浏览器预览（Chromium）正常但**浅色主题下是一块突兀的深色卡片**
- **修复**（McpSettings.vue 样式）：全部改为主题变量——`.mcp-browser` 背景 `var(--bg-secondary)`、label 文字 `var(--text-primary)`、hint/note 用 `var(--text-secondary)/var(--text-muted)`、chip 用 `var(--accent-bg)/var(--accent-color)`（默认浏览器 chip 用绿色半透明）、`--bg-soft` → 主题变量、`.mcp-input` 背景/文字/边框 → `var(--bg-secondary)/var(--text-primary)/var(--border-color)`、`.mcp-error` → `var(--danger-bg)/var(--danger-color)`、`.mcp-summary` → `var(--text-muted)`
- **验证**：浏览器 computed style 确认——浅色主题下 browser 背景 `rgb(240,240,243)`（浅色）✅、label/input 文字 `rgb(26,26,46)`（深色）✅；深色主题天然适配（同一套变量）。vue-tsc + npm test 226 全过；HMR 已推送
- **经验**：scoped 样式里的 `var(--xxx, 回退值)` 若变量在全局主题未定义会静默回退成硬编码色——写前先确认变量名存在于 main.css（`--bg-*`/`--text-*`/`--border-color`/`--accent-*` 等）

### ✅ Puppeteer 浏览器多内核适配（Chromium 系：Chrome/Edge/Chromium/Brave + 系统默认浏览器判定）
- **背景**：用户提出浏览器工具只适配了 Edge，希望按「操作系统已安装的浏览器 + 系统默认浏览器」选择可用内核，本期做 Chromium 系，WebKit(Safari) 预留远期
- **Rust（lib.rs）**：新增 `detect_browsers` 命令——`browser_candidates()` 按平台探测已安装浏览器（macOS：/Applications 与 ~/Applications 的 Chrome/Edge/Chromium/Brave/Arc/Safari；Windows：Program Files 各路径；Linux：which google-chrome/chromium/microsoft-edge/brave-browser）+ `system_default_browser()` 判定系统默认浏览器（macOS 用 swift 内联调 `LSCopyDefaultApplicationURLForURL` 读 https 默认 handler，编译失败回退 `defaults read ...LSHandlers`；Linux `xdg-settings`；Windows 注册表 UserChoice）→ 返回 `BrowserInfo{id,name,path,is_default}[]`；注册命令
- **设置项**：`browser_engine`（settings.rs AppSettings + Default + 2 测试字面量 + appSettings.ts 默认 "auto"）
- **前端 mcp.ts**：`applyPuppeteerEnv` 改异步——优先用户手动 env → `resolveBrowserPath(engine)`（选择逻辑抽到 `utils/browser-select.ts` 纯函数 `pickBrowserPath`：显式选择 → 系统默认浏览器（排除 webkit）→ 推荐序 chrome>edge>chromium>brave → null）→ 兜底 Edge 路径；`loadLegacy` 改为同步仅迁移格式（浏览器 env 由 initFromRust 异步应用）；`connect` 连接浏览器服务器前按最新设置重新应用 env；`detectBrowsers` 带缓存单飞
- **McpSettings.vue**：插件面板顶部新增「浏览器自动化内核」区——下拉（自动/Chrome/Edge/Chromium/Brave/WebKit预留）+ 重新检测按钮 + 已检测浏览器 chip 展示（默认浏览器高亮）+ 当前生效描述 + 说明；onMounted 读设置 + 探测
- **测试**：Rust +0（编译验证）；前端 +9（pickBrowserPath：推荐序 chrome>edge>chromium>brave、默认浏览器优先、默认是 webkit 仍选 Chromium、显式选择、显式选未安装回退推荐序、空列表 null、仅 webkit null、推荐序常量）→ npm test 226；cargo test 60 + vue-tsc + vite build 全过
- **踩坑**：①`applyPuppeteerEnv` 变异步后 `loadLegacy` 同步 .map 不兼容 → 改为加载时不注入浏览器（initFromRust await 异步应用）；②macOS 默认浏览器判定优先 swift 内联（LSCopyDefaultApplicationURLForURL 准确），编译失败回退 plist 文本匹配；③终端 cd 持久化坑——切目录后 vite build 找不到 index.html，需 exec zsh -c 强制切回
- **待做**：真实多机验证各平台路径
- **⚠️ 更新（同日）**：用户确认不做 Safari/WebKit 兼容——已移除全部 WebKit 功能代码（McpSettings 下拉的「Safari/WebKit 预留」项、`browser-select.ts` 的 webkit 排除逻辑、`lib.rs` 的 Safari 探测路径/默认浏览器映射、`isBrowserServer` 正则中的 webkit、对应 3 条前端测试断言与注释）。仅保留 Chromium 系内核

### ✅ 工作流 UX 补齐（对标 Dify：外部输入框 + 拖拽新增节点 + 运行状态可视化 + 字段级引用）
- **背景**：用户反馈工作流「运行过程/结果/输入在哪看」「没有拖拽新增节点」，并调研 Dify 工作流后确认「保留并补齐 UX，不做移除」
- **外部输入框**：WorkflowDialog 顶部新增「外部输入（供 {{user}} 占位符引用）」输入框——此前代码有 `externalInput` 变量与注入逻辑但**界面无输入框**（疏漏），补齐后 `{{user}}` 真正可用
- **拖拽新增节点**：vue-flow 标准模式——面板按钮 `draggable` + `@dragstart` 写 `dataTransfer`（`application/x-wf-node-type`）→ 画布 `@dragover.prevent` + `@drop` 用 `useVueFlow().screenToFlowCoordinate` 把鼠标屏幕坐标转画布坐标，在落点创建节点（点击添加仍保留）
- **节点级运行状态可视化**（对标 Dify 调试体验）：`executeWorkflow` 新增可选 `onStep` 回调（`{nodeId, status: running/done/error/skipped, output}`），每个节点开始/结束/跳过时触发；WorkflowDialog 实时刷新节点状态（执行中橙色旋转 ◐ / 成功绿✓ / 失败红✗ / 跳过灰⏭ + 边框变色 + 跳过半透明）；点节点在配置面板显示「运行状态 + 本步输出」；运行前重置全部 waiting
- **字段级变量引用**（对标 Dify 变量系统）：新增 `renderTemplateEx` 支持 `{{id.field}}`（可多级 `{{id.a.b}}`，对象 JSON 化、缺失字段空串）；引擎维护结构化值表 `structured`（节点输出尝试 `tryParseStructured` 解析 JSON 对象/数组），`resolveInputs`/`renderArgs` 改用结构化表 → LLM 节点输出 JSON 对象后下游可按字段引用（如 `{{解析.title}}`）；`WorkflowResult` 增加 `nodeOutputs` 结构化输出
- **其他**：`WorkflowNode` 增加运行期字段 `runStatus`/`runOutput`（可选，`buildGraph` 序列化时剥离不落盘）；面板提示文字更新（添加节点/连线/外部输入/运行入口说明）
- **测试**：Rust +0、前端 +11（renderTemplateEx 整块/单级/多级/缺失/数字；{{j.title}}/{{j.count}} 字段级引用；onStep 回调 running/done/error/下游继续；拖拽落点坐标）→ npm test 217；vue-tsc + vite build 全过
- **踩坑**：①code 节点 `runCodeNode` 内部已吞异常 → 测试 error 状态需用 llmCall 抛错而非 code 节点；②`nodeOutputs` 应返回结构化表而非字符串表

### ✅ 修复：内置文件系统工具报「未知内置工具」（前后端契约不匹配）
- **现象**：模型调 `list_directory`/`read_multiple_files`/`read_file`（提示词「文件系统使用要点」引导的 filesystem MCP 风格名）配 server=app → 走内置分支 switch 无此 case → 报「未知内置工具」
- **根因**：内置工具实现名是 `list_dir`（Rust `read_file` 返回**格式化字符串**如 `【目录】...`，前端 `list_dir` 却期望**结构化数组** `{dir,path,name,size}[]`，`Array.isArray(res)` 恒 false → 一律报「不是目录」；且提示词引导的名字与内置实现不一致）
- **修复**（chat.ts）：`list_dir` 加 `list_directory` 别名；新增 `read_file`/`read_multiple_files` case（复用 Rust `read_file`）；三者**直接原样返回 Rust 字符串**（目录 `【目录】...` / 文件文本），不再期望数组；提示词「文件系统使用要点」统一改为内置名 `list_dir`/`read_file`；`builtin-tools.ts` 登记 `read_file`；modes-catalog 编码模式同步
- **验证**：vue-tsc + npm test 206 + vite build 全过

### ✅ 修复：内置工具调用报「MCP error Tool xxx not found」（主循环漏 default→app 映射）
- **现象**：内置工具（fetch_page/web_search 等）调用报 `MCP error -32602: Tool xxx not found`
- **根因**：`parseToolCall` 对模型省略 server 字段的工具调用兜底为 `"default"`；子代理循环（1275 行）有 `default→app` 映射，**主代理循环（2502 行）漏了** → `"default"` 不匹配 `callMcpTool` 的 `app/builtin` 分支 → 误走 MCP 执行路径 → MCP 服务器报工具不存在
- **修复**：主循环新增 `const toolServer = tc.server && tc.server !== "default" ? tc.server : "app"`，调用与工具卡片 server 显示统一用映射值，与子代理循环一致
- **验证**：vue-tsc + npm test 206 + vite build 全过

### ✅ 修复：WKWebView 白屏（lookbehind 正则 + .at() 不兼容旧内核）
- **现象**：Tauri 窗口白屏（浏览器预览正常）；随后控制台报 `SyntaxError: Invalid regular expression: invalid group specifier name`
- **根因链**：①`devUrl` 用 `localhost`（macOS 解析为 IPv6 `::1`）而 Vite 只绑 IPv4 `127.0.0.1` → WKWebView 连不上；②`local-file-re.ts` 的 `LOCAL_FILE_RE` 用了 **lookbehind `(?<!...)`**（ES2018，旧 WebKit 不支持）→ 模块加载即 SyntaxError → 白屏；③`App.vue` 用 `.at(-1)`（ES2022）同类隐患
- **修复**：①`tauri.conf.json` devUrl 改 `http://127.0.0.1:1420`（与 Vite 一致）；②`LOCAL_FILE_RE` 改「前缀捕获组」`(^|[^\w\/:])`，group1=前导字符 group2=路径，`ChatMessage.vue` 取 `m[2]`、`idx=m.index+m[1].length`（8 组对照测试证明新旧行为完全等价：句首/句中/~/URL 不误判/连续/中文前导/跨行）；③`App.vue` 的 `.at(-1)` 改 `length-1` 兼容写法
- **验证**：vue-tsc + npm test 206 + vite build 全过；WKWebView 与 127.0.0.1:1420 建立 ESTABLISHED 连接

---

## 2026-08-28

### ✅ IM 网关落地（§3.10 ③，用户确认国内平台：钉钉 / 飞书 / 企业微信）
- **背景**：用户确认 IM 平台「国内的吧，国外的访问不了」→ 选型钉钉 / 飞书 / 企微（方案 `docs/IM_GATEWAY.md`）
- **框架**：新增 `src-tauri/src/im.rs`——`ImConfig`（platform/enabled/whitelist/trigger/system_prompt/max_context + 三平台凭据，存 `settings.im_config` 整体 AES-256-GCM 加密落盘）+ `ImAdapter` trait（async-trait：`poll_updates`/`send_message`）+ `ReplyGenerator`（宿主注入便于 mock）+ `ImGateway`（消息去重 HashSet / 白名单 chat_id / 触发前缀剥离 / 每会话最近 N 条上下文 / 同会话 20s 限流 / 调 LLM 生成回复并回发）+ `ImGatewayState`（running/日志/最近消息，`Arc<Mutex>` 前端轮询）
- **适配器**：`WecomAdapter`（企微只推不接：`gettoken`→`message/send`，可测 token 解析）、`DingtalkAdapter`（stream 长连接：`oauth2/accessToken`→`gateway/connections/open`→wss 发 CONNECTED→收 PING 回 PONG→DATA AES-CBC 解密→`robot/oToMessages/batchSend`）、`FeishuAdapter`（长连接：`tenant_access_token`→`bot/v2/ws/endpoint`→wss 认证帧→事件解密→`im/v1/messages` 发送）；纯函数 `decrypt_dingtalk_data`/`decrypt_feishu_data`（AES-256-CBC，key 派生方式按平台文档，自加密-解密往返测试）
- **命令/生命周期**：`im_start`（读设置 im_config→validate→build adapter→`tauri::async_runtime::spawn` 后台常驻，handle 存 static 供 abort）/`im_stop`（abort + 状态复位）/`im_status`（快照）；setup 里 `app.manage(im::ImGatewayState::shared())`
- **回复生成**：`LlmReplyGen`（lib.rs）每次回复独立开 DB + SecretCipher 读活跃 profile → `api::chat_once` 非流式生成，IM 内置精简系统提示词
- **前端**：`appSettings.ts` 加 `imConfig`；新组件 `ImGatewayPanel.vue`（平台选择 + 分平台凭据 + 白名单/触发前缀/上下文条数/系统提示词 + 保存/启动/停止 + 运行状态/日志/最近消息 3s 轮询）；`SettingsDialog` 新增「即时聊天」Tab
- **测试**：Rust +5（gateway 去重 / 白名单过滤 / 触发前缀剥离 / 钉钉+飞书解密往返 / 企微 token 解析）→ cargo test 59；npm test 189 + vue-tsc + vite build 全过。**待做**：真实凭据实连验证（协议细节按官方文档实现，未在真实平台实测）
- **踩坑**：①reqwest 0.12 **无 websocket feature**（错误提示列出全部可用 feature 亦无）——WebSocket 帧编解码需专用库，改用 `tokio-tungstenite 0.24`（rustls-tls-webpki-roots）+ `futures-util`（直接 use 需直接依赖）+ `async-trait`；②cipher 0.4.4 `encrypt_padded_mut::<Pkcs7>` 需第 2 参 msg_len；③`self.history.entry().or_default()` 的 &mut 借用贯穿到 `self.reply.reply()` 冲突 → 借用块内结束 + `get().cloned()` 取快照；④`ws.as_mut()` 顶部绑定与 PING 处理内再取冲突（E0499）→ 用块内 `let ws = self.ws.as_mut()?` 每次独立借用

### ✅ 修复：本地创作/生图类请求误触发联网搜索
- **背景**：用户「你能画一幅山水画吗」触发自动联网搜索（结果「维基'你'词条、手绘视频教程」无关）——创作类请求本地（HTML/CSS/SVG）即可完成，无需联网
- **修复**：`search-gate.ts shouldSkipAutoSearch` 新增 `ART_CREATE` 规则（画/绘制/画画/作画/画一幅/创作/插画/海报/logo/banner/漫画/表情包/配图/示意图/流程图/思维导图/数据图表/做一张/来一张/生成…图）且无明确联网意图词（教程/怎么/找素材等）→ 跳过自动搜索；多模态视觉模型本地即可理解画面，无需联网教程
- 测试：+6 项（画山水画/画 logo/创作插画/画流程图/做海报 跳过；「怎么画好山水画（想学教程）」仍搜索）→ npm test 189

### 📋 Agent 多模式规划（§3.11 + ROADMAP 近期清单⑥）
- 用户建议：Agent 应像自动化编码助手一样有多种运行模式（任务模式/办公模式等）。设计：**模式 = 系统提示词 + 工具集约束 + 行为风格 + 界面入口**，与角色 persona（我是谁）正交（怎么做）。6 模式：对话(默认)/任务(自动规划→执行→自测→汇报，复用 task-plan)/办公(文档导出规范+知识库 RAG)/研究(检索优先)/编码(语义索引+测试+git)/速答(禁工具低延迟)。Phase A 落地 modes-catalog + 注入 + 输入框切换 UI + 任务/办公模式打通框架；远期自定义模式/模式市场

### ✅ Agent 多模式 Phase A 落地（§3.11）
- **数据**：新建 `src/data/modes-catalog.ts`——`AgentModeId`（chat/task/office/research/coding/quick）+ `AgentMode`（id/name/emoji/description/**prompt 行为提示词**/**allowedTools 工具白名单**）+ `getModeById`/`isToolAllowedByMode`（undefined=不限；`[]`=禁全部（速答）；数组=仅允许）+ 6 模式定义（对话无约束 / 任务引导 plan_task 自动拆解→执行→汇报 / 办公含文档导出规范（CSV/HTML 行列对齐、如实报文件数）+ kb_search 优先 / 研究检索优先来源可溯 / 编码 code_index/code_search+测试 / 速答极简禁工具）
- **提示词注入**：`chat.ts sendMessage` persona 前缀后、skills 前注入「【当前模式：X】+ prompt」——人格管"我是谁"，模式管"怎么做"，二者互补
- **工具约束**：`callMcpTool` 入口加模式白名单拦截（覆盖内置+MCP 所有工具），速答模式返回引导提示
- **状态/持久化**：模块级 `activeModeId` ref（模块级供 callMcpTool 使用，初始从 localStorage 读 `daoshengyi_mode`）+ store `setMode` 写入 localStorage；store return 导出 activeModeId/setMode
- **UI**：`ChatInput.vue` 新增「模式」pill 下拉（6 模式，emoji+名称+描述+✓ 高亮，点击外部关闭），放在联网按钮旁
- 测试：+17 项（6 模式齐全 / getModeById 命中与未知 / 工具白名单 chat 不限 task 允许 plan_task quick 全禁 / 各模式有行为提示词）→ npm test 206；vue-tsc + vite build 全过。**待做**：Phase B（研究/编码深化、模式记忆）、Phase C（自定义模式/市场）

### ✅ 会话级权限记忆（§3.10 🟡）
- **背景**：开启「文件编辑需确认」后，Agent 多次改文件每次都弹 diff 确认，重复打扰
- **落地**：chat.ts 模块级 `sessionPermits` reactive Set（仅本会话有效，不落盘）+ `hasSessionPermit`/`rememberSessionPermit`/`clearSessionPermits`（store 导出）；`replace_string`/`insert_string`/`delete_file` 三个确认点在请求前检查会话允许集（命中直接放行），`EditConfirmRequest` 加 `rememberLabel` 提示文案；`DiffConfirmDialog` 加「本会话内不再询问」勾选——勾选后点「应用」先 `rememberSessionPermit(tool)` 再 `resolveEditConfirm(true)`，后续同工具不再弹确认
- 验证：vue-tsc + vite build 全过

### ✅ 审计可视化面板（§3.10 🟡）
- **后端**：db.rs `clear_tool_audit`（清空）+ lib.rs `clear_tool_audit` 命令 + 注册；tool_audit 表数据由 `log_tool_call` 自动记录（command/git/test/内置工具审计，已接入）
- **前端**：新组件 `AuditPanel.vue`（设置「审计」Tab）——最近 300 条工具调用列表（工具名徽标 + 时间 + 时长 + ✅/❌ 色点 + 参数截断）、按工具名关键词与状态（全部/成功/失败）筛选、点击展开回放完整参数与结果（参数 JSON 美化）、导出 JSON / Markdown、按工具聚合统计（点击快速筛选）、清空
- 验证：cargo test 59 + vue-tsc + vite build 全过

### ✅ 撤销操作回放面板（§3.10 ① 待做项）
- 新组件 `UndoPanel.vue`（设置「撤销」Tab）：`undo_history` 快照列表（编辑/新建/删除 徽标 + 路径 + 时间 + 「已不存在」标记）、按路径/操作筛选、点击展开**原始内容快照**（回滚依据）、一键回滚（`undo_by_id` + notify 提示 + 刷新，回滚后记录移除）、导出 JSON
- 验证：vue-tsc + vite build 全过

### ✅ 符号跳转（P-A3 语义索引待做项）
- **后端**：db.rs `CodeChunkRow` 加 `start_line`（1-based）——`code_search` 排序后对每个命中分块实时计算其在源文件中的起始行号（`chunk_start_line`：chunk 首行 trim 与文件行逐行比对，文件不可读/找不到返回 1）+ 测试 +1；`open_file` 加 `line: Option<i64>`——有行号时优先 VSCode CLI `code --goto path:line`（status Err/非零回退系统默认应用打开）
- **前端**：`code_search` 内置工具返回格式改为 `[n] file:行号`；`ChatMessage.vue linkifyLocalPaths` 改用 `matchAll`——识别路径后紧跟的 `:数字` 一并捕获为 `data-line`，链接显示 `📄 文件名:行号`；点击打开时传 `line`（VSCode 跳行，无 VSCode 则打开文件）
- 验证：cargo test 60（+1）+ npm test 206 + vue-tsc + vite build 全过。**待做**：定义/引用跳转（tree-sitter 语义级）

### ✅ 外部编码 Agent 阶段三（§3.10 🟡：零外部依赖）
- 彻底移除 `delegate_coding_agent`（Claude Code / Codex CLI 委派）：
  - Rust lib.rs 删 `delegate_coding_agent` 命令 + `check_coding_agents`/`check_coding_agent` + `CodingAgentInfo`/`CodingAgentResult`/`parse_cli_tokens`/`which_path`（`run_sys_cmd` 保留，系统健康面板仍用）+ 命令注册
  - 前端删 `BUILTIN_TOOLS.delegate_coding_agent` 定义 + 主提示词描述 + `callBuiltinTool` case + `CodingAgentResult` 类型
  - 编码任务由内置能力承接：git / replace_string / run_tests / 子代理（subagent_delegate/subagent_parallel/subagent_broadcast 等，P-M1~M4 全链路）
- 验证：cargo test 60 + npm test 206 + vue-tsc + vite build 全过（0 警告）

### ✅ Agent 多模式 Phase B：模式记忆
- chat.ts `setMode` 记录模式使用频次（localStorage `daoshengyi_mode_hist`）；`loadMode` 未显式保存时用历史最高频模式（默认对话）；`readModeHist` 导出
- `ChatInput` 模式下拉显示「常用 ×N」标签
- 验证：vue-tsc + vite build 全过

---

## 2026-08-27

### ✅ 工作流 UI 优化（§3.10 ⑤，工作流编辑器可用化）
- **背景**：用户反馈「编辑器还是半成品、好多功能需要优化、甚至节点都无法连线」——默认 vue-flow 节点连接点不可见、难拖线
- **落地**：`WorkflowDialog.vue` 接入已备好的 `WorkflowNodeView.vue` 自定义节点（`markRaw` + `nodeTypes`）：节点**显式渲染可拖拽连线 Handle**——顶部入口（target）+ 底部出口（source）；**条件节点底部双出点**（蓝「T」true / 红「F」false），从对应连接点拖线**自动带分支标签**（connectEdge 读 sourceHandle），无需手动填写；连线/导入/模板/载入工作流时把分支标签同步到 vue-flow 边显示；`fit-view-on-init` + `min-zoom 0.1` 大图自动适配；移除自定义节点外的重复边框样式（节点自带）
- **踩坑**：`nodeTypes` 里 `markRaw(WorkflowNodeView)` 与 vue-flow 1.x `NodeTypesObject`（要求 NodeComponent 含 id/type/selected 等 NodeProps）类型不兼容 → 用宽松断言 `as any`（运行时正确）
- 验证：vue-tsc + vite build 全过

### ✅ 工作流持久化 + 运行历史（§3.10 ④落地）
- **后端**：db.rs 加 `workflows` 表（`name` 唯一，同名保存即更新 graph+updated_at）+ `workflow_runs` 表（wf_id 可空，历史保留 wf_name 快照）+ `wf_save`/`wf_list`/`wf_get`/`wf_delete`/`wf_run_add`/`wf_runs` + `WorkflowRow`/`WorkflowRunRow`；lib.rs 命令 `workflow_save`/`workflow_list`/`workflow_get`/`workflow_delete`/`workflow_run_add`/`workflow_runs` + 注册
- **前端**：`WorkflowDialog.vue` 顶部工具栏——名称输入 +「保存」（`workflow_save`）、「我的工作流」下拉（`workflow_list` + `workflow_get` 载入）、「删除当前」、「刷新」；运行成功/失败自动 `workflow_run_add` 记录（摘要=终端输出前 2 项/错误信息）；底部新增「运行历史」列（✓/✗ 状态 + 名称 + 时间 + 摘要）
- 测试：Rust +2（workflow_save_upsert_list_get_delete：同名更新同 id/列表/读取/删除；workflow_run_history_records_and_lists：记录+倒序+删流不影响历史）→ cargo test 54；vue-tsc + vite build 全过

### ✅ 知识库 RAG 自动注入（§3.10 ③落地）
- **设置**：settings.rs `AppSettings` 加 `rag_enabled`（默认关）/`rag_kb`（空=未配置）字段（serde default + Default + 2 测试字面量同步）+ appSettings.ts 接口与默认值
- **注入**：`chat.ts sendMessage` 在记忆注入后、`ragInjectedConvs` 集合判断**会话首轮只注入一次**（避免每轮重复灌入膨胀上下文）——开启且配置默认知识库时自动 `kb_search` 检索用户消息相关分块（limit 4，5s 超时兜底）注入 volatileCtx「知识库相关上下文（自动检索，非必须逐条引用）」；精细引用仍可让模型手动 kb_search
- **设置 UI**：`SettingsDialog.vue` 新增「知识库」Tab（Database 图标）——自动注入开关 + 默认知识库下拉（kb_list 展示名称+分块数，默认库失效自动兜底第一个）+ 刷新按钮
- 验证：cargo test 52 + vue-tsc + vite build 全过。**踩坑**：multi_replace 时两个测试字面量文本相同导致「Multiple matches」——字段被加进测试却漏了 `Default impl`（改字段类改 4 处：serde 默认 + Default + 各测试字面量，务必逐一核对）

### ✅ 项目语义索引 / 自然语言找代码（§3.10 ②落地，P-A3 补全）
- **后端**：db.rs `code_chunks` 表（root/file/chunk/embedding，按项目组织）+ `code_clear`/`code_add_chunk`/`code_search`（余弦相似度召回）/`code_roots`/`code_stats` + `CodeChunkRow`；lib.rs `code_index` 命令（扫描代码扩展名文件 → 跳过 node_modules/.git/target/dist 与大文件（<512KB）→ `chunk_text` 500 分块 → Ollama `nomic-embed-text` 批量向量化（20/批，重建式；Ollama 不可用明确报错引导部署））、`code_search`（查询嵌入→余弦召回）、`code_roots`/`code_stats`/`code_delete` + 注册
- **前端**：内置工具 `code_index`/`code_search`/`code_roots`/`code_stats`/`code_delete`（callBuiltinTool 分支，code_search 返回 `[文件#分块]` + 代码片段）+ BUILTIN_TOOLS 描述 + 主提示词描述（「找 XX 代码」先 code_index 再 code_search，命中后 read_file 精读）
- **测试**：Rust 新增 1 项（code_index_search_recalls_relevant_chunk：余弦召回/跨项目隔离/roots/stats/清空）→ cargo test 52；vue-tsc + vite build 全过。**待做**：符号跳转（定义/引用）

### ✅ 会话内撤销最近操作（§3.10 ①落地）
- **后端**：db.rs 加 `undo_history` 表（action/path/backup/existed/created_at）+ `record_undo`/`list_undo`/`undo_by_id`（edit=恢复原内容、create=删除新建文件、delete=恢复被删文件，回滚后删记录）+ `UndoRow` 结构体；lib.rs `apply_edits` 重构为 `compute_edits` 纯函数 + 命令层（写盘前读原内容记录 undo），`delete_file_agent` 重构为 `delete_file_impl` + 命令层（删前备份记录 undo），`write_file_agent` 写前快照（存在→edit / 不存在→create）；新命令 `list_undo`/`undo_by_id` + 注册
- **前端**：`callBuiltinTool` 文件写/删工具成功返回后 `dispatchEvent("undo-changed")`；新建 `UndoBubble.vue`（右下角悬浮气泡：显示最近一条「编辑/新建/删除 + 文件名」，点一键回滚，undo 后 notify 提示并刷新）；App.vue 挂载
- **测试**：Rust 新增 4 项（undo_edit_restores / undo_create_deletes / undo_delete_restores / undo_unknown_id）→ cargo test 51；vue-tsc + vite build 全过。**待做**：操作回放面板（审计可视化）

### 📋 开发方向规划（近期路线写入计划与路线图）
- 按「本地可立即开发（自包含、价值高）」整理近期路线：写入 **DEVELOPMENT_PLAN §3.10 近期开发方向** + **ROADMAP 近期落地清单**——🟢 ①会话内「撤销最近操作」（复用 apply_edits/tool_audit）②项目语义索引/自然语言找代码（复用 ollama_embed/kb_chunks，P-A3 补全）③IM 网关远程驱动（方案 docs/IM_GATEWAY.md 已备，补 send_im 只发不收）④知识库 RAG 自动注入 ⑤工作流持久化+运行历史；🟡 会话级权限记忆/审计可视化面板/移除外部委派；🔵 插件生态/跨设备同步/云端工作流市场为远期

### ✅ 弹窗统一改造 + 回复中断修复
- **弹窗关不掉**：`ChatMessage.vue` 点「文件不存在」提示用 `window.alert`，Tauri 2 + macOS WKWebView 下 `alert/confirm` 有已知「弹窗关不掉/无响应」问题 → 新建 `src/utils/dialog.ts`（`notify` 用 `@tauri-apps/plugin-dialog` 的 `message`、`askConfirm` 用 `ask`，原生对话框可正常关闭；非 Tauri 回退 alert/confirm）；ChatMessage/ChatInput 的 8 处 `alert` → `notify`，chat.ts 危险命令审批 2 处 `window.confirm` → `askConfirm`
- **回复中断（只思考无正文/工具没执行）**：日志 `[loop] 第 0 轮结束，toolCall=null，content 4508 / streamingContent 62 / reasoning 4289`——模型在思考里规划（4289 字符），正文输出含**未闭合的工具调用开标记**（visibleText 剥掉后只剩 62 字符残句），`hasCompleteToolCall` 为 false 不走格式修正重试、`isVagueBody` 判非空洞 → break → 中断 → 新增 `tool-call.ts hasToolCallIntent`（检测工具调用**开标记**：标准 `<tool_call`、DSML `<｜DSML｜tool_call｜` 含半截 `tool_`、伪卡片 `### 🔧 调用工具`，无论是否闭合）；主循环 `!tc` 分支在格式无效重试后插入「有意图但未闭合 → 注入修正指令重试」分支，避免「想调工具但标记不完整 → 工具没执行 → 回复中断」
- 测试：新增 7 项（hasToolCallIntent 开标记/半截/夹杂正文/普通回复/空）→ npm test 183；vue-tsc + vite build 全过

### ✅ 修复：agent 生成 HTML 表格排版错位（行列数不齐）
- **根因**：LLM 手工拼 HTML 表格时**行内 `<td>` 数量与表头不一致**（表头 5 列、数据行却有 6~7 个单元格），浏览器自动错位显示（截图：近两年缴费明细表格每行列数不一、列错位）
- **修复**（提示词「文件导出规范」表格部分重写）：①表格文档优先 **CSV**（Excel 直接打开，行列最稳）；②**HTML 表格必须行列对齐**——每行 `<td>`/`<th>` 数量与表头完全一致，禁止行内单元格数不齐，跨列/跨行用 `colspan`/`rowspan` 显式声明并保持总列数不变，并给出最小 `<table>` 模板示例；③CSV 单元格含逗号/换行/中文标点用双引号包裹、每行列数一致、UTF-8；④如实说明无法生成二进制 xlsx/docx
- 验证：npm test 176 + vue-tsc + vite build 全过

### ✅ 修复：本地文件链接把 .html 误识别成 .h（路径错误打不开）
- **根因**：`ChatMessage.vue` 的 `LOCAL_FILE_RE` 扩展名备选顺序 `...|c|cpp|h|hpp|html?|...` 中 **`h` 排在 `html?` 前**，正则引擎从左到右匹配，遇到 `.html` 时 `h` 分支先命中 → 路径被截断成 `xxx.html` 的 `.h` 部分（链接显示 `...2026.05.h`、点击 `file_exists` 校验失败打不开）——正是用户「社保参保证明 html 路径不对」的根因
- **修复**：把正则提取到 `src/utils/local-file-re.ts`（可测），扩展名**长优先**重排 `cpp|c|hpp|html?|h`；ChatMessage.vue import 复用
- 测试：新增 14 项（含点中文文件名 .html 完整匹配、h/cpp/c/hpp 各归其位、URL 不误判、无扩展名不匹配）→ npm test 176；vue-tsc + vite build 全过

### ✅ 文件导出规范强化：如实报告文件数量 + 表格文档格式引导
- **背景**：用户对参保证明附件要求「转成清晰表格文档」，agent 回复「已生成两份表格文档」却只列出一个 `.html` 链接（文件数量谎报），且用户要的是表格文档（Excel/Word）得到的是 `.html`
- **修复**（提示词「文件导出规范」）：①**如实报告文件数量**——生成了几个就引用几个（每个都是 write_file 真实返回路径），禁止声称「N 份/两个版本」除非确实写入了 N 个文件，多个文件必须全部列出；②**表格文档格式引导**——用户要表格文档/Excel/CSV 时生成 **CSV**（Excel 可打开）或 **HTML 表格**（可打印）并说明格式，当前无法生成二进制 .xlsx/.docx，**禁止假装生成了 Excel/Word 文件**
- 验证：npm test 162 + vue-tsc + vite build 全过

### ✅ 自动搜索误触发修复：文档/附件处理类不再联网搜索
- **根因**：发送前自动搜索（enableWebSearch 开关）的跳过逻辑只覆盖「本地文件系统类」，未覆盖**文档/附件处理类**——用户对参保证明附件回复「转成清晰表格文档」（本地格式转换请求），被清洗成关键词联网搜索（界面出现「正在联网搜索：转成清晰表格文档...」），不合理
- **修复**：新建 `src/utils/search-gate.ts` 纯函数 `shouldSkipAutoSearch(text)`（可测），自动搜索跳过规则：①本地文件系统类（本地路径+目录词/纯目录词且无联网意图）②**文档/附件处理类** `DOC_EDIT`（转成/整理/汇总/提取/解读/编辑/翻译/生成/分析 + 表格/文档/excel/word/pdf/清单/报告/证明/截图/文件/附件…）且**无明确联网意图词**（新闻/最新/政策/怎么/是什么…）——含联网意图仍搜索；chat.ts 自动搜索判断改为调用该纯函数。**经验**：本地处理请求（转格式/整理附件）与联网检索要区分触发，启发式按「动词+处理对象」识别 + 联网意图词兜底
- 测试：新增 13 项 → npm test 162；vue-tsc + vite build 全过

### ✅ 停止即时化 + 记忆分层 1.4 + 写入触发 2.3 + P-A4 diff 确认
- **停止不即时修复（真正立刻停）**：此前停止只在前端移除监听，**Rust 端 `send_message` 仍在继续拉流/emit/耗 token** → 新增 `CANCELLED_STREAMS` 取消集合 + `cancel_stream(request_id)` 命令；`send_message` 每收到一个 chunk 前检查，命中即停止生成并 emit sse-done；前端 `activeStreamRequestId` 记录当前流式 id，`stopStreaming` 立即 `invoke("cancel_stream")`——流式生成**下一个 chunk 到达即停**（毫秒级）。已存在的 stopRequested/waitStopSignal 负责中断工具循环。验证：cargo check 0 警告
- **长期记忆 1.4 记忆分层（episodic 聚合层）**：新建 `src/utils/memory-episodic.ts` 纯函数 `buildEpisodicPrompt`（把会话摘要交给 LLM 提炼跨会话反复出现的主题）/`parseEpisodic`（宽松解析、剥离代码块、标题截断 12 字）；db.rs 加 `memory_episodic` 表（id/title/summary/source_summary_ids/created_at/updated_at）+ `save_episodic`/`list_episodic`/`delete_episodic`/`episodic_covered`（收集已汇总摘要 id 避免重复）；lib.rs 命令 `list_episodic`/`save_episodic_cmd`/`delete_episodic_cmd`/`episodic_covered`；memory.ts `aggregateEpisodic(config)`（取最近 60 条摘要 → 过滤未汇总 → LLM 提炼 → 保存）；MemoryPanel 加「跨会话汇总」按钮 + 主题列表（紫色分层区块）。**踩坑**：multi_replace 时误删了「会话摘要」区块导致 History 图标未使用报 TS6133——补回区块。测试：前端 6 项（episodic 纯函数）+ Rust 1 项（episodic_save_list_covered_delete）→ npm test 149、cargo test 46
- **长期记忆 2.3 写入触发优化**：新建 `src/utils/memory-extract.ts` 纯函数 `shouldExtractMessages`（消息条数 ≥6 且有效正文 ≥120 字符才提取，工具/系统消息不参与正文统计）/`extractGateReason`；memory.ts `extractFacts` 开头接入门槛，对话过短/纯寒暄/过程性问答跳过 LLM 提取（失败静默），避免每次对话都调模型生成低价值事实导致记忆库堆积。**踩坑**：默认字符门槛 200 偏高误伤真实对话（8 条实质性对话仅 142 字符）→ 调低到 120。测试：前端 6 项 → npm test 149
- **P-A4 应用内 diff「确认后应用」UI**：`apply_edits` 加 `preview: bool` 参数（preview=true 只算 unified diff 不写盘，summary 标注「预览/未写盘」）+ 6 处测试调用点同步 + 新测试 `apply_edits_preview_does_not_write`（预览不写盘、随后应用才写盘）；AppSettings 加 `file_edit_confirm`（serde 默认 + Default + 2 测试字面量）+ appSettings.ts `fileEditConfirm`；chat.ts 新增 `EditConfirmRequest` 状态 + `requestEditConfirm`（Promise 挂起，**点停止自动按拒绝**避免工具循环卡死）/`resolveEditConfirm`，`replace_string`/`insert_string` 开启确认时先 `apply_edits(preview=true)` 拿 diff → 确认后写盘，`delete_file` 确认路径后才删；新组件 `DiffConfirmDialog.vue`（Teleport 弹窗：diff 深色高亮 + 路径 + 应用/拒绝，挂到 App.vue）；SettingsDialog 权限 tab 加「文件编辑需确认」开关。**踩坑**：Vue 模板 `v-if="req.kind === "edit""` 双引号嵌套致 vite build 报 Unterminated/解析错误——用单引号 `'edit'`。测试：cargo test 47（+preview 1 项）
- **验证**：cargo check 0 警告；cargo test --lib 47 全过；npm test 149 全过；vue-tsc + vite build 全过

### ✅ 长期记忆 §3 补全 + Phase 3 知识库 RAG + Phase 5 系统托盘 + 可视化工作流
- **长期记忆 §3 补全（2.2/3.2/3.3）**：新建 `src/utils/memory-format.ts` 纯函数——`formatMemoriesBlock`（**来源标注**：类型/重要度/相对时间 + **1200 字符注入剪裁**并提示截断）、`pickForgetCandidates`（重要度≤2 + 30 天未访问 + 非偏好 = **遗忘候选**）、`relTime`/`factTypeLabel`；`memory.ts retrieveMemories` 接入 memoryEnabled 开关 + memoryRecallLimit 检索条数（settings.rs/appSettings 加字段）+ 剪裁；`MemoryPanel` 加「记忆配置」行（启用开关 + 检索条数）+「遗忘候选」区块（可删除）。**踩坑**：P-A9 曾误删 BookOpen/History 图标导入——vue-tsc/vite build 都不报（模板引用不检），**运行时才崩**；改 .vue 导入后必须核对模板引用
- **Phase 3 知识库 RAG**：db.rs 加 `kb_chunks`/`kb_chunks_fts` 表 + `kb_clear`/`kb_add_chunk`/`kb_search`/`kb_list`/`kb_delete`（FTS5 unigram 复用 cjk_terms）；lib.rs 命令 `kb_index`（**`chunk_text` 800 字符分块**、md/txt/代码/PDF、P-A8 沙箱白名单、重建式）/`kb_search`/`kb_list`/`kb_delete`；前端内置工具 `kb_index`/`kb_search`/`kb_list` + BUILTIN_TOOLS 描述。**踩坑**：KbChunk/KbInfo 结构体必须在 db.rs **模块级**（不能放 impl 块内）；`kb_index` 内 base64 需 `use base64::Engine as _`
- **Phase 5 系统托盘**：Cargo 开 `tray-icon` feature；`TrayIconBuilder`——**macOS 模板图**（gen-icons.cjs 生成纯黑 `tray-icon.png` + `.icon_as_template(true)` 自动适配深/浅菜单栏，不能用彩色 app 图标会带色块）；左键切换窗口、右键菜单（显示/新建对话/退出）；复用 `menu://action` 事件通道。**踩坑**：`tray.app_handle()` 返回 `&AppHandle` 非 Option
- **Phase 3 可视化工作流编辑器**：依赖 `@vue-flow/core@1.48`；`src/utils/workflow-engine.ts` 纯 DAG 引擎——`topoSort`（拓扑序 + 环检测）/`renderTemplate`（`{{id}}` 占位替换）/`executeWorkflow`（text/llm/tool/end 节点，LLM/工具调用经 `WorkflowRuntime` 注入可测、外部输入 `{{user}}`）；`WorkflowDialog.vue`——Vue Flow 画布 + 节点面板（文本/LLM/工具/结束）+ 点击配置（LLM 提示词/模型、工具名+参数 JSON、文本内容）+ 运行（LLM 走 chat_once、工具走 callMcpTool）+ 运行日志/终端输出 + 导入/导出 JSON；入口=工具菜单「可视化工作流」（ui.workflowOpen）。**踩坑**：①vue-flow 1.x `Node`/`Edge` 泛型极深触发 **TS2589 深度实例化**——内部 ref 用 `any[]` 承载；②模板内字面 `{{...}}` 会被 Vue 当插值/字符串引号混用报「Unterminated string constant」——用 HTML 实体 `&#123;&#123;` 表示字面占位符
- **知识库语义向量检索（Ollama 分块 embedding）**：db.rs `kb_chunks` 加 `embedding BLOB`（`f32::to_le_bytes` 序列化 + 余弦）+ 迁移 `ALTER TABLE`；`kb_search_hybrid` **混合检索**——FTS5 关键词 bm25 命中在前、语义向量余弦补充召回未命中分块（追加、去重、截 limit），删除被取代的纯关键词 `kb_search`（消除 dead-code 警告）；lib.rs `ollama_embed_impl` 重构为可复用异步核心（`ollama_running` + `embed_model_installed` 探测 + localhost:11434/api/embed + 30s 超时），`kb_index` 改异步按批（20/批）生成分块 embedding、Ollama 不可用自动回退纯关键词，`kb_search` 命令改走 hybrid（查询词嵌入 + `kb_search_hybrid`）；前端 `kb_search` 工具描述注明语义向量。**自测**：Rust 新增 `kb_hybrid_semantic_recalls_similar_chunk`（无公共词的分块靠余弦召回）→ **cargo test --lib 45**，cargo check **0 警告**
- **可视化工作流：条件分支 + 代码节点**：`workflow-engine.ts` 新增——①**condition 条件分支**：安全布尔表达式求值器 `evalCondition`（tokenizer + 递归下降解析器 CondParser，支持 `{{id}}` 占位符 / 裸节点 id 引用 / 字符串 / 数字 / `true|false`，运算符 `== != > < >= <= contains startsWith endsWith && || !` 及 `and or not` 关键字，非法表达式安全返回 false）；condition 节点把结果写为 `"true"/"false"`，其出边带 `label`（true/false）做分支路由，未激活分支的节点**跳过不执行**（`skippedIds` 集合，且跳过死端不计入终端输出）；无 label 条件边向后兼容始终激活；`WorkflowEdge.label` 字段。②**code 代码节点**：`runCodeNode` 用 `new Function("input","outputs", body)` 执行用户 JS，异常捕获为文案、对象 JSON 序列化、undefined 返回空串。`WorkflowDialog.vue`：面板加 条件/代码 按钮、inspector 加表达式/代码编辑、**点选连线**编辑分支标签（仅条件源边显示，`@edge-click` + selectedEdgeId + data.edge 承载 WorkflowEdge）、导入导出保留 label。**踩坑**：①Node 24 类型剥离**不支持构造函数参数属性**（`constructor(private x: T)`）→ ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，改普通字段赋值；②表达式操作符转小写后 `condEval` 比较必须一致（写 `"startswith"`/`"endswith"` 而非驼峰）；③跳过分支的死端节点会被终端过滤误收——用 `skippedIds` 排除。测试：新增 27 项（求值器 14 + 代码节点 5 + 分支路由/跳过/合流/兼容 8）→ **npm test 124**；vue-tsc + vite build 全过。
- **Phase 5 全局快捷键**：Cargo 加 `tauri-plugin-global-shortcut`；capabilities 加 `global-shortcut:default`；lib.rs plugin `Builder::with_handler` + setup 注册——`CommandOrControl+Shift+Space`（显示/隐藏主窗口，快速召唤）与 `CommandOrControl+Shift+K`（新建对话，复用 `menu://action` 通道）；`OnceLock<Shortcut>` 供 handler 比对快捷键；「关于」对话框展示快捷键（⌘⇧Space / ⌘⇧K）。**踩坑**：`global_shortcut().register()` 返回 `Result<(), _>`（无句柄），需先 `Shortcut::from_str` 解析出 Shortcut 存 OnceLock 再用它注册与比对。验证：cargo check + cargo test --lib 45 全过；vue-tsc + vite build 全过。待做：设置页可自定义快捷键
- **可视化工作流：内置模板库（为「工作流市场」打基础）**：新建 `src/data/workflow-templates.ts`——4 个模板（研究助手=LLM规划→联网搜索→LLM综合；文案润色；日报生成；**Bug 分流=LLM 判级→condition 条件分支→不同处理→合流**），模板用可读短 id（user/llm1/tool1…），节点间 `{{id}}` 引用；`materializeTemplate(t)` 把节点/边 id 重新生成唯一 id 并同步替换配置里 `{{旧id}}` 引用（`{{user}}` 外部输入保留），可多次载入不冲突；`WorkflowDialog.vue` 面板加「📦 载入模板…」下拉。**自测**：模板合法性校验（每模板 topoSort 无环、`{{id}}` 引用落在本模板节点集、条件出边必带标签）+ materialize（数量不变/id 更新/引用替换/两次物化不冲突）→ **npm test 133**；vue-tsc + vite build 全过。
- **全局快捷键可配置化（设置页自定义）**：AppSettings 加 `global_shortcut_toggle`/`global_shortcut_new_chat`（serde 默认 + Default + 2 测试字面量同步）+ appSettings.ts 同名字段；lib.rs 快捷键静态改为 `OnceLock<Mutex<Option<(Shortcut, Shortcut)>>>` 存当前注册句柄，`register_global_shortcuts(app, toggle, new_chat)` 统一注册入口（解析失败回退默认），新命令 `apply_global_shortcuts` 先注销当前注册再按新配置注册（前端保存后调用即时生效），setup 启动时从设置读取注册；SettingsDialog 新增「快捷键」tab（Keyboard 图标，两输入框 + 恢复默认按钮，保存调 updateSettings + apply_global_shortcuts）。验证：cargo check + cargo test --lib 45 + npm test 133 + vue-tsc + vite build 全过。
- **自测（加强）**：前端新增 13 项（记忆格式化/遗忘候选 5 + 工作流引擎 8）→ **npm test 97**；Rust 新增 4 项（chunk_text 3 + kb 1）→ **cargo test --lib 44**；vue-tsc + vite build + cargo check 全过
- **经验**：①vue-flow 等重度泛型库在 ref 上做 `.find/.filter` 易触发深度实例化，用 `any[]` 承载最省事；②模板里要展示字面双花括号占位符用 HTML 实体；③`chunk_text` 两行合计不超 size 会合并成一块——测断行要用合计超 size 的场景；④纯关键词 `kb_search` 被 hybrid 取代后直接删除（比 `#[allow(dead_code)]` 干净），测试调用点同步改为 `kb_search_hybrid(..., None)`；⑤Node 跑 .ts 测试要避免 TS 类型剥离不支持的语法（参数属性）；⑥全局快捷键 `register()` 返回 `()`，比对需自建 `Shortcut` 句柄；⑦运行时重注册快捷键：把当前句柄存 `Mutex<Option<(t,n)>>`，先 unregister 再 register
- **待做**：云端工作流市场

## 2026-08-26

### ✅ 编程代理 P-A4 多文件编辑 + diff（精确编辑原语 + unified diff 预览）
- **背景**：P-A1 Git / P-A2 验证循环 / P-A3 代码库理解 之后，编程 Agent 修改代码的能力闭环
- **Rust（src-tauri/src/lib.rs）**：
  - `sanitize_home_path(path)` helper：展开 ~/ 并校验主目录内（write_file_agent / apply_edits / delete_file_agent 三处复用安全边界）
  - `apply_edits(path, edits)` 命令：一次调用对单文件应用多个**精确编辑操作**——`replace`（old→new，`occurrence` 指定第几次出现，默认第 1 次）、`insert`（在 anchor 文本 before/after 插入 text）、`delete`（精确删除一段，occurrence 支持）；任一 op 未匹配文本即报错且**不写盘**；写盘后校验；返回 `EditResult{path, diff, new_len, summary}`
  - `line_diff(old, new)` 纯函数：行级 LCS diff → `(char, String)` 操作序列；`format_unified_diff` 渲染**标准 unified diff**（@@ 头 + 3 行上下文 + 相邻 hunk 合并）；无改动返回"（无改动）"
  - `nth_occurrence(hay, needle, occ)`：字节偏移定位第 N 次出现；`truncate_disp` 错误信息截断
  - `delete_file_agent(path)` 命令：仅删除主目录内文件、拒绝目录
- **前端（src/stores/chat.ts）**：
  - 新增 4 个内置工具：`replace_string`（精确替换 + 返回 diff，new_text 可空=删除）、`insert_string`（锚点前/后插入）、`create_file`（**仅当目标不存在时创建**，防误覆盖，返回提示）、`delete_file`（删文件）；均走 `apply_edits` / `delete_file_agent` / `write_file_agent`（存在性校验），只允许主目录内
  - 写入类 MCP 守卫更新：`create_file` 从转发覆盖式 write_file 改为转发内置非覆盖版 create_file
  - 系统提示词：内置工具列表加 4 个编辑工具描述（修改已有文件优先 replace_string / insert_string 精确编辑，勿整体重写）；新增「文件编辑规范」区块——编辑前先 read_file 核对、old_text/anchor 逐字一致、编辑后必须在回复中**说明改动**（列出新增/修改/删除行）、改代码必须 run_tests 验证、失败用 read_file 核对后重试
- **验证**：Rust 测试新增 7 项（diff 标记、unified diff 格式、无改动、occurrence 定位、三原语端到端、坏路径/未匹配拒绝且文件不变、delete_file 安全边界）→ cargo test 全过（38 项含 db/settings/search，31 passed + 7 ignored live）；npm test 35 + vite build 通过
- 踩坑：①unified diff context 行是 `" "+text`、删除/新增行是 `-text`/`+text`（**无中间空格**），测试断言 context 行用 ` line2`、删除行用 `-line4`；②`delete "hello"` 不含换行时删完会留空行，断言按"剩 N 处出现"而非精确内容；③追加测试到已闭合 tests 模块需先确认模块结尾
- **后续**：P-A5 任务规划增强（Plan 模式）为下一优先级；应用内 diff「确认后应用」UI 并入 P-A7 权限矩阵

### ✅ 编程代理 P-A5 任务规划增强（Plan 模式：plan_task/plan_update + 进度卡片）
- **背景**：P-A4 之后，编程 Agent 对复杂任务缺乏「先规划、可视进度、逐步推进」能力
- **前端（src/stores/chat.ts + src/components/TaskPlanCard.vue）**：
  - `types/index.ts` 新增 `PlanStepStatus`/`PlanStep`/`TaskPlan` 类型
  - chat store 新增 `taskPlan` ref + `setTaskPlan()`（跨轮/跨消息保留），`clearCurrentConversation` 清空（新对话重置）
  - 内置工具 `plan_task`（app）：`{title, steps[]}` 创建/替换任务计划 → 返回计划清单 + 执行规范；`plan_update`（app）：`{step(1-based), status}` 更新步骤状态（pending/doing/done/failed）→ 返回进度「N/M 完成」；均用 `useChatStore()` 更新 store（模块级函数内取 store 实例，工具循环时 pinia 已激活）
  - `TaskPlanCard.vue`：对话区顶部进度卡片——标题 + 计数（N/M 或「✅ 全部完成」）+ 渐变进度条 + 每步图标（pending 圆圈/doing 旋转 Loader2/done 对勾/failed 红叉）+ 状态徽标 + 手动关闭按钮；lucide 线性图标、主题变量适配深浅色
  - 系统提示词：内置工具加 plan_task/plan_update 描述 + 「任务规划规范」区块——复杂任务（多步骤/多文件/多研究）先 plan_task 分解、逐步 plan_update 更新（Plan→Act→Observe→修正）、全部 done 后给完整最终答案、简单任务不用
- **验证**：npm test 35 + vite build 通过；get_errors 无报错；dev HMR 正常加载（App.vue 8:45 hmr update，日志 EPIPE 为管道噪音非应用错误）
- **踩坑**：模块级 callBuiltinTool 内调用 `useChatStore()` 取 store 实例需在函数体内（运行时 pinia 已激活），不能在模块顶层调用
- **后续**：P-A6 本地语义 embedding 为下一优先级

### ✅ 外部编码 Agent 降级 + 多 agent 协作路线确立（2026-08-26 架构决策）
- **背景决策**：道生一已具备内置编码能力（P-A1~P-A5），外部编码 Agent（Claude Code/Codex）委派是过渡方案；终局为**零外部编码依赖、多 agent 协作内置化**
- **退役路线（写入 ROADMAP §4.5）**：阶段一（当前）外部委派降级为隐藏兜底 → 阶段二内置多 agent 协作（子代理带工具/并行/角色分工/主代理仲裁）→ 阶段三多 agent 成熟后彻底移除外部委派代码
- **第一步落地**：
  - `SettingsDialog.vue` 移除「编码 Agent」tab（import/tab 按钮/面板/类型）；`ui.ts` SettingsTab 去 agents；`main.ts` 菜单分发去 open-agents；Rust 菜单去「编码 Agent 委派」菜单项；**删除 `CodingAgents.vue` 组件**
  - 委派能力保留为**内置工具 `delegate_coding_agent`**（前端 callBuiltinTool 分支调 Rust `delegate_coding_agent` 命令，支持 agent_id/task/cwd/mode/max_turns/resume_session，返回退出码/耗时/token/输出）；提示词标注「外部兜底，慎用，仅当内置编码能力不足且用户明确要求时调用」
  - Rust 命令 `check_coding_agents` / `delegate_coding_agent` 保留（阶段三再彻底移除）
- **多 agent 协作计划（写入 DEVELOPMENT_PLAN §3.8，P-M1~P-M4）**：P-M1 子代理带工具（复用 sendMessage 工具循环）→ P-M2 并行子代理（Promise.all / futures join）→ P-M3 角色分工（规划/执行/验证/评审模板）→ P-M4 主代理汇总仲裁（orchestrator-subagent 树 + 监视面板）；建议推进顺序 P-A6 → P-M1~P-M4 → P-A7/P-A8
- **验证**：cargo check 通过（菜单移除）；npm test 35 + vite build 通过；全工作区 grep 确认无 CodingAgents/agents tab 残留（仅文档记录）

### ✅ /run 命令生成的文件展示为可点击链接
- **需求**：命令重定向生成的文件（如 `ls -l > l.txt`）应该像 write_file 一样，在回复中展示路径且可点击打开
- **实现**：`CommandOutput` 加 `created_files: Vec<String>`（serde default）；新增纯函数 `extract_redirected_files(cmd, cwd)`——引号感知解析 `>`/`>>`/`2>` 目标，排除 `/dev/null`/`&1`/`$变量`，相对路径结合 cwd（无显式 cwd 用进程当前目录 std::env::current_dir）转绝对路径，去重 + 校验存在；`execute_command` 成功后填充；前端 `runCommand` 在回复底部追加「📄 本次命令生成的文件：- <绝对路径>」，ChatMessage 的 LOCAL_FILE_RE 自动把绝对路径渲染为可点击链接（file_exists 校验 + 点击 open_file）
- **测试**：Rust 新增 `extract_redirected_files_detects_output_files`（>`/>>`/`2>` 检出、/dev/null 与 2>&1 排除、引号内 `>` 不误判、不存在不返回）→ cargo test 35 项通过；npm test 35 + vite build 通过

### ✅ 修复：命令执行工具（/run）不走 shell + 消息框命令面板误触发
- **Bug 1：/run 命令不走 shell**（用户报 `/run list` 报「启动命令失败: No such file or directory」）
  - 根因：`execute_command` 用 `Command::new(command)` 直接执行第一个词（不经 shell）——`~` 不展开、管道/重定向/`&&` 不生效、非可执行文件（如 `list`）报启动错误
  - 修复：前端 `runCommand` 改传**整条命令**（不再 parseCommandLine 拆分，拆分会丢引号与 shell 语义）；后端 `execute_command` 改走 `/bin/sh -c <整条>` + `process_group(0)` 新进程组（超时 kill 整个进程组防 sleep 残留）；提取 `run_shell_command` 辅助函数（不依赖 State）便于测试
  - 新增 3 项 Rust 测试：`~` 展开/管道/`cd &&`、超时杀进程组（2s 超时不等待）、未知命令报 exit 127（非启动失败）→ cargo test 34 项通过
- **Bug 2：消息框命令面板误触发**（用户报 `/run /Users/xx` 无法正常输入）
  - 根因：`currentWord()` 取光标前最后一个非空白词，参数路径 `/Users/xx` 以 `/` 开头 → 又触发命令面板；且面板开着时 Enter 被拦截为「选命令」，用户无法输入含 `/` 的参数
  - 修复：`updateSlash` 仅当 `/` 开头的词位于**行首**（`w.start === 0`）才触发命令面板；参数里的 `/`（路径/URL）一律当普通内容，不弹面板、不拦截输入（可 Esc 关闭、可自由输入，非强制）
- **验证**：cargo test 34 项 + npm test 35 + vite build 通过

### ✅ 修复：停止按钮无法停止子代理/工具循环（真正的中断机制）
- **用户报告**：两个停止按钮（对话区「⏹ 停止生成」+ 输入框「⏹」）都无法停止正在运行的子代理（召回 agent）操作
- **根因**：`stopStreaming()` 只做 `isStreaming.value = false`（隐藏按钮），**没有真正的取消机制**——正在跑的 `runSubagentLoop`（每轮 `chatOnce` 最长 60s）、主代理工具循环（`while round < MAX`）都不会中断；主代理还阻塞在 `await callMcpTool(subagent_delegate)` 上，停止后它返回仍会继续下一轮
- **修复（src/stores/chat.ts）**：
  - 引入**可取消停止信号**（模块级）：`stopRequested` + `stopWaiters` + `requestStop()`/`resetStop()`/`waitStopSignal()` + `AgentStoppedError`
  - `stopStreaming()` 现在调 `requestStop()`（不只是改标志）；`sendMessage` 主流程开头 `resetStop()`（新消息重置）
  - **子代理循环**：每轮 `Promise.race([chatOnce, waitStopSignal()])`，点停止立即抛 `AgentStoppedError`（不等 60s 超时）；工具执行前/后检查；`subagent_delegate` 捕获 `AgentStoppedError` → 子代理标记「已由用户停止」→ 返回"（子代理已由用户停止）"
  - **主代理工具循环**：`while` 顶部 / `await streamRound` 后 / 执行工具前 / `await callMcpTool` 后 四处检查 `stopRequested` → break（停止后不再调新工具/发起新一轮）
  - **streamRound**：`doneP` race 加 `waitStopSignal()`，停止时提前结束当前流式轮（工具循环随后 break）
- **踩坑**：`runSubagentLoop` 的 race 最初用 `waitStopSignal().then(() => { throw ... })` ——race 已结算后停止信号才触发会 unhandled rejection；改用 **kind 标记**（`{kind:"ok"}` / `{kind:"stop"}`）让停止信号只 resolve 不 throw
- **验证**：npm test 35 + vite build 通过；get_errors 无报错
- **注意**：正在执行的单个工具（如子代理正在调的长工具/`chatOnce` 单次）无法中途掐断（Tauri invoke 无 abort），停止在「当前 await 返回后」立即生效——点停止后子代理不会进入下一轮，主代理不再继续，但正在跑的那一次请求最多等到其自然结束（子代理最多 1 轮 chatOnce 60s）

### ✅ 编程代理 P-M1 子代理带工具（多 agent 协作地基）
- **背景**：外部编码 Agent 降级后，研发重心转向内置多 agent 协作；P-M1 是第一步——让子代理从"纯对话"升级为"能调内置工具"
- **实现（src/stores/chat.ts）**：
  - 新增模块级 `runSubagentLoop(config, sysPrompt, goal, opts)`：子代理工具循环——`chatOnce`（非流式）→ `parseToolCall` 从返回内容解析工具调用 → `callMcpTool` 执行（复用主代理工具执行器，内置工具+安全边界一致）→ `<tool_result>` 回填上下文 → 继续下一轮，直到无工具调用返回最终结论；`opts.allowTools` 可关（纯对话子代理）、`maxRounds` 默认 8
  - `subagent_delegate` 工具改造：新增 `allow_tools` 参数（默认 true）；子代理系统提示词注入工具列表（`getMcpToolsPrompt()`）+「可调用内置工具完成子任务，能动手查证/修改/测试就不只靠推理」引导
  - 与主代理差异：非流式 + 无 UI 流式副作用（后台任务，SubagentPanel 只显示状态），符合子代理定位
- **验证**：npm test 35 + vite build 通过；get_errors 无报错
- **注意**：子代理工具循环复用 `callMcpTool`（模块级状态 mcpToolsCache/browserNavigated），P-M2 并行子代理时需处理状态竞争（各子代理独立上下文已隔离，MCP 连接状态共享需加锁/串行浏览器操作）
- **后续**：P-M2 并行子代理（Promise.all 多 runSubagentLoop 并发）→ P-M3 角色分工 → P-M4 主代理汇总仲裁

### ✅ 联网搜索无关结果修复（三层根因：关键词清洗 / 单源填满 / 相关性过滤）
- **用户报告**：搜索"说说什么是人工智能神经网络"返回 11 条全是微软股票（MSFT）等完全无关内容
- **根因链（三层叠加）**：
  1. **关键词清洗 bug（主因）**：`extractSearchKeywords("说说什么是人工智能神经网络")` 返回**完整整句**——疑问词正则是"是什么"（X 是什么），用户是"**什么是**X"方向反了没匹配；"说说/介绍一下"等请求动词没清。整句含疑问词传给搜索引擎，质量天然差
  2. **单源填满**：综合搜索 `search_web` 原实现 4 源无限制合并，当百度反爬（实测 1488 字节验证页）、搜狗对整句返回 0 个 rb 块时，**Bing 一家结果填满 20 条**——Bing 对中文整句返回英文无关（MSFT 股票）
  3. **无相关性过滤**：任何来源的无关结果都会被原样返回
- **修复**：
  - `extractSearchKeywords` 重写：补"什么是/说说/讲讲/介绍一下/是做什么的/干什么的/干嘛的/的最新"等 30+ 词；截断 12 字；清洗后为空回退前 12 字。实测："说说什么是人工智能神经网络"→"人工智能神经网络"、"华为技术有限公司是做什么的"→"华为技术有限公司"
  - `search_web` 多源合并改**每源最多 5 条、总上限 15 条**（防单源填满）+ **`filter_relevant` 相关性过滤**（纯函数）：剔除与查询词无共现的结果 + 低质噪声（词典释义"的意思/怎么读/拼音/造句"、股票行情 stock/quote、问答链接）
  - `search_sogou` 增强：整句查询搜狗返回 vr-title 卡片而非 rb 块 → 新增 `extract_vr_title`（提取 h3.vr-title 内 <a> 文本，修复原来把整个 block 当标题的 bug）
- **验证**：问题场景"人工智能神经网络"从"12 条含 MSFT 股票+4 条'人工'单字释义"→"6 条高质量相关结果"（MBA智库/搜狐科普/知乎入门/微信简史）；cargo test 24 项（search 8 项含 3 个 filter_relevant 测试）+ npm test 35 通过
- **经验**：①搜索引擎对高频请求 IP 级限流是常态（诊断时多次 curl 被限），低频真实使用正常；②"单源结果填满"是多源综合的隐藏陷阱，必须限制单源占比；③中文查询词清洗要同时覆盖"是什么/什么是"两种语序 + 口语请求动词

### ✅ 编程代理 P-A2 验证循环 + P-A3 代码库理解（analyze_project）
- **P-A2 验证循环**：Rust `run_tests(cwd, command?, args?, timeout)` 命令——自动检测项目测试框架（`detect_test_framework` 纯函数：package.json→npm test、Cargo.toml→cargo test、pyproject/requirements→pytest，可显式 command 覆盖）；tokio 子进程 + 超时(默认 300s) + 审计，返回结构化 `TestOutput`（framework/command/stdout/stderr/exit_code/timed_out）。前端 `run_tests` 内置工具：返回「【测试结果】框架/命令/✅通过❌失败 + 失败项/错误摘要(正则提取 FAILED/error/panicked 前 15 行)」；系统提示词加「验证循环」门禁：改代码必跑测试、失败必修复再跑直到通过
- **P-A3 代码库理解**：Rust `analyze_project(root)` 命令——技术栈识别（Cargo.toml→Rust、package.json→TS/JS、pyproject→Python、go.mod→Go、vite.config/App.vue→Vue）、manifest 信息（Cargo 包名/npm 包名+scripts）、源码按扩展名统计（跳过 node_modules/.git/target/dist/build 等）、顶层结构（限制 60 项）；返回结构化 `ProjectAnalysis`。前端 `analyze_project` 工具：返回「【项目分析】技术栈/包信息/源码文件数/顶层结构」；提示词引导分析项目前先调用建立认知
- **验证**：cargo test 21 项（lib 新增 2 个 detect_test_framework 测试 + 3 个 git 校验）；npm test 35 + vite build 通过；analyze_project 对项目自身验证正确（技术栈 TS+Vue、源码 23 ts/16 vue）
- 踩坑：①追加测试时原 tests 模块已以 `}` 结尾，再 cat >> 会多一个 `}` 编译错——追加前先确认模块闭合；②`detect_test_framework` 检查顺序 package.json 优先，测试里同时写 package.json+Cargo.toml 会返回 npm 而非 cargo，须先删 package.json 再测 Cargo；③`&[String]` 参数传 `&["str"]` 字面量 E0308，需 to_string()

### ✅ 修复：Ollama 部署完成后聊天窗口仍提示未就绪/未安装
- **用户报告**：一键部署 Ollama 完成后，聊天窗口顶部横幅仍提示「未就绪 / 一键部署」，设置页「本地模型」tab 可能仍显示「未安装」
- **根因（两层）**：
  1. **横幅只在启动时算一次**：`App.vue checkOllamaOnStart()` 只在 `onMounted` 调用；`ollamaStore.deploy()` 完成后虽调用 `refreshStatus()` 更新了 store.status，但 App.vue 没有监听状态变化 → 部署成功横幅不消失，必须重启应用才恢复
  2. **检测漏掉官方安装器路径**：`ollama_bin()` 候选路径缺 `/Applications/Ollama.app/Contents/Resources/ollama`（官方 .dmg 安装器默认装在系统 `/Applications`，代码只查了 `~/Applications` 与 brew 路径）→ 手动安装的官方 Ollama 被误判「未安装」
- **修复**：
  - `App.vue`：横幅判定抽取为 `evaluateOllamaBanner()`（幂等纯计算）；新增 `watch([ollamaStore.busy, ollamaStore.status, ollamaStore.hw])`——部署中隐藏横幅，状态/硬件变化（含一键部署完成后 store 内 refreshStatus 更新）自动重算，无需重启
  - `lib.rs ollama_bin()`：候选路径新增 `/Applications/Ollama.app/Contents/Resources/ollama`（置于 `ollama_user_bin()` 之前）
- **验证**：npx vite build + npm test 35 + cargo check + get_errors 全部通过
- **经验**：①「一次性启动引导」类 UI 状态必须对数据源做响应式监听，否则异步操作完成后 UI 不更新；②二进制检测候选路径要覆盖官方安装器的默认位置（`/Applications` 与 `~/Applications` 都要）

### ✅ 编程代理 P-M2 并行子代理（多个 runSubagentLoop 并发 + 共享状态竞争处理）
- **背景**：P-M1 子代理带工具之后，多个子任务只能逐个委派；P-M2 让主代理把任务分解为多个**相互独立**的子任务后**并行**收集结果，大幅节省时间
- **前端（src/stores/chat.ts）**：
  - 新增内置工具 `subagent_parallel`（app）：参数 `{tasks: [{goal, context?, allow_tools?}], concurrency?}`——信号量并发池（默认最多 4 worker 并行，等价 Promise.all）；每个子任务登记独立 `SubagentRecord`（SubagentPanel 可视化面板同时显示各子代理 running/completed/failed 进度）；结果按原始任务顺序汇总「## 子任务 N」返回（排序不依赖完成顺序，输出稳定）；单个失败不拖垮其它（捕获记录「（子代理失败: msg）」）
  - 抽取 `buildSubagentSysPrompt(context, allowTools)`：`subagent_delegate` 与 `subagent_parallel` 复用同一子代理系统提示（避免两处文案漂移）
  - 系统提示词：内置工具列表加 `subagent_parallel` 描述（使用时机=任务可拆分为相互独立子任务；注意：①子任务必须真正独立否则不要并行②浏览器单一实例、多任务操作浏览器会被自动串行化、需操作不同网页建议主代理串行③子代理不应继续递归并行委派）；`subagent_delegate` 描述改为「单个子任务 + 有多个独立任务用 subagent_parallel」
- **共享状态竞争处理（P-M2 核心，用户点名）**：
  - **浏览器串行锁**：新建 `src/utils/browser-lock.ts` 导出 `withBrowserLock(fn)`（Promise 链式互斥锁，FIFO、失败 finally 释放不锁死）+ `browserLockIdle()` 测试辅助；`callMcpTool` 中所有 `puppeteer_*` 调用经 `withBrowserLock` 排队执行——server-puppeteer 是**单一浏览器实例**，并行子代理并发 navigate/fill/click 会互相干扰（两个导航竞争、`browserNavigated` 标记并发读写）；非浏览器工具（fetch_page/文件系统/git 等）不受影响、可并行
  - **导航判定移进锁内**：`browserNavigated` 守卫原在 invoke 前同步判定，并行时队列中前一个 navigate 尚未执行 → 后一个 fill 会误判「未打开网页」；改为在锁内执行时判定（抛 `BrowserNotNavigatedError` 由 callMcpTool 捕获转友好提示），能看到前一个 navigate 的真实结果
  - **`refreshMcpTools` 单飞（single-flight）**：并发调用只执行一次、共享同一结果，避免并行子代理/主代理同时刷新时交错清空 `mcpToolsCache` 导致读到空缓存
- **测试（scripts/test-templates-tools.mts）**：新增 `withBrowserLock` 3 项（并发严格 FIFO 串行 / 前一个失败队列继续不锁死 / 三操作保持顺序）→ npm test 38 项通过
- **验证**：npm test 38 + vite build + get_errors 全部通过
- **后续**：P-M3 角色分工（规划者/执行者/验证者/评审者角色模板 + 工具集约束）→ P-M4 主代理汇总仲裁 → P-A6 本地语义 embedding
### ✅ 编程代理 P-M3 角色分工 + P-M4 主代理汇总仲裁
- **P-M3 角色分工**：
  - 新建 `src/data/builtin-tools.ts`：把 `getMcpToolsPrompt` 里的 23 个内置工具描述抽成结构化 `BUILTIN_TOOLS`（name+desc）+ `BUILTIN_TOOL_NAMES` + `validBuiltinTools` 校验函数（供角色目录与测试引用）
  - 新建 `src/data/roles-catalog.ts`：`AGENT_ROLES` 5 个角色模板——**规划者 planner**（拆解/调研，不编辑：plan_task/analyze_project/web_search 等）、**执行者 executor**（落地：编辑/git/run_tests）、**验证者 verifier**（run_tests/git 只读）、**评审者 reviewer**（git diff/analyze）、**研究助手 researcher**（web_search/fetch_page/记忆，不含 git/编辑）；`getRoleById` / `roleAllowedToolNames` / `invalidRoleTools` 校验
  - **工具集约束双保险**：①`getRoleToolsPrompt(allowed)` 提示词只展示角色允许的工具（不注入 MCP/浏览器大段）；②`runSubagentLoop` 新增 `opts.allowedTools` **执行层强制拦截**——不允许的工具不执行，回填「本角色允许的工具：…」提示（提示词过滤只是引导，执行拦截是兜底）
  - `buildSubagentSysPrompt(context, allowTools, roleId?)`：注入角色定位/指令 + 按角色过滤工具列表；`subagent_delegate` / `subagent_parallel` 支持 `role` 参数（未知角色抛错），子代理面板标题前缀 `[角色名]`
- **P-M4 主代理汇总仲裁**：
  - `subagent_parallel` 支持 `synth=true`：并行完成后用**评审角色**跑汇总仲裁子代理（冲突消解/交叉验证/统一呈现），返回 `【并行子代理汇总仲裁】`；仲裁失败回退普通汇总并标注
  - 抽取纯函数 `formatParallelResults(results, workerCount)`：按原始 idx 稳定排序汇总（可测试）
  - 主代理系统提示加「多子代理结果仲裁规范」：结果冲突时明确冲突点 → 评估证据/来源可信度 → 给出判定 → 统一呈现
- **自测（加强）**：新增 16 项——角色 id 唯一 / 5 核心角色齐全 / 字段完整 / **角色 tools 全部引用真实内置工具名（invalidRoleTools 空）** / getRoleById 命中与未知 / roleAllowedToolNames / 内置工具名唯一与描述完整 / validBuiltinTools / 乱序结果按 idx 重排 / 执行者含 run_tests+git（验证循环）/ 研究助手不含 git（工具集隔离）/ 规划者不含编辑工具（只规划不改动）→ npm test 54 项通过
- **踩坑**：①`roles-catalog.ts` import `./builtin-tools` 无扩展名 → Node ESM 测试报 ERR_MODULE_NOT_FOUND（Vite 能解析、Node 不能）→ 改 `./builtin-tools.ts`（tsconfig 已开 `allowImportingTsExtensions`，Vite 构建不受影响）；②P-M4 仲裁块里 `buildSubagentSysPrompt` 计算后未拼进仲裁提示（工具列表没带上）→ 修正为 `仲裁指令 + --- + 评审角色提示 + 各子任务结果`
- **验证**：npm test 54 + vite build + get_errors 全部通过
- **后续**：P-A6 本地语义 embedding（Ollama nomic-embed-text / ONNX 轻量中文模型，补记忆/代码语义检索）→ P-A7/P-A8 权限矩阵 + 沙箱

### ✅ 编程代理 P-A6 本地语义 embedding（Ollama nomic-embed-text）
- **背景**：DeepSeek 无 embeddings 端点 → 记忆语义检索一直是短板（只有 FTS5 关键词）；本机已有 Ollama（一键部署 llava-phi3），正好复用其本地 embedding 补语义
- **Rust（src-tauri/src/lib.rs）**：
  - `ollama_embed(texts) -> Vec<Vec<f32>>` 命令：调 `http://localhost:11434/api/embed`（新版端点，返回 `embeddings: [[..]]`，支持一次多段文本）；30s 超时客户端；**不自动拉模型**——服务未运行（`ollama_running` 2s 快速失败）或 `nomic-embed-text` 未安装时返回明确错误，避免静默下载大文件；模型检测 `embed_model_installed`（`starts_with("nomic-embed-text")`）与响应解析 `parse_embed_response`（embeddings 数组/空向量校验）抽成**纯函数**供测试
  - 向量存取复用既有 `set_fact_embedding` / `search_by_embedding`（SQLite BLOB + 余弦）
- **前端**：
  - 新建 `src/utils/embed-provider.ts`：`embeddingSource(baseUrl)` 判定「ollama / openai / none」——本地 11434 或 **DeepSeek 主模型都走 ollama**（DeepSeek 无 embeddings → 用本地 Ollama 补语义）；其它 OpenAI 兼容端点走通用 `/embeddings`
  - `memory.ts generateEmbedding`：`src==="ollama"` 时改调 `invoke("ollama_embed")`；Ollama 未运行/模型未装 → invoke 报错 → 返回 null → `retrieveMemories` 的向量补充段静默跳过（FTS5 不受影响）；事实提取的 embedding 后台写入同样受益
- **自测（加强）**：前端新增 8 项（embeddingSource 判定：本地/127.0.0.1/DeepSeek→ollama、OpenAI/通义→openai、空→none、isOllamaBase 字面命中与排除）→ npm test 62；Rust 新增 3 项（模型检测命中/未命中、embeddings 解析向量、坏形状缺字段/空向量/非数组报错）→ cargo test --lib 38 全过
- **踩坑**：reqwest `resp.status()` 在 `resp.text().await`（self 移动）后不可用 → 先 `let code = resp.status();` 再取 body
- **验证**：npm test 62 + vite build + cargo test --lib 38 + get_errors 全部通过
- **后续**：P-A7 权限矩阵（工具级开关/路径白名单/会话级权限记忆）+ P-A8 沙箱（文件/网络/命令三层白名单）

### ✅ 编程代理 P-A7 权限矩阵 + P-A8 沙箱
- **P-A7 权限矩阵（工具级 + 路径白名单）**：
  - `settings.rs` AppSettings 加 `disabled_tools` / `allowed_paths`（serde default 向后兼容；Default + 2 处测试字面量同步）+ `appSettings.ts` 加 `disabledTools` / `allowedPaths`
  - 新建 `src/utils/permissions.ts` 纯函数：`isToolDisabled`（精确名匹配，忽略空白）、`isPathAllowed`（字符串前缀 `dir + "/"` 匹配防 `/op2` 误判，支持 `~`）、`pathArgOf`（取 path/cwd/dir/root）
  - 拦截双入口：`callMcpTool` 顶部禁用工具拦截（覆盖内置 + MCP）；`callBuiltinTool` 顶部禁用工具 + 路径白名单拦截（配置了 allowedPaths 时文件/命令类工具只访问白名单目录，返回「⛔ 路径不在权限白名单内」）
  - 设置新增「权限」tab（Shield 图标）：禁用工具 textarea + 路径白名单 textarea，@change 即时保存（每行一个）
- **P-A8 沙箱（文件层白名单，三层沙箱之文件层）**：
  - 纯函数 `path_within_any`（**组件级匹配 `Path::starts_with`**，防 `/a/op2` 误判进 `/a/op`）+ `parse_allowed_paths`（~ 展开为绝对路径）
  - `expand_user_path`（只展开 ~ 不查主目录）+ `sanitize_home_path` 重构复用
  - `sandbox_allowed_paths(db)` 从设置读白名单 + `sandbox_file_path(db, path)`（配置白名单时必须在白名单内；未配置回退主目录边界）
  - `read_file` / `write_file_agent` 加 `db: State<Database>` 应用白名单（read 未配置白名单保持原行为可读任意绝对路径；write 始终主目录边界 + 白名单收紧）；命令层 `DANGEROUS_PATTERNS`（已有）+ P-A7 前端门禁兜底
- **自测（加强）**：前端新增 10 项（isToolDisabled 命中/放行/空白、isPathAllowed 未配置放行/前缀/子目录/外路径拦截/~/pathArgOf）→ npm test 72；Rust 新增 2 项（path_within_any 组件级匹配防前缀误判、parse_allowed_paths ~ 展开）→ cargo test --lib 40 全过
- **踩坑**：①`path_within_any` 空白名单返回 false（调用方先判空再调用），测试断言别写成「空=放行」；②read_file 未配置白名单时**不能**回退到主目录边界（会破坏 /read 读工作区外文件的原行为），只有配置白名单才收紧
- **验证**：npm test 72 + vite build + cargo test --lib 40 + get_errors 全部通过
- **后续**：P-A9 记忆复习（定期 LLM 回顾记忆仓库合并过时/矛盾事实）→ 其余远期（P-A10 插件生态 / P-A11 跨设备同步 / P-A12 多模型路由）

### ✅ 编程代理 P-A9 记忆复习（LLM 回顾记忆库，删除/合并过时矛盾重复事实）
- **背景**：P-A7/P-A8 之后，长期记忆路线图（§3.5 Phase 4.2）的「记忆复习」——定期让 LLM 回顾记忆仓库，清理过时/矛盾/重复事实，避免记忆库越来越臃肿
- **前端**：
  - 新建 `src/utils/memory-review.ts` 纯函数：`buildReviewPrompt(facts)`（含 id 列表 → LLM 找出过时/矛盾/重复项）+ `parseReviewActions(raw)`（宽松解析 JSON 数组，兼容 `from_id`/`id`，跳过非法项）
  - `memory.ts reviewMemories(config)`：list_facts 全量（<6 条跳过）→ buildReviewPrompt → callLLM（辅助配置）→ parseReviewActions → 应用：delete_fact_cmd 删除；merge 时同时删除来源 + 目标重要度 +1（上限 10，update_fact_cmd）；返回「删除 N 条，合并 M 条」汇总；失败静默返回提示
  - `MemoryPanel.vue`「智能复习」按钮（Brain 图标，next to 执行维护）：用 chatStore.getAuxConfig()（未配 API 提示先配置）；完成后刷新列表
- **自测（加强）**：新增 7 项（提示词含 id 与动作、delete+merge/from_id 兼容解析、delete 动作、merge with intoId、空 []、非法 JSON 容错、非法动作/缺 id 跳过）→ npm test 79 通过
- **验证**：npm test 79 + vite build + get_errors 全部通过
- **后续**：P-A10 插件/技能生态（第三方上传/评分/版本管理）→ P-A11 跨设备同步 → P-A12 多模型路由 → Phase 5/6 桌面深度集成与生态（长期）

### ✅ 编程代理 P-A12 多模型路由（按任务类型自动选模型）
- **背景**：多模型路由路线图项——按任务类型（对话/编程/摘要）自动选模型，本地模型作辅助；本机已有 Ollama，摘要/子代理等批量任务可路由到更便宜/更快的模型节省主模型额度
- **配置**：`settings.rs` AppSettings 加 `model_routing: HashMap<String,String>`（任务类型→Profile id，serde default 空；Default + 2 测试字面量同步）+ `appSettings.ts` 加 `modelRouting`（默认 {}）
- **纯函数**：新建 `src/utils/model-routing.ts` `routeProfileId(taskType, routing, auxiliaryProfileId)`——优先级 `routing[taskType]`（专门配置）→ `auxiliaryProfileId`（辅助模型）→ `""`（跟随主模型）；`TASK_TYPES`（chat/coding/summarize/search）
- **接入**：
  - `chat.ts getRoutedAuxConfig(taskType)`：按路由解析 Profile → 辅助 → 主；`subagent_delegate` / `subagent_parallel` 改用 `getRoutedAuxConfig("coding")`（编程子代理可路由到专门编程模型）；store 导出
  - `memory.ts resolveTaskConfig(taskType, fallback)`（读 getSettings 路由 + profiles）：`maybeSummarize` / `extractFacts` / `expandKeywords` / `reviewMemories` 的 LLM 调用与 embedding 生成改走 **summarize 路由模型**
  - `SettingsDialog` API 页新增「模型路由（按任务类型）」：摘要/记忆辅助 + 编程子代理两个 Profile 下拉，@change 即时保存
- **自测（加强）**：新增 5 项（任务类型专门配置优先 / 未配置回退辅助 / 无配置→主 / chat 未专门→辅助 / 空白配置按未配置）→ npm test 84；顺带修掉 chat.ts 两处既有类型错误（runCommand 解构未用 args、web_search enriched 联合类型缺 body）→ **vue-tsc --noEmit 全绿**
- **验证**：npm test 84 + vite build + cargo test --lib 40 + vue-tsc --noEmit 全部通过
- **后续**：P-A10 插件/技能生态（第三方上传/评分/版本管理）、P-A11 跨设备同步（需云端）为远期
## 2026-08-25

### ✅ ROADMAP 整合进开发计划 + 编程代理 P-A1 Git 集成
- **计划整合**：新增 `DEVELOPMENT_PLAN.md §3.7 编程代理能力路线`——把 ROADMAP 全部未实现项（Git/验证循环/代码库索引/多文件编辑 diff/Plan 模式/本地 embedding/权限矩阵/沙箱/记忆复习/插件生态/跨设备同步/多模型路由）按优先级+前置依赖排成 P-A1~P-A12，建议推进顺序 Git→验证循环→代码库索引→diff→Plan→embedding→权限沙箱
- **P-A1 Git 集成**：
  - Rust 新增 `git_operation(cwd, action, args, timeout)` 命令：用 git CLI 子进程（零新依赖，复用 execute_command 的 tokio 进程+超时+审计模式）；白名单子命令（status/diff/log/branch/remote/show/ls-files/rev-parse 只读 + add/commit/pull/push/checkout/init/clone 常规）+ 拒绝危险参数（--force/--hard/reset/rm/clean/--delete），防 agent 误操作
  - 安全校验提取为纯函数 `validate_git_operation` + 3 个单元测试（允许安全操作/拒绝未知子命令/拒绝危险参数）
  - 前端 `git` 内置工具（app）：参数 cwd/action/args，输出截断 6000 字符；系统提示词加 git 工具描述（使用时机：查看/提交/推送/对比/历史/分支）
- **验证**：cargo test --lib 19 项通过（含 3 个 git 校验）；npm test 35 + vite build 通过；真实 git CLI 链路正常（status/log 输出正确）

### ✅ 长期记忆 1.5 用户画像 + 2.1 意图扩展 + 3.1 记忆编辑 + 记忆库净化
- **1.5 用户画像沉淀**：`memory.ts` 新增 `getUserProfile()`——聚合 preference 偏好 + 高重要度(≥7)身份/环境信息，形成结构化「用户画像」；`sendMessage` 每次对话稳定注入 volatileCtx（5 秒超时兜底）；`retrieveMemories` 改为只补重要度≥7 的偏好（避免与画像重复）；`MemoryPanel` 新增「用户画像」高亮区块（chip 展示，粉色调，标注"每次对话自动注入"）
- **2.1 意图关键词扩展**：`retrieveMemories` 在 FTS 首轮无结果时，用 LLM 从问题提取 2-3 个核心检索词（`expandKeywords`）逐个重试检索——解决"模糊提问"（如"我上次说的那家公司"）召回差问题；仅空结果时触发不增加正常路径成本
- **Phase 3.1 记忆编辑**：Rust 新增 `update_fact`（更新文本/类型/重要度 + 同步重建 FTS 索引）与 `update_fact_cmd` 命令；`MemoryPanel` 每条事实加「编辑」按钮 → 行内编辑表单（文本/类型下拉/重要度数字/保存/取消）；用 Pencil 图标
- **记忆库净化**：删除历史遗留的过程性垃圾事实（"截图已保存到…""浏览器已导航…""查询今日金价""无法联网查询…"等 4 条），清理孤儿 FTS 行；75→71 条
- **测试**：db.rs 新增 `update_fact_rebuilds_fts`（编辑后新词可检索），cargo test 15 项全通过；npm test 35 + vite build 通过

### ✅ 长期记忆 Phase 2.4：主动记忆工具（memory_save / memory_recall / memory_forget）
- **动机**：让 Agent 在对话中**主动**保存/回忆/遗忘记忆，而不只是被动等对话结束提取——这是「越用越聪明」的闭环
- **chat.ts**：新增 3 个内置工具（server 填 `app`）：
  - `memory_save(fact, fact_type, importance)`：记住用户明确告知的偏好/个人信息/决策/待办；返回 merged:/saved: 反馈（去重合并自动生效）
  - `memory_recall(query, limit)`：按关键词走 `search_facts`（FTS5 中文 unigram）回忆跨会话记忆；无结果返回"未找到"
  - `memory_forget(query)`：用户要求遗忘时按关键词检索并删除相关记忆
- **系统提示词**：内置工具列表加 3 个工具描述 + 「长期记忆使用要点」区块（主动记忆时机 / 回忆优先勿编造 / 遗忘 / 说明系统也会自动注入记忆）
- **验证**：`memory_recall` 检索链路真实库验证（"深圳"命中 5 条相关记忆）；npm test 35 项通过
- 说明：系统本就在每次对话前自动检索注入记忆（retrieveMemories），主动工具用于更精确的查证/写入/遗忘，二者互补

### ✅ 长期记忆验证基础设施：记忆管理面板（设置「记忆」tab + 菜单入口）
- **动机**：要验证「越用越聪明」，必须先能直观看到记忆状态（写了什么/召回什么/去重没/遗忘没）——此前前端看不到记忆只能手动 sqlite 查
- **Rust**：新增 `list_facts`（按类型过滤/全部，按 重要度×最近访问 排序）、`list_all_summaries`（全部会话摘要倒序）两个命令
- **前端**：新建 `MemoryPanel.vue`（设置「记忆」tab + 菜单栏「工具 → 长期记忆」入口）：
  - 记忆列表：类型徽标（偏好/信息/决策/待办）、重要度星级、访问次数、最近访问时间、可删除单条
  - 类型筛选 + 刷新 + 「执行维护」按钮（手动触发 `maintain_facts` 看衰减/遗忘效果）
  - 顶部统计：事实总数 / 平均重要度 / 各类型分布；底部展示会话摘要列表
- **验证**：dev 日志确认记忆维护线程启动自动运行（`[memory] 记忆维护完成，当前 75 条事实`）；真实库 75 条事实（66 info/4 decision/1 preference/4 todo）可按重要度列出
- **测试**：db.rs 新增 `list_facts_sorts_and_filters`（全部按重要度降序 + 类型过滤），cargo test 6 项通过

### ✅ 长期记忆验证方案（三层）
1. **单元/集成测试**（自动化）：FTS5 中文 unigram 检索、去重合并（同字重排合并/语义相反不误并）、衰减+遗忘+preference 保护、list_facts 排序过滤——db.rs 6 项测试已覆盖
2. **记忆可视化**（直观）：设置「记忆」tab 查看全部事实/摘要，筛选类型、看重要度/访问/时间，可删除、可手动执行维护
3. **端到端场景验证**（用户手测）：见「记忆验证清单」——跨会话「记住→召回」

### ✅ 长期记忆验证清单（用户手测）
- **写入**：对话说「我喜欢简洁的回答」，结束后打开 设置→记忆，应看到 preference 事实（重要度★8）
- **召回**：新开会话说「我有什么偏好？」，agent 应自动注入记忆并回答（无需用户提关键词）
- **去重**：再说一次「简洁的回答方式我喜欢」→ 记忆面板应仍是 1 条（合并），重要度上升
- **遗忘**：点「执行维护」→ 低价值冷记忆消失、preference 保留
- **衰减**：长期不访问的 info 事实重要度逐步下降（daily 维护自动）

### ✅ 长期记忆 Phase 1 启动：FTS5 全文索引 + 事实去重 + 自动遗忘（开发计划 §3.2，1.1/1.2/1.3）
- **背景**：用户进入长期记忆功能研发（"让 agent 越用越聪明"）。最大短板 = DeepSeek 无 embeddings 端点 → 只有 `LIKE` 全表扫，跨会话中文召回差
- **FTS5 全文索引（1.3）**：`memory_facts_fts` FTS5 虚拟表（`rowid` 与 `memory_facts` 关联）；`cjk_terms()` 中文 unigram 分词（"华为技术"→"华 为 技 术"，英文/数字按空白词切分小写）；`search_facts` 改为 FTS5 `MATCH`（bm25 相关度）× importance × recency 加权排序 + LIKE 兜底；`Database::new` 对旧库幂等回填索引；`save_fact`/`delete_fact` 同步维护 FTS。**验证**：rusqlite bundled 内置 FTS5（SQLite 3.45），中文 unigram 检索命中正确
- **事实去重合并（1.1）**：`save_fact` 前查同类型已有事实做字符集 Jaccard 相似度（>0.62 + 长度比 >0.55 惩罚，避免"喜欢简洁"vs"喜欢详细"误并）→ 合并：累加 importance（上限 10）、文本取更长、复用原 id；`save_fact` 命令返回 `saved:id` / `merged:id`；`mcp_server` memory_save 与前端 `extractFacts` 均适配反馈合并状态
- **记忆衰减与自动遗忘（1.2）**：新增 `maintain_facts()`——>45 天未访问的非 preference importance 降 1（最低 1）；importance≤2 且 60 天未访问的删除；清理孤儿 FTS 行；lib.rs 后台线程启动即跑 + 每 6 小时检查；`prune_facts` 命令复用。`preference`（用户偏好）永久保护不衰减不遗忘
- **前端 memory.ts**：`retrieveMemories` 改为 FTS5 全文为主 + 语义向量补充（有 embedding 时）+ 偏好合并的混合检索，去重后注入；`extractFacts` 处理 save_fact 合并返回值（embedding 写入目标 id）
- **测试**：db.rs 新增 3 个测试（中文 unigram FTS 检索、同字重排去重合并 + 语义相反不误并、衰减+遗忘+preference 保护），cargo test 14 项全通过；npm test 35 项通过
- 待做：Phase 1 的 1.4（记忆分层/跨会话摘要汇总）、1.5（用户画像沉淀）；Phase 2 检索注入优化（意图扩展/排序剪裁/主动记忆工具）

### ✅ 搜索源重构：彻底移除 Brave + 多源并行综合（百度/必应/360/搜狗）
- **背景**：Brave Search API 在境内无法直连（需代理），留着鸡肋 → 用户要求彻底移除；同时 web_search 质量一般（摘要常被截断、agent 只给链接让用户自己点）
- **Rust `search.rs`**：删除 `search_brave` + `BraveResponse/BraveWeb/BraveResult` 结构体；`search_web(query)` 改为**四源并行综合**（`futures::join!`）：百度 + 必应 + 360 + 搜狗，按 域名+路径 去重合并，上限 20 条，全空再兜底 DuckDuckGo
  - **新增 `search_baidu`**：`https://www.baidu.com/s?wd=`；真实 URL 在结果块 `mu="http..."` 属性（标题 `<a>` 的 href 是 baidu.com/link 跳转，不可直接用）；标题 `extract_tag(block,"<h3","</h3>")`；摘要藏在 `<!--s-data:{"summaryData":...}-->` JSON 注释 → `extract_baidu_summary` 用 `serde_json` 解析取 `generalLines[].data[].text`
  - **新增 `search_360`**：`https://www.so.com/s?q=`；真实 URL 在 `data-mdurl="http..."` 属性（href 是 so.com/link 跳转）；标题 `<h3 class="res-title">`、摘要 `<p class="res-desc">`
  - **新增 `search_sogou`**：`https://www.sogou.com/web?query=`；普通结果块 `class="rb"`，标题 `<h3 class="pt">`、摘要 `<div class="ft">`；链接是 `/link?url=` 相对跳转 → 补全 `https://www.sogou.com` 前缀
  - **反爬检测**（各源内置）：页面 <3000 字节 或含明确反爬特征（`antispider`/`wappass`/`安全验证`/`请输入验证码`/`captcha`/`访问过于频繁`）→ 静默返回空（该源失败不影响其它源）；360 判定修正：只要页面含 `res-list` 结果标记就继续解析（避免误伤正常页里的"已验证"等字样）
  - **实测**：`test_web_live` 综合搜索 11 条（华为官网/知乎/华为商城/consumer.huawei.com 等），首条即真实结果；多源合并去重效果显著
- **关键经验**：搜索引擎对**高频/连续请求**有 IP 级限流（连发 live 测试会触发，curl 也中招），真实低频使用不受影响；多源并行综合正是为此设计——单源被反爬返回空时其它源照常补上
- **前端清理**：`web_search` 命令去 `braveKey` 参数；删 `set_brave_api_key` 内置工具与系统提示词条目；`appSettings.ts` 删 `braveApiKey` 字段；`McpSettings.vue` 删 brave-search 安装时 prompt 逻辑 + 未使用的 `getSettings/updateSettings/Search` 图标导入；`mcp-catalog.ts` 删 brave-search 插件条目；`settings.rs` 删 `brave_api_key` 字段 + 加解密 + 测试引用
- **搜索信息不足优化**：web_search 工具对最相关**前 2 个结果自动 fetch_page 抓正文片段**（取 600 字符）注入上下文，让模型基于具体信息回答而非只给链接；提示词三处强化「摘要常不完整 → 需要具体数据/细节必须 fetch_page 抓正文，严禁只罗列链接让用户自己点开」（web_search 工具描述、formatSearchResults 注入文本、web_search 工具结果文案）
- 验证：cargo test 全部通过（search 5 单测 + settings + db 等 11 项）、前端无错误、`test_web_live` 端到端 11 条结果

### ✅ 收尾：Puppeteer MCP env 支持（开发计划 §2.1，核心提交 `0930eda`）
- 确认全链路已完成并推送：`McpServerConfig.env` 透传（mcp.rs）、`mcp_connect` env 参数（lib.rs）、`McpServerPersist.env`（appSettings.ts）、mcp.ts 透传 + `applyPuppeteerEnv` 迁移自动补 Edge 路径、`mcp-catalog.ts` puppeteer 条目带 `env: { PUPPETEER_EXECUTABLE_PATH: "...Edge..." }`、`McpSettings.vue` 编辑表单支持 `KEY=VALUE` 多行 env
- 本次仅补文档标记（§2.1 半成品 → 已完成）并验证 `cargo check` + `npm test`(35) + `vite build`
- 至此开发计划 §2「进行中」积压清零，可干净启动长期记忆 Phase 1

### 📌 规划：Agent 长期记忆功能（详见 `DEVELOPMENT_PLAN.md` §3）
- 现状：已有事实提取 / 摘要压缩 / 关键词+向量检索（DeepSeek 无 embeddings 则关键词回退）/ 偏好 / `touch_fact`+`prune_facts` 遗忘命令
- 短板：语义检索在 DeepSeek 下不可用、无事实去重合并、遗忘不自动、无记忆管理 UI、注入无权重排序
- 四阶段计划：①记忆内核增强（去重合并 / 自动遗忘 / FTS5 索引 / 用户画像）②检索注入（混合检索 / 排序剪裁 / 主动记忆工具）③记忆 UI（管理面板 / 配置 / 可视化）④增强（本地 embedding / 记忆复习）
- 待启动：Phase 1（事实去重 + FTS5 索引 + 自动遗忘调度）

### ✅ 用量统计历史累计（081b7ed，92bbd13 修复）
- 后端新增 `usage_agg`（总量）+ `usage_agg_daily`（按天）持久化累计表，删除会话不清零；新增 `accumulate_usage` / `get_usage_agg` 命令；启动时从历史 messages 幂等聚合
- 修复前后端结构不匹配（`{total:{...}}` 嵌套字段层级）；主界面顶栏与「用量统计」页均改为显示**历史累计**（含已删除会话）
- 实测：56649 tokens / ¥0.67 / 8 条；验证：cargo test（9 通过 + 2 新增）、npm test 35、vite build

### ✅ 引用链接 404 修复（a830e19）
- 根因：marked 裸 URL autolink 把 URL 后紧跟的中文正文吞进 href（`...shtml。结束` → href 含中文）→ 点击必 404；叠加模型正文改写 / 截断 URL
- 修复：自定义 marked `url` tokenizer（URL 结尾排除中英文标点 / 空白 / 汉字）；三处提示词强制「逐字原样复制完整 URL，禁止截断 / 删改扩展名 / 编造」

### ✅ 搜索引用地址误判本地文件（4a27944）
- `LOCAL_FILE_RE` 负向后顾 `(?<![\w\/])` → `(?<![\w\/:])`，`https://` 等外链路径不再被当本地文件（不再显示「文件不存在」）

### ✅ 附件按文件类型图标（bbca256）
- 新增 `src/utils/file-icons.ts`：按扩展名 / MIME 映射 lucide 图标（PDF / Excel / Word / PPT / 代码 / 压缩 / 音视频 / JSON / 数据库等）；消息气泡附件卡片与输入框附件栏均动态图标；图片仍走缩略图

### ✅ 五彩光圈穿透 + 搜索结果 URL 截断（f80e699）
- 光圈：`-webkit-mask` 在 WKWebView 失效 → 改 `background-clip: padding-box/border-box` 双背景（仅描边渐变）
- URL：搜索卡片 `[标题](url)` 在 URL 含 `)` 时被 marked 截断 → 改用 `<url>` autolink

### ✅ UI 图标统一为线性图标（e01d1ec）
- 引入 `lucide-vue-next`，替换应用内静态 emoji 图标（按钮 / 设置 tab / 面板标题 / 状态 / 头像等）；`main.css` 加 `.lucide` 统一样式

### ✅ 彻底解决「分析 op 目录」工具循环中断（ead45ae + 6097fea）
- 多层根因：工具调用写在 reasoning 需同时检测；空 `<tool_call>` 与伪卡片注入修正重试；工具轮上限 8→20 + 收尾提示；无正文自动补一轮；`callMcpTool` 拦截 `directory_tree` 引导 `list_directory`；前端 debug_log 诊断埋点
- 验证：9 轮工具 + 2956 字符完整答案

---

## 2026-08-18

### ✅ 功能：数学公式渲染（KaTeX）
- 新增依赖 `katex`；自建 marked 扩展 `src/utils/katex-marked.ts`（替代 `marked-katex-extension`——其类型入口是裸 TS 源码，与项目 `strict + noUnusedParameters` 冲突报 TS6133）
- 支持 `$...$` / `$$...$$` / `\(...\)` / `\[...\]` 写法；行内公式要求前后空格/标点，避免货币误判（如 `$5 和 $10`）
- `ChatMessage.vue` 的 `md()` 前置 `normalizeMath()`：①保护代码块/行内代码 ②中文（汉字+全角标点）紧贴美元符补空格 ③反斜杠括号归一化
- 修复两个渲染 bug：
  1. 公式前紧贴中文全角标点（`，` `；` `（` 等）不被识别 → 补空格字符类扩为 `\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef`，且 inlineRule 结尾标点集合加中文标点
  2. **自定义 marked `text` renderer 忽略 `token.tokens`** 导致加粗/斜体/公式以字面量显示（如 `**xx**`、`$...$`）→ 改为有嵌套 tokens 时先 `this.parser.parseInline(token.tokens)` 渲染，纯文本才做路径链接化
- 样式：main.css 加 katex `white-space:nowrap` + `.katex-display` 横向滚动（长公式不撑破气泡）
- 验证：`vue-tsc` + `vite build` + 15 项解析用例（中文标点紧贴、货币不误判、代码保护、加粗/公式/路径混合）通过

### ✅ 功能：中文系统菜单栏（替代 Tauri 默认英文菜单）
- Rust `build_app_menu()` 构建 6 个菜单（道生一/文件/编辑/视图/窗口/工具）；预定义项（隐藏/退出/撤销/复制/最小化等）系统原生处理
- 自定义项点击 → `on_menu_event` → `emit("menu://action", id)` → 前端 `main.ts` listen 分发
- 新增 `src/stores/ui.ts`（设置 tab / 关于 / 技能库 / 侧边栏 / 主题 / 导出请求状态）；`src/components/AboutDialog.vue` 关于弹窗（版本动态读取 + GitHub 外链经 shell open）
- 坑：安装的 `@tauri-apps/api@2.1.0` 无 `getCurrentWindow().onMenuEvent`（新版本才有）→ 用 Rust emit + 前端 listen 通道最稳
- 验证：`cargo check` + `vue-tsc` + `vite build` + 浏览器驱动 ui store 联动（关于/设置 tab/技能库/侧边栏）通过

### ✅ UI 优化
- **消息内容宽度自适应**：容器 920px → `min(100% - 48px, 1400px)`（小屏填满、大屏封顶），气泡 `78%→85%`，减少高分屏全屏时的两侧空白与内容高度
- **图标统一**：`AppLogo.vue` 与 Dock 图标同源造型（圆点"道" + 横条"一"），颜色随明暗主题切换，底色与背景增加色差 + 边框 + 投影，呈现独立图块
- **设置弹窗**：删除此配置/保存按钮仅「API 配置」tab 显示（其余 tab 只留取消）
- 验证：`vue-tsc` + `vite build` + 浏览器实测（两主题、多视口宽度）通过
- **文档更新**：README 新增界面截图（浅/深主题、设置、关于）；项目结构/技术栈同步

---

## 2026-08-17

### ✅ 修复 + 功能：web_search 多源回退链（Bing 修复 + DuckDuckGo 源）
- **根因**：`[Bing] 0 results` —— Bing DOM 改版后标题开标签带属性（`<h2 class=...>`），`extract_tag` 精确匹配 `<h2>` 失败
- **修复**：`search.rs` 新增宽松 `extract_h2`（允许属性）+ `extract_h2_link`（从 h2 内取真实链接，跳过 CSS link）+ `extract_bing_caption`
- **新增 DuckDuckGo 源**（回退链 Brave → Bing → DDG）：cookie 会话 + 多 UA 轮换 + 202 anomaly 反爬自动重试 3 次；结果链接从 `uddg` 参数双重 percent-decode
- **实测**：Bing 10 results（华为官网/百度百科/爱企查）；DDG 在本环境被 202 反爬拦截（保留重试兜底）；`reqwest` 加 `cookies` feature
- **验证**：Rust 7 项测试通过（settings 4 + search 3），编译通过；已推送 `ecd67f1`

### 📌 调研：Hermes-CN-Desktop 对比（交互/对话/工作模式，v0.8.0-rc7）
- 待落地改进（详见仓库记忆 `hermes-compare-and-local-gpu.md`）：
  - 🔴 Smart 智能审批（三档：手动/smart 辅助模型判断/YOLO）
  - 🔴 子代理可视化面板（树 + 实时事件流 + 并行分组）
  - 🔴 CLI 委派增强（Claude Code/Codex 5 模式 + 后台 + Token/退出码）
  - 🟡 辅助任务独立模型槽 / Persona 人格市场 / 切换优雅重启 overlay
- 架构差异（不必照搬）：Hermes 是托管内核外壳（managed/local/remote），道生一是单体

### ✅ 落地：Hermes 借鉴 6 项全部完成（高 3 + 中 3，逐项推送）
- 🔴 Smart 智能审批：审批三档 manual/smart/yolo；smart 用辅助模型判断命令安全（`judgeCommandSafety`，可配独立辅助模型），失败保守走确认（`fedc36e`）
- 🔴 子代理可视化面板：`SubagentPanel.vue` 展示 goal/状态/耗时/结论预览，可清空已结束，支持并行（`fedc36e`）
- 🔴 CLI 委派增强：`delegate_coding_agent` 支持 print/exec/review/resume 4 模式 + max-turns + resume 会话；返回结构化结果（退出码/耗时/token），前端展示（`a5b978f`）
- 🟡 辅助任务模型槽：设置「辅助任务模型」复用已配置 Profile（无需重复存 Key），Smart 审批/子代理优先用辅助模型省主模型额度（`0040449`）
- 🟡 Persona 人格市场：`personas-catalog.ts` 8 个人格，顶栏切换，注入系统提示词角色前缀（与技能库互补）（`5f37971`）
- 🟡 切换优雅 overlay：switchProfile 停止进行中流 + 800ms 切换提示遮罩（`53f3edf`）
- 低价值项：浅色主题道生一已有（`useTheme` 双主题 + 系统偏好），无需新增

### ✅ 本地 GPU 方案 A：结论（此 Intel Mac 不可行）
- 自编译 `LLAMA_METAL=1` 成功枚举 `MTL0: AMD Radeon Pro 5300M (4080 MiB)`，但实测推理仅 2.0-2.2 t/s（比 CPU 9.9 t/s 慢 5 倍）+ 输出异常 → **Metal offload 在 Intel Mac 是负优化**
- 结论：Ollama（0 GPU）/ Homebrew llama.cpp（无 Metal）/ 自编译 Metal（负优化）均无法有效用 AMD 5300M
- 建议：本地模型保持 CPU（轻量图片理解）+ 重推理走云端 DeepSeek；坚持 GPU 需 Apple Silicon

### ✅ 修复：fetch MCP 插件不可用（`npx mcp-server-fetch` 报错）
- **现象**：启动 MCP 报 `mcp-server-fetch: line 1: /Applications: is a directory` / `syntax error`
- **根因**：npm 上 `mcp-server-fetch`（v0.0.2）是安全研究 **canary 占位包**，`npx` 拉取的是遥测脚本而非 MCP server
- **方案**：`src/stores/mcp.ts` 新增 `migrateConfig` 自动禁用此类配置（提示用内置 `fetch_page`）；`mcp-catalog.ts` 移除 fetch 插件条目；清理 `~/.npm/_npx` 污染缓存
- **验证**：30 项测试通过，无类型错误；应用热更新后「网络请求」不再连接
- **已推送**：`56e8fbe`

### ✅ 修复：Puppeteer MCP 不可用（`spawn Unknown system error -88`）
- **现象**：`puppeteer_navigate` 启动失败
- **根因**：
  1. `chrome-headless-shell` 缓存损坏（目录内缺可执行文件，只有 ABOUT/LICENSE）
  2. 完整版 Chrome for Testing（131，2024 年）在 macOS 26.5.2 上**启动即被系统 SIGKILL**（`zsh: killed`），故 `--version` 都失败
  3. 本机无 Google Chrome，仅有 Microsoft Edge
- **方案**（代码已改，待收尾）：
  - 重新安装 `chrome-headless-shell@131.0.6778.204`（修复缓存）
  - MCP 客户端加 **env 支持**（`mcp.rs`/`lib.rs`/`appSettings.ts`/`mcp.ts`），`PUPPETEER_EXECUTABLE_PATH` 指向本机 Edge
  - 待办：`mcp-catalog.ts` + `McpSettings.vue` + 编译验证 + 推送（见计划 §2.1）
- **验证**：puppeteer + Edge `launch` + `goto` 成功（百度天气页标题正常）

### ✅ 修复：日期幻觉 + 编造数据
- **现象**：模型日期幻觉；未调用工具时编造数据（如天气）
- **根因**：
  1. 工具提示为软性（"需要工具时..."），模型被问实时信息（天气/新闻等）时凭训练数据编造
  2. `volatileCtx` 的【当前时间】只有 HH:MM 无日期；系统提示日期措辞不够强硬
- **修复**（`src/stores/chat.ts`）：
  - `withCurrentDate`：强调"唯一可信日期来源，回答前先核对，严禁编造训练数据日期"
  - `volatileCtx`【当前时间】：补全完整日期（年月日 + 星期 + 时分）
  - `getMcpToolsPrompt`：新增「强制要求（实时/时效信息）」——实时数据**必须先调** `web_search`/`fetch_page`，拿不到明确说「无法获取」，**严禁编造**
- **验证**：`vite build` + `npm test`（30 项）通过

### ✅ 功能：YOLO/自动批准高危命令开关（🟢）
- `settings.rs`/`appSettings.ts`：`AppSettings` 加 `yolo_mode`（默认 false）
- `chat.ts runCommand`：危险命令确认前判断 `yoloMode`，开启则自动批准不弹窗
- `SettingsDialog.vue`：Agent 设置新增「⚠️ 高危操作(YOLO 模式)」开关
- 验证：`cargo check` + `cargo test settings`(4) + `vite build` + `npm test`(30) 通过

### ✅ 功能：用量统计图表页（🟢）
- 新增 `UsageStats.vue`：从 SQLite 对话记录聚合——总会话/消息/Token/费用/平均耗时卡片、缓存命中率条、每日 Token 柱状图、会话 Token 分布
- `SettingsDialog.vue`：新增「📊 用量统计」tab
- 纯 CSS 图表（无新依赖），只改前端（HMR 热更新，不重启 dev 客户端）

### ✅ 功能：会话归档/导出（🟢）
- 归档：`chat.ts` 加 `archivedIds`（localStorage 持久化）+ `archiveConversation`/`unarchiveConversation`/`deleteArchived`；主列表只显示未归档，归档视图可恢复/删除
- 导出：复用已有 `export_conversation` 后端（JSON/Markdown）+ 前端 `downloadExport`（Blob 下载）
- `ChatHistory.vue`：每个会话加「⤓ 导出」「🗂 归档」按钮，顶部「🗄」切换归档视图
- 只改前端不重启 dev 客户端

### ✅ 修复：发送图片回复空内容
- **根因**：`describeImages(images)` 在 `try` 块外，若本地视觉模型识别异常会绕过 catch/finally，`assistantMsg.content` 永不赋值 → 气泡停留为空内容
- **修复**：图片预处理调用包 try-catch，异常时走 `ocrFailed` 分支进入错误兜底
- 验证：`vite build` + `npm test`（30 项）通过

### ✅ 功能：运行时健康/日志面板（🟡）
- Rust：新增 `system_diagnostics` 命令（sw_vers/sysctl/vm_stat/df/uptime 组合，无新依赖）返回 OS/版本/内存/磁盘/运行时长 + `daoshengyi.log` 尾部 150 行
- 前端：新增 `HealthPanel.vue`（系统信息卡片 + 内存/磁盘进度条 + 日志查看 + 刷新）
- `SettingsDialog.vue`：新增「🩺 诊断」tab
- 验证：`cargo check` + `vite build` + `npm test`(30) 通过

### ✅ 功能：定时任务（🟡）
- Rust：`scheduled_tasks` 表 + `list/save/delete/toggle` 命令 + 后台调度线程（每 30 秒检查，`/bin/sh -c` 执行，300 秒超时，结果存最近 1000 字符）；支持每 N 分钟 / 每天 HH:MM
- 前端：新增 `ScheduledTasks.vue`（任务列表 + 添加表单 + 启停/删除/上次结果）
- `SettingsDialog.vue`：新增「⏰ 定时任务」tab
- 验证：`cargo check` + `vite build` + `npm test`(30) 通过

### ✅ 功能：长任务防休眠（🟡）
- Rust：`SleepGuard`（std Mutex）+ `set_prevent_sleep` 命令（macOS `caffeinate -dimsu`，非 macOS 静默跳过）
- 前端：`chat.ts` 加 `setPreventSleep` 辅助；图片识别、`/run` 命令执行前后自动启用/关闭
- 注意坑：lib.rs 的 `Mutex` 默认是 tokio 异步锁，SleepGuard 需显式用 `std::sync::Mutex`；`tokio::process::Command` 无 `.timeout()`，需 `tokio::time::timeout` 包裹
- 验证：`cargo check` + `vite build` + `npm test`(30) 通过

### ✅ 功能：编码 Agent 委派（🔵）
- Rust：`check_coding_agents`（which 检测 claude/codex + 版本）、`delegate_coding_agent`（`claude -p` / `codex exec`，`tokio::time::timeout` 超时，返回 stdout/stderr）
- 前端：新增 `CodingAgents.vue`（安装状态卡片 + 委派表单 + 输出查看 + 安装命令提示）
- `SettingsDialog.vue`：新增「🤖 编码 Agent」tab
- 说明：本机未安装 claude/codex，检测返回「未安装」；装好后即可委派
- 验证：`cargo check` + `vite build` + `npm test`(30) 通过

### ✅ 功能：子代理委派（🔵，轻量版）
- `chat.ts`：新增内置工具 `subagent_delegate`——模型可委派子任务给独立上下文的子代理（复用 `chatOnce` + `withCurrentDate`），返回子代理结论；工具提示中加入说明
- 轻量版：单层子代理（未做 Hermes 的树状监视面板，后续可迭代）
- 验证：`vite build` + `npm test`(30) 通过

### ✅ UI 优化：参考 Hermes-CN-Desktop 布局（2026-08-17）
- **设置对话框**：顶部 tab → **左侧菜单 + 右侧内容**布局（7 个菜单项垂直排列，弹窗加宽至 640px，左侧 `settings-nav` + 右侧 `settings-content` 独立滚动）
- **消息区**：内容居中容器 `messages-inner`（max-width 920px），宽屏下不贴边（Hermes 工作台风格）
- **空状态**：新增 6 个功能引导卡片（⌘N /run /read /📋粘贴图片 /⏰定时任务 /🩺诊断）
- **气泡**：assistant 用 `--bg-assistant-bubble` 柔和背景，user 用 accent 渐变
- **顶栏**：加品牌 AppLogo
- 浏览器实测：主界面 + 设置左侧菜单布局均正常

### ✅ 修复：会话导出按钮"卡死"
- **根因**：`downloadExport` 用 `<a download>` + Blob URL，WKWebView（macOS）不支持 → 点击无反应
- **修复**：Tauri 环境改「原生保存对话框（plugin-dialog `save()`）+ Rust `write_text_file` 命令落盘」（限制 .md/.json/.txt 扩展名）；浏览器预览回退 `<a download>`
- 验证：`cargo check` + `vite build` + `npm test`(30) 通过

### 📌 调研：Hermes-CN-Desktop（`Eynzof/Hermes-CN-Desktop`）
- Tauri 2 + React 桌面客户端，1.6k stars，v0.8.0-rc7；许可 **PolyForm Noncommercial**（只借鉴思路不抄代码）
- 借鉴点已纳入《开发计划》§3（YOLO 开关 / 用量图表 / 会话归档 / 健康面板 / 定时任务 / 子代理委派等）
- 完整调研笔记在会话记忆 `hermes-cn-research.md`

### ✅ 改名：MCP 服务器 →「🧩 插件」体系（2026-08-17）
- 插件管理面板改为「🧩 插件」：Tab「已安装」「🌐 插件市场」，按钮「+ 添加插件（第三方）」
- 设置弹窗左侧菜单第 2 项改为「🧩 插件」

### ✅ 功能：社区插件市场（方向 A，Smithery 接入）
- **背景**：用户要求接 mcp.so，实测其 API 全被 Cloudflare 防护（403），Smithery/Glama 开放（HTTP 200）
- **Rust（mcp.rs）**：MCP 客户端新增**远程 HTTP（streamable HTTP MCP）模式**
  - `McpClient` 增加 `http/endpoint/session_id` Option 字段；`connect` 按 command 是否 `http(s)://` 前缀分发远程/stdio
  - `remote_connect` + 共用 `handshake`（initialize → initialized → tools/list）
  - `send_request` 远程分支：POST JSON-RPC，`mcp-session-id` 头保存/回传，响应兼容 JSON 与 SSE（`data:` 行按 id 匹配）
  - `send_notification` 远程分支：POST 通知后忽略响应
  - `Drop` 仅 stdio 模式 kill 进程
- **Rust（lib.rs）**：新增命令 `fetch_community_plugins`（Smithery 列表）、`fetch_remote_plugin_endpoint`（详情 deploymentUrl）
- **前端（McpSettings.vue）**：插件市场加「🌐 社区插件（远程 · 免安装）」区——搜索 + 加载 Smithery 列表（名称/描述/✓已验证/使用量），安装即查远程端点添加为 `command=URL` 的远程插件并自动连接
- **验证**：`cargo check` ✓、`npx vite build` ✓、`npm test`（30 项全绿）✓
- **注意**：Rust 改动需重启 dev 客户端生效（远程模式在前端 HMR 下无法生效）

### ✅ 基础设施
- `npm run tauri dev` 首次完整构建通过（1m 07s），文件系统 MCP 连接成功（14 工具）
- 拉取远程后验证：工作区配置、`/run` 终端卡片、`/read` 文件读取均保留；HEAD 与 origin/main 同步

---

## 2026-08-14 及之前（Phase 1 及演进，详见 ROADMAP.md）

- **Phase 1 完成**：流式对话、多模型切换、记忆系统、技能库、MCP 客户端、联网搜索、网页抓取、SQLite 持久化、API Key 加密、Token/费用统计、图片预处理、提示词模板
- **Agent 能力演进**：ReAct 自动工具调用、MCP 插件市场、API Key AES 加密迁移、动态获取模型、国产模型定位（仅 DeepSeek）、SSE 丢字修复、AI 头像品牌化、IM 气泡布局、DeepSeek Harness 集成（超时守卫/审计/危险命令/工作区/终端卡片/文件读取）、官方价格表计费、UI 滚动/配色修复
- 每次完成均推送 GitHub main

---

## 验证清单（改完必跑）

```bash
cargo check                     # Rust 编译
npx vite build                  # 前端构建
npm test                        # 前端测试（30 项：19 tokens + 11 模板/工具）
cargo test settings             # Rust 加密测试（4 项）
git push origin main            # 推送
```
