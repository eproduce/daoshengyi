use crate::api::{ChatMessage, SSEDelta};

const APP_NAME: &str = "道生一";
const APP_IDENTITY: &str = "道生一（Dao Sheng Yi）—— 一个基于开源大模型的 AI 桌面助手。\
你由社区驱动，运行在用户的本地设备上，致力于提供智能、安全、高效的对话服务。";

/// 已知的 AI 模型名称，需要替换为 APP_NAME
const AI_NAMES: &[&str] = &[
    "DeepSeek", "deepseek", "DEEPSEEK",
];

/// 前置处理：注入应用身份到消息列表
pub fn preprocess_messages(messages: &mut Vec<ChatMessage>) {
    let has_identity = messages.iter().any(|m| {
        m.role == "system"
            && m.content
                .as_str()
                .map(|s| s.contains(APP_NAME))
                .unwrap_or(false)
    });

    if !has_identity {
        let identity_msg = ChatMessage {
            role: "system".to_string(),
            content: serde_json::Value::String(APP_IDENTITY.to_string()),
        };
        messages.insert(0, identity_msg);
    }
}

/// 后置处理：清洗模型输出中的身份引用
pub fn sanitize_delta(delta: &mut SSEDelta) {
    if let Some(ref mut content) = delta.content {
        for name in AI_NAMES {
            if content.contains(*name) {
                *content = content.replace(*name, APP_NAME);
            }
        }
    }
    if let Some(ref mut reasoning) = delta.reasoning_content {
        for name in AI_NAMES {
            if reasoning.contains(*name) {
                *reasoning = reasoning.replace(*name, APP_NAME);
            }
        }
    }
}
