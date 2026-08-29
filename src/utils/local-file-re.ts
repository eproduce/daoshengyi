// 本地文件路径链接化正则（ChatMessage 渲染用，可测试）。
// 注意：扩展名备选必须「长优先」——html?/hpp 在 h 前、cpp 在 c 前，
// 否则正则引擎从左到右匹配会把 .html 截断成 .h、.cpp 截断成 .c，
// 导致链接路径错误（多出错误扩展名）、点击 file_exists 校验失败打不开。
// 注意：⚠️ 不能用 lookbehind（(?<!...)）排除 URL 前导 —— WKWebView/Safari 旧内核
// 不支持 ES2018 lookbehind，模块加载直接抛 SyntaxError 白屏。改为「前缀捕获组」：
//   - group 1 = 前导字符（路径在行首时为 `^` 空串；否则为前导的非 [\w/:] 字符）
//   - group 2 = 路径本身
// 调用方取 m[2]，路径起点 = m.index + m[1].length。
export const LOCAL_FILE_RE = /(^|[^\w\/:])((?:~\/|\/)[A-Za-z0-9_@.\/\-\u4e00-\u9fa5]*\/[^ \t\n\r\[\]\(\)"']*\.(?:csv|xlsx?|xlsm|pdf|docx?|txt|md|json|png|jpe?g|gif|webp|bmp|svg|py|js|ts|rs|toml|yaml|ya?ml|xml|log|sh|rb|go|java|cpp|c|hpp|html?|h|css|sql|db|zip|tar\.gz|7z))/gi;
