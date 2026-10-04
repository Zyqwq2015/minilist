"use strict";

/* minilist 文件浏览逻辑 */

(function () {
  var $ = ML.$;
  var esc = ML.esc;

  var authed = false;
  var info = null;
  var curPath = "";
  var parentPath = null;
  var items = [];
  var selected = {};
  var selCount = 0;
  var sortKey = "name";
  var sortAsc = true;
  var filterText = "";
  var dragDepth = 0;

  /* ------------------------------ 工具 ------------------------------ */

  function extOf(name) {
    var i = String(name).lastIndexOf(".");
    if (i <= 0) return "";
    return String(name).slice(i + 1).toLowerCase();
  }

  function join(dir, name) {
    return dir ? dir + "/" + name : name;
  }

  function splitPath(p) {
    return String(p || "").split("/").filter(function (s) { return !!s; });
  }

  /**
   * 文件类型标签。刻意不用 emoji：emoji 是彩色的，会破坏纯黑白视觉。
   * 文件夹显示 DIR，其余显示大写扩展名（最多 4 个字符）。
   */
  function iconFor(item) {
    if (item.isDir) return "DIR";
    var e = extOf(item.name);
    if (!e) return "FILE";
    return e.slice(0, 4).toUpperCase();
  }

  function previewKind(name) {
    var e = extOf(name);
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg"].indexOf(e) >= 0) return "image";
    if (["mp4", "webm", "ogv", "mov", "m4v"].indexOf(e) >= 0) return "video";
    if (["mp3", "wav", "ogg", "m4a", "flac", "aac"].indexOf(e) >= 0) return "audio";
    if (e === "pdf") return "pdf";
    return "none";
  }

  function setStatus(text) {
    $("#status").textContent = text || "";
  }

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

  /* ------------------------------ 路由 ------------------------------ */

  function readHash() {
    var h = location.hash || "";
    if (h === "" || h === "#" || h === "#/") return "";
    var s = h.slice(1);
    if (s.slice(0, 1) === "/") s = s.slice(1);
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }

  function setHash(path) {
    var target = "#/" + encodeURIComponent(path || "");
    if (location.hash === target) {
      load(readHash());
    } else {
      location.hash = target;
    }
  }

  /* ------------------------------ 数据 ------------------------------ */

  function load(path) {
    curPath = path || "";
    selected = {};
    selCount = 0;
    $("#loading").hidden = false;
    $("#empty").hidden = true;
    $("#rows").innerHTML = "";
    syncBulk();

    return ML.get("/api/files?path=" + encodeURIComponent(curPath))
      .then(function (data) {
        items = data.items || [];
        curPath = data.path || "";
        parentPath = data.parent;
        $("#loading").hidden = true;
        renderCrumbs();
        renderRows();
        var n = items.length;
        setStatus(n + " 个项目" + (filterText ? "（已过滤）" : ""));
      })
      .catch(function (err) {
        items = [];
        parentPath = null;
        $("#loading").hidden = true;
        renderCrumbs();
        renderRows();
        setStatus("");
        showEmpty("无法读取这个文件夹", err.message);
        if (err.status !== 401) ML.toast(err.message, "err");
      });
  }

  function showEmpty(title, desc) {
    $("#empty").hidden = false;
    $("#emptyTitle").textContent = title || "这个文件夹是空的";
    $("#emptyDesc").textContent = desc || "上传文件，或者新建文件夹试试";
  }

  function renderCrumbs() {
    var box = $("#crumbs");
    box.innerHTML = "";

    var rootLink = document.createElement("a");
    rootLink.href = "#/";
    rootLink.textContent = "根目录";
    rootLink.addEventListener("click", function (e) {
      e.preventDefault();
      setHash("");
    });
    box.appendChild(rootLink);

    var parts = splitPath(curPath);
    var acc = "";
    parts.forEach(function (part, idx) {
      var sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      box.appendChild(sep);

      acc = acc ? acc + "/" + part : part;
      if (idx === parts.length - 1) {
        var cur = document.createElement("span");
        cur.className = "cur";
        cur.textContent = part;
        box.appendChild(cur);
      } else {
        var link = document.createElement("a");
        link.href = "#/" + encodeURIComponent(acc);
        link.textContent = part;
        (function (target) {
          link.addEventListener("click", function (e) {
            e.preventDefault();
            setHash(target);
          });
        })(acc);
        box.appendChild(link);
      }
    });
  }

  function visibleItems() {
    var f = filterText.trim().toLowerCase();
    var list = items.filter(function (it) {
      return !f || it.name.toLowerCase().indexOf(f) >= 0;
    });
    var dir = sortAsc ? 1 : -1;
    list.sort(function (a, b) {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      var r = 0;
      if (sortKey === "size") r = (a.size || 0) - (b.size || 0);
      else if (sortKey === "time") r = (a.mtime || 0) - (b.mtime || 0);
      else if (sortKey === "type") r = extOf(a.name).localeCompare(extOf(b.name));
      else r = a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" });
      return r * dir;
    });
    return list;
  }

  function renderRows() {
    var rows = $("#rows");
    rows.innerHTML = "";
    var list = visibleItems();

    if (!items.length) {
      showEmpty("这个文件夹是空的", "上传文件，或者新建文件夹试试");
      return;
    }
    if (!list.length) {
      showEmpty("没有匹配的项目", "换个关键词试试");
      return;
    }
    $("#empty").hidden = true;

    var frag = document.createDocumentFragment();
    list.forEach(function (item) {
      frag.appendChild(buildRow(item));
    });
    rows.appendChild(frag);
  }

  function buildRow(item) {
    var row = document.createElement("div");
    row.className = "row" + (selected[item.name] ? " selected" : "");

    /* 选择框 */
    var chkCell = document.createElement("div");
    chkCell.className = "c-chk";
    var chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = !!selected[item.name];
    chk.addEventListener("change", function () {
      if (chk.checked) selected[item.name] = true;
      else delete selected[item.name];
      row.classList.toggle("selected", chk.checked);
      syncBulk();
    });
    chkCell.appendChild(chk);

    /* 名称 */
    var nameCell = document.createElement("div");
    nameCell.className = "c-name";
    var icon = document.createElement("span");
    icon.className = "ficon";
    icon.textContent = iconFor(item);
    nameCell.appendChild(icon);

    var label;
    if (item.isDir) {
      label = document.createElement("a");
      label.href = "#/" + encodeURIComponent(join(curPath, item.name));
      label.addEventListener("click", function (e) {
        e.preventDefault();
        setHash(join(curPath, item.name));
      });
    } else {
      label = document.createElement("button");
      label.type = "button";
      label.className = "linkish";
      label.addEventListener("click", function () {
        openFile(item);
      });
    }
    label.textContent = item.name;
    label.title = item.name;
    nameCell.appendChild(label);

    if (item.isLink) {
      var badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "链接";
      nameCell.appendChild(badge);
    }

    /* 大小 / 时间 */
    var sizeCell = document.createElement("div");
    sizeCell.className = "c-size";
    sizeCell.textContent = item.isDir ? "—" : ML.fmtSize(item.size);

    var timeCell = document.createElement("div");
    timeCell.className = "c-time";
    timeCell.textContent = ML.fmtTime(item.mtime);

    /* 操作 */
    var ops = document.createElement("div");
    ops.className = "c-ops";

    if (!item.isDir) {
      var kind = previewKind(item.name);
      if (kind !== "none" || item.editable) {
        ops.appendChild(smallBtn("预览", function () { openFile(item); }));
      }
      ops.appendChild(smallBtn("下载", function () { download(join(curPath, item.name)); }));
    } else {
      ops.appendChild(smallBtn("打包下载", function () { downloadZip([item.name]); }));
    }
    if (item.editable && !item.isDir) {
      ops.appendChild(smallBtn("编辑", function () { openEditor(item); }));
    }
    ops.appendChild(smallBtn("重命名", function () { renameItem(item); }, "write-only-btn"));
    ops.appendChild(smallBtn("删除", function () { deleteItems([item.name]); }, "write-only-btn danger"));

    row.appendChild(chkCell);
    row.appendChild(nameCell);
    row.appendChild(sizeCell);
    row.appendChild(timeCell);
    row.appendChild(ops);

    gateWrite(row);
    return row;
  }

  function smallBtn(text, onClick, extra) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "btn ghost" + (extra ? " " + extra : "");
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  /** 只读模式下禁用所有写操作按钮 */
  function gateWrite(root) {
    if (authed) return;
    ML.$$(".write-only-btn", root).forEach(function (el) {
      el.disabled = true;
      el.title = "登录后才能修改";
    });
    ML.$$(".write-only", root).forEach(function (el) {
      el.disabled = true;
    });
  }

  /* ------------------------------ 批量选择 ------------------------------ */

  function syncBulk() {
    var names = Object.keys(selected);
    selCount = names.length;
    $("#bulkbar").hidden = selCount === 0;
    $("#selCount").textContent = String(selCount);
    var all = visibleItems();
    var chkAll = $("#chkAll");
    if (chkAll) {
      chkAll.checked = all.length > 0 && selCount >= all.length;
    }
  }

  /* ------------------------------ 下载 ------------------------------ */

  function download(rel) {
    var a = document.createElement("a");
    a.href = "/api/download?path=" + encodeURIComponent(rel);
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
    }, 200);
  }

  function downloadZip(names) {
    var list = names && names.length ? names : Object.keys(selected);
    if (!list.length) {
      ML.toast("请先选择要打包的文件", "err");
      return;
    }
    var url = "/api/zip?path=" + encodeURIComponent(curPath);
    list.forEach(function (n) {
      url += "&name=" + encodeURIComponent(n);
    });
    var a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
    }, 200);
  }

  /* ------------------------------ 预览 / 编辑 ------------------------------ */

  function openFile(item) {
    var kind = previewKind(item.name);
    var rel = join(curPath, item.name);
    if (item.editable) {
      openEditor(item);
      return;
    }
    if (kind === "none") {
      download(rel);
      return;
    }

    var box = document.createElement("div");
    box.className = "preview-box";
    var raw = "/api/raw?path=" + encodeURIComponent(rel);
    if (kind === "image") {
      var img = document.createElement("img");
      img.src = raw;
      img.alt = item.name;
      box.appendChild(img);
    } else if (kind === "video") {
      var video = document.createElement("video");
      video.src = raw;
      video.controls = true;
      box.appendChild(video);
    } else if (kind === "audio") {
      var audio = document.createElement("audio");
      audio.src = raw;
      audio.controls = true;
      box.appendChild(audio);
    } else if (kind === "pdf") {
      var frame = document.createElement("iframe");
      frame.src = raw;
      frame.title = item.name;
      box.appendChild(frame);
    }

    ML.modal({
      title: item.name,
      wide: kind === "pdf",
      content: box,
      actions: [{ label: "下载", onClick: function () { download(rel); } }, { label: "关闭", kind: "primary", onClick: function (m) { m.close(); } }]
    });
  }

  function openEditor(item) {
    var rel = join(curPath, item.name);
    ML.get("/api/text?path=" + encodeURIComponent(rel))
      .then(function (data) {
        if (data.binary) {
          ML.toast("这看起来是二进制文件，无法在线编辑", "err");
          return;
        }
        var wrap = document.createElement("div");
        wrap.innerHTML =
          '<div class="hint" id="edInfo"></div>' +
          '<textarea id="edText" spellcheck="false" wrap="off"></textarea>';

        ML.modal({
          title: "编辑 " + item.name,
          wide: true,
          content: wrap,
          actions: [
            { label: "下载", onClick: function () { download(rel); } },
            { label: "关闭", onClick: function (m) { m.close(); } },
            { label: "保存", kind: "primary", id: "edSave", onClick: function (m) { saveEditor(rel, m); } }
          ],
          onMount: function () {
            var ta = document.getElementById("edText");
            ta.value = data.text;
            ta.style.height = Math.max(260, Math.min(620, window.innerHeight - 300)) + "px";
            document.getElementById("edInfo").textContent =
              "编码 " + data.encoding + " · " + ML.fmtSize(data.size) + " · 保存时统一写回 UTF-8";
            if (!authed) {
              ta.readOnly = true;
              var save = document.getElementById("edSave");
              if (save) {
                save.disabled = true;
                save.title = "登录后才能保存";
              }
              document.getElementById("edInfo").textContent += " · 当前只读，登录后才能保存";
            }
          }
        });
      })
      .catch(function (err) {
        ML.toast(err.message, "err");
      });
  }

  function saveEditor(rel, modalApi) {
    var ta = document.getElementById("edText");
    if (!ta) return;
    var btn = document.getElementById("edSave");
    busy(btn, true, "保存中…");
    ML.post("/api/save", { path: rel, content: ta.value })
      .then(function (res) {
        ML.toast("已保存：" + res.name, "ok");
        if (modalApi) modalApi.close();
        load(curPath);
      })
      .catch(function (err) {
        busy(btn, false);
        ML.toast(err.message, "err");
      });
  }

  /* ------------------------------ 输入框模态 ------------------------------ */

  function askText(title, label, value) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        resolve(v);
      }
      var wrap = document.createElement("div");
      wrap.innerHTML =
        '<div class="field"><label for="askInput">' + esc(label) + "</label>" +
        '<input type="text" id="askInput"></div>';

      ML.modal({
        title: title,
        content: wrap,
        actions: [
          { label: "取消", onClick: function (m) { finish(null); m.close(); } },
          {
            label: "确定",
            kind: "primary",
            id: "askOk",
            onClick: function (m) {
              var input = document.getElementById("askInput");
              var v = input ? input.value.trim() : "";
              if (!v) {
                ML.toast("名称不能为空", "err");
                return;
              }
              finish(v);
              m.close();
            }
          }
        ],
        onMount: function () {
          var input = document.getElementById("askInput");
          input.value = value || "";
          input.addEventListener("keydown", function (e) {
            if (e.key === "Enter") {
              var ok = document.getElementById("askOk");
              if (ok) ok.click();
            }
          });
        },
        onClose: function () {
          finish(null);
        }
      });
    });
  }

  /* ------------------------------ 写操作 ------------------------------ */

  function requireLogin() {
    if (authed) return true;
    ML.toast("请先登录，登录后才能修改", "err");
    openLogin();
    return false;
  }

  function newFolder() {
    if (!requireLogin()) return;
    askText("新建文件夹", "文件夹名称", "").then(function (name) {
      if (!name) return;
      ML.post("/api/mkdir", { path: curPath, name: name })
        .then(function (res) {
          ML.toast("已创建：" + res.path, "ok");
          load(curPath);
        })
        .catch(function (err) {
          ML.toast(err.message, "err");
        });
    });
  }

  function newFile() {
    if (!requireLogin()) return;
    askText("新建文件", "文件名（例如 笔记.md）", "").then(function (name) {
      if (!name) return;
      ML.post("/api/newfile", { path: curPath, name: name, content: "" })
        .then(function (res) {
          ML.toast("已创建：" + res.path, "ok");
          load(curPath);
        })
        .catch(function (err) {
          ML.toast(err.message, "err");
        });
    });
  }

  function renameItem(item) {
    if (!requireLogin()) return;
    askText("重命名", "新的名称", item.name).then(function (name) {
      if (!name || name === item.name) return;
      ML.post("/api/rename", { from: join(curPath, item.name), to: join(curPath, name) })
        .then(function () {
          ML.toast("已重命名为：" + name, "ok");
          load(curPath);
        })
        .catch(function (err) {
          ML.toast(err.message, "err");
        });
    });
  }

  function deleteItems(names) {
    if (!requireLogin()) return;
    if (!names.length) return;
    var preview = names.length === 1 ? names[0] : names.length + " 个项目（" + names.slice(0, 3).join("、") + (names.length > 3 ? " 等" : "") + "）";
    ML.confirm("确定要删除 " + preview + " 吗？文件夹会连同里面的内容一起删除，无法撤销。", {
      title: "删除确认",
      okLabel: "删除",
      danger: true
    }).then(function (yes) {
      if (!yes) return;
      var paths = names.map(function (n) {
        return join(curPath, n);
      });
      ML.post("/api/delete", { paths: paths })
        .then(function (res) {
          ML.toast("已删除 " + res.removed.length + " 个项目", "ok");
          selected = {};
          load(curPath);
        })
        .catch(function (err) {
          ML.toast(err.message, "err");
        });
    });
  }

  /* ------------------------------ 上传 ------------------------------ */

  function doUpload(fileList) {
    if (!requireLogin()) return;
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    var fd = new FormData();
    files.forEach(function (f) {
      fd.append("files", f, f.name);
    });

    var url = "/api/upload?path=" + encodeURIComponent(curPath);
    setStatus("正在上传 " + files.length + " 个文件…");
    ML.upload(url, fd, function (loaded, total) {
      if (total) setStatus("正在上传 " + Math.round((loaded / total) * 100) + "% （" + ML.fmtSize(loaded) + " / " + ML.fmtSize(total) + "）");
    })
      .then(function (res) {
        var saved = (res && res.saved) || [];
        var skipped = (res && res.skipped) || [];
        var failed = (res && res.failed) || [];
        var msg = "已上传 " + saved.length + " 个文件";
        if (skipped.length) msg += "，跳过重名 " + skipped.length + " 个";
        if (failed.length) msg += "，名称不合法 " + failed.length + " 个";
        ML.toast(msg, failed.length ? "warn" : "ok");
        load(curPath);
      })
      .catch(function (err) {
        ML.toast(err.message, "err");
        setStatus("");
      });
  }

  /* ------------------------------ 登录 ------------------------------ */

  function openLogin() {
    var wrap = document.createElement("div");
    wrap.innerHTML =
      '<div class="field"><label for="lgUser">用户名</label><input type="text" id="lgUser" autocomplete="username"></div>' +
      '<div class="field"><label for="lgPass">密码</label><input type="password" id="lgPass" autocomplete="current-password"></div>' +
      '<div class="hint" id="lgHint"></div>';

    ML.modal({
      title: "登录 minilist",
      content: wrap,
      actions: [
        { label: "取消", onClick: function (m) { m.close(); } },
        { label: "登录", kind: "primary", id: "lgSubmit", onClick: function (m) { doLogin(m); } }
      ],
      onMount: function (m) {
        var userInput = document.getElementById("lgUser");
        userInput.value = (info && info.username) || "admin";
        var passInput = document.getElementById("lgPass");
        passInput.addEventListener("keydown", function (e) {
          if (e.key === "Enter") doLogin(m);
        });
        setTimeout(function () {
          try { passInput.focus(); } catch (e) { /* ignore */ }
        }, 40);
      }
    });
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
        authed = true;
        info = res.info || {};
        if (modalApi) modalApi.close();
        ML.toast("登录成功", "ok");
        applyAuth();
        load(curPath);
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
        authed = false;
        info = null;
        ML.toast("已退出登录", "ok");
        load(curPath);
      })
      .catch(function (err) {
        ML.toast(err.message, "err");
      });
  }

  function applyAuth() {
    $("#who").textContent = authed ? "已登录：" + ((info && info.username) || "admin") : "未登录 · 只读";
    $("#btnLogin").hidden = authed;
    $("#btnLogout").hidden = !authed;
    $("#roHint").hidden = authed;
    document.title = ((info && info.title) || "minilist") + " · 文件浏览";
    $("#pageTitle").textContent = (info && info.title) || "文件浏览";
    var root = (info && info.sharedFolder) || "";
    $("#rootHint").textContent = root ? root : "";
    $("#rootHint").title = root;

    ["btnNewFolder", "btnNewFile", "btnUpload", "btnEmptyUpload", "btnEmptyFolder", "btnBulkDelete"].forEach(function (id) {
      var el = $(id);
      if (el) {
        el.disabled = !authed;
        if (!authed) el.title = "登录后才能修改";
      }
    });
  }

  /* ------------------------------ 事件绑定 ------------------------------ */

  function bind() {
    ML.bindThemeButton($("#btnTheme"));
    $("#btnLogin").addEventListener("click", openLogin);
    $("#btnLogout").addEventListener("click", logout);

    $("#btnUp").addEventListener("click", function () {
      if (parentPath === null || parentPath === undefined || curPath === "") return;
      setHash(parentPath);
    });
    $("#btnRefresh").addEventListener("click", function () { load(curPath); });

    $("#search").addEventListener("input", function (e) {
      filterText = e.target.value || "";
      renderRows();
      syncBulk();
      setStatus(items.length + " 个项目" + (filterText ? "（正在过滤）" : ""));
    });

    $("#sort").addEventListener("change", function (e) {
      sortKey = e.target.value;
      renderRows();
      syncBulk();
    });
    $("#btnSortDir").addEventListener("click", function () {
      sortAsc = !sortAsc;
      $("#btnSortDir").textContent = sortAsc ? "↑" : "↓";
      renderRows();
      syncBulk();
    });

    $("#chkAll").addEventListener("change", function (e) {
      var all = visibleItems();
      if (e.target.checked) {
        all.forEach(function (it) { selected[it.name] = true; });
      } else {
        selected = {};
      }
      renderRows();
      syncBulk();
    });

    $("#btnClearSel").addEventListener("click", function () {
      selected = {};
      renderRows();
      syncBulk();
    });
    $("#btnZip").addEventListener("click", function () { downloadZip(null); });
    $("#btnBulkDelete").addEventListener("click", function () { deleteItems(Object.keys(selected)); });

    $("#btnNewFolder").addEventListener("click", newFolder);
    $("#btnEmptyFolder").addEventListener("click", newFolder);
    $("#btnNewFile").addEventListener("click", newFile);
    $("#btnUpload").addEventListener("click", function () { $("#fileInput").click(); });
    $("#btnEmptyUpload").addEventListener("click", function () { $("#fileInput").click(); });
    $("#fileInput").addEventListener("change", function (e) {
      doUpload(e.target.files);
      e.target.value = "";
    });

    /* 拖放上传 */
    var panel = $("#panel");
    var veil = $("#dropveil");
    panel.addEventListener("dragenter", function (e) {
      e.preventDefault();
      dragDepth += 1;
      if (authed) veil.classList.add("on");
    });
    panel.addEventListener("dragover", function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    panel.addEventListener("dragleave", function (e) {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) veil.classList.remove("on");
    });
    panel.addEventListener("drop", function (e) {
      e.preventDefault();
      dragDepth = 0;
      veil.classList.remove("on");
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        doUpload(e.dataTransfer.files);
      }
    });
    window.addEventListener("dragover", function (e) { e.preventDefault(); });
    window.addEventListener("drop", function (e) { e.preventDefault(); });
  }

  /* ------------------------------ 启动 ------------------------------ */

  function boot() {
    bind();
    ML.get("/api/session")
      .then(function (res) {
        ML.csrf = res.csrf;
        authed = !!res.authed;
        info = res.info || {};
        if (res.authed) info.username = res.user;
        applyAuth();
      })
      .catch(function () {
        applyAuth();
      })
      .then(function () {
        load(readHash());
      });

    window.addEventListener("hashchange", function () {
      load(readHash());
    });
  }

  boot();
})();