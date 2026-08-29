// KaTeX 数学公式的 marked 扩展
// 说明：不依赖 marked-katex-extension（该包的类型入口是裸 TS 源码，与项目的
// strict + noUnusedParameters 冲突导致 TS6133），这里用同样的 tokenizer 思路
// 实现一个 ~40 行的小扩展，直接调用 katex。
import katex from "katex";
import type { MarkedExtension, RendererExtension, TokenizerExtension, Tokens } from "marked";

interface KatexToken extends Tokens.Generic {
  type: "inlineKatex" | "blockKatex";
  text: string;
  displayMode: boolean;
}

// 行内 $...$ / $$...$$：要求 $ 前是行首或空格、$ 后是空格/标点（含中文全角标点）/行尾，
// 避免误判货币（如 "$5 和 $10"）。\(...\) 与 \[...\] 已在 md() 预处理中归一化。
// 关键：内容部分也不允许未转义的 $（只能 \\. 转义），否则残缺公式（如 "$H是 $G"）
// 会一路吞掉后续文字（含 ** 加粗、其他公式）当公式解析 → KaTeX 整段报错。
const inlineRule = /^(\${1,2})(?!\$)((?:\\.|[^\\\n\$])*?(?:\\.|[^\\\n\$]))\1(?=[\s?!\.,:：？！。，；、（）、…—–·《》〈〉【】]|$)/;
// 块级：$$\n ... \n$$
const blockRule = /^(\${1,2})\n((?:\\[^]|[^\\])+?)\n\1(?:\n|$)/;

// KaTeX 渲染结果 LRU 缓存（借鉴 Hermes Agent katex-memo 思路）：流式渲染时同一公式会在
// 每个 delta 反复渲染，缓存避免重复执行高开销的 renderToString，仅重渲染真正变化的新公式。
const KATEX_CACHE_LIMIT = 512;
const katexCache = new Map<string, string>();
function renderKatex(tex: string, displayMode: boolean): string {
  const key = `${displayMode ? "b" : "i"}:${tex}`;
  const hit = katexCache.get(key);
  if (hit !== undefined) {
    katexCache.delete(key); // LRU：命中后移到末尾
    katexCache.set(key, hit);
    return hit;
  }
  const html = katex.renderToString(tex, { throwOnError: false, displayMode });
  katexCache.set(key, html);
  if (katexCache.size > KATEX_CACHE_LIMIT) {
    const oldest = katexCache.keys().next().value;
    if (oldest !== undefined) katexCache.delete(oldest);
  }
  return html;
}

const inlineKatex: TokenizerExtension & RendererExtension = {
  name: "inlineKatex",
  level: "inline",
  start(src: string) {
    let indexSrc = src;
    while (indexSrc) {
      const index = indexSrc.indexOf("$");
      if (index === -1) return undefined;
      if (index === 0 || indexSrc.charAt(index - 1) === " ") {
        if (indexSrc.substring(index).match(inlineRule)) return index;
      }
      indexSrc = indexSrc.substring(index + 1).replace(/^\$+/, "");
    }
    return undefined;
  },
  tokenizer(src: string) {
    const match = src.match(inlineRule);
    if (!match) return undefined;
    return {
      type: "inlineKatex",
      raw: match[0],
      text: match[2].trim(),
      displayMode: match[1].length === 2,
    };
  },
  renderer: ((token: KatexToken) => renderKatex(token.text, token.displayMode)) as (token: Tokens.Generic) => string,
};

const blockKatex: TokenizerExtension & RendererExtension = {
  name: "blockKatex",
  level: "block",
  tokenizer(src: string) {
    const match = src.match(blockRule);
    if (!match) return undefined;
    return {
      type: "blockKatex",
      raw: match[0],
      text: match[2].trim(),
      displayMode: match[1].length === 2,
    };
  },
  renderer: ((token: KatexToken) => renderKatex(token.text, token.displayMode) + "\n") as (token: Tokens.Generic) => string,
};

export function katexMarkedExtension(): MarkedExtension {
  return { extensions: [inlineKatex, blockKatex] };
}
