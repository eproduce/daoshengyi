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
const inlineRule = /^(\${1,2})(?!\$)((?:\\.|[^\\\n])*?(?:\\.|[^\\\n\$]))\1(?=[\s?!\.,:：？！。，；、（）、…—–·《》〈〉【】]|$)/;
// 块级：$$\n ... \n$$
const blockRule = /^(\${1,2})\n((?:\\[^]|[^\\])+?)\n\1(?:\n|$)/;

function renderKatex(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, { throwOnError: false, displayMode });
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
