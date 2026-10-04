"use strict";

/* minilist 控制台逻辑 */

(function () {
  var $ = ML.$;
  var esc = ML.esc;

  var session = null; // /api/session 的返回
  var st = null; // /api/state 的返回（登录后）

  /* ------------------------------ 小工具 ------------------------------ */

  function busy(btn, on, label) {
    if (!btn) return;
    if (on) {
      if (!btn.getAttribute("data-origin")) btn.setAttribute("data-origin", btn.innerHTML);
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> ' + esc(label || "处理中…");
    } else {
      btn.disabled = false;
      var origin = btn.getAttribute("data-origin");
      if (origin) btn.innerHTML = origin;
    }
  }

  function setStatus(text, kind) {
    $("#statusText").textContent = text;
    var dot = $("#statusDot");
    // 纯黑白：正常 = 实心圆，出错 = 空心圆，不用颜色区分
    if (dot) dot.classList.toggle("err", kind === "err");
  }

  function currentHost() {
    if (st && st.host) return st.host;
    if (session && session.info && session.info.host) return session.info.host;
    return "0.0.0.0";
  }

  function isLoopback(host) {
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  }

  function renderUrlList(container, entries) {
    container.innerHTML = "";
    entries.forEach(function (item) {
      var row = document.createElement("div");
      row.className = "url-row";

      var tag = document.createElement("span");
      tag.className = "small muted";
      tag.textContent = item.label;

      var code = document.createElement("code");
      code.textContent = item.url;

      var open = document.createElement("a");
      open.className = "btn sm ghost";
      open.href = item.url;
      open.target = "_blank";
      open.rel = "noopener";
      open.textContent = "打开";

      row.appendChild(tag);
      row.appendChild(code);
      row.appendChild(ML.copyButton(item.url));
      row.appendChild(open);
      container.appendChild(row);
    });
  }

  function buildEntries(port, suffix, lanBase) {
    var list = [{ label: "本机", url: "http://127.0.0.1:" + port + suffix }];
    if (!isLoopback(currentHost())) {
      (lanBase || []).forEach(function (u) {
        list.push({ label: "局域网", url: u + suffix });
      });
    }
    return list;
  }

  function setDisabled(selector, disabled) {
    ML.$$(selector).forEach(function (el) {
      if (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.tagName === "BUTTON") {
        el.disabled = !!disabled;
      } else {
        el.classList.toggle("is-disabled", !!disabled);
      }
    });
  }

  /* ------------------------------ 渲染 ------------------------------ */

  function render() {
    var authed = !!(session && session.authed);
    var info = (session && session.info) || {};

    document.title = (info.title || "minilist") + " 控制台";
    $("#ver").textContent = "v" + (info.version || "1.0.0");
    $("#who").textContent = authed ? "已登录：" + session.user : "未登录 · 只读";
    $("#btnLogin").hidden = authed;
    $("#btnLogout").hidden = !authed;
    $("#readonlyBar").hidden = authed;

    var mustChange = authed ? !!(st && st.mustChangePassword) : !!info.mustChangePassword;
    $("#firstRun").hidden = !mustChange;

    renderPublish(authed, info);
    renderShare(authed, info);
    renderSettings(authed, info);
    renderAccount(authed);

    var stat = [];
    if (st) {
      stat.push("运行 " + ML.fmtUptime(st.uptime));
      stat.push("控制台端口 " + st.adminPort + " · 投放端口 " + st.boundSitePort);
    }
    $("#footStat").textContent = stat.join("  ·  ");

    setDisabled(".write-only", !authed);
    if (!authed) {
      var pathInputs = ["pubPath", "sharePath"];
      pathInputs.forEach(function (id) {
        var el = $(id);
        if (el) el.placeholder = "登录后才能使用";
      });
    }
  }

  function renderPublish(authed, info) {
    var pub = st ? st.published : info.published;
    var sitePort = st ? st.boundSitePort : info.sitePort;
    var lanBase = st ? st.siteUrls : info.siteUrls;

    var badge = $("#pubBadge");
    if (pub) {
      badge.textContent = "已投放";
      badge.className = "badge on";
      $("#pubLabel").textContent = pub.label + (pub.kind === "dir" ? "（文件夹站点）" : "");
      $("#pubRoot").textContent = (st && st.published ? st.published.root : "") || "登录后可查看完整路径";
    } else {
      badge.textContent = "未投放";
      badge.className = "badge off";
      $("#pubLabel").textContent = "—";
      $("#pubRoot").textContent = "—";
    }

    renderUrlList($("#pubUrls"), buildEntries(sitePort, "/", lanBase));
  }

  function renderShare(authed, info) {
    var folder = st ? st.sharedFolder : (info.sharedFolder || "");
    var adminPort = st ? st.adminPort : info.adminPort;
    var lanBase = st ? st.shareUrls : info.shareUrls;

    var badge = $("#shareBadge");
    if (folder) {
      badge.textContent = "共享中";
      badge.className = "badge on";
      $("#shareFolder").textContent = folder;
    } else {
      badge.textContent = "未设置";
      badge.className = "badge off";
      $("#shareFolder").textContent = "—";
    }

    var local = "http://127.0.0.1:" + adminPort + "/files/";
    $("#shareLink").textContent = local;
    $("#btnGotoFiles").href = "/files/";

    renderUrlList($("#shareUrls"), buildEntries(adminPort, "/files/", lanBase));
  }

  function renderSettings(authed, info) {
    var hostSelect = $("#setHost");
    hostSelect.innerHTML =
      '<option value="0.0.0.0">0.0.0.0（整个局域网都能访问）</option>' +
      '<option value="127.0.0.1">127.0.0.1（只有本机能访问）</option>';

    if (st) {
      $("#setPort").value = st.port;
      $("#setSitePort").value = st.sitePort;
      if (st.host !== "0.0.0.0" && st.host !== "127.0.0.1") {
        var opt = document.createElement("option");
        opt.value = st.host;
        opt.textContent = st.host;
        hostSelect.appendChild(opt);
      }
      hostSelect.value = st.host === "127.0.0.1" ? "127.0.0.1" : st.host;
      $("#setTitle").value = st.title || "minilist";
      $("#setLimit").value = st.uploadLimitMB;
      $("#settingsHint").textContent = "当前实际监听：控制台 " + st.adminPort + "，投放 " + st.boundSitePort + "。";
    } else if (authed) {
      $("#settingsHint").textContent = "";
    } else {
      $("#settingsHint").textContent = "登录后才能修改设置。";
    }
  }

  function renderAccount(authed) {
    var box = $("#accountBody");
    if (!authed) {
      box.innerHTML =
        '<div class="login-cta">' +
        '<div><b>未登录</b><div class="small muted">登录后才能上传、修改、删除和投放。</div></div>' +
        '<button class="btn primary" id="btnLoginInline" type="button">立即登录</button>' +
        "</div>";
      var btn = $("#btnLoginInline");
      if (btn) btn.addEventListener("click", openLogin);
      return;
    }

    box.innerHTML =
      '<div class="grid2">' +
      '<div class="field"><label for="acUser">用户名</label><input type="text" id="acUser"></div>' +
      '<div class="field"><label for="acCurrent">当前密码</label><input type="password" id="acCurrent" autocomplete="current-password"></div>' +
      '<div class="field"><label for="acNext">新密码</label><input type="password" id="acNext" autocomplete="new-password"></div>' +
      '<div class="field"><label for="acNext2">确认新密码</label><input type="password" id="acNext2" autocomplete="new-password"></div>' +
      "</div>" +
      '<div class="btn-row"><button class="btn primary" id="btnSavePassword" type="button">修改密码</button></div>' +
      '<div class="hint">修改密码后，所有已登录的会话都会失效，当前浏览器会自动重新登录。</div>';

    $("#acUser").value = st ? st.username : "";
    $("#btnSavePassword").addEventListener("click", savePassword);
  }

  /* ------------------------------ 数据刷新 ------------------------------ */

  function refresh() {
    return ML.get("/api/session")
      .then(function (res) {
        session = res;
        ML.csrf = res.csrf;
        if (!res.authed) {
          st = null;
          render();
          return null;
        }
        return ML.get("/api/state").then(function (data) {
          st = data.state;
          if (data.csrf) ML.csrf = data.csrf;
          render();
          return null;
        });
      })
      .catch(function (err) {
        setStatus("连接失败", "err");
        ML.toast("读取状态失败：" + err.message, "err");
      });
  }

  function afterWrite(result) {
    if (result && result.state) {
      st = result.state;
      render();
    } else {
      return refresh();
    }
    return null;
  }

  /* ------------------------------ 登录 / 退出 ------------------------------ */

  function openLogin() {
    var content = document.createElement("div");
    content.innerHTML =
      '<div class="field"><label for="lgUser">用户名</label>' +
      '<input type="text" id="lgUser" autocomplete="username"></div>' +
      '<div class="field"><label for="lgPass">密码</label>' +
      '<input type="password" id="lgPass" autocomplete="current-password"></div>' +
      '<div class="hint" id="lgHint"></div>';

    var api = ML.modal({
      title: "登录 minilist",
      content: content,
      actions: [
        { label: "取消", onClick: function (m) { m.close(); } },
        { label: "登录", kind: "primary", id: "lgSubmit", onClick: function (m) { doLogin(m); } }
      ],
      onMount: function (m) {
        var userInput = document.getElementById("lgUser");
        var passInput = document.getElementById("lgPass");
        userInput.value = (session && session.info && session.info.username) || "admin";
        passInput.addEventListener("keydown", function (e) {
          if (e.key === "Enter") doLogin(m);
        });
        setTimeout(function () {
          try { passInput.focus(); } catch (e) { /* ignore */ }
        }, 40);
      }
    });
    return api;
  }

  function doLogin(modalApi) {
    var user = document.getElementById("lgUser").value.trim();
    var pass = document.getElementById("lgPass").value;
    var hint = document.getElementById("lgHint");
    var btn = document.getElementById("lgSubmit");

    if (!user) {
      hint.textContent = "请填写用户名";
      return;
    }
    busy(btn, true, "登录中…");
    ML.post("/api/login", { username: user, password: pass })
      .then(function (res) {
        ML.csrf = res.csrf;
        session = res;
        if (modalApi) modalApi.close();
        ML.toast("登录成功，现在可以修改内容了", "ok");
        return refresh();
      })
      .catch(function (err) {
        busy(btn, false);
        if (hint) hint.textContent = err.message;
      });
  }

  function logout() {
    ML.post("/api/logout", {})
      .then(function () {
        ML.csrf = null;
        session = null;
        st = null;
        ML.toast("已退出登录", "ok");
        return refresh();
      })
      .catch(function (err) {
        ML.toast("退出失败：" + err.message, "err");
      });
  }

  function savePassword() {
    var user = $("#acUser").value.trim();
    var current = $("#acCurrent").value;
    var next = $("#acNext").value;
    var next2 = $("#acNext2").value;
    if (next.length < 4) {
      ML.toast("新密码至少 4 位", "err");
      return;
    }
    if (next !== next2) {
      ML.toast("两次输入的新密码不一致", "err");
      return;
    }
    busy($("#btnSavePassword"), true, "保存中…");
    ML.post("/api/password", { username: user, current: current, next: next })
      .then(function (res) {
        if (res.csrf) ML.csrf = res.csrf;
        ML.toast("密码已更新", "ok");
        $("#acCurrent").value = "";
        $("#acNext").value = "";
        $("#acNext2").value = "";
        return refresh();
      })
      .catch(function (err) {
        ML.toast(err.message, "err");
      })
      .then(function () {
        busy($("#btnSavePassword"), false);
      });
  }

  /* ------------------------------ 投放操作 ------------------------------ */

  function pickAndPublish(kind) {
    var btn = kind === "file" ? $("#btnPickHtml") : $("#btnPickSite");
    busy(btn, true, "等待选择…");
    ML.toast("已在这台电脑上弹出选择框，请在弹出的窗口里选择…", "warn", 4000);
    ML.post("/api/pick", { kind: kind, for: "site" })
      .then(function (res) {
        busy(btn, false);
        if (res.canceled) return null;
        if (!res.ok) {
          ML.toast(res.error || "选择失败", "err");
          return null;
        }
        return publishPath(res.path);
      })
      .catch(function (err) {
        busy(btn, false);
        ML.toast(err.message, "err");
      });
  }

  function publishPath(p) {
    return ML.post("/api/publish/path", { path: p })
      .then(function (res) {
        ML.toast("已投放：" + (res.published ? res.published.label : p), "ok");
        return afterWrite(res);
      })
      .catch(function (err) {
        ML.toast(err.message, "err");
      });
  }

  function uploadHtml(file) {
    var btn = $("#btnUploadHtml");
    busy(btn, true, "上传中…");
    var fd = new FormData();
    fd.append("file", file, file.name);
    ML.upload("/api/publish/upload", fd, function (loaded, total) {
      if (total) busy(btn, true, "上传中 " + Math.round((loaded / total) * 100) + "%");
    })
      .then(function (res) {
        busy(btn, false);
        ML.toast("已上传并投放：" + (res.saved || file.name), "ok");
        return afterWrite(res);
      })
      .catch(function (err) {
        busy(btn, false);
        ML.toast(err.message, "err");
      });
  }

  function clearPublish() {
    ML.confirm("确定要停止投放吗？局域网上的投放地址将不再显示页面。", { okLabel: "停止投放", danger: true }).then(function (yes) {
      if (!yes) return;
      ML.post("/api/publish/clear", {})
        .then(function (res) {
          ML.toast("已停止投放", "ok");
          return afterWrite(res);
        })
        .catch(function (err) {
          ML.toast(err.message, "err");
        });
    });
  }

  /* ------------------------------ 共享文件夹操作 ------------------------------ */

  function pickFolder() {
    var btn = $("#btnPickFolder");
    busy(btn, true, "等待选择…");
    ML.toast("已在这台电脑上弹出选择框，请在弹出的窗口里选择…", "warn", 4000);
    ML.post("/api/pick", { kind: "folder" })
      .then(function (res) {
        busy(btn, false);
        if (res.canceled) return null;
        if (!res.ok) {
          ML.toast(res.error || "选择失败", "err");
          return null;
        }
        return setFolder(res.path);
      })
      .catch(function (err) {
        busy(btn, false);
        ML.toast(err.message, "err");
      });
  }

  function setFolder(p) {
    return ML.post("/api/share/folder", { path: p })
      .then(function (res) {
        ML.toast("共享文件夹已设置为：" + res.sharedFolder, "ok");
        return afterWrite(res);
      })
      .catch(function (err) {
        ML.toast(err.message, "err");
      });
  }

  function clearShare() {
    ML.confirm("确定要停止共享吗？文件浏览页将不再展示内容。", { okLabel: "停止共享", danger: true }).then(function (yes) {
      if (!yes) return;
      ML.post("/api/share/clear", {})
        .then(function (res) {
          ML.toast("已停止共享", "ok");
          return afterWrite(res);
        })
        .catch(function (err) {
          ML.toast(err.message, "err");
        });
    });
  }

  /* ------------------------------ 设置 ------------------------------ */

  function restartNotice(nextUrl) {
    var wrap = document.createElement("div");
    wrap.innerHTML =
      '<div class="notice ok"><span aria-hidden="true">■</span><div>服务正在重启，几秒钟后就能继续使用。</div></div>' +
      (nextUrl
        ? '<div class="hint">你刚刚改动了端口或监听地址，请用新地址重新打开控制台：<br>' +
          '<a href="' + esc(nextUrl) + '">' + esc(nextUrl) + "</a></div>"
        : "");
    ML.modal({
      title: "服务重启中",
      content: wrap,
      dismissable: false,
      actions: [
        {
          label: "我知道了",
          kind: "primary",
          onClick: function (m) {
            m.close();
          }
        }
      ]
    });
  }

  function saveSettings() {
    var body = {
      port: Number($("#setPort").value),
      sitePort: Number($("#setSitePort").value),
      host: $("#setHost").value,
      title: $("#setTitle").value,
      uploadLimitMB: Number($("#setLimit").value)
    };
    busy($("#btnSaveSettings"), true, "保存中…");
    ML.post("/api/settings", body)
      .then(function (res) {
        if (res.restarting) {
          ML.toast("设置已保存，服务正在重启", "ok");
          restartNotice(res.nextPort ? "http://127.0.0.1:" + res.nextPort + "/admin/" : "");
          return;
        }
        st = res.state;
        render();
        ML.toast("设置已保存", "ok");
      })
      .catch(function (err) {
        ML.toast(err.message, "err");
      })
      .then(function () {
        busy($("#btnSaveSettings"), false);
      });
  }

  function restart() {
    ML.confirm("重启服务？正在进行的下载会中断。", { okLabel: "重启" }).then(function (yes) {
      if (!yes) return;
      ML.post("/api/restart", {})
        .then(function () {
          ML.toast("服务正在重启", "ok");
          restartNotice("");
        })
        .catch(function (err) {
          ML.toast(err.message, "err");
        });
    });
  }

  function shutdown() {
    ML.confirm("退出 minilist？退出后局域网上的所有人都将无法访问。", { okLabel: "退出", danger: true }).then(function (yes) {
      if (!yes) return;
      ML.post("/api/shutdown", {})
        .then(function () {
          setStatus("已退出", "err");
          document.body.innerHTML =
            '<div style="max-width:520px;margin:80px auto;text-align:center;font-family:system-ui,sans-serif">' +
            "<h1>minilist 已退出</h1>" +
            '<p class="muted">可以关闭这个页面了。需要再次使用请重新运行启动脚本。</p>' +
            "</div>";
        })
        .catch(function (err) {
          ML.toast(err.message, "err");
        });
    });
  }

  /* ------------------------------ 绑定 ------------------------------ */

  function bind() {
    ML.bindThemeButton($("#btnTheme"));
    $("#btnLogin").addEventListener("click", openLogin);
    $("#btnLogout").addEventListener("click", logout);

    $("#btnPickHtml").addEventListener("click", function () { pickAndPublish("file"); });
    $("#btnPickSite").addEventListener("click", function () { pickAndPublish("folder"); });
    $("#btnPublishPath").addEventListener("click", function () {
      var p = $("#pubPath").value.trim();
      if (!p) {
        ML.toast("请先填写路径", "err");
        return;
      }
      publishPath(p);
    });
    $("#pubPath").addEventListener("keydown", function (e) {
      if (e.key === "Enter") $("#btnPublishPath").click();
    });
    $("#btnClearPublish").addEventListener("click", clearPublish);
    $("#btnUploadHtml").addEventListener("click", function () { $("#htmlFileInput").click(); });
    $("#htmlFileInput").addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (file) uploadHtml(file);
      e.target.value = "";
    });

    $("#btnPickFolder").addEventListener("click", pickFolder);
    $("#btnSharePath").addEventListener("click", function () {
      var p = $("#sharePath").value.trim();
      if (!p) {
        ML.toast("请先填写路径", "err");
        return;
      }
      setFolder(p);
    });
    $("#sharePath").addEventListener("keydown", function (e) {
      if (e.key === "Enter") $("#btnSharePath").click();
    });
    $("#btnClearShare").addEventListener("click", clearShare);
    $("#btnOpenFolder").addEventListener("click", function () {
      ML.post("/api/open-folder", {})
        .then(function () {
          ML.toast("已请求打开资源管理器", "ok");
        })
        .catch(function (err) {
          ML.toast(err.message, "err");
        });
    });

    $("#btnSaveSettings").addEventListener("click", saveSettings);
    $("#btnRestart").addEventListener("click", restart);
    $("#btnShutdown").addEventListener("click", shutdown);
  }

  bind();
  refresh();
})();