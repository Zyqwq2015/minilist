"use strict";

/**
 * 在"运行 minilist 的这台机器"上弹出原生选择框，把绝对路径回传给网页。
 * 只有登录后才能调用（否则任何人都能让服务器弹窗）。
 *
 * Windows 用系统自带的 Windows PowerShell + WinForms；
 * macOS 用 osascript；Linux 尝试 zenity / kdialog。
 * 任何一步失败都返回 { ok:false, error }，网页会退回"手动填写路径"。
 */

const { spawn } = require("child_process");

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function psQuote(value) {
  return "'" + String(value == null ? "" : value).replace(/'/g, "''") + "'";
}

function runCommand(exe, args, timeoutMs) {
  return new Promise(function (resolve) {
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, output: "", error: "无法启动 " + exe + "：" + e.message });
      return;
    }

    let out = "";
    let err = "";
    let settled = false;

    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch (e) {
        /* ignore */
      }
      resolve({ ok: false, output: "", error: "等待选择超时（" + Math.round(timeoutMs / 1000) + " 秒）" });
    }, timeoutMs);

    if (child.stdout) child.stdout.on("data", function (d) { out += d.toString("utf8"); });
    if (child.stderr) child.stderr.on("data", function (d) { err += d.toString("utf8"); });

    child.on("error", function (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, output: "", error: "无法启动 " + exe + "：" + e.message });
    });

    child.on("close", function (code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim(), error: err.trim(), code: code, missing: false });
    });
  });
}

/* --------------------------- Windows --------------------------- */

function windowsScript(kind, options) {
  const title = options.title || (kind === "folder" ? "选择文件夹" : "选择文件");
  const lines = [];
  lines.push("$ErrorActionPreference = 'Stop'");
  lines.push("try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}");
  lines.push("Add-Type -AssemblyName System.Windows.Forms | Out-Null");
  lines.push("$owner = New-Object System.Windows.Forms.Form");
  lines.push("$owner.Text = 'minilist'");
  lines.push("$owner.ShowInTaskbar = $false");
  lines.push("$owner.WindowState = 'Minimized'");
  lines.push("$owner.TopMost = $true");

  if (kind === "folder") {
    lines.push("$dlg = New-Object System.Windows.Forms.FolderBrowserDialog");
    lines.push("$dlg.Description = " + psQuote(title));
    lines.push("$dlg.ShowNewFolderButton = $true");
    if (options.initial) {
      lines.push("if (Test-Path -LiteralPath " + psQuote(options.initial) + ") { $dlg.SelectedPath = " + psQuote(options.initial) + " }");
    }
    lines.push("$result = $dlg.ShowDialog($owner)");
    lines.push("if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.SelectedPath) }");
  } else {
    lines.push("$dlg = New-Object System.Windows.Forms.OpenFileDialog");
    lines.push("$dlg.Title = " + psQuote(title));
    lines.push("$dlg.Filter = " + psQuote(options.filter || "所有文件 (*.*)|*.*"));
    lines.push("$dlg.Multiselect = $false");
    lines.push("$dlg.CheckFileExists = $true");
    if (options.initial) {
      lines.push("if (Test-Path -LiteralPath " + psQuote(options.initial) + ") { $dlg.InitialDirectory = " + psQuote(options.initial) + " }");
    }
    lines.push("$result = $dlg.ShowDialog($owner)");
    lines.push("if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dlg.FileName) }");
  }

  lines.push("$dlg.Dispose()");
  lines.push("$owner.Dispose()");
  return lines.join("\r\n");
}

function windowsPowerShellCandidates() {
  const list = [];
  if (process.env.MINILIST_POWERSHELL) list.push(process.env.MINILIST_POWERSHELL);
  list.push("powershell.exe");
  list.push("pwsh.exe");
  const winDir = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  list.push(winDir + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  return list;
}

async function pickWindows(kind, options, timeoutMs) {
  const script = windowsScript(kind, options);
  const args = ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script];
  const candidates = windowsPowerShellCandidates();
  let lastError = "";
  for (let i = 0; i < candidates.length; i++) {
    const res = await runCommand(candidates[i], args, timeoutMs);
    if (res.ok) {
      if (!res.output) return { ok: false, canceled: true };
      return { ok: true, path: res.output };
    }
    const errText = String(res.error || "");
    // 命令本身失败（例如用户环境限制）与"找不到可执行文件"要分开
    if (errText.indexOf("ENOENT") >= 0 || errText.indexOf("无法启动") === 0) {
      lastError = errText;
      continue;
    }
    lastError = errText || "选择框返回了错误";
    return { ok: false, error: lastError };
  }
  return { ok: false, error: lastError || "找不到可用的 PowerShell" };
}

/* --------------------------- macOS --------------------------- */

function osaQuote(value) {
  return '"' + String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

async function pickMac(kind, options, timeoutMs) {
  const title = options.title || (kind === "folder" ? "选择文件夹" : "选择文件");
  const base = kind === "folder"
    ? "POSIX path of (choose folder with prompt " + osaQuote(title) + ")"
    : "POSIX path of (choose file with prompt " + osaQuote(title) + ")";
  const res = await runCommand("osascript", ["-e", base], timeoutMs);
  if (res.ok) {
    if (!res.output) return { ok: false, canceled: true };
    return { ok: true, path: res.output };
  }
  if (String(res.error).indexOf("User canceled") >= 0 || res.code === 1) {
    return { ok: false, canceled: true };
  }
  return { ok: false, error: res.error || "osascript 调用失败" };
}

/* --------------------------- Linux --------------------------- */

async function pickLinux(kind, options, timeoutMs) {
  const title = options.title || (kind === "folder" ? "选择文件夹" : "选择文件");
  const zenityArgs = ["--file-selection", "--title=" + title];
  if (kind === "folder") zenityArgs.push("--directory");
  let res = await runCommand("zenity", zenityArgs, timeoutMs);
  if (res.ok) {
    if (!res.output) return { ok: false, canceled: true };
    return { ok: true, path: res.output };
  }
  if (String(res.error).indexOf("无法启动") !== 0) {
    return { ok: false, canceled: res.code === 1 };
  }
  const kdialogArgs = kind === "folder" ? ["--getexistingdirectory", options.initial || "."] : ["--getopenfilename", options.initial || "."];
  res = await runCommand("kdialog", ["--title", title].concat(kdialogArgs), timeoutMs);
  if (res.ok) {
    if (!res.output) return { ok: false, canceled: true };
    return { ok: true, path: res.output };
  }
  return { ok: false, error: "系统里没有找到 zenity 或 kdialog，请手动填写路径" };
}

/* --------------------------- 对外接口 --------------------------- */

/**
 * kind: "file" | "folder"
 * options: { title, filter, initial }
 * 返回 { ok:true, path } | { ok:false, canceled:true } | { ok:false, error }
 */
async function pickPath(kind, options, timeoutMs) {
  const opts = options || {};
  const timeout = timeoutMs && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const platform = process.platform;
  if (platform === "win32") return pickWindows(kind, opts, timeout);
  if (platform === "darwin") return pickMac(kind, opts, timeout);
  return pickLinux(kind, opts, timeout);
}

module.exports = { pickPath };