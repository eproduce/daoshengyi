// 本地文件路径链接化正则（ChatMessage 渲染用，可测试）。
// 注意：扩展名备选必须「长优先」——html?/hpp 在 h 前、cpp 在 c 前，
// 否则正则引擎从左到右匹配会把 .html 截断成 .h、.cpp 截断成 .c，
// 导致链接路径错误（多出错误扩展名）、点击 file_exists 校验失败打不开。
export const LOCAL_FILE_RE = /(?<![\w\/:])((?:~\/|\/)[A-Za-z0-9_@.\/\-\u4e00-\u9fa5]*\/[^ \t\n\r\[\]\(\)"']*\.(?:csv|xlsx?|xlsm|pdf|docx?|txt|md|json|png|jpe?g|gif|webp|bmp|svg|py|js|ts|rs|toml|yaml|ya?ml|xml|log|sh|rb|go|java|cpp|c|hpp|html?|h|css|sql|db|zip|tar\.gz|7z))/gi;
