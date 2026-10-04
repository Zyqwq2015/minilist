"use strict";

/**
 * 配置读写。data/config.json 保存端口、投放目标、共享文件夹和口令哈希。
 * 口令用 scrypt + 随机盐，绝不落盘明文。
 *
 * 打包成单个 exe 后，前端文件被塞进只读快照，而 data/ 和 content/ 必须可写，
 * 所以这里把「资源根」和「数据根」分开：
 *   RESOURCE_ROOT / PUBLIC_ROOT —— 只读，public/ 所在位置
 *   DATA_ROOT                   —— 可写，data/ 和 content/ 的父目录
 * 直接跑源码时两者是同一个目录，行为跟以前完全一致。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { normalizeRel } = require("./paths");

function isSea() {
  try {
    // 故意用字符串拼接：让 pkg 之类的打包器静态分析看不到 node:sea，
    // 免得在旧版 Node 基础镜像上被当成"找不到模块"而打包失败。
    const sea = require("node:" + "sea");
    return !!(sea && typeof sea.isSea === "function" && sea.isSea());
  } catch (e) {
    return false;
  }
}

const IS_PACKAGED = !!(process.pkg || isSea());

/** 资源根：必须能找到 public/console.html */
function detectResourceRoot() {
  const fromSource = path.resolve(__dirname, "..");
  const candidates = [fromSource];
  if (IS_PACKAGED) {
    // SEA 不带快照时 __dirname 会落在 exe 目录
    candidates.push(path.dirname(process.execPath));
  }
  for (let i = 0; i < candidates.length; i++) {
    try {
      if (fs.existsSync(path.join(candidates[i], "public", "console.html"))) return candidates[i];
    } catch (e) {
      /* 换下一个 */
    }
  }
  return fromSource;
}

function isWritableDir(dir) {
  const probe = path.join(dir, ".minilist-write-probe-" + process.pid);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, "x");
  } catch (e) {
    return false;
  }
  try {
    fs.unlinkSync(probe);
  } catch (e) {
    /* 能写就行，删不掉不算失败 */
  }
  return true;
}

/** 数据根：优先放在 exe 旁边，不可写时退回 %LOCALAPPDATA%\minilist */
function detectDataRoot() {
  if (!IS_PACKAGED) return detectResourceRoot();
  const exeDir = path.dirname(process.execPath);
  if (isWritableDir(exeDir)) return exeDir;
  const base = process.env.LOCALAPPDATA || process.env.APPDATA || os.tmpdir();
  return path.join(base, "minilist");
}

const RESOURCE_ROOT = detectResourceRoot();
const DATA_ROOT = detectDataRoot();

const APP_ROOT = RESOURCE_ROOT; // 兼容旧用法
const PUBLIC_ROOT = path.join(RESOURCE_ROOT, "public");
const DATA_DIR = path.join(DATA_ROOT, "data");
const CONTENT_DIR = path.join(DATA_ROOT, "content");
const PUBLISH_DIR = path.join(CONTENT_DIR, "published");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

const DEFAULT_PASSWORD = "admin";

const DEFAULTS = {
  host: "0.0.0.0",
  port: 8787,
  sitePort: 8788,
  title: "minilist",
  published: null,
  sharedFolder: "",
  uploadLimitMB: 2048,
  auth: { username: "admin", salt: "", hash: "", mustChange: false }
};

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function scryptHex(password, salt) {
  return crypto
    .scryptSync(Buffer.from(String(password), "utf8"), Buffer.from(String(salt), "utf8"), 64, {
      N: 16384,
      r: 8,
      p: 1,
      maxmem: 128 * 1024 * 1024
    })
    .toString("hex");
}

function newSalt() {
  return crypto.randomBytes(16).toString("hex");
}

function constantEqual(a, b) {
  const ba = Buffer.from(String(a == null ? "" : a), "utf8");
  const bb = Buffer.from(String(b == null ? "" : b), "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function normalizePublished(p) {
  if (!p || typeof p !== "object") return null;
  const root = typeof p.root === "string" ? p.root.trim() : "";
  if (!root || !path.isAbsolute(root)) return null;
  let entry;
  try {
    entry = normalizeRel(p.entry);
  } catch (e) {
    return null;
  }
  if (!entry) return null;
  return {
    root: root,
    entry: entry,
    label: String(p.label || path.basename(entry)).slice(0, 200),
    kind: p.kind === "dir" ? "dir" : "file",
    at: Number(p.at) || 0
  };
}

class ConfigStore {
  constructor(file) {
    this.file = file || CONFIG_FILE;
    this.data = null;
  }

  load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e) {
      raw = null;
    }
    const src = raw && typeof raw === "object" ? raw : {};
    const cfg = Object.assign({}, DEFAULTS, src);
    cfg.auth = Object.assign({}, DEFAULTS.auth, src.auth && typeof src.auth === "object" ? src.auth : {});

    cfg.host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : DEFAULTS.host;
    cfg.port = clampInt(cfg.port, DEFAULTS.port, 1, 65535);
    cfg.sitePort = clampInt(cfg.sitePort, cfg.port === 65535 ? 65534 : cfg.port + 1, 1, 65535);
    cfg.title = String(cfg.title || DEFAULTS.title).slice(0, 60);
    cfg.uploadLimitMB = clampInt(cfg.uploadLimitMB, DEFAULTS.uploadLimitMB, 1, 20480);
    cfg.sharedFolder = typeof cfg.sharedFolder === "string" ? cfg.sharedFolder.trim() : "";
    cfg.published = normalizePublished(cfg.published);
    cfg.auth.username = String(cfg.auth.username || "admin").slice(0, 60) || "admin";

    if (!cfg.auth.salt || !cfg.auth.hash) {
      const salt = newSalt();
      cfg.auth.salt = salt;
      cfg.auth.hash = scryptHex(DEFAULT_PASSWORD, salt);
      cfg.auth.mustChange = true;
    }

    this.data = cfg;
    return cfg;
  }

  save() {
    if (!this.data) return;
    ensureDir(DATA_DIR);
    const tmp = this.file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  /** 重新设置口令；返回是否成功 */
  setPassword(password, username) {
    const pw = String(password == null ? "" : password);
    if (pw.length < 4) {
      const e = new Error("密码至少 4 位");
      e.statusCode = 400;
      throw e;
    }
    if (username) this.data.auth.username = String(username).slice(0, 60);
    const salt = newSalt();
    this.data.auth.salt = salt;
    this.data.auth.hash = scryptHex(pw, salt);
    this.data.auth.mustChange = false;
    this.save();
  }

  /** 用户名 + 口令校验（都是常数时间比较） */
  verify(username, password) {
    const auth = this.data.auth;
    const userOk = constantEqual(username, auth.username);
    const candidate = scryptHex(String(password == null ? "" : password), auth.salt);
    const passOk = constantEqual(candidate, auth.hash);
    return userOk && passOk;
  }
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
}

function ensureAppDirs() {
  ensureDir(DATA_DIR);
  ensureDir(CONTENT_DIR);
  ensureDir(PUBLISH_DIR);
}

module.exports = {
  IS_PACKAGED,
  APP_ROOT,
  RESOURCE_ROOT,
  DATA_ROOT,
  PUBLIC_ROOT,
  DATA_DIR,
  CONTENT_DIR,
  PUBLISH_DIR,
  CONFIG_FILE,
  DEFAULT_PASSWORD,
  DEFAULTS,
  ConfigStore,
  ensureDir,
  ensureAppDirs,
  newSalt,
  scryptHex
};