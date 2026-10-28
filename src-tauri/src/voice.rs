//! 语音输入（"耳朵"）：采集 → VAD → 识别 → 标点。
//!
//! 设计见 `docs/VOICE_INTERACTION_PLAN.md` §3 与 `docs/VOICE_VIDEO_INPUT_PLAN.md` 阶段 1：
//! - **音频与推理全在 Rust 侧**，前端只收事件（避开 WKWebView 麦克风兼容问题）；
//! - 识别结果**进草稿、不自动发送**（唯一的自动提交路径是用户显式开启的「连续对话」）；
//! - `idle` 不录音（隐私红线），`speaking` 期间不录音（半双工，绕开 AEC）；
//! - 模型不进安装包：首次使用时下载到应用数据目录，支持手动放置。
//!
//! 事件（前端监听）：
//! - `voice://state`   `VoiceStatus` —— 相位 / 设备 / 模型就绪情况
//! - `voice://level`   `{ rms, peak, speaking }` —— 真实电平（波形来自实测音量，不是假动画）
//! - `voice://final`   `{ text, wav, mode, seconds }` —— 一轮识别结果
//! - `voice://error`   `{ message }`
//! - `voice://model`   `{ id, phase, received, total, message }` —— 模型准备进度
//! - `voice://speaking` `{ stage: "start" | "end" }` —— TTS 出声起止（由 `surface` 播报处发出）

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// 识别与 VAD 统一用 16kHz 单声道（SenseVoice / Silero 的要求）。
const SAMPLE_RATE: i32 = 16000;
/// 一轮语音最短有效时长：咳嗽/桌椅声不该触发一次 LLM 调用（按话轮计费时这条直接省钱）。
const MIN_SPEECH_SECS: f32 = 0.3;
/// 连续模式下「说完」的静音判定（毫秒，可配）。
pub const DEFAULT_SILENCE_MS: u32 = 800;
/// 默认会话窗口：念完后 10s 内不说话就自动收麦。
pub const DEFAULT_SESSION_WINDOW_MS: u64 = 10_000;
/// 模型空闲多久后释放内存（6 核机器上 SenseVoice 常驻要几百 MB）。
const ASR_IDLE_RELEASE: Duration = Duration::from_secs(300);

pub const EVENT_STATE: &str = "voice://state";
pub const EVENT_LEVEL: &str = "voice://level";
pub const EVENT_FINAL: &str = "voice://final";
pub const EVENT_ERROR: &str = "voice://error";
pub const EVENT_MODEL: &str = "voice://model";
pub const EVENT_SPEAKING: &str = "voice://speaking";
/// `{ reason: "silence" | "cancelled", dropped }` —— 会话窗口结束 / 一键取消
pub const EVENT_IDLE: &str = "voice://idle";

// ---------------------------------------------------------------------------
// 模型：首次使用下载（不进安装包）
// ---------------------------------------------------------------------------

const ASR_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2";
const ASR_BYTES: u64 = 163_002_883;
const VAD_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";
const VAD_BYTES: u64 = 643_854;
const PUNCT_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2";
const PUNCT_BYTES: u64 = 64_717_756;

/// 模型文件的最终落点（相对 `models/voice/`）。手动放置也按这个结构。
const ASR_MODEL: &str = "sense-voice/model.int8.onnx";
const ASR_TOKENS: &str = "sense-voice/tokens.txt";
const VAD_MODEL: &str = "silero_vad.onnx";
const PUNCT_MODEL: &str = "punct/model.int8.onnx";

#[derive(Clone, Debug, Serialize)]
pub struct ModelsStatus {
    pub asr: bool,
    pub vad: bool,
    pub punct: bool,
    pub dir: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct VoiceStatus {
    pub phase: String,
    pub mode: String,
    pub permission: String,
    pub device: String,
    pub sample_rate: u32,
    pub models: ModelsStatus,
    pub last_wav: String,
    pub last_error: String,
    pub asr_loaded: bool,
}

#[derive(Default)]
struct Inner {
    phase: String,
    mode: String,
    device: String,
    sample_rate: u32,
    last_wav: String,
    last_error: String,
}

struct Shared {
    app: AppHandle,
    dir: PathBuf,
    inner: Mutex<Inner>,
    asr_loaded: AtomicBool,
    preparing: AtomicBool,
}

impl Shared {
    fn models_status(&self) -> ModelsStatus {
        ModelsStatus {
            asr: is_ready(&self.dir.join(ASR_MODEL), 1_000_000)
                && is_ready(&self.dir.join(ASR_TOKENS), 100),
            vad: is_ready(&self.dir.join(VAD_MODEL), 100_000),
            punct: is_ready(&self.dir.join(PUNCT_MODEL), 1_000_000),
            dir: self.dir.to_string_lossy().to_string(),
        }
    }

    fn status(&self) -> VoiceStatus {
        let models = self.models_status();
        let inner = self.inner.lock().unwrap();
        VoiceStatus {
            phase: if inner.phase.is_empty() {
                "idle".to_string()
            } else {
                inner.phase.clone()
            },
            mode: inner.mode.clone(),
            permission: mic_authorization(),
            device: inner.device.clone(),
            sample_rate: inner.sample_rate,
            models,
            last_wav: inner.last_wav.clone(),
            last_error: inner.last_error.clone(),
            asr_loaded: self.asr_loaded.load(Ordering::Relaxed),
        }
    }

    fn emit_state(&self) {
        let _ = self.app.emit(EVENT_STATE, self.status());
    }

    fn set_phase(&self, phase: &str) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.phase = phase.to_string();
        }
        self.emit_state();
    }

    fn set_error(&self, message: &str) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.last_error = message.to_string();
        }
        let _ = self
            .app
            .emit(EVENT_ERROR, serde_json::json!({ "message": message }));
        self.emit_state();
    }
}

fn is_ready(path: &Path, min_bytes: u64) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.len() >= min_bytes)
        .unwrap_or(false)
}

/// 递归找解包目录里的某个文件名（官方归档的顶层目录名会随版本改，别写死）。
fn find_file(root: &Path, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(hit) = find_file(&path, name) {
                return Some(hit);
            }
        } else if path.file_name().and_then(|s| s.to_str()) == Some(name) {
            return Some(path);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 引擎状态（命令入口）
// ---------------------------------------------------------------------------

enum Cmd {
    Start {
        mode: String,
        idle_timeout_ms: u64,
        silence_ms: u32,
    },
    Stop,
    Cancel,
}

pub struct VoiceState {
    shared: Arc<Shared>,
    tx: Mutex<mpsc::Sender<Cmd>>,
}

impl VoiceState {
    pub fn new(app: AppHandle) -> Self {
        let dir = app
            .path()
            .app_data_dir()
            .map(|d| d.join("models").join("voice"))
            .unwrap_or_else(|_| PathBuf::from("models/voice"));
        let _ = std::fs::create_dir_all(&dir);
        let shared = Arc::new(Shared {
            app,
            dir,
            inner: Mutex::new(Inner {
                phase: "idle".to_string(),
                ..Default::default()
            }),
            asr_loaded: AtomicBool::new(false),
            preparing: AtomicBool::new(false),
        });
        let (tx, rx) = mpsc::channel();
        let worker_shared = shared.clone();
        std::thread::Builder::new()
            .name("voice-worker".into())
            .spawn(move || worker_loop(worker_shared, rx))
            .expect("启动语音线程失败");
        Self {
            shared,
            tx: Mutex::new(tx),
        }
    }

    fn send(&self, cmd: Cmd) -> Result<(), String> {
        self.tx
            .lock()
            .unwrap()
            .send(cmd)
            .map_err(|_| "语音线程已退出".to_string())
    }

    /// 当前相位。全局快捷键的处理器在 Rust 侧，需要**同步**读相位来决定
    /// 「按下 = 开始聆听还是全停」，所以这里必须是普通方法而不是 `#[tauri::command]`。
    pub fn phase(&self) -> String {
        self.shared.status().phase
    }

    /// 开始采集（与前端 `voice_start` 同一条路径，快捷键不另开一套）。
    pub fn start(&self, mode: &str, idle_timeout_ms: u64, silence_ms: u32) -> Result<(), String> {
        if !self.shared.models_status().asr {
            return Err("语音模型还没准备好".to_string());
        }
        self.shared.last_error_clear();
        self.send(Cmd::Start {
            mode: if mode == "continuous" {
                "continuous"
            } else {
                "ptt"
            }
            .to_string(),
            idle_timeout_ms,
            silence_ms,
        })
    }

    pub fn stop(&self) -> Result<(), String> {
        self.send(Cmd::Stop)
    }

    pub fn cancel(&self) -> Result<(), String> {
        self.send(Cmd::Cancel)
    }
}

#[tauri::command]
pub fn voice_status(state: tauri::State<'_, VoiceState>) -> VoiceStatus {
    state.shared.status()
}

#[tauri::command]
pub fn voice_models_status(state: tauri::State<'_, VoiceState>) -> ModelsStatus {
    state.shared.models_status()
}

/// 准备模型：缺什么下什么，下完解包到最终位置。幂等，可重复调用。
#[tauri::command]
pub async fn voice_models_prepare(app: AppHandle, force: bool) -> Result<String, String> {
    let state = app.state::<VoiceState>();
    if !force && model_ready_all(&state.shared.dir) {
        return Ok("模型已就绪".to_string());
    }
    if state.shared.preparing.swap(true, Ordering::SeqCst) {
        return Ok("正在准备中".to_string());
    }
    let shared = state.shared.clone();
    drop(state);
    tauri::async_runtime::spawn(async move {
        let result = prepare_models(&shared).await;
        if let Err(e) = result {
            shared.set_error(&format!("模型准备失败：{e}"));
        }
        shared.preparing.store(false, Ordering::SeqCst);
        shared.emit_state();
    });
    Ok("开始下载模型".to_string())
}

fn model_ready_all(dir: &Path) -> bool {
    is_ready(&dir.join(ASR_MODEL), 1_000_000)
        && is_ready(&dir.join(ASR_TOKENS), 100)
        && is_ready(&dir.join(VAD_MODEL), 100_000)
        && is_ready(&dir.join(PUNCT_MODEL), 1_000_000)
}

#[tauri::command]
pub fn voice_open_models_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .state::<VoiceState>()
        .shared
        .dir
        .to_string_lossy()
        .to_string();
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败：{e}"))?;
    std::process::Command::new("open")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("打开目录失败：{e}"))?;
    Ok(dir)
}

#[tauri::command]
pub fn voice_open_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn()
            .map_err(|e| format!("打开系统设置失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("仅 macOS 支持一键跳转系统设置".to_string())
    }
}

/// 开始采集。`mode`：`ptt`（按住说话，松手转写整段）/ `continuous`（VAD 判停，说完自动收麦）。
#[tauri::command]
pub fn voice_start(
    state: tauri::State<'_, VoiceState>,
    mode: String,
    idle_timeout_ms: Option<u64>,
    silence_ms: Option<u32>,
) -> Result<VoiceStatus, String> {
    let mode = if mode == "continuous" {
        "continuous"
    } else {
        "ptt"
    };
    state.shared.last_error_clear();
    if !state.shared.models_status().asr {
        return Err("语音模型还没准备好（设置 → 语音里点「下载模型」）".to_string());
    }
    state.send(Cmd::Start {
        mode: mode.to_string(),
        idle_timeout_ms: idle_timeout_ms.unwrap_or(DEFAULT_SESSION_WINDOW_MS),
        silence_ms: silence_ms.unwrap_or(DEFAULT_SILENCE_MS),
    })?;
    Ok(state.shared.status())
}

/// 停止采集并转写（push-to-talk 松手时调用）。
#[tauri::command]
pub fn voice_stop(state: tauri::State<'_, VoiceState>) -> Result<(), String> {
    state.send(Cmd::Stop)
}

/// 取消本轮（丢弃音频、释放麦克风，不产生草稿）。
#[tauri::command]
pub fn voice_cancel(state: tauri::State<'_, VoiceState>) -> Result<(), String> {
    state.send(Cmd::Cancel)
}

impl Shared {
    fn last_error_clear(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.last_error.clear();
    }
}

/// 麦克风授权状态（macOS TCC）。Tauri 打包版必须在 `Info.plist` 里写用途说明，否则进程会被系统终止。
pub fn mic_authorization() -> String {
    #[cfg(target_os = "macos")]
    {
        match macos_auth_status() {
            0 => "not_determined".to_string(),
            1 => "restricted".to_string(),
            2 => "denied".to_string(),
            3 => "authorized".to_string(),
            _ => "unknown".to_string(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        "unknown".to_string()
    }
}

#[cfg(target_os = "macos")]
#[link(name = "AVFoundation", kind = "framework")]
extern "C" {
    /// `AVMediaTypeAudio`（`NSString *` 常量，值为 `@"soun"`）
    static AVMediaTypeAudio: *mut objc2::runtime::AnyObject;
}

#[cfg(target_os = "macos")]
fn macos_auth_status() -> i64 {
    use objc2::msg_send;
    use objc2::runtime::AnyClass;

    unsafe {
        let Some(cls) = AnyClass::get(c"AVCaptureDevice") else {
            return -1;
        };
        let status: i64 = msg_send![cls, authorizationStatusForMediaType: AVMediaTypeAudio];
        status
    }
}

// ---------------------------------------------------------------------------
// 采集线程
// ---------------------------------------------------------------------------

struct Asr {
    recognizer: sherpa_onnx::OfflineRecognizer,
    punct: Option<sherpa_onnx::OfflinePunctuation>,
}

impl Asr {
    fn load(dir: &Path) -> Result<Self, String> {
        let model = dir.join(ASR_MODEL);
        let tokens = dir.join(ASR_TOKENS);
        if !model.exists() || !tokens.exists() {
            return Err("识别模型文件缺失".to_string());
        }
        let mut config = sherpa_onnx::OfflineRecognizerConfig::default();
        config.model_config.sense_voice = sherpa_onnx::OfflineSenseVoiceModelConfig {
            model: Some(model.to_string_lossy().to_string()),
            language: Some("auto".to_string()),
            use_itn: true,
        };
        config.model_config.tokens = Some(tokens.to_string_lossy().to_string());
        // 6 核 i7：给 2 线程。再多会和 LLM 流式输出抢 CPU。
        config.model_config.num_threads = 2;
        config.model_config.provider = Some("cpu".to_string());
        let recognizer = sherpa_onnx::OfflineRecognizer::create(&config)
            .ok_or_else(|| "识别模型加载失败（文件可能损坏）".to_string())?;

        let punct_path = dir.join(PUNCT_MODEL);
        let punct = if punct_path.exists() {
            let config = sherpa_onnx::OfflinePunctuationConfig {
                model: sherpa_onnx::OfflinePunctuationModelConfig {
                    ct_transformer: Some(punct_path.to_string_lossy().to_string()),
                    num_threads: 1,
                    debug: false,
                    provider: Some("cpu".to_string()),
                },
            };
            sherpa_onnx::OfflinePunctuation::create(&config)
        } else {
            None
        };

        Ok(Self { recognizer, punct })
    }

    fn transcribe(&self, samples: &[f32]) -> String {
        if samples.len() < (SAMPLE_RATE as usize / 3) {
            return String::new();
        }
        let stream = self.recognizer.create_stream();
        stream.accept_waveform(SAMPLE_RATE, samples);
        self.recognizer.decode(&stream);
        let raw = stream.get_result().map(|r| r.text).unwrap_or_default();
        let text = clean_asr_text(&raw);
        if text.is_empty() {
            return text;
        }
        match &self.punct {
            Some(p) => p
                .add_punctuation(&text)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or(text),
            None => text,
        }
    }
}

/// 去掉模型可能带出的控制标记（`<|zh|><|NEUTRAL|>` 之类）与多余空白。
pub fn clean_asr_text(raw: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in raw.chars() {
        if ch == '<' {
            in_tag = true;
            continue;
        }
        if ch == '>' && in_tag {
            in_tag = false;
            continue;
        }
        if !in_tag {
            out.push(ch);
        }
    }
    out.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

struct Session {
    _stream: cpal::Stream,
    rx: mpsc::Receiver<Vec<f32>>,
    dropped: Arc<std::sync::atomic::AtomicUsize>,
    resampler: Option<sherpa_onnx::LinearResampler>,
    vad: Option<sherpa_onnx::VoiceActivityDetector>,
    samples: Vec<f32>,
    mode: String,
    idle_timeout: Duration,
    started: Instant,
    last_voice: Instant,
    level_at: Instant,
    speech_seen: bool,
}

/// 把设备回调里的原始采样（可能多声道、非 16k）转成单声道 f32 后投递。
/// 回调里只做搬运，不做重采样/推理（实时线程上不能有重活）。
fn input_callback<T>(
    tx: mpsc::SyncSender<Vec<f32>>,
    channels: usize,
    dropped: Arc<std::sync::atomic::AtomicUsize>,
    conv: fn(T) -> f32,
) -> impl FnMut(&[T], &cpal::InputCallbackInfo) + Send + 'static
where
    T: cpal::SizedSample + Copy + 'static,
{
    move |data: &[T], _: &_| {
        let mono: Vec<f32> = if channels <= 1 {
            data.iter().map(|&s| conv(s)).collect()
        } else {
            data.chunks(channels)
                .map(|c| c.iter().map(|&s| conv(s)).sum::<f32>() / channels as f32)
                .collect()
        };
        if tx.try_send(mono).is_err() {
            dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

impl Session {
    fn open(
        shared: &Shared,
        mode: &str,
        idle_timeout_ms: u64,
        silence_ms: u32,
    ) -> Result<Self, String> {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "找不到麦克风（系统设置里确认已连接）".to_string())?;
        // cpal 0.18 去掉了 `DeviceTrait::name()`，设备名走 Display（`description()` 是结构化版本）
        let device_name = device.to_string();
        let supported = device
            .default_input_config()
            .map_err(|e| format!("读取麦克风配置失败：{e}"))?;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let channels = config.channels as usize;
        // 0.18 起 `SampleRate` 就是 `u32` 别名（不再是 newtype，没有 `.0`）
        let input_rate = config.sample_rate as i32;

        let (tx, rx) = mpsc::sync_channel::<Vec<f32>>(64);
        let dropped = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let err_fn = |e| eprintln!("[voice] 输入流错误：{e}");

        macro_rules! build {
            ($t:ty, $conv:expr) => {
                device.build_input_stream(
                    config.clone(),
                    input_callback::<$t>(tx.clone(), channels, dropped.clone(), $conv),
                    err_fn,
                    None,
                )
            };
        }

        let stream = match sample_format {
            cpal::SampleFormat::F32 => build!(f32, |s| s),
            cpal::SampleFormat::I16 => build!(i16, |s| s as f32 / 32768.0),
            cpal::SampleFormat::I32 => build!(i32, |s| s as f32 / 2147483648.0),
            cpal::SampleFormat::U16 => build!(u16, |s| (s as f32 - 32768.0) / 32768.0),
            cpal::SampleFormat::I8 => build!(i8, |s| s as f32 / 128.0),
            other => return Err(format!("不支持的音频采样格式：{other:?}")),
        }
        .map_err(|e| format!("打开麦克风失败：{e}"))?;

        stream.play().map_err(|e| format!("启动录音失败：{e}"))?;

        let resampler = if input_rate == SAMPLE_RATE {
            None
        } else {
            Some(
                sherpa_onnx::LinearResampler::create(input_rate, SAMPLE_RATE)
                    .ok_or_else(|| "重采样器初始化失败".to_string())?,
            )
        };

        // VAD 只在连续模式用：push-to-talk 有明确的松手边界，不需要判停。
        let vad = if mode == "continuous" {
            let path = shared.dir.join(VAD_MODEL);
            if path.exists() {
                let config = sherpa_onnx::VadModelConfig {
                    silero_vad: sherpa_onnx::SileroVadModelConfig {
                        model: Some(path.to_string_lossy().to_string()),
                        threshold: 0.5,
                        min_silence_duration: silence_ms as f32 / 1000.0,
                        min_speech_duration: 0.25,
                        window_size: 512,
                        max_speech_duration: 30.0,
                    },
                    sample_rate: SAMPLE_RATE,
                    num_threads: 1,
                    provider: Some("cpu".to_string()),
                    debug: false,
                    ..Default::default()
                };
                sherpa_onnx::VoiceActivityDetector::create(&config, 30.0)
            } else {
                None
            }
        } else {
            None
        };

        {
            let mut inner = shared.inner.lock().unwrap();
            inner.device = device_name;
            inner.sample_rate = input_rate as u32;
            inner.mode = mode.to_string();
        }

        Ok(Self {
            _stream: stream,
            rx,
            dropped,
            resampler,
            vad,
            samples: Vec::new(),
            mode: mode.to_string(),
            idle_timeout: Duration::from_millis(idle_timeout_ms.max(1000)),
            started: Instant::now(),
            last_voice: Instant::now(),
            level_at: Instant::now(),
            speech_seen: false,
        })
    }

    fn push_chunk(&mut self, mono: Vec<f32>, shared: &Shared) {
        let mono16 = match &self.resampler {
            Some(r) => r.resample(&mono, false),
            None => mono,
        };
        if mono16.is_empty() {
            return;
        }
        let (rms, peak) = rms_and_peak(&mono16);
        self.samples.extend_from_slice(&mono16);
        // 最多留 60s，避免长会话把内存吃掉（识别只需要当前话轮）
        let cap = SAMPLE_RATE as usize * 60;
        if self.samples.len() > cap {
            let drop = self.samples.len() - cap;
            self.samples.drain(0..drop);
        }
        if self.level_at.elapsed() >= Duration::from_millis(50) {
            self.level_at = Instant::now();
            let _ = shared.app.emit(
                EVENT_LEVEL,
                serde_json::json!({ "rms": rms, "peak": peak, "speaking": self.speech_seen }),
            );
        }
    }

    fn drain_audio(&mut self, shared: &Shared) {
        while let Ok(mono) = self.rx.try_recv() {
            self.push_chunk(mono, shared);
        }
    }
}

fn rms_and_peak(samples: &[f32]) -> (f32, f32) {
    if samples.is_empty() {
        return (0.0, 0.0);
    }
    let mut sum = 0.0f64;
    let mut peak = 0.0f32;
    for &s in samples {
        let a = s.abs();
        if a > peak {
            peak = a;
        }
        sum += (s as f64) * (s as f64);
    }
    ((sum / samples.len() as f64).sqrt() as f32, peak)
}

/// 写 16-bit PCM 单声道 WAV（调试/复听/回归素材；不引入额外依赖）。
pub fn write_wav_i16(path: &Path, samples: &[f32]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
    }
    let data_len = (samples.len() * 2) as u32;
    let mut f = std::fs::File::create(path).map_err(|e| format!("创建 wav 失败：{e}"))?;
    let mut header = Vec::with_capacity(44);
    header.extend_from_slice(b"RIFF");
    header.extend_from_slice(&(36 + data_len).to_le_bytes());
    header.extend_from_slice(b"WAVEfmt ");
    header.extend_from_slice(&16u32.to_le_bytes());
    header.extend_from_slice(&1u16.to_le_bytes()); // PCM
    header.extend_from_slice(&1u16.to_le_bytes()); // mono
    header.extend_from_slice(&(SAMPLE_RATE as u32).to_le_bytes());
    header.extend_from_slice(&((SAMPLE_RATE as u32) * 2).to_le_bytes());
    header.extend_from_slice(&2u16.to_le_bytes());
    header.extend_from_slice(&16u16.to_le_bytes());
    header.extend_from_slice(b"data");
    header.extend_from_slice(&data_len.to_le_bytes());
    f.write_all(&header)
        .map_err(|e| format!("写 wav 头失败：{e}"))?;
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        f.write_all(&v.to_le_bytes())
            .map_err(|e| format!("写 wav 数据失败：{e}"))?;
    }
    Ok(())
}

fn worker_loop(shared: Arc<Shared>, rx: mpsc::Receiver<Cmd>) {
    let mut session: Option<Session> = None;
    let mut asr: Option<Asr> = None;
    let mut asr_used = Instant::now();

    loop {
        match rx.recv_timeout(Duration::from_millis(80)) {
            Ok(Cmd::Start {
                mode,
                idle_timeout_ms,
                silence_ms,
            }) => {
                // 连续对话的 resume：先收掉旧流，避免两个输入流抢设备
                session = None;
                shared.set_phase("starting");
                if asr.is_none() {
                    match Asr::load(&shared.dir) {
                        Ok(a) => {
                            asr = Some(a);
                            shared.asr_loaded.store(true, Ordering::Relaxed);
                        }
                        Err(e) => {
                            shared.set_error(&e);
                            shared.set_phase("idle");
                            continue;
                        }
                    }
                }
                match Session::open(&shared, &mode, idle_timeout_ms, silence_ms) {
                    Ok(s) => {
                        session = Some(s);
                        shared.set_phase("listening");
                    }
                    Err(e) => {
                        shared.set_error(&e);
                        shared.set_phase("idle");
                    }
                }
                asr_used = Instant::now();
            }
            Ok(Cmd::Stop) => {
                if let Some(mut s) = session.take() {
                    // 把回调里还没取走的音频收干净
                    s.drain_audio(&shared);
                    shared.set_phase("transcribing");
                    finish_session(&shared, &mut s, asr.as_ref());
                }
                shared.set_phase("idle");
                asr_used = Instant::now();
            }
            Ok(Cmd::Cancel) => {
                session = None;
                shared.set_phase("idle");
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        let mut close = false;
        let mut close_reason: Option<&str> = None;
        if let Some(s) = session.as_mut() {
            s.drain_audio(&shared);

            // VAD 只在连续模式存在；PTT 有明确的松手边界。
            let mut segments: Vec<Vec<f32>> = Vec::new();
            let mut detected = false;
            if let Some(vad) = &s.vad {
                detected = vad.detected();
                while let Some(seg) = vad.front() {
                    segments.push(seg.samples().to_vec());
                    vad.pop();
                }
            }
            if detected {
                s.speech_seen = true;
                s.last_voice = Instant::now();
            }

            if let Some(samples) = segments
                .iter()
                .find(|sp| sp.len() as f32 / SAMPLE_RATE as f32 >= MIN_SPEECH_SECS)
            {
                s.speech_seen = true;
                if s.mode == "continuous" {
                    // 半双工：说完就收麦，等前端在朗读结束后再 resume
                    shared.set_phase("thinking");
                    let text = asr
                        .as_ref()
                        .map(|a| a.transcribe(samples))
                        .unwrap_or_default();
                    emit_final(&shared, &text, "", "continuous", samples.len());
                    close = true;
                }
            }

            if !close {
                let quiet = s.last_voice.elapsed();
                let idle = if s.speech_seen {
                    // 有检测到语音但始终没成段（噪声/太短）——也不能永远举着麦克风
                    quiet > s.idle_timeout + Duration::from_millis(2000)
                } else {
                    s.mode == "continuous" && s.started.elapsed() >= s.idle_timeout
                };
                if idle {
                    close = true;
                    close_reason = Some("silence");
                }
            }
        }

        if close {
            if let Some(s) = session.take() {
                if let Some(reason) = close_reason {
                    let _ = shared.app.emit(
                        EVENT_IDLE,
                        serde_json::json!({
                            "reason": reason,
                            "dropped": s.dropped.load(Ordering::Relaxed)
                        }),
                    );
                }
            }
            shared.set_phase("idle");
            asr_used = Instant::now();
        }

        // 空闲 5 分钟释放模型内存（几百 MB）
        if session.is_none() && asr.is_some() && asr_used.elapsed() > ASR_IDLE_RELEASE {
            asr = None;
            shared.asr_loaded.store(false, Ordering::Relaxed);
            shared.emit_state();
        }
    }
}

fn finish_session(shared: &Shared, s: &mut Session, asr: Option<&Asr>) {
    // 让 VAD 把尾巴吐出来（连续模式被 Stop 打断时也有内容）
    if let Some(vad) = &s.vad {
        vad.flush();
        while let Some(seg) = vad.front() {
            s.samples.extend_from_slice(seg.samples());
            vad.pop();
        }
    }
    let seconds = s.samples.len() as f32 / SAMPLE_RATE as f32;
    if seconds < MIN_SPEECH_SECS {
        shared.set_error(&format!("太短了（{seconds:.1}s），按住说话至少 0.3 秒"));
        return;
    }
    let wav_path = shared.dir.join("last.wav");
    let wav_note = match write_wav_i16(&wav_path, &s.samples) {
        Ok(()) => wav_path.to_string_lossy().to_string(),
        Err(_) => String::new(),
    };
    {
        let mut inner = shared.inner.lock().unwrap();
        inner.last_wav = wav_note.clone();
    }
    let text = asr.map(|a| a.transcribe(&s.samples)).unwrap_or_default();
    emit_final(shared, &text, &wav_note, &s.mode, s.samples.len());
}

fn emit_final(shared: &Shared, text: &str, wav: &str, mode: &str, sample_len: usize) {
    let text = text.trim().to_string();
    let seconds = sample_len as f32 / SAMPLE_RATE as f32;
    if text.is_empty() {
        // 没听清：给一条明确事件，前端好提示（比静默失败强）
        shared.set_error(&format!("没听清（{seconds:.1}s 音频没有识别出文字）"));
        return;
    }
    shared.last_error_clear();
    let _ = shared.app.emit(
        EVENT_FINAL,
        serde_json::json!({ "text": text, "wav": wav, "mode": mode, "seconds": seconds }),
    );
}

// ---------------------------------------------------------------------------
// 模型下载 / 解包
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct ModelProgress<'a> {
    id: &'a str,
    phase: &'a str,
    received: u64,
    total: u64,
    message: String,
}

fn emit_model(shared: &Shared, id: &str, phase: &str, received: u64, total: u64, message: &str) {
    let _ = shared.app.emit(
        EVENT_MODEL,
        ModelProgress {
            id,
            phase,
            received,
            total,
            message: message.to_string(),
        },
    );
}

async fn prepare_models(shared: &Shared) -> Result<(), String> {
    let dir = shared.dir.clone();
    let downloads = dir.join(".downloads");
    std::fs::create_dir_all(&downloads).map_err(|e| format!("建下载目录失败：{e}"))?;
    let client = reqwest::Client::builder()
        .user_agent("daoshengyi/voice")
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败：{e}"))?;

    if !(is_ready(&dir.join(ASR_MODEL), 1_000_000) && is_ready(&dir.join(ASR_TOKENS), 100)) {
        let archive = downloads.join("sense-voice.tar.bz2");
        download(&client, shared, "asr", ASR_URL, &archive, ASR_BYTES).await?;
        extract_archive(shared, "asr", &archive, &dir, true)?;
        let _ = std::fs::remove_file(&archive);
    }
    if !is_ready(&dir.join(VAD_MODEL), 100_000) {
        download(
            &client,
            shared,
            "vad",
            VAD_URL,
            &downloads.join("silero_vad.onnx"),
            VAD_BYTES,
        )
        .await?;
        std::fs::copy(downloads.join("silero_vad.onnx"), dir.join(VAD_MODEL))
            .map_err(|e| format!("放置 VAD 模型失败：{e}"))?;
    }
    if !is_ready(&dir.join(PUNCT_MODEL), 1_000_000) {
        let archive = downloads.join("punct.tar.bz2");
        download(&client, shared, "punct", PUNCT_URL, &archive, PUNCT_BYTES).await?;
        extract_archive(shared, "punct", &archive, &dir, false)?;
        let _ = std::fs::remove_file(&archive);
    }
    emit_model(shared, "all", "ready", 0, 0, "模型就绪");
    Ok(())
}

async fn download(
    client: &reqwest::Client,
    shared: &Shared,
    id: &str,
    url: &str,
    dest: &Path,
    expected: u64,
) -> Result<(), String> {
    if is_ready(dest, expected / 2) {
        emit_model(shared, id, "cached", expected, expected, "已下载");
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
    }
    emit_model(shared, id, "downloading", 0, expected, "开始下载");
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载失败（{id}）：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败（{id}）：HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(expected);
    let tmp = dest.with_extension("part");
    let mut file = std::fs::File::create(&tmp).map_err(|e| format!("创建文件失败：{e}"))?;
    let mut received: u64 = 0;
    let mut last_emit = Instant::now();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取下载流失败：{e}"))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("写模型文件失败：{e}"))?;
        received += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(200) {
            last_emit = Instant::now();
            emit_model(shared, id, "downloading", received, total, "");
        }
    }
    file.flush().map_err(|e| format!("落盘失败：{e}"))?;
    drop(file);
    if expected > 0 && received < expected / 2 {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("下载不完整（{id}）：{received} / {expected} 字节"));
    }
    std::fs::rename(&tmp, dest).map_err(|e| format!("重命名模型文件失败：{e}"))?;
    emit_model(shared, id, "downloaded", received, total, "下载完成");
    Ok(())
}

fn extract_archive(
    shared: &Shared,
    id: &str,
    archive: &Path,
    dir: &Path,
    with_tokens: bool,
) -> Result<(), String> {
    emit_model(shared, id, "extracting", 0, 0, "解包中");
    let tmp = dir.join(format!(".unpack-{id}"));
    if tmp.exists() {
        std::fs::remove_dir_all(&tmp).map_err(|e| format!("清理临时目录失败：{e}"))?;
    }
    std::fs::create_dir_all(&tmp).map_err(|e| format!("建临时目录失败：{e}"))?;
    let file = std::fs::File::open(archive).map_err(|e| format!("打开归档失败：{e}"))?;
    let decoder = bzip2::read::BzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);
    tar.unpack(&tmp).map_err(|e| format!("解包失败：{e}"))?;

    let move_to = |name: &str, target: &str| -> Result<(), String> {
        let hit = find_file(&tmp, name).ok_or_else(|| format!("归档里没有 {name}"))?;
        let target_path = dir.join(target);
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
        }
        let _ = std::fs::remove_file(&target_path);
        std::fs::rename(&hit, &target_path).map_err(|e| format!("放置 {name} 失败：{e}"))?;
        Ok(())
    };

    if with_tokens {
        move_to("model.int8.onnx", ASR_MODEL)?;
        move_to("tokens.txt", ASR_TOKENS)?;
    } else {
        move_to("model.int8.onnx", PUNCT_MODEL)?;
    }
    let _ = std::fs::remove_dir_all(&tmp);
    emit_model(shared, id, "ready", 0, 0, "已就绪");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "dsy-voice-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn clean_asr_text_strips_model_tags_and_spaces() {
        assert_eq!(
            clean_asr_text("<|zh|><|NEUTRAL|><|Speech|><|withitn|>打开设置 看看"),
            "打开设置 看看"
        );
        assert_eq!(clean_asr_text("  你好\n世界  "), "你好 世界");
        assert_eq!(clean_asr_text("<|zh|>"), "");
    }

    #[test]
    fn rms_and_peak_measure_real_amplitude() {
        let (rms, peak) = rms_and_peak(&[0.0, 0.0, 0.0]);
        assert_eq!(rms, 0.0);
        assert_eq!(peak, 0.0);
        // 全 0.5 的方波：rms = 0.5，peak = 0.5
        let (rms, peak) = rms_and_peak(&[0.5, -0.5, 0.5, -0.5]);
        assert!((rms - 0.5).abs() < 1e-6);
        assert!((peak - 0.5).abs() < 1e-6);
    }

    #[test]
    fn write_wav_i16_writes_valid_header_and_payload() {
        let dir = tmp("wav");
        let path = dir.join("a.wav");
        write_wav_i16(&path, &[0.0, 0.5, -0.5]).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        assert_eq!(bytes.len(), 44 + 3 * 2);
        let data_len = u32::from_le_bytes(bytes[40..44].try_into().unwrap());
        assert_eq!(data_len, 6);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn find_file_walks_nested_dirs() {
        let dir = tmp("find");
        let nested = dir.join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("tokens.txt"), b"x").unwrap();
        let hit = find_file(&dir, "tokens.txt").expect("应能找到");
        assert!(hit.ends_with("b/tokens.txt"));
        assert!(find_file(&dir, "nope.txt").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn is_ready_requires_real_file_and_size() {
        let dir = tmp("ready");
        let path = dir.join("m.onnx");
        std::fs::write(&path, vec![0u8; 10]).unwrap();
        assert!(!is_ready(&path, 11));
        assert!(is_ready(&path, 10));
        assert!(!is_ready(&dir.join("missing"), 0));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn model_paths_are_under_models_voice() {
        // 契约：手动放置模型时目录结构固定（设置页会显示这个路径）
        assert!(ASR_MODEL.starts_with("sense-voice/"));
        assert!(ASR_TOKENS.starts_with("sense-voice/"));
        assert!(PUNCT_MODEL.starts_with("punct/"));
        assert!(!VAD_MODEL.contains('/'));
    }

    /// 读 16kHz/单声道/16-bit PCM WAV（模型自带的 test_wavs 就是这种格式）。
    fn read_wav_i16_mono(path: &Path) -> Result<Vec<f32>, String> {
        let bytes = std::fs::read(path).map_err(|e| format!("读 wav 失败：{e}"))?;
        if bytes.len() < 44 || &bytes[0..4] != b"RIFF" {
            return Err("不是合法的 WAV".to_string());
        }
        let mut pos = 12;
        let mut channels = 1u16;
        let mut rate = 16000u32;
        let mut bits = 16u16;
        while pos + 8 <= bytes.len() {
            let id = &bytes[pos..pos + 4];
            let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
            let body = pos + 8;
            if id == b"fmt " && body + 16 <= bytes.len() {
                channels = u16::from_le_bytes(bytes[body + 2..body + 4].try_into().unwrap());
                rate = u32::from_le_bytes(bytes[body + 4..body + 8].try_into().unwrap());
                bits = u16::from_le_bytes(bytes[body + 14..body + 16].try_into().unwrap());
            } else if id == b"data" {
                let end = (body + size).min(bytes.len());
                let samples = bytes[body..end]
                    .chunks_exact(2)
                    .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
                    .collect::<Vec<f32>>();
                // 多声道就地取首声道（模型只在 16k 单声道上训练）
                let mono = if channels > 1 {
                    samples
                        .chunks(channels as usize)
                        .map(|c| c[0])
                        .collect::<Vec<f32>>()
                } else {
                    samples
                };
                if rate != 16000 {
                    return Err(format!("wav 采样率 {rate} 不是 16kHz（测试素材需自行转换）"));
                }
                if bits != 16 {
                    return Err(format!("wav 位深 {bits} 不是 16bit"));
                }
                return Ok(mono);
            }
            pos = body + size + (size & 1);
        }
        Err("wav 里没有 data 块".to_string())
    }

    /// 真机识别自检（默认忽略：要联网下 220MB 模型）。
    ///
    /// 这是唯一能证明「模型真的能加载、真的能识别出字」的测试 —— 单测只能证明拼装逻辑对。
    /// 用法：
    /// ```text
    /// DAOSHENGYI_VOICE_MODEL_DIR=/tmp/dsy-voice-live \
    ///   cargo test --lib voice::tests::live_transcribe -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "需要已下载的模型目录（DAOSHENGYI_VOICE_MODEL_DIR）与一段 16kHz wav"]
    fn live_transcribe_returns_text_with_punctuation() {
        let dir = PathBuf::from(
            std::env::var("DAOSHENGYI_VOICE_MODEL_DIR")
                .expect("请设置 DAOSHENGYI_VOICE_MODEL_DIR 指向模型目录"),
        );
        let wav = std::env::var("DAOSHENGYI_VOICE_WAV")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dir.join("zh.wav"));
        let samples = read_wav_i16_mono(&wav).expect("读取测试 wav");
        let asr = Asr::load(&dir).expect("加载 SenseVoice（文件是否完整？）");
        let started = Instant::now();
        let text = asr.transcribe(&samples);
        let ms = started.elapsed().as_millis();
        eprintln!(
            "[live] {:.2}s 音频 → {ms}ms（RTF {:.2}）：{text}",
            samples.len() as f32 / SAMPLE_RATE as f32,
            ms as f32 / (samples.len() as f32 / SAMPLE_RATE as f32 * 1000.0)
        );
        assert!(!text.is_empty(), "没识别出文字");
        assert!(
            text.chars().any(|c| "，。！？、；：".contains(c)),
            "标点模型没有生效：{text}"
        );
    }
}
