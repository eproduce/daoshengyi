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
| 外部服务（可选） | `localVisionRuntime = external` | 任何 OpenAI 兼容端点，如 Strata `http://127.0.0.1:8080/v1` |

二进制探测顺序：`<app_data>/runtimes/llama-server` → `/usr/local/bin` → `/opt/homebrew/bin`
→ `/usr/bin` → `which llama-server`。

## 2. 模型来源（唯一需要用户操作的一步）

llama.cpp 只做推理，不提供模型仓库。当前提供两条零依赖路径：

1. **导入 GGUF 文件**：设置 → 本地模型 → 「导入 GGUF 文件…」（多选）。
2. **从目录导入**：扫描目录（递归 3 层），`.gguf` 或魔数为 `GGUF` 的文件都会导入；
   同盘使用硬链接，**不额外占磁盘**。

嵌入模型按文件名识别（`embed` / `bge-` / `gte-` / `e5-`）；投影器按 `mmproj` / `projector` / `clip` 识别。
未导入嵌入模型时，记忆/知识库检索自动降级为 FTS5 关键词（**绝不返回假向量**）。

## 3. 外部本地推理服务（可选）

Strata 等工具在本机提供 OpenAI 兼容 API（Strata 默认 `http://127.0.0.1:8080/v1`，
模型名与 Key 任意）。在「设置 → 本地模型 → 外部本地推理服务」填入即可：

- 后端选择 `auto`（默认）：llama.cpp 就绪优先，否则用已配置的外部服务；
- 后端选择 `external`：强制走外部服务（未配置 Base URL 时明确报错）；
- 聊天侧也可直接在「API 配置 → 本地服务」新建一个 Profile 复用同一端点。

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
