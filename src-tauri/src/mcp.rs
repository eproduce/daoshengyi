use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

// --- JSON-RPC 2.0 基础类型 ---

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
}

// --- MCP 协议类型 ---

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InitializeParams {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    pub capabilities: ClientCapabilities,
    #[serde(rename = "clientInfo")]
    pub client_info: ClientInfo,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClientCapabilities {
    pub tools: Option<ToolsCapability>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolsCapability {
    #[serde(rename = "listChanged")]
    pub list_changed: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InitializeResult {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    pub capabilities: ServerCapabilities,
    #[serde(rename = "serverInfo")]
    pub server_info: ServerInfo,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServerCapabilities {
    pub tools: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tool {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ListToolsResult {
    pub tools: Vec<Tool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CallToolParams {
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CallToolResult {
    pub content: Vec<ToolContent>,
    #[serde(rename = "isError")]
    pub is_error: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: Option<String>,
}

// --- MCP Server 配置 ---

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub enabled: bool,
}

// --- MCP 客户端 ---

pub struct McpClient {
    process: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: tokio::io::BufReader<tokio::process::ChildStdout>,
    id_counter: u64,
    pub tools: Vec<Tool>,
    pub server_name: String,
}

impl McpClient {
    /// 启动 MCP Server 进程并完成握手
    pub async fn connect(config: &McpServerConfig) -> Result<Self, String> {
        let mut child = tokio::process::Command::new(&config.command)
            .args(&config.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("启动 MCP Server 失败: {}", e))?;

        let stdin = child.stdin.take().ok_or("无法获取 stdin")?;
        let stdout = child.stdout.take().ok_or("无法获取 stdout")?;
        let stdout = tokio::io::BufReader::new(stdout);

        let mut client = McpClient {
            process: child,
            stdin,
            stdout,
            id_counter: 1,
            tools: Vec::new(),
            server_name: config.name.clone(),
        };

        // MCP 握手
        let init_params = InitializeParams {
            protocol_version: "2024-11-05".into(),
            capabilities: ClientCapabilities {
                tools: Some(ToolsCapability { list_changed: Some(true) }),
            },
            client_info: ClientInfo {
                name: "daoshengyi".into(),
                version: "0.1.0".into(),
            },
        };

        let response = client
            .send_request("initialize", Some(serde_json::to_value(&init_params).map_err(|e| e.to_string())?))
            .await?;
        let _init: InitializeResult =
            serde_json::from_value(response.ok_or("无响应")?).map_err(|e| format!("解析初始化响应: {}", e))?;

        // 发送 initialized 通知
        client.send_notification("notifications/initialized", None).await?;

        // 获取工具列表
        let tools_resp = client.send_request("tools/list", None).await?;
        let tools_result: ListToolsResult =
            serde_json::from_value(tools_resp.ok_or("工具列表为空")?).map_err(|e| format!("解析工具列表: {}", e))?;
        client.tools = tools_result.tools;

        Ok(client)
    }

    /// 发送 JSON-RPC 请求并等待响应
    async fn send_request(&mut self, method: &str, params: Option<Value>) -> Result<Option<Value>, String> {
        let id = self.id_counter;
        self.id_counter += 1;
        let request = JsonRpcRequest {
            jsonrpc: "2.0".into(), id, method: method.into(), params,
        };
        let mut json = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        json.push('\n');

        use tokio::io::AsyncWriteExt;
        self.stdin.write_all(json.as_bytes()).await.map_err(|e| e.to_string())?;
        self.stdin.flush().await.map_err(|e| e.to_string())?;

        // 读取响应
        use tokio::io::AsyncBufReadExt;
        loop {
            let mut line = String::new();
            self.stdout.read_line(&mut line).await.map_err(|e| format!("读取响应: {}", e))?;
            if line.trim().is_empty() { continue; }
            let response: JsonRpcResponse = serde_json::from_str(&line).map_err(|e| format!("解析响应: {}", e))?;
            if response.id == Some(id) {
                if let Some(err) = response.error {
                    return Err(format!("MCP 错误 [{}]: {}", err.code, err.message));
                }
                return Ok(response.result);
            }
        }
    }

    /// 发送通知（无响应）
    async fn send_notification(&mut self, method: &str, params: Option<Value>) -> Result<(), String> {
        let notif = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let mut json = serde_json::to_string(&notif).map_err(|e| e.to_string())?;
        json.push('\n');

        use tokio::io::AsyncWriteExt;
        self.stdin.write_all(json.as_bytes()).await.map_err(|e| e.to_string())?;
        self.stdin.flush().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 调用工具
    pub async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<CallToolResult, String> {
        let params = CallToolParams { name: name.into(), arguments };
        let resp = self
            .send_request("tools/call", Some(serde_json::to_value(&params).map_err(|e| e.to_string())?))
            .await?;
        serde_json::from_value(resp.ok_or("无响应")?).map_err(|e| format!("解析工具调用结果: {}", e))
    }
}
