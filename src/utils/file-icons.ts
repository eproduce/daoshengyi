import type { Component } from "vue";
import {
  FileText, FileSpreadsheet, FileType2, FileCode2, FileArchive,
  FileAudio, FileVideo, FileBox, FileJson, Image, Database, Presentation,
} from "lucide-vue-next";

/**
 * 根据文件名（扩展名）+ MIME 类型返回对应的 lucide 图标组件，
 * 用于附件栏 / 附件卡片按文件类型展示不同图标。
 */
export function fileTypeIcon(name: string, mimeType?: string): Component {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const mime = (mimeType || "").toLowerCase();

  // 图片
  if (mime.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "heic", "avif", "tiff"].includes(ext)) return Image;
  // PDF
  if (mime === "application/pdf" || ext === "pdf") return FileText;
  // 表格（Excel / CSV）
  if (["xls", "xlsx", "xlsm", "csv", "tsv"].includes(ext) || /excel|ms-excel|spreadsheet/.test(mime)) return FileSpreadsheet;
  // Word 文档
  if (["doc", "docx", "wps"].includes(ext) || /word|officedocument\.wordprocessing/.test(mime)) return FileType2;
  // 演示文稿
  if (["ppt", "pptx"].includes(ext) || /presentation|powerpoint/.test(mime)) return Presentation;
  // 压缩包
  if (["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz"].includes(ext)) return FileArchive;
  // 音频
  if (mime.startsWith("audio/") || ["mp3", "wav", "flac", "m4a", "ogg", "aac", "aiff", "mid"].includes(ext)) return FileAudio;
  // 视频
  if (mime.startsWith("video/") || ["mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v"].includes(ext)) return FileVideo;
  // 数据库
  if (["db", "sqlite", "sqlite3"].includes(ext) || /sqlite|database/.test(mime)) return Database;
  // JSON
  if (ext === "json" || mime === "application/json") return FileJson;
  // 代码
  if (["py", "js", "ts", "jsx", "tsx", "rs", "go", "java", "c", "cpp", "h", "hpp", "sh", "bash", "zsh", "html", "htm", "css", "scss", "less", "toml", "yaml", "yml", "xml", "sql", "rb", "php", "swift", "kt", "cs", "vue", "svelte", "ex", "exs"].includes(ext)) return FileCode2;
  // 纯文本 / Markdown / 日志
  if (["txt", "md", "markdown", "log", "text", "rtf"].includes(ext) || mime.startsWith("text/")) return FileText;
  // 其他
  return FileBox;
}
