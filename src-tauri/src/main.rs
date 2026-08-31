fn main() {
    // MCP 服务器模式：`daoshengyi --mcp-server` 时以 stdio MCP server 运行（供 Claude Desktop 等接入）
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--mcp-server") {
        std::process::exit(daoshengyi_lib::run_mcp_server());
    }
    // S6 非交互执行：`daoshengyi --exec "<提示词>" [--json]`（供脚本/CI 复用引擎能力）
    if args.iter().any(|a| a == "--exec") {
        std::process::exit(daoshengyi_lib::run_exec(args));
    }
    daoshengyi_lib::run()
}
