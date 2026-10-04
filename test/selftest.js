"use strict";

/**
 * minilist 端到端自检
 *
 *   node test/selftest.js
 *
 * 会在临时目录里造一批测试文件，用随机端口把服务整个跑起来，
 * 然后把「投放 / 只读 / 登录 / 上传 / 下载 / 编辑 / 重命名 / 删除 / 打包 / 越权」全跑一遍。
 * 全部通过时退出码为 0。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const assert = require("assert");

const { createApp } = require("../src/server");
const fsa = require("../src/fsapi");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "minilist-selftest-"));

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("  [OK]   " + name);
  } catch (e) {
    failed += 1;
    const msg = e && e.message ? e.message : String(e);
    failures.push(name + "  ->  " + msg);
    console.log("  [FAIL] " + name);
    console.log("         " + msg);
  }
}

function request(port, method, urlPath, options) {
  const opts = options || {};
  return new Promise(function (resolve, reject) {
    const headers = {};
    const src = opts.headers || {};
    Object.keys(src).forEach(function (k) {
      headers[k] = src[k];
    });
    let body = opts.body;
    if (body !== undefined && body !== null && !Buffer.isBuffer(body)) {
      body = Buffer.from(String(body), "utf8");
    }
    if (body) headers["Content-Length"] = body.length;

    const req = http.request(
      { host: "127.0.0.1", port: port, method: method, path: urlPath, headers: headers },
      function (res) {
        const chunks = [];
        res.on("data", function (c) {
          chunks.push(c);
        });
        res.on("end", function () {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: buf,
            text: buf.toString("utf8")
          });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(20000, function () {
      req.destroy(new Error("请求超时"));
    });
    if (body) req.write(body);
    req.end();
  });
}

function json(res) {
  try {
    return JSON.parse(res.text);
  } catch (e) {
    throw new Error("返回的不是 JSON（HTTP " + res.status + "）：" + res.text.slice(0, 200));
  }
}

function buildMultipart(files) {
  const boundary = "----minilistSelftest" + Math.random().toString(16).slice(2);
  const chunks = [];
  files.forEach(function (f) {
    chunks.push(Buffer.from("--" + boundary + "\r\n", "utf8"));
    chunks.push(Buffer.from('Content-Disposition: form-data; name="files"; filename="' + f.name + '"\r\n', "utf8"));
    chunks.push(Buffer.from("Content-Type: application/octet-stream\r\n\r\n", "utf8"));
    chunks.push(Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), "utf8"));
    chunks.push(Buffer.from("\r\n", "utf8"));
  });
  chunks.push(Buffer.from("--" + boundary + "--\r\n", "utf8"));
  return { boundary: boundary, body: Buffer.concat(chunks) };
}

async function main() {
  console.log("");
  console.log("minilist 自检开始");
  console.log("临时目录：" + TMP);
  console.log("");

  /* ---------------- 准备测试数据 ---------------- */

  const shareDir = path.join(TMP, "share");
  fs.mkdirSync(path.join(shareDir, "sub"), { recursive: true });
  fs.writeFileSync(path.join(shareDir, "hello.txt"), "你好 minilist\n", "utf8");
  fs.writeFileSync(path.join(shareDir, "sub", "a.json"), '{"a":1}', "utf8");

  const siteDir = path.join(TMP, "site");
  fs.mkdirSync(siteDir, { recursive: true });
  fs.writeFileSync(
    path.join(siteDir, "index.html"),
    "<!doctype html><html><head><meta charset=\"utf-8\"><link rel=\"stylesheet\" href=\"style.css\"></head><body><h1>MINILIST_SITE_OK</h1></body></html>",
    "utf8"
  );
  fs.writeFileSync(path.join(siteDir, "style.css"), "h1{color:red}", "utf8");

  const configFile = path.join(TMP, "config.json");

  /* ---------------- 启动 ---------------- */

  const app = createApp({
    configFile: configFile,
    publishDir: path.join(TMP, "published")
  });
  app.config.port = 0;
  app.config.sitePort = 0;
  app.config.sharedFolder = shareDir;
  fsa.resetRootCache();

  const bound = await app.startServers();
  const A = bound.adminPort;
  const S = bound.sitePort;
  console.log("控制台端口 " + A + "，投放端口 " + S);
  console.log("");

  let cookie = "";
  let csrf = "";

  function authHeaders(extra) {
    const h = { Cookie: cookie, "X-CSRF-Token": csrf };
    const src = extra || {};
    Object.keys(src).forEach(function (k) {
      h[k] = src[k];
    });
    return h;
  }

  /* ---------------- 基础 ---------------- */

  console.log("一、服务与页面");

  await check("健康检查 /__ml/health 返回 minilist", async function () {
    const r = await request(A, "GET", "/__ml/health");
    assert.strictEqual(r.status, 200, "HTTP " + r.status);
    assert.strictEqual(json(r).app, "minilist");
  });

  await check("控制台 / 文件浏览 / 静态资源都能打开", async function () {
    const paths = ["/admin/", "/files/", "/__ml/ui.js", "/__ml/base.css", "/__ml/favicon.svg", "/admin/console.js", "/files/browse.js"];
    for (let i = 0; i < paths.length; i++) {
      const r = await request(A, "GET", paths[i]);
      assert.strictEqual(r.status, 200, paths[i] + " 返回 " + r.status);
    }
  });

  await check("根路径跳转到控制台", async function () {
    const r = await request(A, "GET", "/");
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, "/admin/");
  });

  await check("未知路径返回 404", async function () {
    const r = await request(A, "GET", "/nope-nope");
    assert.strictEqual(r.status, 404);
  });

  /* ---------------- 只读 ---------------- */

  console.log("");
  console.log("二、未登录 = 只读");

  await check("未登录时 /api/session 报告只读且不给 CSRF", async function () {
    const r = await request(A, "GET", "/api/session");
    assert.strictEqual(r.status, 200);
    const j = json(r);
    assert.strictEqual(j.authed, false);
    assert.strictEqual(j.csrf, null);
  });

  await check("匿名可以列目录", async function () {
    const r = await request(A, "GET", "/api/files?path=");
    assert.strictEqual(r.status, 200, r.text);
    const j = json(r);
    assert.strictEqual(j.items.length, 2, "期望 2 项，实际 " + j.items.length);
    assert.strictEqual(j.items[0].isDir, true, "文件夹应排在最前面");
  });

  await check("匿名可以下载文件", async function () {
    const r = await request(A, "GET", "/api/download?path=" + encodeURIComponent("hello.txt"));
    assert.strictEqual(r.status, 200);
    assert.ok(String(r.headers["content-disposition"]).indexOf("attachment") === 0);
    assert.ok(r.text.indexOf("minilist") >= 0);
  });

  await check("匿名上传被拒绝（401）", async function () {
    const mp = buildMultipart([{ name: "x.txt", data: "x" }]);
    const r = await request(A, "POST", "/api/upload?path=", {
      headers: { "Content-Type": "multipart/form-data; boundary=" + mp.boundary },
      body: mp.body
    });
    assert.strictEqual(r.status, 401, r.text);
  });

  await check("匿名删除被拒绝（401）", async function () {
    const r = await request(A, "POST", "/api/delete", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["hello.txt"] })
    });
    assert.strictEqual(r.status, 401, r.text);
    assert.ok(fs.existsSync(path.join(shareDir, "hello.txt")), "文件不应被删除");
  });

  await check("路径穿越被拒绝（403）", async function () {
    const r = await request(A, "GET", "/api/files?path=" + encodeURIComponent("../../Windows"));
    assert.strictEqual(r.status, 403, r.text);
  });

  /* ---------------- 登录 ---------------- */

  console.log("");
  console.log("三、登录与 CSRF");

  await check("错误密码被拒绝", async function () {
    const r = await request(A, "POST", "/api/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "definitely-wrong" })
    });
    assert.strictEqual(r.status, 401, r.text);
  });

  await check("默认账号 admin/admin 可以登录并拿到会话", async function () {
    const r = await request(A, "POST", "/api/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" })
    });
    assert.strictEqual(r.status, 200, r.text);
    const j = json(r);
    assert.ok(j.csrf && j.csrf.length > 10, "应返回 CSRF 令牌");
    csrf = j.csrf;
    const sc = r.headers["set-cookie"];
    assert.ok(sc && sc[0], "应下发 Cookie");
    cookie = String(sc[0]).split(";")[0];
    assert.ok(cookie.indexOf("minilist_sid=") === 0);
  });

  await check("有 Cookie 但没有 CSRF 时写操作被拒绝（403）", async function () {
    const mp = buildMultipart([{ name: "x.txt", data: "x" }]);
    const r = await request(A, "POST", "/api/upload?path=", {
      headers: { "Content-Type": "multipart/form-data; boundary=" + mp.boundary, Cookie: cookie },
      body: mp.body
    });
    assert.strictEqual(r.status, 403, r.text);
  });

  await check("登录后 /api/state 返回完整个状态", async function () {
    const r = await request(A, "GET", "/api/state", { headers: { Cookie: cookie } });
    assert.strictEqual(r.status, 200, r.text);
    const j = json(r);
    assert.strictEqual(j.state.sharedFolder, shareDir);
    assert.strictEqual(j.state.username, "admin");
  });

  /* ---------------- 写操作 ---------------- */

  console.log("");
  console.log("四、登录后的上传 / 修改 / 删除");

  await check("上传中文名文件", async function () {
    const mp = buildMultipart([{ name: "新文件 中文.txt", data: "上传内容" }]);
    const r = await request(A, "POST", "/api/upload?path=", {
      headers: authHeaders({ "Content-Type": "multipart/form-data; boundary=" + mp.boundary }),
      body: mp.body
    });
    assert.strictEqual(r.status, 200, r.text);
    const j = json(r);
    assert.strictEqual(j.saved.length, 1, "应保存 1 个文件");
    assert.strictEqual(j.saved[0].name, "新文件 中文.txt");
    assert.strictEqual(fs.readFileSync(path.join(shareDir, "新文件 中文.txt"), "utf8"), "上传内容");
  });

  await check("上传到子目录", async function () {
    const mp = buildMultipart([{ name: "b.txt", data: "B" }]);
    const r = await request(A, "POST", "/api/upload?path=" + encodeURIComponent("sub"), {
      headers: authHeaders({ "Content-Type": "multipart/form-data; boundary=" + mp.boundary }),
      body: mp.body
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(fs.existsSync(path.join(shareDir, "sub", "b.txt")));
  });

  await check("读取文本内容（UTF-8 自动识别）", async function () {
    const r = await request(A, "GET", "/api/text?path=" + encodeURIComponent("hello.txt"));
    assert.strictEqual(r.status, 200, r.text);
    const j = json(r);
    assert.strictEqual(j.encoding, "utf-8");
    assert.ok(j.text.indexOf("你好") === 0, "内容应为 " + JSON.stringify(j.text));
  });

  await check("保存修改写回磁盘", async function () {
    const r = await request(A, "POST", "/api/save", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path: "hello.txt", content: "改过了\n" })
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(fs.readFileSync(path.join(shareDir, "hello.txt"), "utf8"), "改过了\n");
  });

  await check("新建文件夹", async function () {
    const r = await request(A, "POST", "/api/mkdir", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path: "", name: "新建目录" })
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(fs.statSync(path.join(shareDir, "新建目录")).isDirectory());
  });

  await check("重名新建文件夹被拒绝（409）", async function () {
    const r = await request(A, "POST", "/api/mkdir", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path: "", name: "新建目录" })
    });
    assert.strictEqual(r.status, 409, r.text);
  });

  await check("非法名称被拒绝（400）", async function () {
    const r = await request(A, "POST", "/api/mkdir", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path: "", name: "../逃逸" })
    });
    assert.ok(r.status === 400 || r.status === 403, "实际 " + r.status);
  });

  await check("新建文本文件", async function () {
    const r = await request(A, "POST", "/api/newfile", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path: "", name: "note.md", content: "# 标题" })
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(fs.readFileSync(path.join(shareDir, "note.md"), "utf8"), "# 标题");
  });

  await check("重命名文件", async function () {
    const r = await request(A, "POST", "/api/rename", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ from: "note.md", to: "note-renamed.md" })
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(fs.existsSync(path.join(shareDir, "note-renamed.md")));
    assert.ok(!fs.existsSync(path.join(shareDir, "note.md")));
  });

  await check("打包下载返回合法 ZIP", async function () {
    const r = await request(A, "GET", "/api/zip?path=&name=" + encodeURIComponent("hello.txt"));
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.slice(0, 2).toString("latin1"), "PK");
    assert.ok(String(r.headers["content-disposition"]).indexOf(".zip") >= 0);
  });

  await check("打包整个目录", async function () {
    const r = await request(A, "GET", "/api/zip?path=");
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.body.slice(0, 2).toString("latin1"), "PK");
  });

  await check("删除文件与文件夹", async function () {
    const r = await request(A, "POST", "/api/delete", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ paths: ["note-renamed.md", "新建目录", "新文件 中文.txt"] })
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(json(r).removed.length, 3);
    assert.ok(!fs.existsSync(path.join(shareDir, "note-renamed.md")));
    assert.ok(!fs.existsSync(path.join(shareDir, "新建目录")));
  });

  /* ---------------- 投放 ---------------- */

  console.log("");
  console.log("五、投放 HTML 到局域网端口");

  await check("未投放时投放端口给出占位页", async function () {
    const r = await request(S, "GET", "/");
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.indexOf("minilist") >= 0);
  });

  await check("投放一个 HTML 文件", async function () {
    const r = await request(A, "POST", "/api/publish/path", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path: path.join(siteDir, "index.html") })
    });
    assert.strictEqual(r.status, 200, r.text);
    const j = json(r);
    assert.strictEqual(j.published.entry, "index.html");
    assert.strictEqual(j.published.root, siteDir);
  });

  await check("投放端口能打开这个页面", async function () {
    const r = await request(S, "GET", "/");
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.indexOf("MINILIST_SITE_OK") >= 0, "页面内容不对：" + r.text.slice(0, 120));
  });

  await check("投放端口能取到同目录的 css", async function () {
    const r = await request(S, "GET", "/style.css");
    assert.strictEqual(r.status, 200);
    assert.ok(r.text.indexOf("color:red") >= 0);
    assert.ok(String(r.headers["content-type"]).indexOf("text/css") === 0);
  });

  await check("投放端口越权访问被拒绝", async function () {
    const a = await request(S, "GET", "/..%2f..%2fWindows%2fwin.ini");
    assert.strictEqual(a.status, 403, "实际 " + a.status);
    const b = await request(S, "GET", "/Windows/win.ini");
    assert.strictEqual(b.status, 404, "实际 " + b.status);
  });

  await check("投放端口没有开放的写接口", async function () {
    const r = await request(S, "POST", "/api/delete", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["hello.txt"] })
    });
    assert.strictEqual(r.status, 405, "实际 " + r.status);
    assert.ok(fs.existsSync(path.join(shareDir, "hello.txt")));
  });

  await check("未登录不能投放", async function () {
    const r = await request(A, "POST", "/api/publish/clear", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.strictEqual(r.status, 401, r.text);
  });

  await check("upload 方式投放 HTML", async function () {
    const mp = buildMultipart([
      { name: "uploaded.html", data: "<!doctype html><title>UP</title><p>MINILIST_UPLOAD_OK</p>" }
    ]);
    const r = await request(A, "POST", "/api/publish/upload", {
      headers: authHeaders({ "Content-Type": "multipart/form-data; boundary=" + mp.boundary }),
      body: mp.body
    });
    assert.strictEqual(r.status, 200, r.text);
    const page = await request(S, "GET", "/");
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.indexOf("MINILIST_UPLOAD_OK") >= 0, "上传投放后页面内容不对");
  });

  await check("停止投放", async function () {
    const r = await request(A, "POST", "/api/publish/clear", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({})
    });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(json(r).state.published, null);
  });

  /* ---------------- 设置 ---------------- */

  console.log("");
  console.log("六、设置与账号");

  await check("修改标题与上传上限", async function () {
    const r = await request(A, "POST", "/api/settings", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ title: "minilist 自检", uploadLimitMB: 128 })
    });
    assert.strictEqual(r.status, 200, r.text);
    const j = json(r);
    assert.strictEqual(j.state.title, "minilist 自检");
    assert.strictEqual(j.state.uploadLimitMB, 128);
  });

  await check("修改共享文件夹并恢复", async function () {
    const other = path.join(TMP, "share2");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "only-here.txt"), "x", "utf8");

    const r1 = await request(A, "POST", "/api/share/folder", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path: other })
    });
    assert.strictEqual(r1.status, 200, r1.text);

    const list = await request(A, "GET", "/api/files?path=");
    assert.strictEqual(json(list).items.length, 1);
    assert.strictEqual(json(list).items[0].name, "only-here.txt");

    const r2 = await request(A, "POST", "/api/share/folder", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path: shareDir })
    });
    assert.strictEqual(r2.status, 200, r2.text);
  });

  await check("不存在的共享文件夹被拒绝", async function () {
    const r = await request(A, "POST", "/api/share/folder", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path: path.join(TMP, "does-not-exist-xyz") })
    });
    assert.strictEqual(r.status, 404, r.text);
  });

  await check("旧密码不对时改密码被拒绝", async function () {
    const r = await request(A, "POST", "/api/password", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ current: "nope", next: "newpass123" })
    });
    assert.strictEqual(r.status, 400, r.text);
  });

  await check("改密码后旧会话失效、新密码可用", async function () {
    const r = await request(A, "POST", "/api/password", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ current: "admin", next: "newpass123" })
    });
    assert.strictEqual(r.status, 200, r.text);
    const fresh = json(r);
    assert.ok(fresh.csrf);

    // 旧 cookie 应已失效
    const stale = await request(A, "GET", "/api/state", { headers: { Cookie: cookie } });
    assert.strictEqual(stale.status, 401, "旧会话应失效，实际 " + stale.status);

    // 旧密码登录失败
    const oldLogin = await request(A, "POST", "/api/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" })
    });
    assert.strictEqual(oldLogin.status, 401, "旧密码应失效");

    // 新密码登录成功
    const newLogin = await request(A, "POST", "/api/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "newpass123" })
    });
    assert.strictEqual(newLogin.status, 200, newLogin.text);
    cookie = String(newLogin.headers["set-cookie"][0]).split(";")[0];
    csrf = json(newLogin).csrf;
  });

  await check("退出登录后写操作重新被拒绝", async function () {
    const r = await request(A, "POST", "/api/logout", {
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({})
    });
    assert.strictEqual(r.status, 200, r.text);
    const after = await request(A, "GET", "/api/session", { headers: { Cookie: cookie } });
    assert.strictEqual(json(after).authed, false);
  });

  /* ---------------- 收尾 ---------------- */

  try {
    await Promise.race([
      app.stopServers(),
      new Promise(function (resolve) {
        setTimeout(resolve, 3000);
      })
    ]);
  } catch (e) {
    console.log("  关闭服务时出错：" + e.message);
  }

  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (e) {
    console.log("  清理临时目录失败（可手动删除）：" + TMP);
  }

  console.log("");
  console.log("============================================");
  console.log("  通过 " + passed + " 项，失败 " + failed + " 项");
  console.log("============================================");
  if (failed) {
    console.log("");
    console.log("失败明细：");
    failures.forEach(function (f) {
      console.log("  - " + f);
    });
    console.log("");
    process.exitCode = 1;
  } else {
    console.log("");
    console.log("全部通过，minilist 可以正常使用。");
    console.log("");
    process.exitCode = 0;
  }

  // 兜底：万一还有残留的 keep-alive 连接，3 秒后强制结束，避免脚本卡住
  setTimeout(function () {
    process.exit(process.exitCode || 0);
  }, 3000).unref();
}

main().catch(function (err) {
  console.error("");
  console.error("自检脚本自身出错：");
  console.error(err && err.stack ? err.stack : err);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
  process.exitCode = 1;
});