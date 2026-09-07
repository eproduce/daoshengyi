// 自动联网搜索触发门槛（纯函数，可测试）：
// 发送前自动搜索（enableWebSearch 开关）采用**意图正向**判定——默认不自动搜索，
// 仅当消息命中「明确需要实时/外部信息」或「用户显式要求搜索」时才联网；
// 其余（闲聊、纯知识问答、写作/翻译、代码、本地/文档/创作任务等）一律跳过，
// 修复「无论发什么都第一时间去联网搜索」的过度触发问题。

// 本地绝对路径（/Users/... 或 ~/...）
const LOCAL_PATH_RE = /(~\/|\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\-/]+)/;
// 本地文件系统类操作词（配合本地路径判断）
const LOCAL_FS_HINTS =
  /(目录|文件夹|项目|文件|读取|列出|打开|查看|结构|workspace|本地|源码|里面有什么|这个路径)/;
// 文档/附件处理类请求（转表格/生成文档/整理要点/解读证明/翻译/分析附件等）：
// 基于用户已给内容（附件/正文）本地即可完成，不需要联网
const DOC_EDIT =
  /(转成|转为|做成|整理|汇总|提取|解读|编辑|修改|总结|翻译|生成|分析|撰写|润色|起草).{0,12}(表格|文档|excel|word|pdf|md|markdown|清单|要点|报告|格式|证明|截图|文件|图片|附件)/i;
// 本地创作/生图类请求（画/绘制/创作/做图/写文等）：多模态模型本地即可完成，无需联网
const ART_CREATE =
  /(画|绘制|画画|作画|画一幅|画一个|创作|插画|海报|logo|banner|漫画|表情包|配图|示意图|流程图|思维导图|数据图表|做一张|来一张|写一首|写一篇|拟个标题|起个名)/i;
// —— 正向「确实需要联网」的信号 ——
// 实时/时效/外部动态类：命中表示答案依赖当前或外部信息
const WEB_NEED =
  /(新闻|热点|资讯|快讯|突发|最新|实时|行情|股票|股价|汇率|金价|油价|房价|比分|排名|榜单|销量|天气|气温|降雨|台风|地震|疫情|政策|新规|发布|上市|开售|上映|招聘|教程|攻略|多少钱|价格|现状|进展|后续)/;
// 用户显式要求搜索/查证（注意：google/谷歌/必应 单独出现多是“去该网站”，
// 必须搭配 搜/查/一下 等才算搜索意图，避免“跳转到 google 首页”被误判为要搜索）
const EXPLICIT_SEARCH =
  /(搜索|搜一下|搜搜|帮我搜|搜一搜|上网查|查一下|查查|查一查|帮我查|百度一下|百度搜|搜狗搜|(google|谷歌|必应|bing).{0,6}(搜|查|一下)|(用|去|上|在).{0,4}(google|谷歌|必应|百度).{0,4}(搜|查)|找找.{0,4}(资料|信息|网站)|查.{0,4}(新闻|信息|消息|资料|最新))/i;

/** 是否应跳过自动联网搜索（true=不搜索）。 */
export function shouldSkipAutoSearch(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  const hasLocalPath = LOCAL_PATH_RE.test(t);
  const isLocalFs = hasLocalPath && LOCAL_FS_HINTS.test(t);
  const isLocalWordOnly = /(目录|文件夹|本地文件|项目结构|目录结构)/.test(t);
  const isDocEdit = DOC_EDIT.test(t);
  const isArtCreate = ART_CREATE.test(t);
  // 1) 本地/文档/创作任务且**无时效需求** → 跳过（内容已由用户给出，处理本身不需联网）
  const strongLocal = isLocalFs || isLocalWordOnly || isDocEdit || isArtCreate;
  const webNeed = WEB_NEED.test(t) || EXPLICIT_SEARCH.test(t);
  if (strongLocal && !webNeed) return true;
  // 2) 明确需要实时/外部信息或显式要求搜索 → 联网
  if (webNeed) return false;
  // 3) 其余（闲聊 / 纯知识问答 / 写作 / 代码 / 本地文件等）默认不自动搜索
  return true;
}
