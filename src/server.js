"use strict";

/**
 * minilist HTTP 服务
 *
 * 两个监听端口：
 *   - 控制台端口：/admin/ 控制台、/files/ 文件浏览、/api/* 接口（只读接口匿名可用，写接口必须登录 + CSRF）
 *   - 投放端口  ：只读地把选中的 HTML（及其同目录静态资源）发布到局域网
 *
 * 分开两个端口是为了做真正的源隔离：被投放的网页无法读取控制台接口的响应，
 * 也拿不到写操作需要的 CSRF 令牌。
 */

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const { mimeOf, isActiveContent } = require("./mime");
const { normalizeRel, resolveInside, isInside, baseName, httpError } = require("./paths");
const { readBody, parseMultipart } = require("./multipart");
const { makeZip } = require("./zip");
const fsa = require("./fsapi");
const dialog = require("./dialog");
const netinfo = require("./net");
const sessions = require("./auth");
const cfgmod = require("./config");

const VERSION = "1.0.0";

const PUBLIC_DIR = cfgmod.PUBLIC_ROOT;

const PREVIEW_CSP = [
  "sandbox allow-scripts allow-popups allow-modals",
  "default-src 'none'",
  "img-src 'self' data: blob: *",
  "media-src 'self' data: blob: *",
  "style-src 'unsafe-inline' *",
  "script-src 'unsafe-inline' *",
  "font-src 'self' data: *",
  "connect-src 'none'",
  "form-action 'none'"
].join("; ");

const STATIC_MAP = {
  "/admin": "console.html",
  "/admin/": "console.html",
  "/admin/console.css": "console.css",
  "/admin/console.js": "console.js",
  "/files": "browse.html",
  "/files/": "browse.html",
  "/files/browse.css": "browse.css",
  "/files/browse.js": "browse.js",
  "/__ml/base.css": "base.css",
  "/__ml/ui.js": "ui.js",
  "/__ml/favicon.svg": "favicon.svg",
  "/__ml/logo.svg": "logo.svg"
};

/* ------------------------------ 小工具 ------------------------------ */

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function clientIP(req) {
  const addr = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
  return addr || "unknown";
}

/** 客户端中途断开时 socket 会报错，这里吞掉，避免变成未捕获异常 */
function ignoreError() {
  /* ignore */
}

function contentDisposition(name, inline) {
  const raw = String(name == null ? "" : name);
  const ascii = raw.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  const head = inline ? "inline" : "attachment";
  return head + '; filename="' + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(raw);
}

function sendJSON(res, status, obj, extraHeaders) {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const headers = Object.assign(
    {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    },
    extraHeaders || {}
  );
  try {
    res.writeHead(status, headers);
    res.end(body);
  } catch (e) {
    try {
      res.destroy();
    } catch (e2) {
      /* ignore */
    }
  }
}

function sendError(res, status, message) {
  if (res.headersSent) {
    try {
      res.destroy();
    } catch (e) {
      /* ignore */
    }
    return;
  }
  sendJSON(res, status, { error: message });
}

function sendPlain(res, status, text) {
  if (res.headersSent || res.writableEnded) return;
  const body = Buffer.from(String(text), "utf8");
  try {
    res.writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": body.length,
      "Cache-Control": "no-store"
    });
    res.end(body);
  } catch (e) {
    try {
      res.destroy();
    } catch (e2) {
      /* ignore */
    }
  }
}

function handleError(res, err) {
  const status = err && err.statusCode ? err.statusCode : 500;
  if (status >= 500) {
    console.error("[minilist] " + (err && err.stack ? err.stack : err));
  }
  sendError(res, status, status >= 500 ? "服务器错误：" + (err && err.message ? err.message : "未知错误") : err.message || "请求失败");
}

async function readJSON(req, limit) {
  const buf = await readBody(req, limit || 2 * 1024 * 1024);
  if (!buf.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch (e) {
    throw httpError(400, "请求体不是合法 JSON");
  }
  return parsed && typeof parsed === "object" ? parsed : {};
}

/** 支持 Range 的文件下发 */
async function serveFileRange(req, res, abs, opts) {
  const options = opts || {};
  let st;
  try {
    st = await fsp.stat(abs);
  } catch (e) {
    return sendPlain(res, 404, "404 Not Found");
  }
  if (!st.isFile()) return sendPlain(res, 404, "404 Not Found");

  const headers = {
    "Content-Type": mimeOf(abs),
    "Last-Modified": st.mtime.toUTCString(),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff"
  };

  const name = path.basename(abs);
  if (options.disposition === "attachment") headers["Content-Disposition"] = contentDisposition(name, false);
  else if (options.disposition === "inline") headers["Content-Disposition"] = contentDisposition(name, true);

  if (options.sandbox) headers["Content-Security-Policy"] = PREVIEW_CSP;
  if (options.csp) headers["Content-Security-Policy"] = options.csp;

  let start = 0;
  let end = st.size > 0 ? st.size - 1 : 0;
  let status = 200;

  const rangeHeader = options.allowRange ? req.headers.range : null;
  if (rangeHeader && st.size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (m && (m[1] !== "" || m[2] !== "")) {
      if (m[1] === "") {
        const suffix = parseInt(m[2], 10);
        if (suffix > 0) {
          start = Math.max(0, st.size - suffix);
          end = st.size - 1;
          status = 206;
        }
      } else {
        const s = parseInt(m[1], 10);
        const e = m[2] === "" ? st.size - 1 : Math.min(parseInt(m[2], 10), st.size - 1);
        if (s <= e && s < st.size) {
          start = s;
          end = e;
          status = 206;
        } else {
          res.writeHead(416, { "Content-Range": "bytes */" + st.size });
          return res.end();
        }
      }
      if (status === 206) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + st.size;
    }
  }

  const length = st.size === 0 ? 0 : end - start + 1;
  headers["Content-Length"] = length;
  res.writeHead(status, headers);

  if (req.method === "HEAD" || length === 0) return res.end();

  const stream = fs.createReadStream(abs, { start: start, end: end });
  stream.on("error", function () {
    try {
      res.destroy();
    } catch (e) {
      /* ignore */
    }
  });
  stream.pipe(res);
}

/* ------------------------------ 应用 ------------------------------ */

function createApp(options) {
  const opts = options || {};
  const store = new cfgmod.ConfigStore(opts.configFile);
  const config = store.load();
  cfgmod.ensureAppDirs();

  if (!config.sharedFolder) {
    config.sharedFolder = cfgmod.CONTENT_DIR;
  }

  const state = {
    store: store,
    config: config,
    sessions: new sessions.SessionStore(),
    guard: new sessions.LoginGuard(8, 60000),
    adminServer: null,
    siteServer: null,
    adminPort: config.port,
    sitePort: config.sitePort,
    startedAt: Date.now(),
    shuttingDown: false,
    publishDir: opts.publishDir ? path.resolve(opts.publishDir) : cfgmod.PUBLISH_DIR
  };

  /* ---------- 共享文件夹根 ---------- */

  function shareRoot() {
    const root = state.config.sharedFolder;
    if (!root) throw httpError(404, "还没有选择要展示的文件夹");
    return root;
  }

  /* ---------- 对外信息 ---------- */

  function publicInfo() {
    const cfg = state.config;
    return {
      app: "minilist",
      version: VERSION,
      title: cfg.title,
      host: cfg.host,
      adminPort: state.adminPort,
      sitePort: state.sitePort,
      adminUrls: netinfo.urlsFor(state.adminPort),
      shareUrls: netinfo.urlsFor(state.adminPort).map(function (u) { return u + "/files/"; }),
      siteUrls: netinfo.urlsFor(state.sitePort),
      published: cfg.published ? { label: cfg.published.label, kind: cfg.published.kind } : null,
      hasSharedFolder: !!cfg.sharedFolder,
      mustChangePassword: !!cfg.auth.mustChange
    };
  }

  function fullState() {
    const cfg = state.config;
    return {
      app: "minilist",
      version: VERSION,
      title: cfg.title,
      username: cfg.auth.username,
      mustChangePassword: !!cfg.auth.mustChange,
      host: cfg.host,
      port: cfg.port,
      sitePort: cfg.sitePort,
      adminPort: state.adminPort,
      boundSitePort: state.sitePort,
      uploadLimitMB: cfg.uploadLimitMB,
      adminUrls: netinfo.urlsFor(state.adminPort),
      shareUrls: netinfo.urlsFor(state.adminPort).map(function (u) { return u + "/files/"; }),
      siteUrls: netinfo.urlsFor(state.sitePort),
      sharedFolder: cfg.sharedFolder || "",
      published: cfg.published
        ? { label: cfg.published.label, kind: cfg.published.kind, root: cfg.published.root, entry: cfg.published.entry }
        : null,
      uptime: Math.floor((Date.now() - state.startedAt) / 1000),
      platform: process.platform
    };
  }

  /* ---------- 权限 ---------- */

  function requireWriter(req, res) {
    const session = sessions.sessionFrom(req, state.sessions);
    if (!session) {
      sendError(res, 401, "请先登录，登录后才能修改");
      return null;
    }
    const token = req.headers["x-csrf-token"];
    if (!token || typeof token !== "string" || token !== session.csrf) {
      sendError(res, 403, "会话校验失败，请刷新页面后重试");
      return null;
    }
    return session;
  }

  /* ---------- 会话接口 ---------- */

  function apiSession(req, res) {
    const session = sessions.sessionFrom(req, state.sessions);
    const info = publicInfo();
    if (session) {
      info.sharedFolder = state.config.sharedFolder || "";
      info.username = session.user;
      return sendJSON(res, 200, { authed: true, user: session.user, csrf: session.csrf, info: info });
    }
    return sendJSON(res, 200, { authed: false, user: null, csrf: null, info: info });
  }

  async function apiLogin(req, res) {
    const ip = clientIP(req);
    const guard = state.guard.status(ip);
    if (guard.locked) {
      return sendError(res, 429, "登录失败次数过多，请 " + guard.retryAfter + " 秒后再试");
    }
    const body = await readJSON(req, 64 * 1024);
    const user = body.username == null ? state.config.auth.username : String(body.username);
    const pass = body.password == null ? "" : String(body.password);
    if (!state.store.verify(user, pass)) {
      const after = state.guard.fail(ip);
      if (after.locked) {
        return sendError(res, 401, "用户名或密码不正确，已锁定 " + after.retryAfter + " 秒");
      }
      const left = Math.max(1, state.guard.maxFails - after.fails);
      return sendError(res, 401, "用户名或密码不正确，还可以尝试 " + left + " 次");
    }
    state.guard.success(ip);
    const session = state.sessions.create(state.config.auth.username);
    const info = publicInfo();
    info.sharedFolder = state.config.sharedFolder || "";
    info.username = session.user;
    return sendJSON(
      res,
      200,
      { ok: true, authed: true, user: session.user, csrf: session.csrf, info: info },
      { "Set-Cookie": sessions.sessionCookie(session.token) }
    );
  }

  function apiLogout(req, res) {
    const session = requireWriter(req, res);
    if (!session) return;
    state.sessions.destroy(session.token);
    sendJSON(res, 200, { ok: true }, { "Set-Cookie": sessions.clearCookie() });
  }

  function apiState(req, res) {
    const session = sessions.sessionFrom(req, state.sessions);
    if (!session) return sendError(res, 401, "请先登录");
    sendJSON(res, 200, { ok: true, state: fullState(), csrf: session.csrf });
  }

  /* ---------- 投放 ---------- */

  async function apiPublishPath(req, res) {
    if (!requireWriter(req, res)) return;
    const body = await readJSON(req, 64 * 1024);
    let raw = String(body.path == null ? "" : body.path).trim();
    if (raw.length > 1 && raw.slice(0, 1) === '"' && raw.slice(-1) === '"') raw = raw.slice(1, -1);
    if (!raw) return sendError(res, 400, "请填写要投放的 HTML 文件或网站文件夹的绝对路径");
    if (!path.isAbsolute(raw)) return sendError(res, 400, "请填写绝对路径，例如 D:\\site\\index.html");

    let st = null;
    try {
      st = await fsp.stat(raw);
    } catch (e) {
      st = null;
    }
    if (!st) return sendError(res, 404, "路径不存在：" + raw);

    let root;
    let entry;
    let kind;
    let label;

    if (st.isDirectory()) {
      root = path.resolve(raw);
      const indexPath = path.join(root, "index.html");
      const ist = await fsp.stat(indexPath).catch(function () { return null; });
      if (!ist || !ist.isFile()) {
        return sendError(res, 400, "这个文件夹里没有 index.html，请选择一个 HTML 文件，或换成包含 index.html 的文件夹");
      }
      entry = "index.html";
      kind = "dir";
      label = path.basename(root) || root;
    } else if (st.isFile()) {
      const resolved = path.resolve(raw);
      root = path.dirname(resolved);
      entry = path.basename(resolved);
      kind = "file";
      label = entry;
    } else {
      return sendError(res, 400, "只能投放普通文件或文件夹");
    }

    state.config.published = { root: root, entry: entry, label: label, kind: kind, at: Date.now() };
    state.store.save();
    return sendJSON(res, 200, { ok: true, published: state.config.published, state: fullState() });
  }

  async function apiPublishUpload(req, res) {
    if (!requireWriter(req, res)) return;
    const limit = Math.max(1, state.config.uploadLimitMB) * 1024 * 1024;
    const raw = await readBody(req, limit);
    const entries = parseMultipart(raw, req.headers["content-type"]);
    let file = null;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].filename) {
        file = entries[i];
        break;
      }
    }
    if (!file) return sendError(res, 400, "没有收到文件");

    const base = (baseName(file.filename) || "index.html").replace(/[\\/:*?"<>|]/g, "_");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dir = path.join(state.publishDir, stamp + "-" + base.replace(/\.[^.]+$/, ""));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, base), file.data);

    let entry = base;
    if (base.toLowerCase() !== "index.html") {
      await fsp.writeFile(path.join(dir, "index.html"), file.data);
      entry = "index.html";
    }

    state.config.published = { root: dir, entry: entry, label: base, kind: "file", at: Date.now() };
    state.store.save();
    return sendJSON(res, 200, { ok: true, saved: base, state: fullState() });
  }

  function apiPublishClear(req, res) {
    if (!requireWriter(req, res)) return;
    state.config.published = null;
    state.store.save();
    sendJSON(res, 200, { ok: true, state: fullState() });
  }

  /* ---------- 共享文件夹 ---------- */

  async function apiShareFolder(req, res) {
    if (!requireWriter(req, res)) return;
    const body = await readJSON(req, 64 * 1024);
    let raw = String(body.path == null ? "" : body.path).trim();
    if (raw.length > 1 && raw.slice(0, 1) === '"' && raw.slice(-1) === '"') raw = raw.slice(1, -1);
    if (!raw) return sendError(res, 400, "请填写文件夹的绝对路径");
    if (!path.isAbsolute(raw)) return sendError(res, 400, "请填写绝对路径，例如 D:\\共享资料");

    let st = null;
    try {
      st = await fsp.stat(raw);
    } catch (e) {
      st = null;
    }
    if (!st) return sendError(res, 404, "路径不存在：" + raw);
    if (!st.isDirectory()) return sendError(res, 400, "这不是一个文件夹");

    state.config.sharedFolder = path.resolve(raw);
    fsa.resetRootCache();
    state.store.save();
    return sendJSON(res, 200, { ok: true, sharedFolder: state.config.sharedFolder, state: fullState() });
  }

  function apiShareClear(req, res) {
    if (!requireWriter(req, res)) return;
    state.config.sharedFolder = "";
    fsa.resetRootCache();
    state.store.save();
    sendJSON(res, 200, { ok: true, state: fullState() });
  }

  /* ---------- 原生选择框 / 打开资源管理器 ---------- */

  async function apiPick(req, res) {
    if (!requireWriter(req, res)) return;
    const body = await readJSON(req, 64 * 1024);
    const kind = body.kind === "folder" ? "folder" : "file";
    const options = {};
    if (kind === "file") {
      options.title = "选择要投放到局域网的 HTML 文件";
      options.filter = "网页文件 (*.html;*.htm)|*.html;*.htm|所有文件 (*.*)|*.*";
    } else {
      options.title = body.for === "site" ? "选择网站文件夹（里面要有 index.html）" : "选择要展示的文件夹";
    }
    if (body.for === "site" && state.config.published && state.config.published.root) {
      options.initial = state.config.published.root;
    } else if (state.config.sharedFolder) {
      options.initial = state.config.sharedFolder;
    }
    const result = await dialog.pickPath(kind, options);
    return sendJSON(res, 200, result);
  }

  async function apiOpenFolder(req, res) {
    if (!requireWriter(req, res)) return;
    const body = await readJSON(req, 64 * 1024);
    let dir = String(body.path == null ? "" : body.path).trim();
    if (!dir) dir = state.config.sharedFolder || "";
    if (!dir) return sendError(res, 400, "还没有需要打开的文件夹");
    let st = null;
    try {
      st = await fsp.stat(dir);
    } catch (e) {
      st = null;
    }
    if (!st || !st.isDirectory()) return sendError(res, 404, "文件夹不存在：" + dir);
    try {
      if (process.platform === "win32") {
        spawn("explorer.exe", [dir], { detached: true, stdio: "ignore", windowsHide: false }).unref();
      } else if (process.platform === "darwin") {
        spawn("open", [dir], { detached: true, stdio: "ignore" }).unref();
      } else {
        spawn("xdg-open", [dir], { detached: true, stdio: "ignore" }).unref();
      }
    } catch (e) {
      return sendError(res, 500, "无法打开资源管理器：" + e.message);
    }
    return sendJSON(res, 200, { ok: true });
  }

  /* ---------- 设置 / 口令 ---------- */

  /**
   * 重启必须在当前响应发出之后再做。
   * 否则 stopServers() 会 closeAllConnections()，把正在返回的这条连接一起掐掉。
   */
  function scheduleRestart() {
    setTimeout(function () {
      restartServers().catch(function (err) {
        console.error("[minilist] 重启失败：" + (err && err.message ? err.message : err));
      });
    }, 500);
  }

  async function apiSettings(req, res) {
    if (!requireWriter(req, res)) return;
    const body = await readJSON(req, 64 * 1024);
    const cfg = state.config;
    let needRestart = false;

    if (body.port !== undefined) {
      const p = clampInt(body.port, cfg.port, 1, 65535);
      if (p !== state.adminPort) needRestart = true;
      cfg.port = p;
    }
    if (body.sitePort !== undefined) {
      const p = clampInt(body.sitePort, cfg.sitePort, 1, 65535);
      if (p !== state.sitePort) needRestart = true;
      cfg.sitePort = p;
    }
    if (body.host !== undefined) {
      const h = String(body.host).trim() || "0.0.0.0";
      if (h !== cfg.host) needRestart = true;
      cfg.host = h;
    }
    if (body.title !== undefined) {
      cfg.title = String(body.title).slice(0, 60) || "minilist";
    }
    if (body.uploadLimitMB !== undefined) {
      cfg.uploadLimitMB = clampInt(body.uploadLimitMB, cfg.uploadLimitMB, 1, 20480);
    }

    state.store.save();

    if (needRestart) {
      sendJSON(res, 200, {
        ok: true,
        restarted: true,
        restarting: true,
        nextPort: cfg.port,
        nextSitePort: cfg.sitePort,
        state: fullState()
      });
      scheduleRestart();
      return;
    }

    return sendJSON(res, 200, { ok: true, restarted: false, state: fullState() });
  }

  async function apiPassword(req, res) {
    const session = requireWriter(req, res);
    if (!session) return;
    const body = await readJSON(req, 64 * 1024);
    const current = String(body.current == null ? "" : body.current);
    const next = String(body.next == null ? "" : body.next);
    const nextUser = body.username === undefined ? null : String(body.username).trim();

    if (!state.store.verify(session.user, current)) {
      return sendError(res, 400, "当前密码不正确");
    }
    if (nextUser !== null && nextUser.length < 3) {
      return sendError(res, 400, "用户名至少 3 个字符");
    }
    try {
      state.store.setPassword(next, nextUser || undefined);
    } catch (e) {
      return sendError(res, e.statusCode || 400, e.message);
    }
    state.sessions.destroyAll();
    const fresh = state.sessions.create(state.config.auth.username);
    const info = publicInfo();
    info.sharedFolder = state.config.sharedFolder || "";
    info.username = fresh.user;
    return sendJSON(res, 200, { ok: true, csrf: fresh.csrf, info: info }, { "Set-Cookie": sessions.sessionCookie(fresh.token) });
  }

  /* ---------- 文件接口（共享文件夹） ---------- */

  async function apiFiles(req, res, url) {
    const root = shareRoot();
    const data = await fsa.listDir(root, url.searchParams.get("path"));
    return sendJSON(res, 200, data);
  }

  async function apiDownload(req, res, url) {
    const root = shareRoot();
    const info = await fsa.statOne(root, url.searchParams.get("path"));
    if (info.stat.isDirectory()) {
      const zip = await fsa.collectForZip(root, info.rel, null);
      const buf = makeZip(zip.entries);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": buf.length,
        "Content-Disposition": contentDisposition(zip.name, false),
        "Cache-Control": "no-store"
      });
      return res.end(buf);
    }
    return serveFileRange(req, res, info.abs, { disposition: "attachment", allowRange: false });
  }

  async function apiRaw(req, res, url) {
    const root = shareRoot();
    const info = await fsa.statOne(root, url.searchParams.get("path"));
    if (info.stat.isDirectory()) return sendError(res, 400, "这是文件夹");
    const active = isActiveContent(mimeOf(info.abs));
    return serveFileRange(req, res, info.abs, {
      disposition: null,
      allowRange: true,
      sandbox: active
    });
  }

  async function apiText(req, res, url) {
    const root = shareRoot();
    const data = await fsa.readTextFile(root, url.searchParams.get("path"));
    return sendJSON(res, 200, data);
  }

  async function apiZip(req, res, url) {
    const root = shareRoot();
    const names = url.searchParams.getAll("name");
    const collected = await fsa.collectForZip(root, url.searchParams.get("path"), names);
    if (!collected.entries.length) return sendError(res, 404, "没有可打包的内容");
    const buf = makeZip(collected.entries);
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Length": buf.length,
      "Content-Disposition": contentDisposition(collected.name, false),
      "Cache-Control": "no-store"
    });
    return res.end(buf);
  }

  async function apiUpload(req, res, url) {
    if (!requireWriter(req, res)) return;
    const root = shareRoot();
    const limit = Math.max(1, state.config.uploadLimitMB) * 1024 * 1024;
    const raw = await readBody(req, limit);
    const entries = parseMultipart(raw, req.headers["content-type"]);
    const overwrite = url.searchParams.get("overwrite") !== "0";
    const result = await fsa.saveUploads(root, url.searchParams.get("path"), entries, overwrite);
    return sendJSON(res, 200, result);
  }

  async function apiMkdir(req, res) {
    if (!requireWriter(req, res)) return;
    const root = shareRoot();
    const body = await readJSON(req, 64 * 1024);
    const result = await fsa.makeDir(root, body.path, body.name);
    return sendJSON(res, 200, result);
  }

  async function apiNewFile(req, res) {
    if (!requireWriter(req, res)) return;
    const root = shareRoot();
    const body = await readJSON(req, 256 * 1024);
    const result = await fsa.createFile(root, body.path, body.name, body.content || "");
    return sendJSON(res, 200, result);
  }

  async function apiRename(req, res) {
    if (!requireWriter(req, res)) return;
    const root = shareRoot();
    const body = await readJSON(req, 64 * 1024);
    const result = await fsa.renameEntry(root, body.from, body.to);
    return sendJSON(res, 200, result);
  }

  async function apiDelete(req, res) {
    if (!requireWriter(req, res)) return;
    const root = shareRoot();
    const body = await readJSON(req, 256 * 1024);
    const result = await fsa.removeEntries(root, body.paths);
    return sendJSON(res, 200, result);
  }

  async function apiSave(req, res) {
    if (!requireWriter(req, res)) return;
    const root = shareRoot();
    const body = await readJSON(req, 8 * 1024 * 1024);
    const result = await fsa.writeTextFile(root, body.path, body.content);
    return sendJSON(res, 200, result);
  }

  /* ---------- 生命周期 ---------- */

  function apiRestart(req, res) {
    if (!requireWriter(req, res)) return;
    sendJSON(res, 200, { ok: true, restarting: true, state: fullState() });
    scheduleRestart();
  }

  function apiShutdown(req, res) {
    if (!requireWriter(req, res)) return;
    state.shuttingDown = true;
    sendJSON(res, 200, { ok: true, message: "minilist 正在退出" });
    setTimeout(function () {
      stopServers().then(function () {
        process.exit(0);
      });
    }, 300);
  }

  /* ------------------------------ 路由 ------------------------------ */

  async function handleApi(req, res, url) {
    const p = url.pathname;
    const method = req.method;

    if (p === "/api/session" && method === "GET") return apiSession(req, res);
    if (p === "/api/login" && method === "POST") return apiLogin(req, res);
    if (p === "/api/logout" && method === "POST") return apiLogout(req, res);
    if (p === "/api/state" && method === "GET") return apiState(req, res);

    if (p === "/api/publish/path" && method === "POST") return apiPublishPath(req, res);
    if (p === "/api/publish/upload" && method === "POST") return apiPublishUpload(req, res);
    if (p === "/api/publish/clear" && method === "POST") return apiPublishClear(req, res);

    if (p === "/api/share/folder" && method === "POST") return apiShareFolder(req, res);
    if (p === "/api/share/clear" && method === "POST") return apiShareClear(req, res);

    if (p === "/api/pick" && method === "POST") return apiPick(req, res);
    if (p === "/api/open-folder" && method === "POST") return apiOpenFolder(req, res);
    if (p === "/api/settings" && method === "POST") return apiSettings(req, res);
    if (p === "/api/password" && method === "POST") return apiPassword(req, res);
    if (p === "/api/restart" && method === "POST") return apiRestart(req, res);
    if (p === "/api/shutdown" && method === "POST") return apiShutdown(req, res);

    if (p === "/api/files" && method === "GET") return apiFiles(req, res, url);
    if (p === "/api/download" && method === "GET") return apiDownload(req, res, url);
    if (p === "/api/raw" && method === "GET") return apiRaw(req, res, url);
    if (p === "/api/text" && method === "GET") return apiText(req, res, url);
    if (p === "/api/zip" && method === "GET") return apiZip(req, res, url);
    if (p === "/api/upload" && method === "POST") return apiUpload(req, res, url);
    if (p === "/api/mkdir" && method === "POST") return apiMkdir(req, res);
    if (p === "/api/newfile" && method === "POST") return apiNewFile(req, res);
    if (p === "/api/rename" && method === "POST") return apiRename(req, res);
    if (p === "/api/delete" && method === "POST") return apiDelete(req, res);
    if (p === "/api/save" && method === "POST") return apiSave(req, res);

    return sendError(res, 404, "接口不存在：" + method + " " + p);
  }

  /**
   * 前端静态文件。用同步读取：打包成 exe 后这些文件在只读快照里，
   * 同步 fs 是所有打包器都支持得最稳的一路。
   * 只有打包后才常驻内存缓存；直接跑源码时每次读盘，改样式刷新即可生效。
   */
  const staticCache = new Map();

  function serveStatic(res, name) {
    const file = path.join(PUBLIC_DIR, name);
    if (!isInside(PUBLIC_DIR, file)) return sendPlain(res, 404, "404 Not Found");

    let buf = cfgmod.IS_PACKAGED ? staticCache.get(name) : null;
    if (!buf) {
      try {
        buf = fs.readFileSync(file);
      } catch (e) {
        console.error("[minilist] 读不到前端文件：" + file + "  （" + e.message + "）");
        return sendPlain(res, 404, "找不到前端文件 " + name);
      }
      if (cfgmod.IS_PACKAGED) staticCache.set(name, buf);
    }

    try {
      res.writeHead(200, {
        "Content-Type": mimeOf(file),
        "Content-Length": buf.length,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff"
      });
      return res.end(buf);
    } catch (e) {
      try {
        res.destroy();
      } catch (e2) {
        /* ignore */
      }
    }
  }

  async function handleAdmin(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    } catch (e) {
      return sendError(res, 400, "非法请求地址");
    }

    const p = url.pathname;

    try {
      if (p.indexOf("/api/") === 0) {
        return await handleApi(req, res, url);
      }

      if (p === "/__ml/health") {
        return sendJSON(res, 200, {
          app: "minilist",
          version: VERSION,
          uptime: Math.floor((Date.now() - state.startedAt) / 1000),
          adminPort: state.adminPort,
          sitePort: state.sitePort,
          published: !!state.config.published,
          sharedFolder: !!state.config.sharedFolder
        });
      }

      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        return res.end("Method Not Allowed");
      }

      if (p === "/") {
        res.writeHead(302, { Location: "/admin/" });
        return res.end();
      }

      const mapped = STATIC_MAP[p];
      if (mapped) return await serveStatic(res, mapped);

      if (p === "/favicon.ico") return await serveStatic(res, "favicon.svg");

      return sendPlain(res, 404, "404 Not Found  |  minilist");
    } catch (err) {
      return handleError(res, err);
    }
  }

  function sitePlaceholder() {
    const cfg = state.config;
    const title = String(cfg.title || "minilist").replace(/[<>&"]/g, "");
    return [
      "<!doctype html>",
      '<html lang="zh-CN"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      "<title>" + title + "</title>",
      "<style>",
      "*{box-sizing:border-box}",
      "html,body{height:100%;margin:0}",
      "body{display:flex;align-items:center;justify-content:center;background:#000;color:#fff;",
      "font:16px/1.7 system-ui,'Microsoft YaHei',sans-serif;padding:24px}",
      ".box{max-width:520px;width:100%;padding:40px;text-align:center;border:3px double #fff}",
      "h1{margin:0 0 16px;font-size:24px;letter-spacing:3px;text-transform:uppercase}",
      "p{margin:10px 0}",
      "hr{border:0;border-top:1px solid #fff;margin:20px 0}",
      "code{border:1px solid #fff;padding:2px 8px;font-family:ui-monospace,Consolas,monospace;font-size:13px}",
      "</style></head><body><div class=\"box\">",
      "<h1>minilist</h1>",
      "<hr>",
      "<p>这台机器的 minilist 目前还没有投放任何页面。</p>",
      "<p>请在控制台里选择一个 HTML 文件，然后刷新本页。</p>",
      "</div></body></html>"
    ].join("\n");
  }

  async function handleSite(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    } catch (e) {
      return sendPlain(res, 400, "非法请求地址");
    }

    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        return res.end("Method Not Allowed");
      }

      if (url.pathname === "/__minilist") {
        const pub = state.config.published;
        return sendJSON(res, 200, { app: "minilist", version: VERSION, published: pub ? pub.label : null });
      }

      const published = state.config.published;
      if (!published) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(sitePlaceholder());
      }

      let rel;
      try {
        rel = normalizeRel(decodeURIComponent(url.pathname));
      } catch (e) {
        return sendPlain(res, 403, "非法路径");
      }
      if (!rel) rel = published.entry;

      const root = published.root;
      let abs;
      try {
        abs = resolveInside(root, rel).abs;
      } catch (e) {
        return sendPlain(res, 403, "非法路径");
      }

      let realRoot = null;
      try {
        realRoot = await fsp.realpath(root);
      } catch (e) {
        return sendPlain(res, 404, "投放目录不存在，请在控制台重新选择");
      }

      let real = null;
      try {
        real = await fsp.realpath(abs);
      } catch (e) {
        return sendPlain(res, 404, "404 Not Found");
      }
      if (!isInside(realRoot, real)) return sendPlain(res, 403, "禁止访问");

      const st = await fsp.stat(real).catch(function () { return null; });
      if (!st) return sendPlain(res, 404, "404 Not Found");

      if (st.isDirectory()) {
        const indexPath = path.join(real, "index.html");
        const ist = await fsp.stat(indexPath).catch(function () { return null; });
        if (ist && ist.isFile()) {
          return serveFileRange(req, res, indexPath, { disposition: null, allowRange: true });
        }
        return sendPlain(res, 404, "该目录下没有 index.html");
      }
      if (!st.isFile()) return sendPlain(res, 404, "404 Not Found");

      return serveFileRange(req, res, real, { disposition: null, allowRange: true });
    } catch (err) {
      return handleError(res, err);
    }
  }

  /* ---------- 监听 ---------- */

  function listenOn(server, host, port, tries) {
    return new Promise(function (resolve, reject) {
      let attempt = 0;

      function attemptListen(p) {
        function onError(err) {
          server.removeListener("listening", onListening);
          if (err && err.code === "EADDRINUSE" && attempt < tries) {
            attempt += 1;
            attemptListen(p + 1);
            return;
          }
          reject(err);
        }
        function onListening() {
          server.removeListener("error", onError);
          const addr = server.address();
          resolve(addr && typeof addr === "object" && addr.port ? addr.port : p);
        }
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(p, host);
      }

      attemptListen(port);
    });
  }

  async function startServers() {
    const cfg = state.config;
    const host = cfg.host;

    const admin = http.createServer(function (req, res) {
      res.on("error", ignoreError);
      req.on("error", ignoreError);
      handleAdmin(req, res).catch(function (err) {
        handleError(res, err);
      });
    });
    admin.requestTimeout = 15 * 60 * 1000;
    admin.headersTimeout = 60000;
    admin.keepAliveTimeout = 65000;
    state.adminServer = admin;
    state.adminPort = await listenOn(admin, host, cfg.port, 30);

    const site = http.createServer(function (req, res) {
      res.on("error", ignoreError);
      req.on("error", ignoreError);
      handleSite(req, res).catch(function (err) {
        handleError(res, err);
      });
    });
    site.requestTimeout = 5 * 60 * 1000;
    site.headersTimeout = 60000;
    site.keepAliveTimeout = 65000;
    state.siteServer = site;
    state.sitePort = await listenOn(site, host, cfg.sitePort, 30);

    let changed = false;
    if (cfg.port !== state.adminPort) {
      cfg.port = state.adminPort;
      changed = true;
    }
    if (cfg.sitePort !== state.sitePort) {
      cfg.sitePort = state.sitePort;
      changed = true;
    }
    if (changed) state.store.save();

    return { adminPort: state.adminPort, sitePort: state.sitePort };
  }

  async function stopServers() {
    const list = [state.adminServer, state.siteServer];
    state.adminServer = null;
    state.siteServer = null;
    await Promise.all(
      list.map(function (server) {
        return new Promise(function (resolve) {
          if (!server) return resolve();
          try {
            if (typeof server.closeAllConnections === "function") server.closeAllConnections();
          } catch (e) {
            /* ignore */
          }
          server.close(function () {
            resolve();
          });
        });
      })
    );
  }

  async function restartServers() {
    await stopServers();
    return startServers();
  }

  return {
    state: state,
    config: config,
    startServers: startServers,
    stopServers: stopServers,
    restartServers: restartServers,
    publicInfo: publicInfo,
    fullState: fullState,
    handleAdmin: handleAdmin,
    handleSite: handleSite
  };
}

module.exports = { createApp, VERSION, PREVIEW_CSP };