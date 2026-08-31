// S2 项目指令发现（Codex 能力整合）：从工作区/项目目录向上递归查找「项目指令文件」
// （AGENTS.md 优先，其次 道生一.md），把项目级约定（编码规范/测试命令/目录说明）注入对话上下文。
// 机制参考 OpenAI Codex 的 AGENTS.md spec：文件可出现在仓库任意层级，就近优先。
//
// 纯函数部分（candidateInstructionPaths）可脱离 Tauri 单测；IO 部分在 chat.ts 注入时调用，
// 5s 超时兜底，不阻塞主对话。

import { invoke } from "@tauri-apps/api/core";

export const PROJECT_INSTRUCTION_MAX_BYTES = 8000;

export interface ProjectInstructions {
  path: string;
  content: string;
}

const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "道生一.md"];

/** 纯函数：从 cwd 向上生成候选指令文件路径（每层 AGENTS.md 优先于 道生一.md，最近目录优先）。 */
export function candidateInstructionPaths(cwd: string): string[] {
  const out: string[] = [];
  let dir = (cwd || "").replace(/\/+$/, "");
  for (let depth = 0; depth < 8 && dir; depth++) {
    for (const name of INSTRUCTION_FILE_NAMES) out.push(`${dir}/${name}`);
    const idx = dir.lastIndexOf("/");
    if (idx <= 0) break;
    dir = dir.slice(0, idx);
  }
  return out;
}

/** 读取第一个真实存在且非空的项目指令文件；全部不可用返回 null。 */
export async function discoverProjectInstructions(
  cwd: string,
): Promise<ProjectInstructions | null> {
  for (const path of candidateInstructionPaths(cwd)) {
    try {
      const exists = await invoke<boolean>("file_exists", { path });
      if (!exists) continue;
      const content = await invoke<string>("read_file", { path });
      if (!content.trim()) continue;
      return {
        path,
        content:
          content.length > PROJECT_INSTRUCTION_MAX_BYTES
            ? content.slice(0, PROJECT_INSTRUCTION_MAX_BYTES)
            : content,
      };
    } catch {
      /* 该文件不可读则尝试下一个候选 */
    }
  }
  return null;
}
