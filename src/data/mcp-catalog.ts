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
///
/// 收录原则（2026-09-15 收敛，依据 docs/AGENT_DIAGNOSIS_2026-09-15.md 实测数据）：
/// **只收录「内置工具确实没有」的长尾/账号型第三方服务**。与内置能力重叠的服务器
/// 一律下架——两套同名工具（MCP 的 read_file vs 内置 read_file、MCP 的 git vs 内置 git）
/// 会让模型二选一，既浪费工具 schema 预算（MAX_NATIVE_TOOLS，且 MCP 在末尾被静默
/// 截尾），又是参数名错/路由错的高发区（fetch_page 曾被按名字转发给 MCP → Tool not found）。
/// 已下架：文件系统（内置 read_file/write_file/list_dir/… 全套）、Git（内置 git）、
/// SQLite（内置 rusqlite 已在用）、记忆（内置 memory_*）、时间（内置即可）、
/// 浏览器自动化（已内置化，见 browser_* 工具）。
/// 注：用户此前已安装的插件不受影响——不在市场展示，但配置仍保留可继续使用。
export const MCP_CATALOG: McpCatalogItem[] = [
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
