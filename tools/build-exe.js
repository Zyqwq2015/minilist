"use strict";

/**
 * 把 minilist 打包成单个 exe。
 *
 *   node tools/build-exe.js
 *   node tools/build-exe.js --target node20-win-x64 --out dist/minilist.exe
 *   node tools/build-exe.js --console-subsystem     # 保留黑色命令行窗口（调试用）
 *
 * 原理：用 pkg 把 Node 运行时 + 全部 JS + public/ 前端文件塞进一个可执行文件。
 *
 * 打包完还会把 PE 头的 Subsystem 从「控制台」改成「GUI」，
 * 这样双击时 Windows 根本不会分配黑色命令行窗口，
 * 用户看到的只有自动打开的 minilist 应用窗口（纯黑白界面）。
 * 日志改写到 数据目录\minilist.log，出错用系统弹窗提示。
 *
 * 打包后 data/ 和 content/ 会生成在 exe 旁边（exe 所在目录不可写时退到
 * %LOCALAPPDATA%\minilist），前端资源则从 exe 内部的只读快照读取。
 *
 * 第一次运行需要联网下载对应平台的 Node 基础二进制（约 40MB），
 * 之后会缓存在 %USERPROFILE%\.pkg-cache 里，可离线重复打包。
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "launch.js");

const SUBSYSTEM_GUI = 2; // IMAGE_SUBSYSTEM_WINDOWS_GUI
const SUBSYSTEM_CUI = 3; // IMAGE_SUBSYSTEM_WINDOWS_CUI

function parseArgs(argv) {
  const out = {
    target: "node20-win-x64",
    out: path.join(ROOT, "dist", "minilist.exe"),
    gui: true
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target" && argv[i + 1]) out.target = argv[++i];
    else if (a.indexOf("--target=") === 0) out.target = a.slice(9);
    else if (a === "--out" && argv[i + 1]) out.out = path.resolve(argv[++i]);
    else if (a.indexOf("--out=") === 0) out.out = path.resolve(a.slice(6));
    else if (a === "--console-subsystem") out.gui = false;
    else if (a === "--gui-subsystem") out.gui = true;
  }
  return out;
}

/**
 * 直接改 PE 可选头里的 Subsystem 字段。
 * 布局：DOS 头 e_lfanew(0x3C) -> "PE\0\0"(4) -> COFF 头(20) -> 可选头，
 * Subsystem 在可选头偏移 68（PE32 / PE32+ 都一样），是个 UInt16。
 * 这样就不需要 editbin 之类的额外工具。
 */
function patchSubsystem(file, subsystem) {
  const fd = fs.openSync(file, "r+");
  try {
    const dos = Buffer.alloc(64);
    if (fs.readSync(fd, dos, 0, 64, 0) < 64) throw new Error("文件太小，不是 PE 文件");
    if (dos.readUInt16LE(0) !== 0x5a4d) throw new Error("缺少 MZ 头，不是 Windows 可执行文件");

    const peOff = dos.readUInt32LE(0x3c);
    const sig = Buffer.alloc(4);
    fs.readSync(fd, sig, 0, 4, peOff);
    if (sig.readUInt32LE(0) !== 0x00004550) throw new Error("缺少 PE 签名");

    const off = peOff + 4 + 20 + 68;
    const cur = Buffer.alloc(2);
    fs.readSync(fd, cur, 0, 2, off);
    const before = cur.readUInt16LE(0);

    const next = Buffer.alloc(2);
    next.writeUInt16LE(subsystem, 0);
    fs.writeSync(fd, next, 0, 2, off);

    return { before: before, after: subsystem };
  } finally {
    fs.closeSync(fd);
  }
}

function subsystemName(v) {
  if (v === SUBSYSTEM_GUI) return "GUI（无控制台窗口）";
  if (v === SUBSYSTEM_CUI) return "Console（黑色命令行窗口）";
  return "未知(" + v + ")";
}

function runShell(cmdline) {
  return new Promise(function (resolve) {
    const child = spawn(cmdline, { cwd: ROOT, stdio: "inherit", shell: true });
    child.on("error", function (e) {
      resolve({ ok: false, error: e.message });
    });
    child.on("close", function (code) {
      resolve({ ok: code === 0, code: code });
    });
  });
}

function human(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("");
  console.log("  minilist 打包成 exe");
  console.log("  ----------------------------------------");
  console.log("  入口：  " + ENTRY);
  console.log("  目标：  " + args.target);
  console.log("  输出：  " + args.out);
  console.log("  Node：  " + process.version);
  console.log("");

  if (!fs.existsSync(ENTRY)) {
    console.error("  找不到入口文件：" + ENTRY);
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });

  // 优先用还在维护的 @yao-pkg/pkg（支持 node20/node22）
  //
  // 这里必须传「项目目录 .」而不是入口文件 src/launch.js：
  // pkg 的 assets 是相对"传入的入口"解析的，传文件时会去 src/public 找，
  // 结果前端资源一个都没打进去，exe 跑起来全是 404。
  const attempts = [
    {
      name: "@yao-pkg/pkg",
      cmdline: 'npx --yes @yao-pkg/pkg . --targets "' + args.target + '" --output "' + args.out + '"'
    },
    {
      name: "pkg@5.8.1（旧版，最高只到 node18）",
      cmdline: 'npx --yes pkg@5.8.1 . --targets node18-win-x64 --output "' + args.out + '"'
    }
  ];

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    console.log("  [" + (i + 1) + "/" + attempts.length + "] 正在用 " + attempt.name + " 打包，第一次会下载基础二进制，请耐心等待…");
    console.log("");

    const res = await runShell(attempt.cmdline);

    if (res.ok && fs.existsSync(args.out)) {
      const size = fs.statSync(args.out).size;

      let patchNote = "保持命令行窗口（--console-subsystem）";
      if (args.gui) {
        try {
          const r = patchSubsystem(args.out, SUBSYSTEM_GUI);
          patchNote = subsystemName(r.before) + "  ->  " + subsystemName(r.after);
        } catch (e) {
          patchNote = "改写子系统失败：" + e.message + "（双击仍会看到命令行窗口）";
        }
      }

      console.log("");
      console.log("  ========================================");
      console.log("   打包成功");
      console.log("  ========================================");
      console.log("   文件：" + args.out + "  （" + human(size) + "）");
      console.log("   子系统：" + patchNote);
      console.log("");
      console.log("   双击它就能启动 minilist，不需要装 Node，也不会出现黑色命令行窗口。");
      console.log("   会自动打开纯黑白的 minilist 应用窗口。");
      console.log("   data\\ 和 content\\ 会生成在 exe 旁边。");
      console.log("");
      console.log("   想临时看日志：命令行里运行 minilist.exe --console");
      console.log("   数据目录\\minilist.log 里也有完整日志。");
      console.log("");
      return;
    }

    console.log("");
    console.log("  " + attempt.name + " 没有成功" + (res.code !== undefined ? "（退出码 " + res.code + "）" : "") + "。");
    if (i < attempts.length - 1) console.log("  换一个打包器再试一次…");
    console.log("");
  }

  console.error("  打包失败。请检查：");
  console.error("    1. 是否有网络：需要从 GitHub 下载 Node 基础二进制；");
  console.error("    2. 是否装了 Node.js 16+ 且 npx 可用（node -v / npx -v）；");
  console.error("    3. 公司网络/代理是否拦截了 github.com（可设 HTTPS_PROXY 后重试）；");
  console.error("    4. 也可以手动执行下面这条命令，看完整报错：");
  console.error('       npx --yes pkg@5.8.1 . --targets node18-win-x64 --output "dist/minilist.exe"');
  console.error("");
  console.error("  打包不了也不影响使用：直接双击 启动minilist.cmd 一样能跑（只要装了 Node）。");
  console.error("");
  process.exitCode = 1;
}

main().catch(function (err) {
  console.error("打包脚本自身出错：" + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
