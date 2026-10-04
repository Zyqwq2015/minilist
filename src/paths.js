"use strict";

/**
 * 路径安全工具。
 *
 * 所有来自浏览器的路径都是"相对于共享根目录"的，必须先经过 normalizeRel
 * 去掉盘符、前导斜杠和 ..，再用 resolveInside 做一次 isInside 兜底校验。
 * Windows 下 path.relative 自带大小写不敏感比较，不会因为盘符大小写误判。
 */

const path = require("path");

function httpError(code, message) {
  const e = new Error(message);
  e.statusCode = code;
  return e;
}

function badPath(message) {
  return httpError(403, message || "非法路径");
}

/** 把用户给的相对路径收敛成 a/b/c 形式；出现 .. 或 : 直接拒绝 */
function normalizeRel(rel) {
  let s = String(rel == null ? "" : rel);
  s = s.replace(/\\/g, "/");
  s = s.replace(/^[a-zA-Z]:/, "");
  s = s.replace(/^\/+/, "");
  const parts = [];
  const segs = s.split("/");
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg || seg === ".") continue;
    if (seg === "..") throw badPath("路径中不允许出现 ..");
    if (seg.indexOf(":") >= 0) throw badPath("路径中不允许出现 :");
    parts.push(seg);
  }
  return parts.join("/");
}

function toAbs(root, cleanRel) {
  if (!cleanRel) return root;
  return path.join(root, cleanRel.split("/").join(path.sep));
}

/** abs 是否落在 root 之内（含 root 本身） */
function isInside(root, abs) {
  const rel = path.relative(root, abs);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  if (rel === "..") return false;
  return rel.slice(0, 3) !== ".." + path.sep;
}

/** 相对路径 -> 绝对路径，并确保没有越界 */
function resolveInside(root, rel) {
  const clean = normalizeRel(rel);
  const abs = toAbs(root, clean);
  if (!isInside(root, abs)) throw badPath();
  return { abs: abs, rel: clean };
}

/** 校验一个新建/上传的"单层名字"，返回绝对路径 */
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function safeChildName(dirAbs, name) {
  const n = String(name == null ? "" : name).trim();
  if (!n || n === "." || n === "..") throw httpError(400, "名称不合法");
  if (/[\\/:*?"<>|]/.test(n)) throw httpError(400, '名称中不能包含 \\ / : * ? " < > |');
  if (/[. ]$/.test(n)) throw httpError(400, "名称不能以点或空格结尾");
  if (n.length > 200) throw httpError(400, "名称过长");
  if (process.platform === "win32" && WIN_RESERVED.test(n)) {
    throw httpError(400, "这是 Windows 保留名称，请换一个");
  }
  return path.join(dirAbs, n);
}

/** 只取最后一段，用于上传文件名 */
function baseName(name) {
  const s = String(name == null ? "" : name).replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  const base = i < 0 ? s : s.slice(i + 1);
  return base.trim();
}

module.exports = {
  httpError,
  badPath,
  normalizeRel,
  toAbs,
  isInside,
  resolveInside,
  safeChildName,
  baseName
};