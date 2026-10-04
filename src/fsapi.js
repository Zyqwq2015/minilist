"use strict";

/**
 * 共享文件夹内的文件操作。
 * 所有函数都先做"相对路径 -> 绝对路径 + 越界检查"，再对已存在的路径做
 * realpath 校验，避免通过符号链接跳出共享根。
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const { resolveInside, safeChildName, baseName, isInside, httpError } = require("./paths");
const { isTextFile } = require("./mime");
const { LIMIT_FILES, LIMIT_BYTES } = require("./zip");

const MAX_TEXT_BYTES = 4 * 1024 * 1024;

const realRootCache = new Map();

function resetRootCache() {
  realRootCache.clear();
}

async function realRootOf(root) {
  if (realRootCache.has(root)) return realRootCache.get(root);
  let real;
  try {
    real = await fsp.realpath(root);
  } catch (e) {
    throw httpError(404, "共享文件夹不存在或无法访问：" + root);
  }
  realRootCache.set(root, real);
  return real;
}

async function assertInsideReal(realRoot, abs) {
  let real;
  try {
    real = await fsp.realpath(abs);
  } catch (e) {
    if (e.code === "ENOENT") throw httpError(404, "文件或文件夹不存在");
    if (e.code === "EPERM" || e.code === "EACCES") throw httpError(403, "没有权限访问该位置");
    throw e;
  }
  if (!isInside(realRoot, real)) throw httpError(403, "该位置超出了共享范围");
  return real;
}

/* --------------------------- 目录与文件信息 --------------------------- */

async function listDir(root, rel) {
  const target = resolveInside(root, rel);
  const realRoot = await realRootOf(root);
  await assertInsideReal(realRoot, target.abs);

  const st = await fsp.stat(target.abs);
  if (!st.isDirectory()) throw httpError(400, "这不是一个文件夹");

  const dirents = await fsp.readdir(target.abs, { withFileTypes: true });
  const items = [];
  for (let i = 0; i < dirents.length; i++) {
    const d = dirents[i];
    const abs = path.join(target.abs, d.name);
    let lst;
    try {
      lst = await fsp.lstat(abs);
    } catch (e) {
      continue;
    }
    let isDir = lst.isDirectory();
    const isLink = lst.isSymbolicLink();
    if (isLink) {
      try {
        const s2 = await fsp.stat(abs);
        isDir = s2.isDirectory();
      } catch (e) {
        isDir = false;
      }
    }
    items.push({
      name: d.name,
      isDir: isDir,
      isLink: isLink,
      editable: !isDir && isTextFile(d.name),
      size: isDir ? 0 : lst.size,
      mtime: lst.mtimeMs
    });
  }

  items.sort(function (a, b) {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
  });

  let parent = null;
  if (target.rel) {
    const idx = target.rel.lastIndexOf("/");
    parent = idx < 0 ? "" : target.rel.slice(0, idx);
  }

  return { path: target.rel, parent: parent, items: items };
}

async function statOne(root, rel) {
  const target = resolveInside(root, rel);
  const realRoot = await realRootOf(root);
  const real = await assertInsideReal(realRoot, target.abs);
  const st = await fsp.stat(real);
  return { abs: real, rel: target.rel, stat: st, name: path.basename(real) };
}

/* --------------------------- 文本读写 --------------------------- */

function decodeText(buf) {
  if (buf.length === 0) return { text: "", encoding: "utf-8", binary: false };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(buf.slice(2)), encoding: "utf-16le", binary: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(buf.slice(2)), encoding: "utf-16be", binary: false };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.slice(3).toString("utf8"), encoding: "utf-8", binary: false };
  }
  const sample = buf.slice(0, Math.min(buf.length, 8192));
  if (sample.indexOf(0) >= 0) return { text: "", encoding: "binary", binary: true };

  const utf8 = buf.toString("utf8");
  if (utf8.indexOf("\ufffd") < 0) return { text: utf8, encoding: "utf-8", binary: false };

  try {
    const gbk = new TextDecoder("gbk").decode(buf);
    if (gbk.indexOf("\ufffd") < 0) return { text: gbk, encoding: "gbk", binary: false };
  } catch (e) {
    /* 这个 Node 没带 GBK 解码器 */
  }
  return { text: utf8, encoding: "utf-8", binary: false };
}

async function readTextFile(root, rel, maxBytes) {
  const limit = maxBytes && maxBytes > 0 ? maxBytes : MAX_TEXT_BYTES;
  const info = await statOne(root, rel);
  if (info.stat.isDirectory()) throw httpError(400, "这是文件夹，不能当文本编辑");
  if (info.stat.size > limit) {
    throw httpError(413, "文件超过 " + Math.round(limit / 1048576) + " MB，无法在线编辑，请下载后修改");
  }
  const buf = await fsp.readFile(info.abs);
  const decoded = decodeText(buf);
  return {
    path: info.rel,
    name: info.name,
    size: info.stat.size,
    mtime: info.stat.mtimeMs,
    text: decoded.text,
    encoding: decoded.encoding,
    binary: decoded.binary
  };
}

async function writeTextFile(root, rel, text) {
  const info = await statOne(root, rel);
  if (info.stat.isDirectory()) throw httpError(400, "这是文件夹");
  let body = String(text == null ? "" : text);
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
  await fsp.writeFile(info.abs, Buffer.from(body, "utf8"));
  const st = await fsp.stat(info.abs);
  return { path: info.rel, name: info.name, size: st.size, mtime: st.mtimeMs };
}

async function createFile(root, rel, name, text) {
  const target = resolveInside(root, rel);
  const realRoot = await realRootOf(root);
  await assertInsideReal(realRoot, target.abs);
  const dest = safeChildName(target.abs, name);
  const exists = await fsp.stat(dest).then(function () { return true; }).catch(function () { return false; });
  if (exists) throw httpError(409, "同名文件已存在");
  const body = String(text == null ? "" : text);
  await fsp.writeFile(dest, Buffer.from(body, "utf8"));
  return { path: target.rel ? target.rel + "/" + path.basename(dest) : path.basename(dest) };
}

/* --------------------------- 目录操作 --------------------------- */

async function makeDir(root, rel, name) {
  const target = resolveInside(root, rel);
  const realRoot = await realRootOf(root);
  await assertInsideReal(realRoot, target.abs);
  const dest = safeChildName(target.abs, name);
  const exists = await fsp.stat(dest).then(function () { return true; }).catch(function () { return false; });
  if (exists) throw httpError(409, "同名文件或文件夹已存在");
  await fsp.mkdir(dest, { recursive: false });
  return { path: target.rel ? target.rel + "/" + path.basename(dest) : path.basename(dest) };
}

async function renameEntry(root, fromRel, toRel) {
  const realRoot = await realRootOf(root);
  const from = resolveInside(root, fromRel);
  const to = resolveInside(root, toRel);
  await assertInsideReal(realRoot, from.abs);

  if (from.abs === to.abs) return { from: from.rel, to: to.rel };

  // 只有"文件夹"才需要检查是否被移动到自己内部（文件路径做 isInside 会误判）
  const fromStat = await fsp.stat(from.abs);
  if (fromStat.isDirectory() && isInside(from.abs, to.abs)) {
    throw httpError(400, "不能把文件夹移动到它自己里面");
  }

  const parent = path.dirname(to.abs);
  let pst = null;
  try {
    pst = await fsp.stat(parent);
  } catch (e) {
    pst = null;
  }
  if (!pst || !pst.isDirectory()) throw httpError(404, "目标文件夹不存在");
  await assertInsideReal(realRoot, parent);

  const clash = await fsp.stat(to.abs).then(function () { return true; }).catch(function () { return false; });
  if (clash) throw httpError(409, "目标已存在：" + path.basename(to.abs));

  await fsp.rename(from.abs, to.abs);
  return { from: from.rel, to: to.rel };
}

async function removeEntries(root, rels) {
  const realRoot = await realRootOf(root);
  const removed = [];
  const missing = [];
  const list = Array.isArray(rels) ? rels : [];
  for (let i = 0; i < list.length; i++) {
    const target = resolveInside(root, list[i]);
    if (target.abs === root) throw httpError(400, "不能删除共享根目录");
    try {
      await assertInsideReal(realRoot, target.abs);
    } catch (e) {
      if (e.statusCode === 404) {
        missing.push(target.rel);
        continue;
      }
      throw e;
    }
    await fsp.rm(target.abs, { recursive: true, force: true });
    removed.push(target.rel);
  }
  return { removed: removed, missing: missing };
}

/* --------------------------- 上传 --------------------------- */

async function saveUploads(root, rel, entries, overwrite) {
  const target = resolveInside(root, rel);
  const realRoot = await realRootOf(root);
  await assertInsideReal(realRoot, target.abs);
  const st = await fsp.stat(target.abs);
  if (!st.isDirectory()) throw httpError(400, "上传目标不是文件夹");

  const saved = [];
  const skipped = [];
  const failed = [];
  const list = Array.isArray(entries) ? entries : [];
  const allowOverwrite = overwrite !== false;

  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (!entry || !entry.filename) continue;
    const base = baseName(entry.filename);
    if (!base) continue;

    let dest;
    try {
      dest = safeChildName(target.abs, base);
    } catch (e) {
      // 单个文件名不合法不应该让整批上传失败
      failed.push(base);
      continue;
    }

    if (!allowOverwrite) {
      const exists = await fsp.stat(dest).then(function () { return true; }).catch(function () { return false; });
      if (exists) {
        skipped.push(base);
        continue;
      }
    }
    await fsp.writeFile(dest, entry.data);
    saved.push({ name: base, size: entry.data.length });
  }
  return { path: target.rel, saved: saved, skipped: skipped, failed: failed };
}

/* --------------------------- 打包下载 --------------------------- */

async function collectForZip(root, rel, names) {
  const base = resolveInside(root, rel);
  const realRoot = await realRootOf(root);
  await assertInsideReal(realRoot, base.abs);

  const entries = [];
  let totalBytes = 0;

  async function walk(abs, zipName, depth) {
    if (depth > 40) return;
    let st;
    try {
      st = await fsp.lstat(abs);
    } catch (e) {
      return;
    }
    if (st.isSymbolicLink()) return; // 不跟随，避免跳出共享根
    if (st.isDirectory()) {
      entries.push({ name: zipName + "/", data: Buffer.alloc(0), mtime: st.mtime, dir: true });
      if (entries.length > LIMIT_FILES) throw httpError(413, "文件数量过多，请分批打包");
      const children = await fsp.readdir(abs);
      for (let i = 0; i < children.length; i++) {
        await walk(path.join(abs, children[i]), zipName + "/" + children[i], depth + 1);
      }
      return;
    }
    if (!st.isFile()) return;
    const data = await fsp.readFile(abs);
    totalBytes += data.length;
    if (totalBytes > LIMIT_BYTES) throw httpError(413, "打包内容超过 2GB，请分批下载");
    entries.push({ name: zipName, data: data, mtime: st.mtime, dir: false });
  }

  const requested = Array.isArray(names) ? names : [];
  const picked = requested.length ? requested : null;

  if (!picked) {
    const children = await fsp.readdir(base.abs);
    for (let i = 0; i < children.length; i++) {
      await walk(path.join(base.abs, children[i]), children[i], 0);
    }
    return { entries: entries, name: (base.rel ? path.basename(base.rel) : "minilist") + ".zip", base: base.rel };
  }

  for (let i = 0; i < picked.length; i++) {
    const child = resolveInside(root, base.rel ? base.rel + "/" + picked[i] : picked[i]);
    const st = await fsp.lstat(child.abs).catch(function () { return null; });
    if (!st) continue;
    await walk(child.abs, path.basename(child.abs), 0);
  }
  const zipName = picked.length === 1 ? picked[0].replace(/\.[^.]+$/, "") + ".zip" : "minilist-selection.zip";
  return { entries: entries, name: zipName, base: base.rel };
}

module.exports = {
  MAX_TEXT_BYTES,
  resetRootCache,
  realRootOf,
  listDir,
  statOne,
  decodeText,
  readTextFile,
  writeTextFile,
  createFile,
  makeDir,
  renameEntry,
  removeEntries,
  saveUploads,
  collectForZip
};