/// 消息角色
export type MessageRole = "user" | "assistant" | "system";

/// 图片附件
export interface ImageAttachment {
  id: string;
  base64: string;
  mimeType: string;
  fileName?: string;
}

/// 文件上下文附件（文本/PDF 提取内容，作为上下文注入提示词，不直接展示在消息里）
export interface FileAttachment {
  id: string;
  name: string;
  content: string;
  mimeType?: string;
}

/// 多模态消息内容
export type MessageContent =
  | string
  | (TextContentPart | ImageContentPart)[];

export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageContentPart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

/// 单条消息
export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  reasoning_content?: string;
  images?: ImageAttachment[];
  attachments?: FileAttachment[];
  timestamp: number;
  streaming?: boolean;
  duration?: number;
  tokens?: number;
  cost?: number;
}

/// 对话会话
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  model: string;
}

/// API 请求体（兼容格式）
export interface ChatCompletionRequest {
  model: string;
  messages: {
    role: MessageRole;
    content: MessageContent;
  }[];
  stream: boolean;
}

/// API 配置
export interface ApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  temperature: number;
  thinkingEnabled: boolean;
  reasoningEffort: "low" | "high" | "max";
  systemPrompt: string;
  enableWebSearch: boolean;
  maxContextMessages: number;
}

/// 保存的 API 配置组（快速切换）
export interface ApiProfile extends ApiConfig {
  id: string;
  name: string;
  /// 从厂商拉取到的可用模型列表
  availableModels?: string[];
}

/// 流式响应 delta
export interface StreamDelta {
  content?: string;
  role?: string;
}

/// 硬件综合性能评估（判断是否适合本地部署视觉模型）
export interface HardwareInfo {
  cpu_cores: number;
  cpu_brand: string;
  memory_gb: number;
  gpu_name: string;
  gpu_memory_mb: number;
  has_metal: boolean;
  score: number;
  verdict: "recommended" | "warning" | "not_recommended";
  message: string;
}

/// 技能
export interface Skill {
  id: string;
  name: string;
  description: string;
  prompt: string;
  enabled: boolean;
  category: string;
  source: "user" | "catalog" | "import";
  importUrl?: string;
  version?: string;
  author?: string;
  createdAt: number;
  updatedAt: number;
}

/// 技能目录项（内置可选安装）
export interface SkillCatalogItem {
  id: string;
  name: string;
  description: string;
  prompt: string;
  category: string;
  author: string;
  version: string;
  tags: string[];
}

