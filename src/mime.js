"use strict";

/**
 * 扩展名 -> MIME 映射，以及"这个文件能不能当文本编辑"的判断。
 * 只依赖 Node 内置模块。
 */

const path = require("path");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".xhtml": "application/xhtml+xml; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jfif": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".ogv": "video/ogg",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".epub": "application/epub+zip"
};

const TEXT_EXT = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonc", ".js", ".mjs", ".cjs", ".ts", ".tsx",
  ".jsx", ".css", ".scss", ".sass", ".less", ".html", ".htm", ".xhtml", ".xml", ".svg",
  ".vue", ".svelte", ".py", ".java", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".go",
  ".rs", ".rb", ".php", ".pl", ".lua", ".sh", ".bash", ".zsh", ".bat", ".cmd", ".ps1",
  ".psm1", ".sql", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".properties",
  ".csv", ".tsv", ".log", ".srt", ".vtt", ".tex", ".r", ".kt", ".swift", ".dart",
  ".gradle", ".editorconfig", ".htaccess", ".gitignore", ".gitattributes", ".npmrc",
  ".prettierrc", ".eslintrc", ".makefile", ".dockerignore"
]);

const PLAIN_NAMES = new Set([
  "dockerfile", "makefile", "license", "licence", "readme", "changelog", "notice",
  "hosts", "passwd", "procfile", "gemfile", "rakefile"
]);

function extOf(file) {
  const e = path.extname(String(file == null ? "" : file));
  return e ? e.toLowerCase() : "";
}

function mimeOf(file) {
  return TYPES[extOf(file)] || "application/octet-stream";
}

/** 是否可以用内置文本编辑器打开 */
function isTextFile(file) {
  const base = path.basename(String(file == null ? "" : file)).toLowerCase();
  if (PLAIN_NAMES.has(base)) return true;
  if (base.startsWith(".env")) return true;
  if (base.startsWith(".") && TEXT_EXT.has(base)) return true;
  return TEXT_EXT.has(extOf(file));
}

/**
 * 这些类型如果内联渲染，等于把用户上传的内容放到和后台同一个源上执行，
 * 存在存储型 XSS 风险。预览时统一加 CSP sandbox 把它们隔离到独立源。
 */
function isActiveContent(mime) {
  const m = String(mime || "").toLowerCase();
  return m.indexOf("text/html") === 0 ||
    m.indexOf("application/xhtml") === 0 ||
    m.indexOf("image/svg") === 0 ||
    m.indexOf("application/xml") === 0 ||
    m.indexOf("text/xml") === 0 ||
    m.indexOf("application/javascript") === 0 ||
    m.indexOf("text/javascript") === 0;
}

module.exports = { mimeOf, extOf, isTextFile, isActiveContent, TYPES, TEXT_EXT };