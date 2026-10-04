"use strict";

/* minilist 前端公共工具：DOM、格式化、请求、Toast、模态框、主题 */

(function () {
  var ML = {};
  window.ML = ML;

  /* 脚本出错时直接显示在页脚状态栏，避免页面静默变成空白 */
  function reportError(prefix, message) {
    try {
      var el = document.getElementById("status") || document.getElementById("statusText");
      if (el) el.textContent = prefix + (message || "未知错误");
    } catch (e) {
      /* ignore */
    }
  }

  window.addEventListener("error", function (e) {
    var where = "";
    if (e && e.filename) {
      where = " [" + String(e.filename).replace(/^.*\//, "") + ":" + e.lineno + "]";
    }
    reportError("脚本错误：" + where + " ", e && e.message ? e.message : "");
  });

  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    reportError("请求出错：", r && r.message ? r.message : String(r));
  });

  /**
   * 取单个元素。既接受裸 id（"btnLogin"），也接受带 # 的写法（"#btnLogin"）。
   * 注意：必须是"两种都接受"，因为页面代码里两种写法都有，写死一种会导致
   * 所有元素都取到 null、整个脚本静默失效。
   */
  ML.$ = function (id) {
    var s = String(id == null ? "" : id);
    if (s.charAt(0) === "#") s = s.slice(1);
    return s ? document.getElementById(s) : null;
  };

  ML.$$ = function (selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  };

  ML.esc = function (value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      if (c === "&") return "&amp;";
      if (c === "<") return "&lt;";
      if (c === ">") return "&gt;";
      if (c === '"') return "&quot;";
      return "&#39;";
    });
  };

  ML.fmtSize = function (n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return v === 0 ? "0 B" : "—";
    if (v < 1024) return v + " B";
    if (v < 1048576) return (v / 1024).toFixed(1) + " KB";
    if (v < 1073741824) return (v / 1048576).toFixed(1) + " MB";
    return (v / 1073741824).toFixed(2) + " GB";
  };

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  ML.fmtTime = function (ms) {
    var v = Number(ms);
    if (!isFinite(v) || v <= 0) return "—";
    var d = new Date(v);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  };

  ML.fmtUptime = function (seconds) {
    var s = Math.max(0, Math.floor(Number(seconds) || 0));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + " 小时 " + m + " 分";
    if (m > 0) return m + " 分 " + (s % 60) + " 秒";
    return s + " 秒";
  };

  /* ------------------------------ 主题 ------------------------------ */

  ML.applyTheme = function (theme) {
    var t = theme === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    // 让应用窗口的标题栏/边框也跟着黑白（支持 theme-color 的浏览器）
    try {
      var meta = document.querySelector('meta[name="theme-color"]');
      if (!meta) {
        meta = document.createElement("meta");
        meta.setAttribute("name", "theme-color");
        document.head.appendChild(meta);
      }
      meta.setAttribute("content", t === "light" ? "#ffffff" : "#000000");
    } catch (e) {
      /* ignore */
    }
    try {
      localStorage.setItem("minilist.theme", t);
    } catch (e) {
      /* ignore */
    }
    return t;
  };

  ML.currentTheme = function () {
    try {
      var saved = localStorage.getItem("minilist.theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch (e) {
      /* ignore */
    }
    try {
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
    } catch (e) {
      /* ignore */
    }
    return "dark";
  };

  ML.toggleTheme = function () {
    var now = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    return ML.applyTheme(now);
  };

  ML.applyTheme(ML.currentTheme());

  /* ------------------------------ Toast ------------------------------ */

  ML.toast = function (message, kind, ms) {
    var root = ML.$("toasts");
    if (!root) {
      root = document.createElement("div");
      root.id = "toasts";
      root.className = "toasts";
      document.body.appendChild(root);
    }
    var node = document.createElement("div");
    node.className = "toast" + (kind ? " " + kind : "");
    node.textContent = String(message == null ? "" : message);
    root.appendChild(node);
    var life = ms || (kind === "err" ? 6000 : 3000);
    setTimeout(function () {
      node.style.transition = "opacity .25s";
      node.style.opacity = "0";
      setTimeout(function () {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 260);
    }, life);
    return node;
  };

  /* ------------------------------ 请求 ------------------------------ */

  ML.csrf = null;

  ML.request = function (url, options) {
    var opts = options || {};
    var headers = {};
    var key;
    if (opts.headers) {
      for (key in opts.headers) {
        if (Object.prototype.hasOwnProperty.call(opts.headers, key)) headers[key] = opts.headers[key];
      }
    }
    var method = (opts.method || "GET").toUpperCase();
    var init = { method: method, headers: headers, credentials: "same-origin", cache: "no-store" };
    if (opts.body !== undefined && opts.body !== null) {
      if (typeof FormData !== "undefined" && opts.body instanceof FormData) {
        init.body = opts.body;
      } else {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(opts.body);
      }
    }
    if (method !== "GET" && method !== "HEAD" && ML.csrf) {
      headers["X-CSRF-Token"] = ML.csrf;
    }
    return fetch(url, init).then(function (res) {
      var ct = res.headers.get("content-type") || "";
      var parsing = ct.indexOf("application/json") >= 0
        ? res.json().catch(function () { return null; })
        : Promise.resolve(null);
      return parsing.then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || ("请求失败（HTTP " + res.status + "）"));
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  };

  ML.get = function (url) {
    return ML.request(url);
  };

  ML.post = function (url, body) {
    return ML.request(url, { method: "POST", body: body || {} });
  };

  ML.upload = function (url, formData, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.withCredentials = true;
      if (ML.csrf) xhr.setRequestHeader("X-CSRF-Token", ML.csrf);
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onProgress(e.loaded, e.total);
        };
      }
      xhr.onload = function () {
        var data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (e) {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          var err = new Error((data && data.error) || ("上传失败（HTTP " + xhr.status + "）"));
          err.status = xhr.status;
          err.data = data;
          reject(err);
        }
      };
      xhr.onerror = function () {
        reject(new Error("网络错误，上传中断"));
      };
      xhr.send(formData);
    });
  };

  /* ------------------------------ 模态框 ------------------------------ */

  ML.modal = function (options) {
    var opts = options || {};
    var mask = document.createElement("div");
    mask.className = "modal-mask";

    var modal = document.createElement("div");
    modal.className = "modal" + (opts.wide ? " wide" : "");

    var head = document.createElement("div");
    head.className = "modal-head";
    var title = document.createElement("h3");
    title.textContent = opts.title || "";
    var closeBtn = document.createElement("button");
    closeBtn.className = "modal-close";
    closeBtn.type = "button";
    closeBtn.innerHTML = "&times;";
    head.appendChild(title);
    head.appendChild(closeBtn);

    var body = document.createElement("div");
    body.className = "modal-body";
    if (typeof opts.content === "string") body.innerHTML = opts.content;
    else if (opts.content) body.appendChild(opts.content);

    modal.appendChild(head);
    modal.appendChild(body);

    var foot = null;
    if (opts.actions && opts.actions.length) {
      foot = document.createElement("div");
      foot.className = "modal-foot";
      modal.appendChild(foot);
    }

    mask.appendChild(modal);

    function close(result) {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      document.removeEventListener("keydown", onKey);
      if (opts.onClose) opts.onClose(result);
    }

    function onKey(e) {
      if (e.key === "Escape" && opts.dismissable !== false) close(null);
    }

    closeBtn.addEventListener("click", function () {
      close(null);
    });
    mask.addEventListener("mousedown", function (e) {
      if (e.target === mask && opts.dismissable !== false) close(null);
    });
    document.addEventListener("keydown", onKey);

    var api = { el: modal, body: body, close: close };

    if (foot) {
      opts.actions.forEach(function (action) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn" + (action.kind ? " " + action.kind : "");
        btn.textContent = action.label;
        if (action.id) btn.id = action.id;
        btn.addEventListener("click", function () {
          if (action.onClick) action.onClick(api, btn);
          else close(null);
        });
        foot.appendChild(btn);
      });
    }

    document.body.appendChild(mask);
    if (opts.onMount) opts.onMount(api);

    var focusTarget = modal.querySelector("input, textarea, select, button.primary");
    if (focusTarget) {
      setTimeout(function () {
        try {
          focusTarget.focus();
        } catch (e) {
          /* ignore */
        }
      }, 30);
    }

    return api;
  };

  ML.confirm = function (message, options) {
    var opts = options || {};
    return new Promise(function (resolve) {
      var done = false;
      function settle(value) {
        if (done) return;
        done = true;
        resolve(value);
      }
      ML.modal({
        title: opts.title || "请确认",
        content: '<div style="font-size:13.5px;line-height:1.7;word-break:break-word">' + ML.esc(message) + "</div>",
        actions: [
          {
            label: opts.cancelLabel || "取消",
            onClick: function (m) {
              settle(false);
              m.close();
            }
          },
          {
            label: opts.okLabel || "确定",
            kind: opts.danger ? "danger" : "primary",
            onClick: function (m) {
              settle(true);
              m.close();
            }
          }
        ],
        onClose: function () {
          settle(false);
        }
      });
    });
  };

  ML.copy = function (text) {
    var value = String(text == null ? "" : text);
    function fallback() {
      try {
        var ta = document.createElement("textarea");
        ta.value = value;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return ok;
      } catch (e) {
        return false;
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value).then(function () {
        return true;
      }).catch(function () {
        return fallback();
      });
    }
    return Promise.resolve(fallback());
  };

  ML.copyButton = function (text, label) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn sm ghost";
    btn.textContent = label || "复制";
    btn.addEventListener("click", function () {
      ML.copy(text).then(function (ok) {
        ML.toast(ok ? "已复制" : "复制失败，请手动选择", ok ? "ok" : "err");
      });
    });
    return btn;
  };

  /* ------------------------------ 主题按钮绑定 ------------------------------ */

  ML.bindThemeButton = function (btn) {
    if (!btn) return;
    var sync = function () {
      btn.textContent = document.documentElement.getAttribute("data-theme") === "light" ? "深色" : "浅色";
      btn.title = "切换主题";
    };
    sync();
    btn.addEventListener("click", function () {
      ML.toggleTheme();
      sync();
    });
  };
})();