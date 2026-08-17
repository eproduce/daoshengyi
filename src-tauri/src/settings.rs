//! 应用设置持久化 + API Key 加密存储
//!
//! 配置统一存储在 SQLite `app_settings` 表（由 db.rs 提供存取），
//! 其中的 `apiKey` 字段使用 AES-256-GCM 加密后落盘。
//! 加密密钥保存在应用数据目录下的 `secret.key`（Unix 权限 0600）。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

/// API Profile 的持久化形态（apiKey 在内存中为明文，落盘前由 SecretCipher 加密）
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ApiProfileSettings {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub max_tokens: u32,
    pub temperature: f32,
    pub thinking_enabled: bool,
    pub reasoning_effort: String,
    pub system_prompt: String,
    pub enable_web_search: bool,
    pub max_context_messages: u32,
    #[serde(default)]
    pub available_models: Option<Vec<String>>,
}

/// 应用全部设置的统一结构
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub profiles: Vec<ApiProfileSettings>,
    pub active_profile_id: String,
    pub mcp_servers: serde_json::Value,
    pub active_conversation_id: Option<String>,
    /// Agent 工作区目录（借鉴 DeepSeek Harness 的 workspace 概念）
    #[serde(default)]
    pub workspace: Option<String>,
    /// YOLO 模式：开启后危险命令不再弹确认、自动批准执行（对应 HERMES_YOLO_MODE 理念）
    #[serde(default)]
    pub yolo_mode: bool,
    /// 危险命令审批模式：manual（手动确认，默认）/ smart（辅助模型智能判断）/ yolo（全部自动批准）
    #[serde(default = "default_approval_mode")]
    pub approval_mode: String,
    /// 辅助任务使用的 Profile（空 = 跟随主模型）：用于 Smart 审批 / 子代理等辅助任务
    #[serde(default)]
    pub auxiliary_profile_id: Option<String>,
}

fn default_approval_mode() -> String {
    "manual".to_string()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            profiles: Vec::new(),
            active_profile_id: String::new(),
            mcp_servers: serde_json::Value::Array(Vec::new()),
            active_conversation_id: None,
            workspace: None,
            yolo_mode: false,
            approval_mode: "manual".to_string(),
            auxiliary_profile_id: None,
        }
    }
}

/// AES-256-GCM 加解密器，密钥从应用数据目录加载/生成
pub struct SecretCipher {
    key: [u8; KEY_LEN],
}

impl SecretCipher {
    pub fn new(app_dir: &Path) -> Result<Self, String> {
        let key = load_or_create_key(app_dir)?;
        Ok(Self { key })
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&self.key))
    }

    /// 加密明文，输出 `base64(nonce).base64(ciphertext)`
    pub fn encrypt(&self, plain: &str) -> Result<String, String> {
        if plain.is_empty() {
            return Ok(String::new());
        }
        let mut nonce_bytes = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = self
            .cipher()
            .encrypt(nonce, plain.as_bytes())
            .map_err(|e| format!("加密失败: {}", e))?;
        Ok(format!("{}.{}", B64.encode(nonce_bytes), B64.encode(ciphertext)))
    }

    /// 解密 `base64(nonce).base64(ciphertext)` 格式的密文
    pub fn decrypt(&self, enc: &str) -> Result<String, String> {
        if enc.is_empty() {
            return Ok(String::new());
        }
        let parts: Vec<&str> = enc.splitn(2, '.').collect();
        if parts.len() != 2 {
            return Err("密文格式错误".into());
        }
        let nonce_bytes = B64.decode(parts[0]).map_err(|e| format!("解码 nonce 失败: {}", e))?;
        let ciphertext = B64.decode(parts[1]).map_err(|e| format!("解码密文失败: {}", e))?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        let plaintext = self
            .cipher()
            .decrypt(nonce, ciphertext.as_ref())
            .map_err(|e| format!("解密失败: {}", e))?;
        String::from_utf8(plaintext).map_err(|e| format!("解密结果不是 UTF-8: {}", e))
    }

    /// 对 settings 中所有 profile 的 apiKey 做加密（落盘前调用）
    pub fn encrypt_settings(&self, settings: &mut AppSettings) -> Result<(), String> {
        for p in settings.profiles.iter_mut() {
            p.api_key = self.encrypt(&p.api_key)?;
        }
        Ok(())
    }

    /// 对 settings 中所有 profile 的 apiKey 做解密（读盘后调用）
    /// 解密失败（旧数据为明文）时保留原文，保证向后兼容
    pub fn decrypt_settings(&self, settings: &mut AppSettings) -> Result<(), String> {
        for p in settings.profiles.iter_mut() {
            if !p.api_key.is_empty() {
                if let Ok(plain) = self.decrypt(&p.api_key) {
                    p.api_key = plain;
                }
            }
        }
        Ok(())
    }
}

/// 从密钥文件加载 32 字节密钥，不存在则生成并写入（0600 权限）
fn load_or_create_key(app_dir: &Path) -> Result<[u8; KEY_LEN], String> {
    let key_path: PathBuf = app_dir.join("secret.key");
    if key_path.exists() {
        let bytes = std::fs::read(&key_path).map_err(|e| format!("读取密钥文件失败: {}", e))?;
        if bytes.len() == KEY_LEN {
            let mut key = [0u8; KEY_LEN];
            key.copy_from_slice(&bytes);
            return Ok(key);
        }
        // 长度不对视为损坏，重新生成
    }
    let mut key = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut key);
    std::fs::write(&key_path, &key).map_err(|e| format!("写入密钥文件失败: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_cipher() -> (SecretCipher, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("ds_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cipher = SecretCipher::new(&dir).unwrap();
        (cipher, dir)
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let (cipher, dir) = tmp_cipher();
        let plain = "sk-test-api-key-123456";
        let enc = cipher.encrypt(plain).unwrap();
        assert_ne!(enc, plain);
        assert!(!enc.contains(plain), "密文不应包含明文");
        let dec = cipher.decrypt(&enc).unwrap();
        assert_eq!(dec, plain);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn encrypt_empty_and_unicode() {
        let (cipher, dir) = tmp_cipher();
        // 空字符串直接返回空
        assert_eq!(cipher.encrypt("").unwrap(), "");
        assert_eq!(cipher.decrypt("").unwrap(), "");
        // 含中文与符号
        let plain = "密钥🔑sk-中文-abc";
        let enc = cipher.encrypt(plain).unwrap();
        assert_eq!(cipher.decrypt(&enc).unwrap(), plain);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn settings_encrypt_decrypt_roundtrip() {
        let (cipher, dir) = tmp_cipher();
        let mut settings = AppSettings {
            profiles: vec![ApiProfileSettings {
                id: "p1".into(),
                name: "DeepSeek".into(),
                base_url: "https://api.deepseek.com".into(),
                api_key: "sk-secret".into(),
                model: "deepseek-v4-flash".into(),
                max_tokens: 4096,
                temperature: 0.7,
                thinking_enabled: true,
                reasoning_effort: "high".into(),
                system_prompt: "".into(),
                enable_web_search: false,
                max_context_messages: 50,
                available_models: None,
            }],
            active_profile_id: "p1".into(),
            mcp_servers: serde_json::json!([]),
            active_conversation_id: None,
            workspace: None,
            yolo_mode: false,
        };
        cipher.encrypt_settings(&mut settings).unwrap();
        assert_ne!(settings.profiles[0].api_key, "sk-secret", "落盘应为密文");
        cipher.decrypt_settings(&mut settings).unwrap();
        assert_eq!(settings.profiles[0].api_key, "sk-secret");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn decrypt_legacy_plaintext_kept() {
        let (cipher, dir) = tmp_cipher();
        // 旧数据为明文，decrypt_settings 应保留原文而非报错
        let mut settings = AppSettings {
            profiles: vec![ApiProfileSettings {
                id: "p1".into(), name: "x".into(), base_url: "u".into(),
                api_key: "sk-legacy-plain".into(), model: "m".into(),
                max_tokens: 100, temperature: 0.5, thinking_enabled: false,
                reasoning_effort: "high".into(), system_prompt: "".into(),
                enable_web_search: false, max_context_messages: 10,
                available_models: None,
            }],
            active_profile_id: "p1".into(),
            mcp_servers: serde_json::json!([]),
            active_conversation_id: None,
            workspace: None,
            yolo_mode: false,
        };
        cipher.decrypt_settings(&mut settings).unwrap();
        assert_eq!(settings.profiles[0].api_key, "sk-legacy-plain");
        std::fs::remove_dir_all(dir).ok();
    }
}
