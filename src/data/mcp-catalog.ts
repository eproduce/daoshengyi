/// MCP 插件市场目录项
export interface McpCatalogItem {
  id: string;
  name: string;
  icon: string;
  description: string;
  category: string;
  command: string;
  args: string;
  tags: string[];
}

/// 内置 MCP 插件市场（常用官方服务器）
export const MCP_CATALOG: McpCatalogItem[] = [
  {
    id: "filesystem",
    name: "文件系统",
    icon: "📁",
    description: "读写本地文件、浏览目录、搜索文件",
    category: "系统",
    command: "npx",
    args: "-y @modelcontextprotocol/server-filesystem /tmp",
    tags: ["文件", "本地"],
  },
  {
    id: "fetch",
    name: "网络请求",
    icon: "🌐",
    description: "抓取网页、转 Markdown",
    category: "网络",
    command: "npx",
    args: "-y @modelcontextprotocol/server-fetch",
    tags: ["HTTP", "抓取"],
  },
  {
    id: "puppeteer",
    name: "浏览器自动化",
    icon: "🌍",
    description: "网页交互、点击、截图（Puppeteer）",
    category: "网络",
    command: "npx",
    args: "-y @modelcontextprotocol/server-puppeteer",
    tags: ["浏览器", "自动化"],
  },
  {
    id: "git",
    name: "Git",
    icon: "🌿",
    description: "Git 仓库操作、提交、diff、日志",
    category: "开发",
    command: "npx",
    args: "-y @modelcontextprotocol/server-git",
    tags: ["git", "版本控制"],
  },
  {
    id: "github",
    name: "GitHub",
    icon: "🐙",
    description: "GitHub 仓库、Issue、PR 操作",
    category: "开发",
    command: "npx",
    args: "-y @modelcontextprotocol/server-github",
    tags: ["github", "仓库"],
  },
  {
    id: "sqlite",
    name: "SQLite",
    icon: "🗄️",
    description: "SQLite 数据库查询与分析",
    category: "数据",
    command: "npx",
    args: "-y @modelcontextprotocol/server-sqlite /tmp/daoshengyi.db",
    tags: ["数据库", "SQL"],
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    icon: "🐘",
    description: "Postgres 数据库查询（需修改连接串）",
    category: "数据",
    command: "npx",
    args: "-y @modelcontextprotocol/server-postgres postgresql://localhost/mydb",
    tags: ["数据库", "SQL"],
  },
  {
    id: "redis",
    name: "Redis",
    icon: "🔴",
    description: "Redis 键值读写与命令执行",
    category: "数据",
    command: "npx",
    args: "-y @modelcontextprotocol/server-redis",
    tags: ["redis", "缓存"],
  },
  {
    id: "memory",
    name: "记忆",
    icon: "🧠",
    description: "知识图谱持久化记忆（独立于内置记忆）",
    category: "工具",
    command: "npx",
    args: "-y @modelcontextprotocol/server-memory",
    tags: ["记忆", "知识"],
  },
  {
    id: "time",
    name: "时间",
    icon: "🕐",
    description: "获取当前时间、时区转换",
    category: "工具",
    command: "npx",
    args: "-y @modelcontextprotocol/server-time",
    tags: ["时间", "时区"],
  },
  {
    id: "everything",
    name: "Everything 示例",
    icon: "🧪",
    description: "官方示例服务器（用于学习 MCP 协议）",
    category: "工具",
    command: "npx",
    args: "-y @modelcontextprotocol/server-everything",
    tags: ["示例", "教学"],
  },
  {
    id: "brave-search",
    name: "Brave 搜索",
    icon: "🔍",
    description: "Brave Search 联网搜索（需配置 API Key）",
    category: "搜索",
    command: "npx",
    args: "-y @modelcontextprotocol/server-brave-search",
    tags: ["搜索", "API"],
  },
];

/// 市场分类（按顺序展示）
export const MCP_CATEGORIES = ["全部", "系统", "网络", "开发", "数据", "工具", "搜索"];
