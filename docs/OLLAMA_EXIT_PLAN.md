# 本地运行时：退出 Ollama、转向 llama.cpp（评估 + 迁移计划）

> 2026-09-24 · 结论先行：**可以移除，但「移除 Ollama」≠「删掉 Ollama 集成」**——
> llama.cpp 能接住 Ollama 的**推理**角色（视觉 / 嵌入），接不住它的**模型分发**角色
> （`ollama pull` 那一层 registry）。本次已把**推理路径**全部切到 llama.cpp；
> 「分发路径」怎么替代需要产品取舍，见 §5。

## 1. 为什么值得做（实测依据）

2026-09-17 在本机（Intel Mac i7-9750H / 16GB，llava-phi3 3.8B，768px 图）实测：

| 运行时 | 模型加载后内存 | 空闲行为 | 单次耗时 |
| --- | --- | --- | --- |
| 裸 llama.cpp `-c 2048 -np 1` | 3928 MB | 进程退出即归还（0） | 41.5s |
| Ollama | 20 MB daemon + **4505 MB**（它自己 spawn 的 llama-server 子进程） | 4.5 GB 滞留到 `keep_alive`（默认 5 分钟） | 44.6s |

- **换运行时不提速**（同一内核，Ollama 内部就是 Go daemon + 它自己的 llama-server），
  收益是**内存与常驻**：llama.cpp 走本应用的空闲看门狗（视觉 120s / 嵌入 30s）→ 空闲 0 常驻。
- Ollama 的模型 blob **本身就是 GGUF**（实测魔数）→ 迁移**零下载、零额外磁盘**（硬链接）。

## 2. 现状盘点

### llama.cpp 已承接（本机已验证具备）

- 二进制：`/usr/local/bin/llama-server`
- 应用托管模型目录 `<app_data>/models/`：
  `llava-phi3-latest.gguf`(2.2G) + `llava-phi3-latest-mmproj.gguf`(579M) + `nomic-embed-text-latest.gguf`(262M)
- 视觉：`pick_vision_backend` 的 `auto` 已优先 llama.cpp（端口 18080）
- 嵌入：`local_runtime::embed_texts`（端口 18081，`--embedding --pooling mean`，解析 `/v1/embeddings`）
- 生命周期：按需启动 + 空闲回收 + 应用退出钩子停止（只停自己起的进程）

### 原先仍绑死 Ollama 的 4 处（本次处理了第 1 处）

| # | 位置 | 影响 | 本次状态 |
| --- | --- | --- | --- |
| 1 | `ollama_embed_impl` 走 `localhost:11434/api/embed`，被 `kb_index`/`kb_search`/`kb_add`/`code_index`/`code_search` 共用 | Ollama 一没 → 知识库向量静默降级、`code_index` 直接报错 | ✅ **已切换**到统一入口 `embed_prefer_local` |
| 2 | 模型获取唯一入口 `local_runtime_import_ollama`（扫 Ollama 模型库硬链接） | 移除后**无法再添加新模型** | ⏳ 待定（§5.1） |
| 3 | 用户 profile「本地 Ollama」：`baseUrl=http://localhost:11434/v1`，`model=llava-phi3:latest` | 该 profile 会不可用 | ⏳ 待迁移（§5.2） |
| 4 | `ollama_setup`（brew install + 官方脚本）、`ollama_status`、启动横幅、设置「本地模型」面板 | 新用户的本地模型引导断掉 | ⏳ 待重做（§5.3） |

## 3. 本次已落地（2026-09-24）

**统一入口 `embed_prefer_local`**（`src-tauri/src/lib.rs`）：

```text
优先 local_runtime::embed_texts（llama.cpp，按需启动 + 空闲 30s 回收）
  ↓ 失败
回退 ollama_embed_impl（兼容只装了 Ollama、没装 llama-server 的环境）
  ↓ 都失败
返回合并错误（同时给出两个原因，便于区分「缺二进制」还是「缺模型」）
```

- `kb_index` / `kb_search` / `kb_add` / `code_index` / `code_search` 全部改走该入口
  （这些命令新增 `app: tauri::AppHandle` 参数；Tauri 自动注入，**前端 invoke 调用无需改动**）。
- `ollama_embed` 命令语义变为「统一入口」（llama.cpp 优先 + Ollama 回退）；
  名字里的 `ollama` 是历史遗留，**待更名 `embed_texts`**（需同步注册表 + `src/stores/memory.ts` 1 处）。
- 前端 `src/stores/memory.ts` 原先「先 `local_embed` 再 `ollama_embed`」的两步试错简化为单次调用
  （少一次必然失败的尝试）。
- 工具描述与提示词里的「需本地 Ollama + nomic-embed-text」改为「需本地嵌入模型
  （llama.cpp 优先，Ollama 兜底）」，涉及 `src/data/builtin-tools.ts`、`src/stores/chat.ts`、
  设置面板「本地模型」页文案。

**效果**：Ollama 从此**完全退出推理路径**——只作为「模型导入来源」与「回退后端」存在。
把 Ollama 退掉（`~/Applications/Ollama.app` 退出）后，视觉与嵌入仍由 llama.cpp 正常提供。

## 4. 还有哪些「Ollama 专属」的东西在代码里

- `ollama_setup` / `ollama_status` / `ollama_installing` / `ollama_running` / `ollama_models`：
  部署与探测链路（brew install / 官方脚本 / `/api/tags`）。
- `local_runtime_import_ollama`：扫描 `~/.ollama/models/manifests/**` → 定位 blob → 硬链接导入。
- 设置面板「本地模型」tab：硬件评估、一键部署、模型拉取、运行时状态卡片（`stores/ollama.ts`）。
- `localVisionRuntime: auto | llamacpp | ollama`：**建议长期保留 `ollama` 这个取值**
  （它是回退能力，不是历史包袱）。

## 5. 剩余缺口与方案

### 5.1 模型获取（唯一的真问题）

llama.cpp 只做推理，**没有模型仓库**。移除 Ollama 后「新模型怎么来」必须给答案：

| 方案 | 新增依赖 | 大陆可用性 | 工作量 | 备注 |
| --- | --- | --- | --- | --- |
| A. 「选择本地 GGUF 文件导入」+ 扫目录 | 无 | ✅（用户自行下载） | 小 | 现有 `list_gguf` / `pick_model_pair` 可复用，只缺文件选择 |
| B. 内置下载器（HuggingFace 直链） | `reqwest`（已有） | ❌ 直连不稳 | 中 | 需要断点续传 + 校验 |
| C. 内置下载器（魔搭 ModelScope） | `reqwest` | ✅ 较好 | 中 | 需实测直链与限速 |
| D. 保留 Ollama 当「纯模型下载器」 | Ollama | ✅ | 零 | 即不追求字面移除，只把它降级为可选工具 |

**推荐**：先做 A（零依赖、立刻可用），把 D 作为过渡（已有环境不受影响），
B/C 等实际需要再评估——**不要在没实测大陆直连前写下载器**。

### 5.2 本地聊天 profile 迁移

llama-server 本身提供 OpenAI 兼容端点（`/v1/chat/completions`，含 SSE 流式），
所以「本地聊天」可以不再经过 Ollama。但直接改 `baseUrl` 到 `127.0.0.1:18080/v1` 不够，还要解决：

1. **服务就绪**：18080 由本应用按需启动，用户发消息时服务可能没起 →
   需要新增「发送前确保本地服务就绪」的调用（可复用 `local_runtime::ensure_server`，
   暴露一个轻量命令），否则用户只会看到连接失败。
2. **空闲策略冲突**：视觉用的 120s 空闲回收对聊天太短（每轮对话后可能卸载 2.3GB 权重，
   下一轮要等 10~20s 重载）→ 聊天 profile 应使用更长的空闲时间或常驻，直到用户显式停止。
3. **模型选择**：llama-server 单进程单模型，而 `pick_model_pair` 现在按「最大 + 带投影器」
   挑给视觉用 → 聊天要能独立指定 GGUF（新增设置项 `local_chat_model`）。
4. 注意：本地 3.8B 模型本来就不具备可靠的工具调用能力，行为与现状一致（不会变差）。

### 5.3 部署引导 UI 重做

把「一键部署 Ollama（brew install + pull llava-phi3）」换成：

- 检测 `llama-server`（`brew install llama.cpp`，或本应用自带运行时目录）
- 「导入模型」两种入口：①从 Ollama 导入（已有环境）②选择本地 GGUF 文件（新，见 5.1-A）
- 状态卡片改为**以 llama.cpp 为主**（现有 `RuntimeStatus` 已足够，把 Ollama 状态降为次要信息）

## 6. 分步计划

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **M1（本次）** | 嵌入切换 + 文案 + 本文件 | ✅ 已过门禁：cargo 254 / vitest 528 / clippy 0 / build |
| M2 | 「选择本地 GGUF 导入」+ 设置面板以 llama.cpp 为主 | 冷启动无 Ollama 时，索引/检索/视觉全通 |
| M3 | 本地聊天 profile 迁移（就绪保证 + 模型指定 + 空闲策略） | 断网、退出 Ollama.app 后本地聊天可用 |
| M4 | 删除 `ollama_setup` 链路与「一键部署」UI | 代码里不再有 `brew install ollama` |

## 7. 回退与风险

- **回退**：`localVisionRuntime` 保留 `ollama` 取值；`embed_prefer_local` 保留 Ollama 回退分支
  → 装了 Ollama 的用户行为不变。
- **不要动用户的 Ollama.app**：它可能由用户自启（`~/Applications/Ollama.app`），
  本应用退出钩子只能停自己起的进程。移除集成 ≠ 卸载用户软件。
- **Intel Mac 注意**：本机 x86_64，GPU 加速指望不上（自编译 Metal 实测反而更慢），
  模型选型看 CPU 表现；本地运行时选型不要假设 Apple Silicon。
- **模型质量**：llama.cpp 与 Ollama 跑同一 GGUF 时，llava-phi3 的图片描述质量相当
  （两者都是「幻觉级」，属 3.8B 模型固有限制，不是运行时差异）。

## 8. 一句话总结

**推理已全面 llama.cpp 化**（嵌入 + 视觉），Ollama 降级为「模型来源 + 回退」；
真正卡住「删掉 Ollama」的不是技术，而是**模型从哪来**——先做「选本地 GGUF 导入」，
再决定要不要写下载器或永久保留 Ollama 当下载器。
