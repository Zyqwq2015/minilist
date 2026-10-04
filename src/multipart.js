"use strict";

/**
 * multipart/form-data 解析（浏览器 FormData 上传）。
 * 为了简单可靠，整个请求体先读进内存，但会按上限提前拒绝。
 */

function httpError(code, message) {
  const e = new Error(message);
  e.statusCode = code;
  return e;
}

function readBody(req, limitBytes) {
  const max = limitBytes && limitBytes > 0 ? limitBytes : 64 * 1024 * 1024;
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    let settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }

    req.on("data", function (chunk) {
      if (settled) return;
      size += chunk.length;
      if (size > max) {
        fail(httpError(413, "请求体超过上限 " + Math.round(max / 1048576) + " MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", function (err) {
      fail(err);
    });
    req.on("aborted", function () {
      fail(httpError(400, "上传被中断"));
    });
  });
}

/** filename*=UTF-8''%E4%B8%AD%E6%96%87.txt */
function decodeRFC5987(value) {
  let v = String(value || "").trim();
  if (v.slice(0, 1) === '"' && v.slice(-1) === '"') v = v.slice(1, -1);
  const m = /^([A-Za-z0-9_-]+)'([A-Za-z0-9_-]*)'(.*)$/.exec(v);
  if (!m) return null;
  try {
    return decodeURIComponent(m[3]);
  } catch (e) {
    return null;
  }
}

function parseMultipart(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ""));
  if (!m) throw httpError(400, "不是合法的 multipart 请求（缺少 boundary）");
  const boundary = "--" + String(m[1] || m[2]).trim();
  const delim = Buffer.from("\r\n" + boundary);
  const first = Buffer.from(boundary + "\r\n");
  const crlfcrlf = Buffer.from("\r\n\r\n");
  const endMarker = Buffer.from(boundary + "--");
  const entries = [];

  let start = body.indexOf(first);
  if (start < 0) return entries;

  let guard = 0;
  while (start >= 0) {
    guard += 1;
    if (guard > 100000) break;

    const dataStart = start + boundary.length + 2;
    let end = body.indexOf(delim, dataStart);
    let final = false;

    if (end < 0) {
      end = body.indexOf(endMarker, dataStart);
      final = true;
      if (end < 0) break;
    }

    const headEnd = body.indexOf(crlfcrlf, dataStart);
    if (headEnd < 0 || headEnd > end) break;

    const rawHead = body.slice(dataStart, headEnd).toString("utf8");
    const data = body.slice(headEnd + 4, end);
    const headers = {};
    const lines = rawHead.split("\r\n");
    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].indexOf(":");
      if (idx > 0) {
        headers[lines[i].slice(0, idx).trim().toLowerCase()] = lines[i].slice(idx + 1).trim();
      }
    }

    const cd = headers["content-disposition"] || "";
    const nameMatch = /name="([^"]*)"/i.exec(cd);
    let filename = null;
    const starMatch = /filename\*\s*=\s*([^;]+)/i.exec(cd);
    if (starMatch) filename = decodeRFC5987(starMatch[1]);
    if (filename == null) {
      const plainMatch = /filename="([^"]*)"/i.exec(cd);
      if (plainMatch) filename = plainMatch[1];
    }

    entries.push({
      name: nameMatch ? nameMatch[1] : "",
      filename: filename,
      contentType: headers["content-type"] || "",
      data: data
    });

    if (final) break;

    // end 指向分区之间的 "\r\n"，真正的下一个分隔行从 end + 2 开始
    start = body.indexOf(first, end);
  }

  return entries;
}

module.exports = { readBody, parseMultipart, httpError };