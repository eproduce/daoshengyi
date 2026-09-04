//! MCP（Model Context Protocol）客户端：stdio 连接外部 MCP 服务器并调用其工具。
//!
//! 提供 JSON-RPC 2.0 请求/响应类型、stdio 子进程管理、initialize / tools/list / tools/call
//! 握手流程，以及服务器 env 透传与按需连接（浏览器等重服务器懒激活）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

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
    /// 图片类内容（如 puppeteer_screenshot 截图）的 base64 数据
    #[serde(default)]
    pub data: Option<String>,
}

// --- MCP Server 配置 ---

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub enabled: bool,
    /// 透传给 MCP server 进程的环境变量（如 PUPPETEER_EXECUTABLE_PATH 指定浏览器）
    #[serde(default)]
    pub env: HashMap<String, String>,
}

// --- MCP 客户端 ---

pub struct McpClient {
    // stdio 子进程模式
    process: Option<tokio::process::Child>,
    stdin: Option<tokio::process::ChildStdin>,
    stdout: Option<tokio::io::BufReader<tokio::process::ChildStdout>>,
    // 远程 HTTP（streamable HTTP MCP）模式：command 以 http(s):// 开头
    http: Option<reqwest::Client>,
    endpoint: Option<String>,
    session_id: Option<String>,
    id_counter: u64,
    pub tools: Vec<Tool>,
}

impl McpClient {
    /// 连接 MCP Server。command 以 http(s):// 开头时走远程 HTTP（streamable HTTP MCP，
    /// 用于社区插件市场如 Smithery/Glama 的远程端点）；否则走 stdio 子进程。
    pub async fn connect(config: &McpServerConfig) -> Result<Self, String> {
        let mut client = McpClient {
            process: None,
            stdin: None,
            stdout: None,
            http: None,
            endpoint: None,
            session_id: None,
            id_counter: 1,
            tools: Vec::new(),
        };
        if config.command.starts_with("http://") || config.command.starts_with("https://") {
            client.remote_connect(&config.command).await?;
        } else {
            client.stdio_connect(config).await?;
        }
        Ok(client)
    }

    /// stdio 子进程模式：spawn 进程，再走共用握手
    async fn stdio_connect(&mut self, config: &McpServerConfig) -> Result<(), String> {
        let mut cmd = tokio::process::Command::new(&config.command);
        cmd.args(&config.args);
        // 透传配置的 env（如 puppeteer 用本机 Edge 作为浏览器）
        if !config.env.is_empty() {
            cmd.envs(&config.env);
        }
        // server-puppeteer 在 macOS 12 (Intel) 无头模式下导航会报
        // "Attempted to use detached Frame"，改用有头模式可正常工作。
        // 该环境变量对其他 MCP 服务器（filesystem/fetch/git 等）无影响。
        cmd.env("HEADLESS", "false");
        // 让子进程（node）与它的后代（如 puppeteer 启动的 Chrome）处于同一进程组，
        // 断开时 killpg 可一并终止浏览器进程，避免浏览器窗口残留。
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("启动 MCP Server 失败: {}", e))?;

        let stdin = child.stdin.take().ok_or("无法获取 stdin")?;
        let stdout = child.stdout.take().ok_or("无法获取 stdout")?;
        let stdout = tokio::io::BufReader::new(stdout);
        self.process = Some(child);
        self.stdin = Some(stdin);
        self.stdout = Some(stdout);
        self.handshake().await
    }

    /// 远程 HTTP（streamable HTTP MCP）模式：JSON-RPC over POST
    async fn remote_connect(&mut self, endpoint: &str) -> Result<(), String> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| format!("构建 HTTP 客户端失败: {}", e))?;
        self.http = Some(http);
        self.endpoint = Some(endpoint.to_string());
        self.handshake().await
    }

    /// 握手：initialize → initialized 通知 → tools/list（stdio / 远程共用）
    async fn handshake(&mut self) -> Result<(), String> {
        let init_params = InitializeParams {
            protocol_version: "2024-11-05".into(),
            capabilities: ClientCapabilities {
                tools: Some(ToolsCapability {
                    list_changed: Some(true),
                }),
            },
            client_info: ClientInfo {
                name: "daoshengyi".into(),
                version: "0.1.0".into(),
            },
        };

        let response = self
            .send_request(
                "initialize",
                Some(serde_json::to_value(&init_params).map_err(|e| e.to_string())?),
            )
            .await?;
        let _init: InitializeResult = serde_json::from_value(response.ok_or("无响应")?)
            .map_err(|e| format!("解析初始化响应: {}", e))?;

        // 发送 initialized 通知
        self.send_notification("notifications/initialized", None)
            .await?;

        // 获取工具列表
        let tools_resp = self.send_request("tools/list", None).await?;
        let tools_result: ListToolsResult =
            serde_json::from_value(tools_resp.ok_or("工具列表为空")?)
                .map_err(|e| format!("解析工具列表: {}", e))?;
        self.tools = tools_result.tools;

        Ok(())
    }

    /// 发送 JSON-RPC 请求并等待响应（stdio / 远程 HTTP 自动分发）
    async fn send_request(
        &mut self,
        method: &str,
        params: Option<Value>,
    ) -> Result<Option<Value>, String> {
        let id = self.id_counter;
        self.id_counter += 1;
        let request = JsonRpcRequest {
            jsonrpc: "2.0".into(),
            id,
            method: method.into(),
            params,
        };
        if self.http.is_some() {
            return self.remote_request(&request).await;
        }

        let mut json = serde_json::to_string(&request).map_err(|e| e.to_string())?;
        json.push('\n');

        use tokio::io::AsyncWriteExt;
        self.stdin
            .as_mut()
            .unwrap()
            .write_all(json.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        self.stdin
            .as_mut()
            .unwrap()
            .flush()
            .await
            .map_err(|e| e.to_string())?;

        // 读取响应
        use tokio::io::AsyncBufReadExt;
        loop {
            let mut line = String::new();
            self.stdout
                .as_mut()
                .unwrap()
                .read_line(&mut line)
                .await
                .map_err(|e| format!("读取响应: {}", e))?;
            if line.trim().is_empty() {
                continue;
            }
            let response: JsonRpcResponse =
                serde_json::from_str(&line).map_err(|e| format!("解析响应: {}", e))?;
            if response.id == Some(id) {
                if let Some(err) = response.error {
                    return Err(format!("MCP 错误 [{}]: {}", err.code, err.message));
                }
                return Ok(response.result);
            }
        }
    }

    /// 远程 HTTP 请求（streamable HTTP MCP）：POST JSON-RPC，兼容 JSON 与 SSE(text/event-stream) 响应
    async fn remote_request(&mut self, request: &JsonRpcRequest) -> Result<Option<Value>, String> {
        let http = self.http.clone().ok_or("HTTP 客户端未初始化")?;
        let endpoint = self.endpoint.clone().ok_or("端点未初始化")?;
        let mut builder = http
            .post(&endpoint)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream");
        if let Some(sid) = &self.session_id {
            builder = builder.header("mcp-session-id", sid);
        }
        let resp = builder
            .json(request)
            .send()
            .await
            .map_err(|e| format!("HTTP 请求失败: {}", e))?;
        // streamable HTTP：session id 由首次响应的响应头下发
        if self.session_id.is_none() {
            if let Some(sid) = resp
                .headers()
                .get("mcp-session-id")
                .and_then(|v| v.to_str().ok())
            {
                self.session_id = Some(sid.to_string());
            }
        }
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let text = resp.text().await.map_err(|e| format!("读取响应: {}", e))?;
        let is_sse =
            content_type.contains("event-stream") || text.trim_start().starts_with("data:");
        let want_id = request.id;

        if is_sse {
            // 优先按 id 匹配；个别服务器 SSE 不带 id，则取第一条含 result 的
            let parsed: Vec<Value> = text
                .lines()
                .filter_map(|l| l.trim().strip_prefix("data:"))
                .filter_map(|d| serde_json::from_str::<Value>(d.trim()).ok())
                .collect();
            if let Some(v) = parsed
                .iter()
                .find(|v| v.get("id").and_then(|x| x.as_u64()) == Some(want_id))
            {
                return extract_result(v.clone());
            }
            if let Some(v) = parsed.iter().find(|v| v.get("result").is_some()) {
                return extract_result(v.clone());
            }
            return Err(format!("SSE 响应中未找到请求 {} 的结果", want_id));
        }

        let v: Value = serde_json::from_str(&text).map_err(|e| format!("解析 JSON 响应: {}", e))?;
        extract_result(v)
    }

    /// 发送通知（无响应）
    /// 注意：params 为 None 时必须序列化为空对象 {} 而非 null，
    /// 否则部分 MCP 服务器（如 server-puppeteer）会因收到 params:null 而卡住，
    /// 导致后续 tools/list 请求无响应、连接失败（客户端 drop 后 kill 服务器进程）。
    async fn send_notification(
        &mut self,
        method: &str,
        params: Option<Value>,
    ) -> Result<(), String> {
        let notif = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params.unwrap_or_else(|| serde_json::json!({})),
        });
        if self.http.is_some() {
            // 远程通知：POST 后忽略响应（streamable HTTP 通知也走 POST）
            let http = self.http.clone().ok_or("HTTP 客户端未初始化")?;
            let endpoint = self.endpoint.clone().ok_or("端点未初始化")?;
            let mut builder = http
                .post(&endpoint)
                .header("Content-Type", "application/json");
            if let Some(sid) = &self.session_id {
                builder = builder.header("mcp-session-id", sid);
            }
            let _ = builder.json(&notif).send().await;
            return Ok(());
        }
        let mut json = serde_json::to_string(&notif).map_err(|e| e.to_string())?;
        json.push('\n');

        use tokio::io::AsyncWriteExt;
        self.stdin
            .as_mut()
            .unwrap()
            .write_all(json.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        self.stdin
            .as_mut()
            .unwrap()
            .flush()
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 调用工具
    pub async fn call_tool(
        &mut self,
        name: &str,
        arguments: Value,
    ) -> Result<CallToolResult, String> {
        let params = CallToolParams {
            name: name.into(),
            arguments,
        };
        let resp = self
            .send_request(
                "tools/call",
                Some(serde_json::to_value(&params).map_err(|e| e.to_string())?),
            )
            .await?;
        serde_json::from_value(resp.ok_or("无响应")?)
            .map_err(|e| format!("解析工具调用结果: {}", e))
    }
}

/// 从 JSON-RPC 响应值中提取 result；若含 error 则返回错误。
fn extract_result(v: Value) -> Result<Option<Value>, String> {
    if let Some(err) = v.get("error") {
        let code = err.get("code").and_then(|x| x.as_i64()).unwrap_or(-1);
        let msg = err
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string();
        return Err(format!("MCP 错误 [{}]: {}", code, msg));
    }
    Ok(v.get("result").cloned())
}

impl Drop for McpClient {
    fn drop(&mut self) {
        // 断开连接时终止 MCP 服务器进程及其启动的浏览器，形成使用闭环。
        // 注意：puppeteer 的 Chrome 会自建进程组/会话，且 npx→node 可能 exec 导致
        // 进程树链断裂，递归 kill 可能漏杀部分 Chrome 进程，故再按
        // user-data-dir 特征匹配兜底清理所有 puppeteer 浏览器进程。
        #[cfg(unix)]
        {
            // 仅 stdio 模式需要终止子进程；远程 HTTP 模式 process 为 None
            if let Some(pid) = self.process.as_ref().and_then(|p| p.id()) {
                if pid > 1 {
                    kill_process_tree(pid);
                }
            }
            // 兜底：终止 puppeteer 启动的 Chrome for Testing（带 puppeteer 临时 profile 目录）
            let _ = std::process::Command::new("pkill")
                .args(["-9", "-f", "puppeteer_dev_chrome_profile"])
                .status();
        }
    }
}

/// 递归终止指定进程及其所有后代进程（通过 ps 解析进程树）。
/// 用于断开 MCP 连接时确保 puppeteer 的 Chrome 浏览器进程一并退出。
#[cfg(unix)]
fn kill_process_tree(pid: u32) {
    // 先收集直接子进程（在 kill 父进程前，避免子进程被 reparent 后难以定位）
    let children: Vec<u32> = std::process::Command::new("ps")
        .args(["-axo", "pid,ppid"])
        .output()
        .ok()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter_map(|line| {
                    let mut parts = line.split_whitespace();
                    let p = parts.next()?.parse::<u32>().ok()?;
                    let pp = parts.next()?.parse::<u32>().ok()?;
                    if pp == pid {
                        Some(p)
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    // 先终止所有后代，再终止自身
    for c in children {
        kill_process_tree(c);
    }
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}
