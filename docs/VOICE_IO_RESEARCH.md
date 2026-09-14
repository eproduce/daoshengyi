# 道生一 · Agent 语音输入输出方案调研报告

> 目标：为「道生一」选一套**准确、高效、可离线**的 Agent 语音输入（STT）与输出（TTS）方案。
> 调研时间：2026-09-15 · 调研方式：GitHub 源码/README/CI 脚本 + 本机实测取证
> 结论可执行性判定标准：**必须能在这台 Intel Mac（x86_64-apple-darwin）上真的构建出来**（本项目已有前车之鉴：`ort-sys`/fastembed 在本机无预编译产物，完全不可用）。

---

## 一、结论摘要（TL;DR）

| 环节 | 推荐 | 理由一句话 |
|---|---|---|
| **语音输入（中文）** | **`sherpa-onnx` 官方 Rust crate**（Silero VAD + 流式 Zipformer 中文草稿 + SenseVoice/Paraformer 二次确认） | 官方发布 `osx-x64`（Intel Mac）静态/动态预编译库，crate 默认静态链接且首次构建自动下载；自带 `cpal` 麦克风实时示例；中文精度与 CPU 速度均优于 Whisper 系 |
| **语音输出（中文）** | **第一阶段：macOS 原生 `say` / `AVSpeechSynthesizer`（婷婷 Tingting）**；第二阶段按需换 sherpa-onnx 的 Kokoro-zh / Matcha-zh | 本机实测**已内置 9 个 zh_CN 音色、零下载、零依赖、离线**，是"今天就能用"的最优解 |
| **交互形态** | 先做 **Push-to-Talk（按住说话）半双工闭环**，再做**打断（barge-in）与唤醒词** | 半双工避开了回声消除（AEC）这个大坑；唤醒词可用 sherpa-onnx KWS（3M 参数 zh-en 模型）后补 |
| **明确不要做** | ❌ 在本机用 ONNX 系 Rust crate（`ort-sys`）搭嵌入/ASR；❌ whisper.cpp Metal；❌ 依赖 Apple `SFSpeechRecognizer` 做离线中文 | 本机 `ort-sys` 无 x86_64 预编译、Metal 实测负优化（2.0 t/s vs CPU 9.9 t/s）、系统无离线识别资产 |

**核心技术判断**：`sherpa-onnx` 是目前唯一同时满足「中文强 + CPU 友好 + 官方支持 Intel Mac + 官方 Rust API + 原生 Tauri 示例 + 模型生态完整（ASR/TTS/VAD/标点/唤醒词）」的方案。Whisper 系在这台机器上**慢且中文弱**，只适合作为可选后备。

---

## 二、本机与项目硬约束（先划边界，再选型）

| 约束 | 事实 | 对选型的影响 |
|---|---|---|
| CPU 架构 | Intel Mac（i7-9750H，6 核），`x86_64-apple-darwin` | 只能选**提供 x86_64 macOS 预编译或纯 C/C++ 可源码编译**的方案 |
| GPU | 无可用 GPU（Ollama 枚举 0 GPU；自编译 llama.cpp Metal 仅 2.0-2.2 t/s，反而比 CPU 慢 5 倍） | **不要指望 GPU 加速**；选型必须看 **CPU INT8 性能**（Parakeet / sherpa-onnx INT8 正是这条路） |
| 已踩过的坑 | `ort-sys` 无 `x86_64-apple-darwin` 预编译产物 → fastembed 等 ONNX Rust crate **不可构建** | 但注意：**sherpa-onnx 的 Rust crate 不走 `ort-sys`**，它自带 `onnxruntime` 预编译库（见 §四.2），这条坑不适用于它 |
| 技术栈 | Tauri 2 + Vue 3 + Rust；已有 `tauri-plugin-global-shortcut`（可做按住说话热键）、`tauri-plugin-store`（设置持久化）、`portable-pty` | 音频采集/推理放 **Rust 侧**最自然；快捷键插件已在依赖里 |
| 已有原生集成先例 | `src-tauri/ocr_tool.swift` + 预编译 `ocr_tool` 二进制（Vision OCR） | 若走 Apple 原生能力，项目已有"编译 Swift 辅助工具"的成熟模式 |
| 产品理念 | 本地优先（数据不出设备） | **排除**把音频送到云端的默认路径（含 Apple 服务器版识别） |

---

## 三、需求拆解

**语音输入**
1. 中文（含中英混说）准确率优先，专有名词/技术词可接受（可用热词增强）
2. 首字延迟 < 1s、整段结束延迟 < 1.5s（说话结束到文字落地）
3. 离线可用、开机免登录、无网络也能用
4. 不能把整机 CPU 吃满（同时还要跑 LLM 流式输出）

**语音输出**
1. 中文自然度可接受（不要求真人级，但不要"机器朗读味"到出戏）
2. 首字节延迟 < 800ms，且**能边生成边朗读**（与现有流式回复自然结合）
3. 可随时打断（用户开口即停，或按 ESC）
4. 离线、零或小体积下载

---

## 四、GitHub 方案调研

### 4.1 ASR 引擎总表

| 方案 | 中文能力 | CPU 速度 | 体积 | 许可 | 本机可构建性 | 结论 |
|---|---|---|---|---|---|---|
| **sherpa-onnx** | ★★★★★（SenseVoice/Paraformer/Zipformer/FireRedASR/Qwen3-ASR 全支持） | ★★★★★ INT8 实时 | 模型分级（几十 MB ~ 数百 MB） | Apache-2.0 | ✅ **官方 osx-x64 预编译** | **首选** |
| SenseVoice（FunASR） | ★★★★★（中/粤优于 Whisper；AISHELL-1/2、WenetSpeech 基准） | ★★★★★ 非自回归，比 Whisper-Small **快 >5×**、比 Whisper-Large **快 15×** | ⚠️ 待实测 | 代码 MIT；**权重** FunASR Model License（官方澄清：允许商用，须满足署名/命名条款） | ✅ 经 sherpa-onnx 或 SenseVoice.cpp（GGML） | **作为中文主引擎**（经 sherpa-onnx 调用） |
| whisper.cpp（`whisper-rs`） | ★★★（中文一般，易丢标点/幻觉） | ★★（small 尚可，medium/large 在 6 核 CPU 上慢） | small f16 487MB；medium-q4_1 492MB；large-v3-turbo 1600MB；large-v3-q5_0 1100MB | whisper.cpp MIT | ✅ GGML 可源码编译 | **后备**（英文/多语种场景） |
| **whisper-rs 现状** | — | — | — | Unlicense | ⚠️ **仓库 2025-07-30 归档**，迁移到 Codeberg | 不作为长期依赖 |
| Moonshine（moonshine-ai/moonshine，11.1k★） | ⚠️ 英文为主，其他语种为"legacy/较新" | ★★★★★ 超低延迟流式（"边听边算"） | 从 ~1MB（micro）到数百 MB | MIT（legacy 非英文非流式为社区许可） | ✅ 提供 macOS C API | 英文场景的黑马；**中文暂不押注** |
| Apple `SFSpeechRecognizer` | ★★★★ | ★★★★★ | 0 | 系统 API | ✅ 但**本机取证：无离线识别资产**（`/System/Library/Speech/Recognizers` 不存在；`AssetsV2` 下只有 Siri/翻译相关资产，无 SpeechRecognition 资产） | ❌ 大概率走 Apple 服务器 → 违背本地优先；**不采用** |
| Vosk | ★★★（模型旧） | ★★★★ | 中文小模型约几十 MB | Apache-2.0 | ✅ | 备选，精度不及新一代 |
| 云端实时语音（豆包/GLM-Realtime/Qwen3-Omni Realtime/OpenAI Realtime） | ★★★★★ | — | 0 | 商业 | — | **仅在用户显式开启"高质量模式"时可选**，不作默认 |

### 4.2 sherpa-onnx：本报告的核心方案（证据链）

为什么它在本机**真的能用**（逐条已核实）：

1. **官方发布 Intel Mac 预编译库**
   `rust-api-examples/for-advanced-users.md` 明确列出 `x86_64-apple-darwin` 的产物：
   - `sherpa-onnx-v1.13.8-osx-x64-static-lib.tar.bz2`
   - `sherpa-onnx-v1.13.8-osx-x64-shared-lib.tar.bz2`
   并且 Rosetta 交叉编译说明里还有：`rustup target add x86_64-apple-darwin`。
2. **本体依赖的 onnxruntime 也有 osx-x86_64 预编译**
   `cmake/onnxruntime-osx-x86_64.cmake` → 下载 `onnxruntime-osx-x86_64-1.28.2.zip`（另有 `-static_lib` 版）。
   → 这就是为什么它**不受本项目 `ort-sys` 坑的影响**：它自带运行时，不走 `ort-sys`。
3. **官方 Rust API 已就绪，且默认静态链接自动下载**
   crates.io `sherpa-onnx` 最新 **1.13.8（2026-09-11）**，依赖 `sherpa-onnx-sys`；示例 `Cargo.toml` 默认 `default = ["static"]`，注释写明 *"The first build may download the matching sherpa-onnx native libraries for your platform automatically"*。
4. **官方提供 Tauri 构建脚本**
   仓库内 `scripts/tauri/build-tauri-vad-asr.sh.in`、`build-tauri-vad-asr-mic.sh.in` 明确含 `macos-x86_64) RUST_TARGET="x86_64-apple-darwin"`，并有 `tauri-examples/` 目录与 Tauri 预编译 demo。
5. **麦克风实时识别有现成 Rust 示例（用 `cpal`）**
   `rust-api-examples` 共 51 个示例，与语音输入输出直接相关的有：
   | # | 示例 | 用途 |
   |---|---|---|
   | 14 | `streaming_zipformer_microphone`（zh-en） | **实时流式中文识别（麦克风）** |
   | 39 | `sense_voice_simulate_streaming_microphone` | VAD 切段 + SenseVoice 逐段识别（模拟流式，中文最准） |
   | 45 | `zipformer_transducer_simulate_streaming_microphone`（zh） | 同上，Zipformer 中文 |
   | 41/42 | `parakeet_tdt_*_simulate_streaming_microphone` | 英文高质量路线 |
   | 21 | `sense_voice` | 非流式 SenseVoice |
   | 8/10 | `matcha_tts_zh` / `kokoro_tts_zh_en` | **中文 TTS** |
   | 5/6 | `vits_tts`（Piper en/de） | Piper TTS |
   | 24/50 | `silero_vad_remove_silence` / `ten_vad_*` | VAD 静音切除 |
   | 29/32 | `online_punctuation` / `offline_punctuation` | **中文标点还原**（关键！） |
   | 30 | `keyword_spotter` | **唤醒词**（KWS） |
6. **模型清单覆盖中文全场景**（官方预训练表）
   - 流式（适合实时草稿）：`sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20`、`-small-bilingual-zh-en-2023-02-16`、`-zh-14M-2023-02-23`（14M，甚至适合 Cortex-A7）
   - 非流式（适合最终结果）：`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`（**含中文方言**）、`sherpa-onnx-paraformer-zh-2024-03-09`（中英+方言）、`sherpa-onnx-zipformer-ctc-zh-int8-2025-07-03`、`sherpa-onnx-telespeech-ctc-int8-zh-2024-06-04`（方言）、`sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8`（英文）
   - 也支持第三方强模型：FireRedASR、Qwen3-ASR、Cohere Transcribe、FunASR Nano（中文/方言）
   - TTS：Kokoro（zh-en）、Matcha（zh）、VITS/Piper、Supertonic、ZipVoice（零样本音色克隆）、Pocket TTS

**引用与署名注意**：sherpa-onnx 本体 Apache-2.0；SenseVoice 代码 MIT，**权重**适用 FunASR Model License（官方澄清允许商用，但须遵守 §2.2 的署名与模型命名要求）。若分发模型文件，需在"关于"页加第三方声明（项目已有 `THIRD_PARTY` 类文档习惯）。

### 4.3 Whisper 系与 Tauri 参考实现

- **`whisper-rs` 已归档（2025-07-30）**，作者迁往 Codeberg，理由是反对 GitHub 的 GenAI 政策。功能仍可用但生态冻结 → 不作为长期方案。
- **Handy（`cjpais/Handy`，31.6k★，MIT）是本项目最值得抄的 Tauri 参考实现**：
  - 同样是 **Tauri 2 + Rust** 的离线语音输入桌面应用，**明确支持 Intel Mac**
  - Rust 侧技术栈可直接借鉴：`cpal`（音频 I/O）、`vad-rs`（Silero VAD）、`rubato`（重采样）、`transcribe-cpp`（Whisper GGML）、`transcribe-rs`（Parakeet，**CPU 优化，约 5× 实时，最低 Skylake 6 代**）、`rdev`（全局快捷键）
  - 工程细节值得抄：按住说话/点按切换双模式、模型手动安装目录约定、剪贴板粘贴延迟与"Reliable Paste"、蓝图式设置页
- Parakeet 是 **CPU-only 且速度惊人**（"~5x real-time on mid-range hardware, tested on i5"），但**主要面向英文** → 中文场景不适用，可作为"英文模式"备选。

### 4.4 Agent 语音运行时参考（交互形态层面）

- **`QwenAudio/qwen-audio-agent`（2.6k★，Apache-2.0）**：专为 **AI 编码 Agent** 做的实时语音运行时。
  - 支持 **DeepSeek**（原生 ACP）等十余种后端；核心设计 = **前台对话 + 后台任务并行**（任务完成自然回到对话："已经好了。"）
  - 唤醒词用 **sherpa-onnx KWS（3M 参数 zh-en transducer）**，"空闲休眠但麦克风常开，唤醒词零云端调用"
  - 支持 HF `speech-to-speech` 全本地 VAD+STT+LLM+TTS 前端
  - → 它的**交互模型**（常驻在场、任务不打断对话、进度可追问）比它的代码更值得借鉴
- **`KoljaB/RealtimeSTT`（10.1k★，MIT）**：给出了一个很关键的生产级结论 ——
  > CPU 场景推荐**两段式**：`sherpa-onnx` 流式模型（Nemotron，快速可替换草稿）+ `Parakeet`（回合结束一次性精修最终稿）；"只处理新增音频帧"，比"反复重转写不断增长的缓冲"好得多。
  - 这条经验指导了本报告的**两段式架构**（草稿流式 + 终稿精修），只是把引擎换成中文更强的 Zipformer + SenseVoice。
- `pipecat-ai/pipecat`、`livekit/agents`：全双工语音 Agent 框架，但都是 Python 服务端形态，与 Tauri 单体架构不匹配 → 只借鉴"打断/轮次/状态机"设计，不引入。

### 4.5 TTS 方案对比

| 方案 | 中文自然度 | 延迟 | 体积/依赖 | 离线 | 许可 | 本机可用性 |
|---|---|---|---|---|---|---|
| **macOS 原生 `say` / `AVSpeechSynthesizer`** | ★★★☆（婷婷 Tingting 尚可） | ★★★★★ 秒出 | **0（系统自带）** | ✅ | 系统 API | ✅ **本机实测 180 个音色，其中 9 个 zh_CN**：`Tingting`、`Eddy/Flo/Grandma/Grandpa/Reed/Rocko/Sandy/Shelley (中文（中国大陆）)` |
| **sherpa-onnx + Kokoro-82M（zh-en）** | ★★★★ | ★★★★ | 需下模型 | ✅ | Apache-2.0 | ✅（官方 Rust 示例 #10） |
| sherpa-onnx + Matcha（zh） | ★★★★ | ★★★★ | 需下模型 | ✅ | 视模型 | ✅（示例 #8） |
| sherpa-onnx + Piper/VITS（zh） | ★★★ | ★★★★★ | 小 | ✅ | MIT | ✅（示例 #5/6，中文模型需另找） |
| sherpa-onnx + Supertonic / ZipVoice / Pocket TTS | ★★★★☆（ZipVoice 支持**零样本音色克隆**） | ★★★ | 需下模型 | ✅ | 视模型 | ✅ 但功能较新 |
| `edge-tts`（微软 Edge 在线 TTS） | ★★★★★ | ★★★ | 0 | ❌ 需联网 | 非官方 API（ToS 灰色） | 可作"在线高质量"可选项 |
| 云端 TTS（MiniMax/CosyVoice API/OpenAI） | ★★★★★ | ★★★ | 0 | ❌ | 商业 | 可作付费高质量可选项 |

**推荐路径**：TTS 先用 macOS 原生（今天就能听），把"自然度"这一非阻塞项推迟，等 STT 闭环跑通后再评估 Kokoro-zh（质量提升明显、体积可控）。

---

## 五、对比矩阵（以本机可构建性为第一裁决列）

| 候选整体方案 | 本机可构建 | 中文准确率 | 延迟 | 体积 | 维护活跃度 | 裁决 |
|---|---|---|---|---|---|---|
| **A. sherpa-onnx（VAD+Zipformer+SenseVoice）+ macOS say** | ✅ 官方 osx-x64 预编译 + 官方 Rust API | ★★★★★ | ★★★★☆ | 可控（分级下载） | ★★★★★（192 releases，周更） | **✅ 采用** |
| B. whisper.cpp/whisper-rs + say | ✅ 可源码编译 | ★★★ | ★★（CPU 上 medium+ 太慢） | 487MB~1.6GB | ★★（whisper-rs 归档） | 后备（英文） |
| C. Apple SFSpeechRecognizer + say | ✅ | ★★★★ | ★★★★★ | 0 | 系统 | ❌ 本机无离线资产，默认走云端 |
| D. Moonshine + TTS | ✅ | ⚠️ 中文弱 | ★★★★★ | 小 | ★★★★★ | 观望（英文优先） |
| E. 云端实时语音（豆包/GLM/Qwen-Omni/OpenAI） | ✅（纯网络） | ★★★★★ | ★★★★★ | 0 | ★★★★★ | 可选开关（非默认） |
| F. 直接复用 qwen-audio-agent | ⚠️ 是独立 Node 应用，不是库 | ★★★★★ | ★★★★★ | — | ★★★★★ | ❌ 不能嵌入；仅借鉴交互 |

---

## 六、推荐方案：三阶段落地

### 阶段 0（0.5 天）· 打通骨架
- Rust 新增 `voice` 模块；引入 `cpal` 采集 16kHz 单声道 PCM；`sherpa-onnx` crate 接 Silero VAD
- `Info.plist` 补 `NSMicrophoneUsageDescription`（Tauri v2 macOS 麦克风必需，否则直接崩）
- Tauri 命令：`voice_start_recording` / `voice_stop_recording`；事件：`voice-level`（音量条）
- 验收：按住热键能录到音频、VAD 能切出说话段、松手落盘 wav

### 阶段 1（2-3 天）· Push-to-Talk 最小闭环（**第一优先**）
- ASR：**SenseVoice（离线非流式）** 对 VAD 切出的段落做一次识别（中文最准、非自回归够快）
- VAD：`./run-sense-voice-simulate-streaming-microphone.sh` 这套组合即是官方推荐形态
- 标点：接 `online_punctuation`/`offline_punctuation` 模型补齐中文标点（否则输出是一串无标点长句，体验落差极大）
- TTS：`say -v Tingting`（或 `AVSpeechSynthesizer` 更可控，可拿到"朗读开始/结束"回调用于 UI 状态）
- 前端：`ChatInput` 麦克风按钮 + 按住空格说话（复用已有的 `tauri-plugin-global-shortcut`）+ 识别中/朗读中状态
- 接通现有 Agent：识别文本直接走 `sendMessage(text)`；回复走**句子级流式朗读**（在现有 `sse-delta` 流里按中文句末标点切分，凑够一句就送 TTS），这是"边生成边朗读"的最低成本实现
- 打断：朗读期间**暂停录音**（半双工），ESC/点按钮即停 —— 规避 AEC
- 验收：说一句 → 1.5s 内出文字 → 回车发送 → 回复念出来；全程离线

### 阶段 2（3-5 天）· 实时草稿 + 精修（体验质变）
- 引入**流式 Zipformer（zh-en）**：说话过程中实时上屏草稿字
- 回合结束用 **SenseVoice 精修**整段（两段式，参照 RealtimeSTT 的 CPU 生产建议）
- 前端：草稿文字浅色显示 → 精修后定型；支持中途改口
- 设置项：模型选择（SenseVoice / Paraformer / Zipformer-CTC / FireRedASR / Qwen3-ASR）、语言、是否启用标点、TTS 音色与语速
- 验收：首字 < 1s；整段结束 → 终稿 < 1.5s；中文常见技术词准确率目测 > 90%

### 阶段 3（按需）· 免手操作与全双工
- **唤醒词**：sherpa-onnx KWS（3M zh-en 模型，参考 qwen-audio-agent 的"常驻监听 + 唤醒即会话"）
- **热词增强**：把项目名/技术词汇注入 ASR（sherpa-onnx 支持 hotwords/上下文偏置）
- **真全双工 + 打断**：需要 AEC（可用 `speexdsp`/WebRTC APM 或在 macOS 上用 `VoiceProcessingIO` 音频单元）——复杂度高，明确排在最后
- **TTS 升级**：Kokoro-zh / Matcha-zh；或云端高质量 TTS 作为可选
- **可选**：云端实时语音（豆包/GLM-Realtime/Qwen3-Omni）作为"高质量低延迟模式"开关

---

## 七、集成设计（对齐现有代码）

```
┌──────────────────────── Vue 前端 ────────────────────────┐
│ ChatInput.vue  ──🎤 按住说话 / 🔊 朗读开关                │
│ 监听事件: voice-draft / voice-final / tts-state / voice-level │
│ 复用: tauri-plugin-global-shortcut（按住说话热键）          │
└───────────────┬──────────────────────────────────────────┘
                │ invoke / event
┌───────────────▼────────────── Rust (src-tauri/src/voice.rs) ─────────┐
│ cpal 采集 16kHz mono ──► Silero VAD ──► [可选] 流式 Zipformer 草稿     │
│                                   └──► SenseVoice 精修 ──► 标点模型    │
│ TTS: /usr/bin/say 子进程 或 AVSpeechSynthesizer（Swift 辅助工具）      │
│ 模型管理: ~/Library/Application Support/com.daoshengyi.app/models/     │
└───────────────┬──────────────────────────────────────────────────────┘
                │ 文字进出
        src/stores/chat.ts（现有 Agent 主循环，含 sse-delta 流）
```

要点：
1. **音频与推理全在 Rust 侧**，前端只收事件 —— 避免 WebView 麦克风权限与 WKWebView 的兼容问题，也与项目"重活放 Rust"的既有风格一致。
2. **TTS 两种实现**：先用 `say` 子进程（5 行代码，立即可用）；若要精确的"开始/结束/被打断"回调与音量控制，按 `ocr_tool.swift` 的既有模式加一个 `speak_tool.swift`（`AVSpeechSynthesizer`，可 `stopSpeaking` 即时打断）。
3. **模型不塞进安装包**：首次使用时下载到应用数据目录，UI 显示进度与体积；参照 Handy 的"手动安装模型"兜底（把文件丢进 `models/` 也能被识别），解决国内网络问题。
4. **设置项**（`appSettings.ts` + `SettingsDialog`）：语音输入开关、模型、语言、标点开关、VAD 灵敏度（静音判定时长/阈值）、TTS 音色与语速、朗读时机（全文/逐句）、是否云端高质量模式。

---

## 八、风险与坑（提前列清）

| 风险 | 说明 | 对策 |
|---|---|---|
| **麦克风权限** | Tauri v2 macOS 必须在 `Info.plist` 写 `NSMicrophoneUsageDescription`，否则进程被系统终止；首次调用会弹权限框 | 按 `tauri-plugin-macos-permissions` 或系统 API 检测状态，UI 给"去系统设置开启"引导 |
| **中文标点缺失** | ASR 原生输出通常无标点，长段落体验极差 | 必接标点模型（sherpa-onnx 有 online/offline 两套）；ITN（数字/日期规范化）按需 |
| **CPU 抢占** | ASR + LLM 流式 + TTS 同时跑，6 核 i7 会互相抢 | ASR 用 INT8、限定线程数；TTS 用系统 `say`（几乎不吃 CPU） |
| **回声/打断** | 扬声器外放时麦克风会听到 TTS → 误触发 | 阶段 1 用**半双工**（朗读时停录）；阶段 3 再上 AEC |
| **首次下载体积** | SenseVoice/Zipformer 模型数百 MB 级 | 分级：先给最小可用集（唤醒/草稿可选），大模型按需下；支持手动放置 |
| **蓝牙耳机音质降级** | macOS 上蓝牙耳机切双向音频会降质（Handy 明确记录的已知问题） | 文档提示：输出用耳机、输入选内置麦克风 |
| **许可署名** | SenseVoice 权重有署名/命名条款；sherpa-onnx Apache-2.0；Handy MIT | 加"关于 → 第三方声明"清单 |
| **平台扩展** | 本方案 macOS 优先（TTS 用系统能力） | STT 侧 sherpa-onnx 跨平台，未来 Windows/Linux 只需替换 TTS 实现 |
| **模型体积与精度权衡未实测** | 本报告未在本机跑基准 | 阶段 1 完成后做 §九 的实测，用数据选模型 |

---

## 九、待实测清单（用数据定模型）

在本机（i7-9750H，CPU-only）跑一组基准，产出表格后再定默认模型：

| 指标 | 方法 |
|---|---|
| 实时率 RTF / CPU 占用 | 同一段 10s 中文音频，测各模型 wall time ÷ 音频时长；`top`/`ps` 采样 CPU% |
| 首字延迟 | 流式 Zipformer：从说话开始到首个草稿字上屏 |
| 终稿延迟 | 说话结束 → 精修文字落地 |
| 中文准确率 | 自录 20 句（含项目术语、中英混说、数字）人工统计字错率，对比 SenseVoice / Paraformer / Zipformer-CTC / FireRedASR |
| TTS 自然度 | `Tingting` vs Kokoro-zh vs Matcha-zh 主观对比（同段文本） |
| 内存/常驻 | 空闲与识别中各模型 RSS |

---

## 十、未采用方案与负结论（避免重复踩坑）

1. **ONNX 系 Rust crate（`ort-sys`/fastembed 等）**：本机无 `x86_64-apple-darwin` 预编译产物，且降级版本后构建脚本也失败 → **不可用**。（注意 sherpa-onnx 自带 onnxruntime 预编译，不受此限。）
2. **whisper.cpp Metal 加速**：本机实测 2.0-2.2 t/s，比 CPU 的 9.9 t/s 慢 5 倍，且输出异常 → **不要在 Intel Mac 上开 Metal**。
3. **Apple `SFSpeechRecognizer` 作为离线中文识别**：本机无离线识别资产（`/System/Library/Speech/Recognizers` 不存在、`AssetsV2` 无 SpeechRecognition 资产）→ 大概率走 Apple 服务器，违背本地优先 → **不用**。
4. **`whisper-rs` 作为长期依赖**：仓库已归档（2025-07-30，迁 Codeberg）→ 只用其底层 whisper.cpp，或干脆不用。
5. **`sherpa-rs`（thewh1teagle）**：已于 2026-06-06 归档并声明"请改用官方 Rust API" → 直接用官方 `sherpa-onnx` crate。
6. **直接集成 qwen-audio-agent**：它是完整的 Node 应用（网关 + 前端 + ACP 桥），不是可嵌入库 → 只借鉴交互设计。
7. **pipecat / livekit agents**：Python 服务端形态，与本项目 Tauri 单体架构不匹配 → 只借鉴轮次/打断状态机。

---

## 十一、参考链接

**核心**
- sherpa-onnx：https://github.com/k2-fsa/sherpa-onnx （Apache-2.0，14.8k★）
  - Rust 示例（含麦克风/ VAD / TTS / 标点 / KWS 共 51 例）：`rust-api-examples/README.md`
  - Intel Mac 预编译与链接说明：`rust-api-examples/for-advanced-users.md`
  - Tauri 构建脚本：`scripts/tauri/build-tauri-vad-asr-mic.sh.in`
  - crate：https://crates.io/crates/sherpa-onnx （v1.13.8）
- SenseVoice：https://github.com/QwenAudio/SenseVoice （代码 MIT；权重 FunASR Model License）
- 模型清单：https://k2-fsa.github.io/sherpa/onnx/pretrained_models/index.html

**参考实现 / 交互设计**
- Handy（Tauri 2 离线语音输入，MIT，31.6k★）：https://github.com/cjpais/Handy
- qwen-audio-agent（Agent 实时语音运行时，Apache-2.0，2.6k★）：https://github.com/QwenAudio/qwen-audio-agent
- RealtimeSTT（CPU 两段式流式建议，MIT，10.1k★）：https://github.com/KoljaB/RealtimeSTT
- Moonshine（超低延迟，MIT，11.1k★）：https://github.com/moonshine-ai/moonshine

**已归档（仅记录）**
- whisper-rs（2025-07-30 归档 → Codeberg）：https://github.com/tazz4843/whisper-rs
- sherpa-rs（2026-06-06 归档，官方 API 取代）：https://github.com/thewh1teagle/sherpa-rs
