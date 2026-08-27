// 自动联网搜索触发门槛（纯函数，可测试）：
// 发送前自动搜索（enableWebSearch 开关）应对哪些消息**跳过**，避免对
// 本地/附件处理类请求联网搜索（如「列出本地目录」「转成清晰表格文档」）。

// 本地文件系统类强提示词
const LOCAL_FS_HINTS = /(目录|文件夹|项目|文件|读取|列出|打开|查看|结构|workspace|本地|源码)/;
// 本地绝对路径（/Users/... 或 ~/...）
const LOCAL_PATH_RE = /(~\/|\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\-/]+)/;
// 明确联网意图词：命中则视为确实需要搜索，不跳过
const WEB_INTENT = /(天气|新闻|股票|汇率|价格|最新|热点|资讯|排名|趋势|行情|政策|招聘|公司|产品|游戏|电影|事件|公告|教程|指南|怎么|如何|是什么|搜索|查询)/;
// 文档/附件处理类请求（转表格/生成文档/整理要点/解读证明/翻译/分析附件等）：
// 基于已给内容（附件/正文）本地即可完成，不需要联网；含明确联网意图词时不跳过
const DOC_EDIT = /(转成|转为|做成|整理|汇总|提取|解读|编辑|修改|总结|翻译|生成|分析).{0,10}(表格|文档|excel|word|pdf|md|清单|要点|报告|格式|证明|截图|文件|图片|附件)/i;
// 本地创作/生图类请求（画/绘制/创作/做图等）：用 HTML/CSS/SVG/代码本地即可完成，
// 无需联网搜索教程/素材（多模态视觉模型可理解画面）；含明确联网意图词（学教程/找参考/查素材）时不跳过
const ART_CREATE = /(画|绘制|画画|作画|画一幅|画一个|创作|插画|海报|logo|banner|漫画|表情包|配图|示意图|流程图|思维导图|数据图表|做一张|来一张|生成.{0,10}(图|图片|图像|插画|海报))/i;

/** 是否应跳过自动联网搜索（true=不搜索）。 */
export function shouldSkipAutoSearch(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const hasLocalPath = LOCAL_PATH_RE.test(t);
  const isLocalFs = hasLocalPath && LOCAL_FS_HINTS.test(t);
  const isLocalWordOnly = /(目录|文件夹|本地文件|项目结构|目录结构)/.test(t) && !WEB_INTENT.test(t);
  const isDocEdit = DOC_EDIT.test(t) && !WEB_INTENT.test(t);
  const isArtCreate = ART_CREATE.test(t) && !WEB_INTENT.test(t);
  return isLocalFs || isLocalWordOnly || isDocEdit || isArtCreate;
}
