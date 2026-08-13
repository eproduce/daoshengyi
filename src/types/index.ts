/// 消息角色
export type MessageRole = "user" | "assistant" | "system";

/// 图片附件
export interface ImageAttachment {
  id: string;
  base64: string;
  mimeType: string;
  fileName?: string;
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

/// API 请求体（OpenAI 兼容格式）
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

