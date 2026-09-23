# 道生一 能否兼容 DSH 插件？（结论：不能直接兼容，也不建议去兼容）

日期：2026-09-23 ｜ 参考：本地 `deepseek-harness` 仓库（`docs/cordis-primer.zh.md`、
`.agents/notes/implemented/architecture/2026-09-18-plugin-install-registries.md`、`packages/sdk/`、`packages/mcp/`）

## 一、两边的「插件」不是同一种东西

| 维度 | 道生一 | DSH |
| --- | --- | --- |
| 插件形态 | **MCP 服务器**（外部进程 + stdio JSON-RPC）／**技能**（提示词包）／内置工具（编译进 Rust） | **npm 包形式的 Cordis 插件**：函数对象 `apply(ctx)`（可选 `inject`）或 `Service` 子类 |
| 运行位置 | 独立进程（node/npx 或本地二进制），崩溃不拖累本体 | **DSH 宿主进程内**，由 Cordis loader 挂载 |
| 依赖 | 无：自描述 `inputSchema`，协议即契约 | **宿主服务图**：`ctx.tools` / `ctx.llm` / `ctx.sessions` / `ctx.fs` … + 类型化事件契约（`emit`/`waterfall`/`parallel`/`serial`/`bail`） |
| 安装 | 插件市场（`mcp-catalog.ts`）/ 手动配置 / 技能外部导入（`skill_import`） | `dsh plugin add <npm spec>`（pnpm 安装，带 registry 回退链） |
| 生命周期 | 进程启停 | `inject` 等待依赖就绪；注册是**可逆副作用**（`ctx.effect()`/`ctx.on()`，reload/teardown 时撤销） |

## 二、为什么不能直接把 DSH 插件拿来跑

Cordis 插件**不是**独立程序，而是"注册进宿主上下文的对象"：它靠 `inject` 声明所需服务并等待就绪，
通过 `ctx.tools`/`ctx.llm`/… 与宿主交互，靠事件契约通信。我们这边：

- 没有 JS 运行时（只有跑 npx MCP server 的 Node 侧车）；
- 没有 Cordis 内核；
- 没有 DSH 的服务面与事件契约。

⇒ 要跑起来，等于把**DSH 本体（服务图 + 事件语义）** 搬进来，而不是"加个插件加载器"。
这与我们已定的两条决策直接冲突：

- `docs/ROADMAP.md` §5.1（2026-09-15）：三层能力模型（内置工具 / 技能 / MCP），**不再自建插件 SDK**；MCP 收敛为长尾补充；
- `docs/STRUCTURAL_GAP_ANALYSIS.md`：**不引入 Cordis 或通用插件内核**（单进程 Tauri、工具集封闭，没有"第三方可扩展"的需求）。

## 三、方向是不对称的

- ✅ **我们的 MCP 插件在 DSH 里能用**：DSH 有 `packages/mcp`（连接外部 MCP 服务器、调工具、读资源）。
- ❌ **DSH 的 Cordis 插件在我们这儿用不了**。

## 四、若确实要"部分兼容"，只有三条路

| 路径 | 做法 | 可行性 | 代价 |
| --- | --- | --- | --- |
| **A. 移植插件**（推荐） | 把想要的插件改写成 ① 道生一**技能**（本质是提示词/流程的）或 ② **MCP server**（只提供工具、不依赖宿主服务的） | 高 | 人工一次性移植，可验证；不引入新运行时 |
| **B. DSH SDK 桥** | DSH 有进程外 SDK（换行分帧 JSON-RPC，TS/Python 客户端，可启动 `dsh`、开会话、发提示词、观察事件）。照 `mcp.rs` 的方式在 Rust 侧接一个 stdio 客户端，把"让 DSH 跑一件事"包成一个内置工具 | 中 | **这是调用 DSH 运行时，不是加载它的插件**；用户机器需要 node+pnpm+dsh 与完整 profile，与"零外部编码依赖 / 内置优先"路线冲突 |
| **C. Cordis 适配器** | Node 侧车加载 cordis 内核 + 桩实现 `ctx.tools`/`ctx.llm`，把"纯工具型插件"暴露成 MCP server | 低 | 要复刻 DSH 服务契约与事件语义，只对极少数无宿主依赖的插件有效，投入产出比差 |

## 五、建议

1. **"想要某个具体能力"** → 说清是哪个 DSH 插件，按路径 A 移植。DSH 生态里能力类插件（确定性工具集、压缩、
   脱敏、预算护栏、钩子、权限规则…）我们**已在 `DSH_ABSORPTION_PLAN` 里吸收完毕**（P0/P1 全绿），外观类
   （皮肤/主题/宠物/启动器）本就明确不吸收。
2. **"想要生态"** → 现实路径是 MCP（已支持市场 + 目录收敛原则）+ 技能外部导入（已支持）；社区那块若真有
   第三方开发需求，再谈 O7 插件化 SDK（当前决策：不做）。
3. **不建议为兼容而兼容**：为跑 DSH 插件而引入 Node 运行时 + Cordis 内核 + DSH 服务面，成本远高于把需要的那
   几个能力直接内置/做成技能。
