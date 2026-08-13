use crate::api::ChatMessage;

const APP_NAME: &str = "道生一";
const APP_IDENTITY: &str = "道生一（Dao Sheng Yi）—— 一个基于开源大模型的 AI 桌面助手。\
你由社区驱动，运行在用户的本地设备上，致力于提供智能、安全、高效的对话服务。";

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
