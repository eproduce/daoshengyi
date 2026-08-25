/// MCP 插件市场目录项
export interface McpCatalogItem {
  id: string;
  name: string;
  icon: string;
  description: string;
  category: string;
  command: string;
  args: string;
  /** 透传给 MCP server 进程的环境变量（如 Puppeteer 指定本机浏览器） */
  env?: Record<string, string>;
  tags: string[];
}

/// 内置 MCP 插件市场（常用官方服务器）
export const MCP_CATALOG: McpCatalogItem[] = [
  {
    id: "filesystem",
    name: "文件系统",
    icon: "Folder",
    description: "读写本地文件、浏览目录、搜索文件",
    category: "系统",
    command: "npx",
    args: "-y @modelcontextprotocol/server-filesystem /tmp",
    tags: ["文件", "本地"],
  },
  {
    id: "puppeteer",
    name: "浏览器自动化",
    icon: "Globe",
    description: "网页交互、点击、截图（Puppeteer，默认用本机 Edge 内核）",
    category: "网络",
    command: "npx",
    args: "-y @modelcontextprotocol/server-puppeteer",
    env: {
      // server-puppeteer 需要 Chrome/Chromium；puppeteer 缓存的旧版 Chrome for
      // Testing 在较新 macOS（如 26）上会被系统 SIGKILL（spawn error -88），
      // 故默认指定本机 Microsoft Edge（Chromium 内核）。可自行改路径。
      PUPPETEER_EXECUTABLE_PATH: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      // 默认视口只有 800x600，窗口放大后页面只占窗口一部分。
      // PUPPETEER_LAUNCH_OPTIONS 是 JSON，传给 puppeteer.launch()：把页面视口
      // 与 Edge 窗口大小设成一致，让页面占满窗口。可自行调整尺寸。
      PUPPETEER_LAUNCH_OPTIONS: '{"defaultViewport":{"width":1440,"height":900},"args":["--window-size=1440,900"]}',
    },
    tags: ["浏览器", "自动化"],
  },
  {
    id: "git",
    name: "Git",
    icon: "GitBranch",
    description: "Git 仓库操作、提交、diff、日志",
    category: "开发",
    command: "npx",
    args: "-y @modelcontextprotocol/server-git",
    tags: ["git", "版本控制"],
  },
  {
    id: "github",
    name: "GitHub",
    icon: "Github",
    description: "GitHub 仓库、Issue、PR 操作",
    category: "开发",
    command: "npx",
    args: "-y @modelcontextprotocol/server-github",
    tags: ["github", "仓库"],
  },
  {
    id: "sqlite",
    name: "SQLite",
    icon: "Database",
    description: "SQLite 数据库查询与分析",
    category: "数据",
    command: "npx",
    args: "-y @modelcontextprotocol/server-sqlite /tmp/daoshengyi.db",
    tags: ["数据库", "SQL"],
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    icon: "Server",
    description: "Postgres 数据库查询（需修改连接串）",
    category: "数据",
    command: "npx",
    args: "-y @modelcontextprotocol/server-postgres postgresql://localhost/mydb",
    tags: ["数据库", "SQL"],
  },
  {
    id: "redis",
    name: "Redis",
    icon: "CircleDot",
    description: "Redis 键值读写与命令执行",
    category: "数据",
    command: "npx",
    args: "-y @modelcontextprotocol/server-redis",
    tags: ["redis", "缓存"],
  },
  {
    id: "memory",
    name: "记忆",
    icon: "Brain",
    description: "知识图谱持久化记忆（独立于内置记忆）",
    category: "工具",
    command: "npx",
    args: "-y @modelcontextprotocol/server-memory",
    tags: ["记忆", "知识"],
  },
  {
    id: "time",
    name: "时间",
    icon: "Clock",
    description: "获取当前时间、时区转换",
    category: "工具",
    command: "npx",
    args: "-y @modelcontextprotocol/server-time",
    tags: ["时间", "时区"],
  },
  {
    id: "everything",
    name: "Everything 示例",
    icon: "FlaskConical",
    description: "官方示例服务器（用于学习 MCP 协议）",
    category: "工具",
    command: "npx",
    args: "-y @modelcontextprotocol/server-everything",
    tags: ["示例", "教学"],
  },
];

/// 市场分类（按顺序展示）
export const MCP_CATEGORIES = ["全部", "系统", "网络", "开发", "数据", "工具", "搜索"];
