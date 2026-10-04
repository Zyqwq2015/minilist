"use strict";

/**
 * 会话与登录限流。
 *
 * 会话只放在内存里：进程重启后需要重新登录（对局域网小工具来说更安全、更简单）。
 * Cookie 为 HttpOnly + SameSite=Strict；因为局域网一般是 http，所以没有加 Secure。
 * 所有写操作除了 Cookie 还要求带 X-CSRF-Token，防止被同主机其它端口的页面借用会话。
 */

const crypto = require("crypto");

const COOKIE_NAME = "minilist_sid";
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时

class SessionStore {
  constructor(ttlMs) {
    this.ttl = ttlMs && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS;
    this.map = new Map();
  }

  create(user) {
    this.sweep();
    const token = crypto.randomBytes(32).toString("base64url");
    const csrf = crypto.randomBytes(24).toString("base64url");
    const now = Date.now();
    const session = {
      token: token,
      csrf: csrf,
      user: String(user || "admin"),
      createdAt: now,
      lastSeen: now,
      expiresAt: now + this.ttl
    };
    this.map.set(token, session);
    return session;
  }

  get(token) {
    if (!token) return null;
    const s = this.map.get(token);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) {
      this.map.delete(token);
      return null;
    }
    s.lastSeen = Date.now();
    s.expiresAt = Date.now() + this.ttl;
    return s;
  }

  destroy(token) {
    if (token) this.map.delete(token);
  }

  destroyAll() {
    this.map.clear();
  }

  sweep() {
    const now = Date.now();
    const dead = [];
    this.map.forEach(function (v, k) {
      if (v.expiresAt <= now) dead.push(k);
    });
    for (let i = 0; i < dead.length; i++) this.map.delete(dead[i]);
  }

  size() {
    return this.map.size;
  }
}

function parseCookies(header) {
  const out = {};
  const raw = String(header || "");
  if (!raw) return out;
  const parts = raw.split(";");
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    const idx = item.indexOf("=");
    if (idx < 0) continue;
    const key = item.slice(0, idx).trim();
    if (!key) continue;
    let value = item.slice(idx + 1).trim();
    if (value.slice(0, 1) === '"' && value.slice(-1) === '"') value = value.slice(1, -1);
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch (e) {
      decoded = value;
    }
    out[key] = decoded;
  }
  return out;
}

function sessionFrom(req, store) {
  const cookies = parseCookies(req.headers ? req.headers.cookie : "");
  return store.get(cookies[COOKIE_NAME]);
}

function sessionCookie(token, maxAgeSeconds) {
  const age = typeof maxAgeSeconds === "number" ? maxAgeSeconds : Math.floor(DEFAULT_TTL_MS / 1000);
  return COOKIE_NAME + "=" + token + "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + age;
}

function clearCookie() {
  return COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0";
}

/** 登录失败限流：同一 IP 连续失败若干次后短暂锁定 */
class LoginGuard {
  constructor(maxFails, lockMs) {
    this.maxFails = maxFails || 8;
    this.lockMs = lockMs || 60000;
    this.map = new Map();
  }

  status(ip) {
    const rec = this.map.get(ip);
    if (!rec) return { locked: false, fails: 0, retryAfter: 0 };
    if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
      return { locked: true, fails: rec.fails, retryAfter: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
    }
    return { locked: false, fails: rec.fails, retryAfter: 0 };
  }

  fail(ip) {
    const now = Date.now();
    let rec = this.map.get(ip);
    if (!rec || (rec.lockedUntil && rec.lockedUntil <= now && rec.fails >= this.maxFails)) {
      rec = { fails: 0, lockedUntil: 0 };
    }
    rec.fails += 1;
    if (rec.fails >= this.maxFails) {
      rec.lockedUntil = now + this.lockMs;
      rec.fails = 0;
    }
    this.map.set(ip, rec);
    return this.status(ip);
  }

  success(ip) {
    this.map.delete(ip);
  }

  cleanup() {
    const now = Date.now();
    const dead = [];
    this.map.forEach(function (v, k) {
      if (v.lockedUntil && v.lockedUntil < now - 3600000) dead.push(k);
    });
    for (let i = 0; i < dead.length; i++) this.map.delete(dead[i]);
  }
}

module.exports = {
  COOKIE_NAME,
  DEFAULT_TTL_MS,
  SessionStore,
  LoginGuard,
  parseCookies,
  sessionFrom,
  sessionCookie,
  clearCookie
};