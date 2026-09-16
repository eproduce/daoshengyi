/**
 * 危险命令分级判定（吸收自 DSH 生态的 dsh-safety-net / dsh-risk-gate / dsh-perm-guard /
 * commons-guards 的「确定性风险分级」思路）。
 *
 * 与「一张正则清单」的区别：
 * - **分级**：forbidden（绝不执行）/ danger（必须人工确认）/ caution（放行但提示）/ safe；
 * - **解释**：每条命中都带「为什么危险」与「建议替代」，既能让人看懂弹窗，也能让模型学会改法；
 * - **抑制误报**：`rm -rf node_modules`、`rm -rf /tmp/x`、`--force-with-lease` 这类正常操作
 *   不升级为危险（否则用户会被训练成「无脑点同意」，门禁反而失效）；
 * - 纯函数、零依赖、可测试。
 *
 * 注意：这是**语义辅助**，不替代命令执行策略（execpolicy）与会话授权；三者叠加生效。
 */

export type RiskLevel = "safe" | "caution" | "danger" | "forbidden";

export interface RiskVerdict {
  level: RiskLevel;
  ruleId: string;
  title: string;
  reason: string;
  suggestion?: string;
  /** 命中的具体片段（便于弹窗高亮/日志留痕） */
  matched?: string;
}

const SAFE: RiskVerdict = {
  level: "safe",
  ruleId: "none",
  title: "未命中风险规则",
  reason: "",
};

/** rm 的可收割目录：删这些属于日常清理，不该升级为危险 */
const SAFE_RM_PATH =
  /(^|\/)(node_modules|dist|build|out|target|coverage|\.next|\.nuxt|\.cache|\.parcel-cache|\.turbo|__pycache__|\.pytest_cache|\.mypy_cache|\.venv|venv|\.tox|\.gradle|DerivedData|tmp|temp|\.tmp)(\/|$)/i;

const TEMP_PATH = /^(\/tmp\/|\/var\/folders\/|\$TMPDIR|~\/Library\/Caches\/|\.\/?\.cache\/)/;

function rmInvocation(cmd: string): { recursive: boolean; force: boolean; targets: string[] } | null {
  const m = /\brm\b([^|;&\n]*)/.exec(cmd);
  if (!m) return null;
  const tokens = m[1].match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  let recursive = false;
  let force = false;
  const targets: string[] = [];
  for (const raw of tokens) {
    const t = raw.replace(/^["']|["']$/g, "");
    if (t.startsWith("-")) {
      const flags = t.replace(/^-+/, "");
      if (/[rR]/.test(flags)) recursive = true;
      if (/f/.test(flags)) force = true;
      // 分离写法：-r -f
      continue;
    }
    targets.push(t);
  }
  return { recursive, force, targets };
}

interface Rule {
  id: string;
  level: RiskLevel;
  re: RegExp;
  title: string;
  reason: string;
  suggestion?: string;
}

/** 顺序敏感：先 forbidden，再 danger，最后 caution */
const RULES: Rule[] = [
  // ---------- forbidden：绝不执行 ----------
  {
    id: "fork-bomb",
    level: "forbidden",
    re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    title: "fork bomb",
    reason: "它会无限自我复制进程，瞬间耗尽系统资源，机器会卡死到需要强制重启。",
  },
  {
    id: "rm-root",
    level: "forbidden",
    re: /\brm\s+(?:-[a-zA-Z]*\s+)*(?:\/|\/\*|~|~\/|\$HOME|\$\{HOME\})\s*(?:$|[;&|])/,
    title: "删除根目录/家目录",
    reason: "目标包含 / 或 ~ 本身（不是其子目录），会删除系统或用户全部文件。",
    suggestion: "若只想清理，请删除具体子目录，如 rm -rf ./build 或 rm -rf /tmp/xxx。",
  },
  {
    id: "no-preserve-root",
    level: "forbidden",
    re: /--no-preserve-root/,
    title: "--no-preserve-root",
    reason: "显式绕过 rm 对根目录的保护，等同于删除整个系统。",
  },
  {
    id: "mkfs",
    level: "forbidden",
    re: /\bmkfs(\.\w+)?\b/,
    title: "格式化文件系统",
    reason: "mkfs 会重建文件系统，目标分区上的数据将不可恢复。",
  },
  {
    id: "dd-to-device",
    level: "forbidden",
    re: /\bdd\b[^\n]*\bof=\/dev\/(?:disk|rdisk|sd|hd|nvme|vd|mmcblk)\w*/i,
    title: "向块设备直写",
    reason: "dd 直接覆写磁盘设备，会摧毁分区表与全部数据。",
  },
  {
    id: "overwrite-device",
    level: "forbidden",
    re: /(?:>|>>)\s*\/dev\/(?:disk|rdisk|sd|hd|nvme|vd|mmcblk)\w*/,
    title: "重定向覆写块设备",
    reason: "把输出重定向到磁盘设备节点会摧毁该设备上的数据。",
  },
  {
    id: "chmod-root",
    level: "forbidden",
    re: /\bch(?:mod|own)\s+-[a-zA-Z]*R[a-zA-Z]*\s+[^\s]+\s+\/(?:\s|$)/,
    title: "递归改根目录权限/属主",
    reason: "递归修改 / 的权限或属主会让系统文件失去保护，通常直接导致系统无法启动。",
  },
  {
    id: "system-power",
    level: "forbidden",
    // 只放过 `--help`（`shutdown -h now` 的 -h 是「停机」参数，不是帮助）
    re: /\b(?:shutdown|reboot|halt|poweroff)\b(?!\s*--help\b)/,
    title: "关机/重启系统",
    reason: "会中断用户所有工作，且 Agent 无法自行恢复。",
    suggestion: "需要重启服务时，请只重启该服务的进程。",
  },
  {
    id: "disk-erase",
    level: "forbidden",
    re: /\bdiskutil\s+(?:eraseDisk|eraseVolume|reformat|zeroDisk)\b|\bformat\s+[a-z]:/i,
    title: "擦除磁盘/分区",
    reason: "擦除操作不可逆，会清空整个磁盘或分区。",
  },
  {
    id: "windows-force-format",
    level: "forbidden",
    re: /\b(?:rd|rmdir)\s+\/s\s+\/q\s+[a-z]:\\?(?:\s|$)/i,
    title: "递归删除盘符根目录",
    reason: "rd /s /q 针对盘符根目录会删除整盘数据。",
  },

  // ---------- danger：必须人工确认 ----------
  {
    id: "git-force-push",
    level: "danger",
    re: /\bgit\s+push\b[^\n]*\s(?:--force|-f)(?:\s|$)/,
    title: "强制推送（覆盖远端历史）",
    reason: "强推会覆盖远端提交，他人已拉取的提交可能永久丢失。",
    suggestion: "优先用 --force-with-lease；若只是自己的临时分支，也请先确认无协作者。",
  },
  {
    id: "git-destructive",
    level: "danger",
    re: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*[fdx]|checkout\s+--\s+\.|branch\s+-D|stash\s+(?:drop|clear)|rebase\s+--root)/,
    title: "Git 破坏性操作",
    reason: "会丢弃工作区/暂存区改动或删除分支，未提交的内容无法找回。",
    suggestion: "先 git stash 或 git branch 备份，再执行。",
  },
  {
    id: "privilege-escalation",
    level: "danger",
    re: /\b(?:sudo|doas)\b/,
    title: "提权执行",
    reason: "以管理员权限执行，命令的影响范围超出当前用户。",
    suggestion: "多数情况不需要 sudo；请说明为何必须提权。",
  },
  {
    id: "remote-script-exec",
    level: "danger",
    re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b/,
    title: "下载并直接执行远程脚本",
    reason: "执行的是网络上的可变内容，无法审计，可能包含任意恶意指令。",
    suggestion: "先下载到文件、人工看过内容，再执行。",
  },
  {
    id: "rm-recursive",
    level: "danger",
    re: /\brm\b/, // 二次判定（见 assessCommandRisk：仅递归删除非安全目录才升级）
    title: "递归强制删除",
    reason: "递归删除不可逆，路径写错就会丢掉源码或用户数据。",
    suggestion: "先 ls 确认目录内容；考虑先移到废纸篓/备份目录。",
  },
  {
    id: "rsync-delete",
    level: "danger",
    re: /\brsync\b[^\n]*--delete\b/,
    title: "rsync --delete",
    reason: "会把目标端中源端不存在的文件删除（常见于写错源/目标顺序）。",
  },
  {
    id: "kill-all",
    level: "danger",
    re: /\b(?:killall|pkill)\b[^\n]*|\bkill\b[^\n]*-9[^\n]*\b-1\b/,
    title: "批量结束进程",
    reason: "可能连带杀掉用户未保存工作的应用或系统进程。",
  },
  {
    id: "sql-destructive",
    level: "danger",
    re: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*;)/i,
    title: "数据库破坏性语句",
    reason: "会删除表结构或全表数据。",
    suggestion: "改用带 WHERE 的 DELETE，并先 SELECT 确认影响行数。",
  },
  {
    id: "npm-publish",
    level: "danger",
    re: /\b(?:npm|cargo|pnpm|yarn)\s+publish\b/,
    title: "发布到公共仓库",
    reason: "发布通常不可撤销（npm 包名会被占用/版本号不可复用）。",
  },
  {
    id: "ssh-credential-delete",
    level: "danger",
    re: /\brm\b[^\n]*\s(?:~|\$HOME)?\/?\.ssh\b|\bhistory\s+-c\b/,
    title: "删除 SSH 凭据/清空历史",
    reason: "会破坏用户的登录能力或抹掉可审计痕迹。",
  },
  {
    id: "truncate-dev",
    level: "danger",
    re: /(?:\/usr\/sbin\/)?\btruncate\b[^\n]*-s\s*0|[>|]\s*\/dev\/(?:null|zero)\b[^\n]*\b(?:of|>)\s*\/dev\/(?:disk|sd|nvme)/,
    title: "截断/误写设备",
    reason: "把文件截断为 0 字节会直接丢掉内容。",
  },

  // ---------- caution：放行但提示 ----------
  {
    id: "force-with-lease",
    level: "caution",
    re: /\bgit\s+push\b[^\n]*--force-with-lease\b/,
    title: "带租约的强推",
    reason: "比 --force 安全（若远端有新提交会被拒绝），仍会改写远端历史。",
  },
  {
    id: "npm-global-install",
    level: "caution",
    re: /\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\s+(?:-g|--global)\b/,
    title: "全局安装包",
    reason: "会修改全局环境，可能与其他项目的版本冲突。",
  },
  {
    id: "chmod-777",
    level: "caution",
    re: /\bchmod\s+(?:-[a-zA-Z]*\s+)*7?77\b/,
    title: "放宽权限到 777",
    reason: "任何用户都可读写执行，存在安全风险。",
    suggestion: "按最小权限设置，如 755（目录）/644（文件）。",
  },
  {
    id: "pip-system-install",
    level: "caution",
    re: /\bpip3?\s+install\b(?![^\n]*--user)/,
    title: "安装 Python 包（未指定 --user）",
    reason: "可能写入系统环境，建议用虚拟环境或加 --user。",
  },
  {
    id: "dd-generic",
    level: "caution",
    re: /\bdd\b[^\n]*\bof=/,
    title: "dd 写盘",
    reason: "dd 不会二次确认，且参数顺序写反就会毁掉目标。",
  },
  {
    id: "mv-bulk",
    level: "caution",
    re: /\bmv\b[^\n]*\s(?:\/|\*)[^\n]*/,
    title: "批量移动文件",
    reason: "批量 mv 若目标路径写错，排查成本高。",
  },
];

function pickLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  const order: RiskLevel[] = ["safe", "caution", "danger", "forbidden"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

/** 规则 → 判定结果（字段名不同：规则用 id，结果用 ruleId） */
function toVerdict(rule: Rule, matched: string): RiskVerdict {
  return {
    level: rule.level,
    ruleId: rule.id,
    title: rule.title,
    reason: rule.reason,
    suggestion: rule.suggestion,
    matched,
  };
}

/**
 * 判定一条 shell 命令的风险等级。
 * 关键设计：`rm` 单独二次判定 —— 只有「递归且目标不在安全目录内」才升级为 danger，
 * 避免把 `rm -rf node_modules` 这类日常清理也拦成危险（那会让审批疲劳、门禁失效）。
 */
export function assessCommandRisk(command: string): RiskVerdict {
  const cmd = String(command ?? "").trim();
  if (!cmd) return SAFE;

  let verdict: RiskVerdict = SAFE;
  const remember = (v: RiskVerdict) => {
    if (pickLevel(v.level, verdict.level) === v.level) verdict = v;
  };

  for (const rule of RULES) {
    const m = rule.re.exec(cmd);
    if (!m) continue;

    if (rule.id === "rm-recursive") {
      const inv = rmInvocation(cmd);
      if (!inv || !inv.recursive || inv.targets.length === 0) continue;
      const allSafe = inv.targets.every(
        (t) => SAFE_RM_PATH.test(t) || TEMP_PATH.test(t) || /^\.\/(dist|build|out|target|tmp)/.test(t),
      );
      if (allSafe) {
        remember({
          level: "caution",
          ruleId: "rm-build-artifacts",
          title: "清理可再生成的目录",
          reason: "递归删除的是构建/依赖产物目录（可重新生成），确认路径无误即可。",
          matched: inv.targets.join(" "),
        });
      } else {
        remember(toVerdict(rule, m[0]));
      }
      continue;
    }

    remember(toVerdict(rule, m[0]));
  }

  return verdict;
}

/** 兼容旧接口：是否需要人工确认（danger / forbidden） */
export function isRiskyCommand(command: string): boolean {
  const v = assessCommandRisk(command);
  return v.level === "danger" || v.level === "forbidden";
}

/** 面向模型的一段拒绝/警示说明（含原因与替代建议） */
export function describeRisk(v: RiskVerdict, command: string): string {
  if (v.level === "safe") return "";
  const head =
    v.level === "forbidden"
      ? `⛔ 该命令被安全门禁**禁止执行**（风险项：${v.title}）`
      : `⚠️ 该命令属于**高风险操作**（风险项：${v.title}）`;
  const lines = [`${head}：$ ${command}`, `原因：${v.reason}`];
  if (v.suggestion) lines.push(`建议：${v.suggestion}`);
  return lines.join("\n");
}
