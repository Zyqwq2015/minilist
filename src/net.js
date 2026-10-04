"use strict";

/** 局域网地址探测 */

const os = require("os");

function lanInterfaces() {
  const out = [];
  let ifaces;
  try {
    ifaces = os.networkInterfaces();
  } catch (e) {
    return out;
  }
  const names = Object.keys(ifaces);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const list = ifaces[name] || [];
    for (let j = 0; j < list.length; j++) {
      const info = list[j];
      const family = info.family;
      const isV4 = family === "IPv4" || family === 4;
      if (!isV4) continue;
      if (info.internal) continue;
      const addr = String(info.address || "");
      if (!addr) continue;
      out.push({ iface: name, address: addr });
    }
  }
  // 常见的家庭/办公网段排在前面
  out.sort(function (a, b) {
    const rank = function (item) {
      if (item.address.indexOf("192.168.") === 0) return 0;
      if (item.address.indexOf("10.") === 0) return 1;
      if (item.address.indexOf("172.") === 0) return 2;
      if (item.address.indexOf("169.254.") === 0) return 9;
      return 5;
    };
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.iface.localeCompare(b.iface);
  });
  return out;
}

function lanHosts() {
  const list = lanInterfaces();
  const seen = {};
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (seen[list[i].address]) continue;
    seen[list[i].address] = true;
    out.push(list[i].address);
  }
  return out;
}

function urlsFor(port) {
  const hosts = lanHosts();
  const out = [];
  for (let i = 0; i < hosts.length; i++) {
    out.push("http://" + hosts[i] + ":" + port);
  }
  return out;
}

module.exports = { lanInterfaces, lanHosts, urlsFor };