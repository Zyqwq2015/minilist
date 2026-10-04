"use strict";

/**
 * 零依赖 ZIP 打包（仅 store 方式，不压缩）。
 * 用途：多选文件 / 整个文件夹打包下载。
 * 限制：单个 zip 总量不超过 2GB（不做 zip64）。
 */

const LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const LIMIT_FILES = 20000;

const CRC_TABLE = (function () {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const date = d instanceof Date ? d : new Date();
  const time = ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() >> 1) & 31);
  const day = (((date.getFullYear() - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31);
  return { time: time, date: day };
}

/**
 * entries: [{ name: "a/b.txt", data: Buffer, mtime: Date, dir: Boolean }]
 * 目录条目 name 需要自带结尾的 "/"（本函数会自动补齐）。
 */
function makeZip(entries) {
  const list = entries || [];
  if (list.length > LIMIT_FILES) {
    const e = new Error("文件数量过多（超过 " + LIMIT_FILES + " 个），请分批下载");
    e.statusCode = 413;
    throw e;
  }
  let total = 0;
  for (let i = 0; i < list.length; i++) {
    total += (list[i].data ? list[i].data.length : 0);
  }
  if (total > LIMIT_BYTES) {
    const e = new Error("打包内容超过 2GB，请分批下载");
    e.statusCode = 413;
    throw e;
  }

  const parts = [];
  const centrals = [];
  let offset = 0;

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const data = item.data ? item.data : Buffer.alloc(0);
    const isDir = !!item.dir;
    let name = String(item.name == null ? "" : item.name).replace(/\\/g, "/");
    if (isDir && name.slice(-1) !== "/") name += "/";
    const nameBuf = Buffer.from(name, "utf8");
    const crc = isDir ? 0 : crc32(data);
    const dt = dosDateTime(item.mtime);
    const size = data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    parts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dt.time, 12);
    central.writeUInt16LE(dt.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    // 目录：MS-DOS 属性 0x10；文件：0x20
    central.writeUInt32LE(isDir ? 0x10 : 0x20, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));

    offset += local.length + nameBuf.length + size;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  parts.push(centralBuf, eocd);
  return Buffer.concat(parts);
}

module.exports = { makeZip, crc32, LIMIT_FILES, LIMIT_BYTES };