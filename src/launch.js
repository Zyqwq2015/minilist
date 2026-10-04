"use strict";

/**
 * minilist 启动器
 *
 *   node src/launch.js [选项]
 *
 *   --port <n>        控制台端口（默认 8787）
 *   --site-port <n>   投放端口（默认 8788）
 *   --host <addr>    监听地址（默认 0.0.0.0，即整个局域网可访问）
 *   --folder <path>   启动时直接指定要展示的文件夹
 *   --html <path>     启动时直接投放一个 HTML 文件或网站文件夹
 *   --password <pw>   设置登录密码（首次运行有效，也可随时改）
 *   --no-open         不自动打开界面窗口
 *   --no-app          用普通浏览器标签页打开（默认应用窗口模式）
 *   --console         强制保留命令行窗口（默认打包版不显示）
 *   --help            显示帮助
 *
 * 打包成 GUI 子系统的 exe 后，双击启动时系统不会分配控制台：
 * 此时所有日志写进 数据目录\minilist.log，出错用系统弹窗提示，
 * 交互界面是自动打开的 minilist 应用窗口（纯黑白）。
 */

const fs = require("fs");
const path = require("path");
const util = require("util");
const { spawn, spawnSync } = require("child_process");

/* ---------------- 输出通道：没有控制台也不能崩 ---------------- */

function mute(stream) {
  try {
    if (stream && typeof stream.on === "function") stream.on("error", function () {});
  } catch (e) {
    /* ignore */
  }
}

mute(process.stdout);
mute(process.stderr);

/** fd 1 真的可写吗？GUI 子系统双击启动时不可写 */
function stdoutUsable() {
  try {
    fs.fstatSync(1);
    return true;
  } catch (e) {
    return false;
  }
}

const HAS_CONSOLE = stdoutUsable();
let LOG_FILE = null;

function writeLine(text) {
  const line = String(text == null ? "" : text) + "\n";
  if (HAS_CONSOLE) {
    try {
      fs.writeSync(1, line);
      return;
    } catch (e) {
      /* 退到日志文件 */
    }
  }
  if (!LOG_FILE) return;
  try {
    fs.appendFileSync(LOG_FILE, line, "utf8");
  } catch (e) {
    /* ignore */
  }
}

// 让项目里所有 console.log / console.error 都走安全通道
function installConsole() {
  const wrap = function () {
    writeLine(util.format.apply(util, arguments));
  };
  console.log = wrap;
  console.info = wrap;
  console.warn = wrap;
  console.error = wrap;
}

installConsole();

const cfgmod = require("./config");

try {
  fs.mkdirSync(cfgmod.DATA_DIR, { recursive: true });
  LOG_FILE = path.join(cfgmod.DATA_DIR, "minilist.log");
} catch (e) {
  LOG_FILE = null;
}

const netinfo = require("./net");
const { createApp, VERSION } = require("./server");

/** GUI 模式（没有控制台）用系统弹窗告诉用户出了什么事 */
function showAlert(title, text) {
  if (process.platform !== "win32" || HAS_CONSOLE) return;
  const psQuote = function (v) {
    return "'" + String(v == null ? "" : v).replace(/'/g, "''") + "'";
  };
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "[System.Windows.Forms.MessageBox]::Show(" +
      psQuote(text) +
      ", " +
      psQuote(title) +
      ", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null"
  ].join("; ");
  try {
    spawnSync("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 120000
    });
  } catch (e) {
    /* 弹窗失败也没别的办法了 */
  }
}

function parseArgs(argv) {
  const out = { open: true, app: true };
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const next = function () {
      i += 1;
      return list[i];
    };
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--no-open") out.open = false;
    else if (a === "--no-app") out.app = false;
    else if (a === "--console") out.forceConsole = true;
    else if (a === "--port") out.port = next();
    else if (a.indexOf("--port=") === 0) out.port = a.slice(7);
    else if (a === "--site-port") out.sitePort = next();
    else if (a.indexOf("--site-port=") === 0) out.sitePort = a.slice(12);
    else if (a === "--host") out.host = next();
    else if (a.indexOf("--host=") === 0) out.host = a.slice(7);
    else if (a === "--folder") out.folder = next();
    else if (a.indexOf("--folder=") === 0) out.folder = a.slice(9);
    else if (a === "--html") out.html = next();
    else if (a.indexOf("--html=") === 0) out.html = a.slice(7);
    else if (a === "--password") out.password = next();
    else if (a.indexOf("--password=") === 0) out.password = a.slice(11);
    else if (a.trim()) console.log("[minilist] 忽略未知参数：" + a);
  }
  return out;
}

function printHelp() {
  console.log("minilist " + VERSION + " —— 把 HTML 投放到局域网端口，并展示指定文件夹的文件");
  console.log("");
  console.log("用法： node src/launch.js [选项]");
  console.log("");
  console.log("  --port <n>        控制台端口（默认 8787）");
  console.log("  --site-port <n>   投放端口（默认 8788）");
  console.log("  --host <addr>     监听地址（默认 0.0.0.0）");
  console.log("  --folder <path>   直接指定要展示的文件夹");
  console.log("  --html <path>     直接投放一个 HTML 文件或网站文件夹");
  console.log("  --password <pw>   设置登录密码");
  console.log("  --no-open         不自动打开界面窗口");
  console.log("  --no-app          用普通浏览器标签页打开");
  console.log("  --console         强制保留命令行窗口");
  console.log("  --help            显示帮助");
}

function openInBrowser(url, preferApp) {
  const platform = process.platform;
  if (platform === "win32") {
    if (preferApp) {
      const candidates = [
        path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe")
      ];
      for (let i = 0; i < candidates.length; i++) {
        if (fs.existsSync(candidates[i])) {
          try {
            spawn(candidates[i], ["--app=" + url], { detached: true, stdio: "ignore", windowsHide: false }).unref();
            return true;
          } catch (e) {
            /* 换下一个 */
          }
        }
      }
    }
    try {
      spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      return true;
    } catch (e) {
      return false;
    }
  }
  try {
    if (platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch (e) {
    return false;
  }
}

function line(label, value) {
  console.log("  " + label + "  " + value);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  // 无控制台版本的 exe 上加 --console：用 cmd start 重新拉起一次，
  // 这样 Windows 会给它分配一个真正的命令行窗口。
  if (args.forceConsole && !HAS_CONSOLE && process.platform === "win32" && !process.env.MINILIST_RELAUNCHED) {
    try {
      const passArgs = process.argv.slice(2);
      spawn("cmd.exe", ["/c", "start", "", process.execPath].concat(passArgs), {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        env: Object.assign({}, process.env, { MINILIST_RELAUNCHED: "1" })
      }).unref();
      process.exit(0);
    } catch (e) {
      /* 拉不起来就继续按无窗口模式跑 */
    }
  }

  cfgmod.ensureAppDirs();

  const app = createApp();
  const cfg = app.config;
  const store = app.state.store;

  if (args.host) cfg.host = String(args.host);
  if (args.port !== undefined && isFinite(Number(args.port))) cfg.port = Math.max(1, Math.min(65535, Math.floor(Number(args.port))));
  if (args.sitePort !== undefined && isFinite(Number(args.sitePort))) cfg.sitePort = Math.max(1, Math.min(65535, Math.floor(Number(args.sitePort))));

  if (args.password) {
    try {
      store.setPassword(String(args.password));
      console.log("[minilist] 登录密码已更新。");
    } catch (e) {
      console.error("[minilist] 设置密码失败：" + e.message);
    }
  }
  store.save();

  if (args.folder) {
    const abs = path.resolve(String(args.folder));
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        cfg.sharedFolder = abs;
        store.save();
        console.log("[minilist] 共享文件夹：" + abs);
      } else {
        console.error("[minilist] --folder 不是文件夹：" + abs);
      }
    } catch (e) {
      console.error("[minilist] --folder 路径不存在：" + abs);
    }
  }

  if (args.html) {
    const abs = path.resolve(String(args.html));
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        const index = path.join(abs, "index.html");
        if (fs.existsSync(index)) {
          cfg.published = { root: abs, entry: "index.html", label: path.basename(abs), kind: "dir", at: Date.now() };
        } else {
          console.error("[minilist] --html 文件夹里没有 index.html：" + abs);
        }
      } else if (st.isFile()) {
        cfg.published = {
          root: path.dirname(abs),
          entry: path.basename(abs),
          label: path.basename(abs),
          kind: "file",
          at: Date.now()
        };
      }
      if (cfg.published) {
        store.save();
        console.log("[minilist] 已投放：" + cfg.published.root + " -> " + cfg.published.entry);
      }
    } catch (e) {
      console.error("[minilist] --html 路径不存在：" + abs);
    }
  }

  let bound;
  try {
    bound = await app.startServers();
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    console.error("");
    console.error("[minilist] 启动失败：" + reason);
    let tip = "";
    if (e && e.code === "EADDRINUSE") {
      tip = "端口被占用了，请换一个端口：minilist.exe --port 9000 --site-port 9001";
    } else if (e && e.code === "EACCES") {
      tip = "没有权限监听这个端口，请换一个端口，或以管理员身份运行。";
    }
    if (tip) console.error("         " + tip);
    try {
      await app.stopServers();
    } catch (e2) {
      /* ignore */
    }
    showAlert("minilist 启动失败", "minilist 启动失败：\n\n" + reason + (tip ? "\n\n" + tip : "") + "\n\n日志：" + (LOG_FILE || "(无)"));
    process.exitCode = 1;
    return;
  }

  const local = "http://127.0.0.1:" + bound.adminPort;
  const anyHost = cfg.host === "0.0.0.0" || cfg.host === "::" || cfg.host === "";
  const lanAdmin = netinfo.urlsFor(bound.adminPort);
  const lanSite = netinfo.urlsFor(bound.sitePort);

  console.log("");
  console.log("  ============================================");
  console.log("   minilist " + VERSION + "  已启动");
  console.log("  ============================================");
  line("控制台：", local + "/admin/");
  line("文件浏览：", local + "/files/");
  if (anyHost && lanAdmin.length) {
    line("局域网控制台：", lanAdmin[0] + "/admin/");
    line("局域网文件：", lanAdmin[0] + "/files/");
  }
  if (cfg.published) {
    line("投放端口：", "http://127.0.0.1:" + bound.sitePort + "/");
  } else {
    line("投放端口：", "http://127.0.0.1:" + bound.sitePort + "/   （尚未投放页面）");
  }
  if (anyHost && lanSite.length) {
    line("局域网投放：", lanSite[0]);
  }
  line("共享文件夹：", cfg.sharedFolder || "(未设置)");
  line("投放内容：", cfg.published ? cfg.published.root + "  ->  " + cfg.published.entry : "(未投放)");
  line("数据目录：", cfgmod.DATA_DIR);
  line("资源目录：", cfgmod.RESOURCE_ROOT + (cfgmod.IS_PACKAGED ? "   （已打包）" : "   （源码运行）"));
  if (!HAS_CONSOLE) line("日志文件：", LOG_FILE || "(无)");
  console.log("");
  if (cfg.auth.mustChange) {
    console.log("  首次使用默认账号： admin / " + cfgmod.DEFAULT_PASSWORD + "   （请尽快在控制台里修改密码）");
  } else {
    console.log("  账号： " + cfg.auth.username + "   （密码已设置）");
  }
  if (anyHost) {
    console.log("  提示：Windows 首次监听 0.0.0.0 时防火墙会弹窗，请选择「允许访问」。");
  }
  console.log("  按 Ctrl+C 退出。");
  console.log("");

  if (!anyHost) {
    console.log("  当前只监听本机（" + cfg.host + "），局域网上的其它设备访问不到。");
    console.log("");
  }

  if (args.open) {
    const ok = openInBrowser(local + "/admin/", args.app);
    if (!ok) {
      console.log("  （自动打开界面窗口失败，请手动访问上面的地址）");
      showAlert("minilist 已启动", "自动打开界面窗口失败，请手动在浏览器里访问：\n\n" + local + "/admin/");
    }
  } else if (!HAS_CONSOLE) {
    showAlert("minilist 已启动", "minilist 已在后台运行，界面地址：\n\n" + local + "/admin/");
  }

  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log("");
    console.log("[minilist] 收到 " + signal + "，正在退出…");
    try {
      await app.stopServers();
    } catch (e) {
      /* ignore */
    }
    process.exit(0);
  }

  process.on("SIGINT", function () {
    shutdown("SIGINT");
  });
  process.on("SIGTERM", function () {
    shutdown("SIGTERM");
  });
}

// 没有控制台时也要能优雅退出：打包版用不到 Ctrl+C，退出请点界面里的「退出 minilist」
process.on("uncaughtException", function (err) {
  console.error("[minilist] 未捕获的异常：");
  console.error(err && err.stack ? err.stack : String(err));
  showAlert("minilist 出错", "minilist 遇到未处理的错误：\n\n" + (err && err.message ? err.message : String(err)) + "\n\n日志：" + (LOG_FILE || "(无)"));
  process.exit(1);
});

main().catch(function (err) {
  console.error("[minilist] 未捕获的错误：");
  console.error(err && err.stack ? err.stack : err);
  showAlert("minilist 出错", "minilist 启动过程中出错：\n\n" + (err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});