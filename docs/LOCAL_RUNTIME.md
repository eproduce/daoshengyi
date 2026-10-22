# 本地运行时：llama.cpp（推理 + 嵌入）

> 2026-10-21 · 状态：**已收敛为单一路径**。应用不再依赖任何外部本地模型守护进程；
> 本地能力全部由本应用托管的 `llama-server` 提供。旧的 Ollama 集成（部署、拉取、导入、
> 回退嵌入、`OLLAMA_*` 环境变量）已从代码与设置界面移除。

## 1. 能力边界

| 能力 | 实现 | 说明 |
| --- | --- | --- |
| 视觉描述 | `describe_image` → `local_runtime::ensure_server` | 端口 18080，按需启动 + 空闲 120s 回收 |
| 嵌入（语义检索） | `embed_texts` → `local_runtime::embed_texts` | 端口 18081，`--embedding --pooling mean`，空闲 30s 回收 |
| 模型导入 | `local_runtime_import_gguf` / `local_runtime_import_dir` | 硬链接优先；按 GGUF 魔数识别 |
| 其它推理端点 | 「设置 → API 配置」新增 Profile | 本地（Strata / LM Studio / vLLM）与云端通用，本地视觉不可用时前端自动使用 |

二进制探测顺序：`<app_data>/runtimes/llama-server` → `/usr/local/bin` → `/opt/homebrew/bin`
→ `/usr/bin` → `which llama-server`。

## 2. 模型来源（唯一需要用户操作的一步）

llama.cpp 只做推理，不提供模型仓库。当前提供两条零依赖路径：

1. **导入 GGUF 文件**：设置 → 本地模型 → 「导入 GGUF 文件…」（多选）。
2. **从目录导入**：扫描目录（递归 3 层），`.gguf` 或魔数为 `GGUF` 的文件都会导入；
   同盘使用硬链接，**不额外占磁盘**。

嵌入模型按文件名识别（`embed` / `bge-` / `gte-` / `e5-`）；投影器按 `mmproj` / `projector` / `clip` 识别。
未导入嵌入模型时，记忆/知识库检索自动降级为 FTS5 关键词（**绝不返回假向量**）。

## 3. 其它推理端点（统一走 API 配置）

本机其它推理服务（Strata / LM Studio / vLLM）与云端视觉模型**不再有单独入口**：
在「设置 → API 配置」新增一个 OpenAI 兼容 Profile（填 Base URL / Key / 模型名）即可。

- 本地视觉（llama.cpp）可用时优先用它；
- 本地视觉不可用时，前端 `describeImages` 会自动挑一个**支持图片输入**的 Profile 识别图片；
- 一套配置同时服务聊天与识图，本地 / 云端一致。

## 4. 生命周期与内存

- `ensure_server` 启动后由看门狗计时，`IDLE_KILL_SECS = 120` 秒无请求即停止；
- 应用退出钩子会停止本应用启动的进程（不触碰用户自行启动的其他服务）；
- 固定 `-np 1`，只保留一份 KV cache。

## 5. 可观测性

「设置 → 本地模型」展示：二进制路径、托管目录、已导入模型、当前模型是否带投影器、
服务/嵌入服务状态与空闲秒数、嵌入模型与端口。导入结果逐文件列出「硬链接 / 复制 / 已存在」。

## 6. 迁移与兼容性

- 旧的 `localVisionRuntime = "ollama"` 取值已删除；读到旧设置时按 `auto` 处理。
- 旧的 `ollama` API Profile 不再自动创建；已存在的手工配置不影响启动，但不再被应用改写。
- 用户原有的模型文件不会被删除；通过「从目录导入」重新接入即可。
