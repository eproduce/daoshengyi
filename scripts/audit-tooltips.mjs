// 开发小工具：审计所有 Vue 组件里的 <button> 是否带 title（悬停提示）。
// 用法：node scripts/audit-tooltips.mjs
// 输出：缺 title 的图标按钮（含 svg 且几乎无文字）清单，便于批量补 title。
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  ...readdirSync(join(root, "src/components"))
    .filter((f) => f.endsWith(".vue"))
    .map((f) => join("src/components", f)),
  join("src/App.vue"),
];

let total = 0;
let iconMiss = 0;
for (const rel of files) {
  const txt = readFileSync(join(root, rel), "utf8").replace(/\r/g, "");
  const re = /<button\b[\s\S]*?<\/button>/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const block = m[0];
    const open = block.slice(0, block.indexOf(">") + 1);
    const hasTitle = /title\s*=\s*["']\S/.test(open) || /\stitle\s*=\s*["']/.test(open);
    total++;
    if (hasTitle) continue;
    const inner = block.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ");
    const text = inner.replace(/[{}\s"'`$().:;|\-/]/g, "");
    const hasSvg = /<svg/.test(block);
    // 纯图标（svg 无文字）或仅 emoji/无实质文字 → 可疑
    if (hasSvg && text.length < 2) {
      iconMiss++;
      const line = txt.slice(0, m.index).split("\n").length;
      console.log(
        `MISS ${rel}:${line} | ${JSON.stringify(text)} | open=${open.replace(/\s+/g, " ").slice(0, 90)}`,
      );
    }
  }
}
console.log(`--- buttons=${total} icon-without-title=${iconMiss}`);
