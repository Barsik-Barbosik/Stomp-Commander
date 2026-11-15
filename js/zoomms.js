// MultiStomp pedals (MS-70CDR, MS-50G, MS-60B): the file commands of zoom-zt2's ZD2 pedals,
// as themanro's tools/file_probe.html (ZoomMultistompZDL, MIT) sends them. Checked on an
// MS-70CDR 2.10 (list, read, write, delete, adding an effect to FLST_SEQ.ZDT); the MS-50G and
// MS-60B are untested.
//
// Differences from the G1on family (zoomg1.js): no mode switch around operations, shorter close
// messages, a write message without the trailing 00, a per-file "check" before writes and
// deletes, and a working file read (512-byte blocks), so no raw flash reads. A new effect must
// also get a record in FLST_SEQ.ZDT, or the pedal doesn't list it (effectListAdd / Remove).

import { ZoomG1, LIST_FILE, pack7, unpack7, crc32, u35 } from './zoomg1.js';

const STEP = [0x60, 0x05, 0x00];
const READ = [0x60, 0x22, 0x14, 0x2F, 0x60, 0x00, 0x0C, 0x00, 0x04, 0x00, 0x00, 0x00];
const OPEN_READ = [0x60, 0x20, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const OPEN_WRITE = [0x60, 0x20, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const fromU35 = b => b.reduce((s, x, i) => s + x * 2 ** (7 * i), 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export class ZoomMS extends ZoomG1 {
  get family() { return 'ms'; }
  get maxFiles() { return null; }   // no limit known

  // No mode switch: the MS-70CDR 2.10 OS runs the 60 file commands without editor mode, and
  // 51 (editor off) reloads the patch from flash, losing unsaved edits. Patch / knob commands
  // need 50 first and should send it themselves; never send 51.
  session(fn) { return fn(); }

  // A 12-character 8.3 name has no 00 after it.
  async find(first, pattern = '*') {
    for (const r of await this.cmd([0x60, first ? 0x25 : 0x26, 0x00, 0x00], pattern)) {
      if (r.length >= 34 && r[4] === 0x04) {
        const raw = r.slice(14, 26);
        const end = raw.indexOf(0);
        const name = String.fromCharCode(...(end < 0 ? raw : raw.slice(0, end)));
        return name ? { name, size: fromU35(r.slice(29, 34)) } : null;
      }
    }
    return null;
  }

  findClose() { return this.fileClose(); }

  async fileClose() {
    await this.cmd([0x60, 0x21, 0x40, 0x00, 0x00, 0x00, 0x00]);
    await this.cmd([0x60, 0x09]);
  }

  async listing() {
    this.listed = await super.listing();
    return this.listed;
  }

  async diskUsage() {
    for (const r of await this.cmd([0x60, 0x29, 0x00, 0x00, 0x00, 0x00, 0x00]))
      if (r.length >= 20 && r[4] === 0x04) return { max: fromU35(r.slice(10, 15)), avail: fromU35(r.slice(15, 20)) };
    return null;
  }

  // The same shape as the G1on's flash file table (UPPERCASE name -> { name, addr, size }), from the
  // last listing: the MS read needs only the name.
  async fileTable() {
    const files = this.listed || await this.listing();
    return new Map(files.map(f => [f.name.toUpperCase(), { name: f.name, addr: 0, size: f.size }]));
  }

  // Read a file through the pedal's own file read: per 512-byte block 05, 22, 05; the data comes in
  // the reply to the second 05 (60 04 22 01 .., length, packed data, CRC32), length 0 at the end.
  // Stops once `limit` bytes are in.
  async readData(name, progress, size = 0, limit = Infinity) {
    const out = [];
    await this.cmd(OPEN_READ, name);
    try {
      for (let guard = 0; guard < 4096 && out.length < limit; guard++) {
        await this.cmd(STEP);
        await this.cmd(READ);
        const blk = (await this.cmd(STEP)).find(r => r.length >= 15 && r[3] === 0x60 && r[4] === 0x04 && r[5] === 0x22);
        if (!blk) break;
        const n = blk[8] | (blk[9] << 7);
        if (!n) break;
        const data = unpack7(blk.slice(10, -5)).slice(0, n);
        const crc = (blk.at(-5) | (blk.at(-4) << 7) | (blk.at(-3) << 14) | (blk.at(-2) << 21) | ((blk.at(-1) & 0x0F) << 28)) >>> 0;
        if (data.length !== n || ((crc ^ 0xFFFFFFFF) >>> 0) !== crc32(data)) throw new Error(`${name}: CRC mismatch at offset ${out.length}`);
        for (const b of data) out.push(b);
        if (progress) progress(out.length, Math.max(size, out.length));
      }
    } finally {
      await this.fileClose();
    }
    return Uint8Array.from(out);
  }

  readFile(name, table, progress) {
    return this.readData(name, progress, table?.get(name.toUpperCase())?.size || 0);
  }

  async readHead(ent, length) {
    const data = await this.readData(ent.name, null, 0, length);
    if (data.length < Math.min(length, ent.size)) throw new Error(`${ent.name}: read ${data.length} bytes`);
    return data.subarray(0, length);
  }

  // One message that must be answered (else Error).
  async need(body, name, what, opts) {
    const r = await this.cmd(body, name, opts);
    if (!r.length) throw new Error(`no reply to ${what}`);
    return r;
  }

  // check: 60 25 + name, 05, 27 (zoom-zt2's file_check, before every write and delete).
  async check(name) {
    await this.need([0x60, 0x25, 0x00, 0x00], name, 'check');
    await this.need(STEP, null, 'check');
    await this.need([0x60, 0x27], null, 'check end');
  }

  // Write a file (replaces one with the same name), then read it back. On a missing reply or a
  // read-back difference the file is deleted and an Error thrown.
  async upload(name, data, progress) {
    let opened = false;
    try {
      await this.check(name);
      await this.need([0x60, 0x24], name, 'delete');
      opened = true;
      await this.need(OPEN_WRITE, name, 'open for write');
      await this.need(STEP, null, 'open for write');
      for (let off = 0; off < data.length; off += 512) {
        const chunk = data.subarray(off, off + 512);
        const crc = (crc32(chunk) ^ 0xFFFFFFFF) >>> 0;
        const n = chunk.length;
        await this.need([0x60, 0x23, 0x40, 0, 0, 0, 0, n & 0x7F, (n >> 7) & 0x7F, 0, 0, 0, ...pack7(chunk), ...u35(crc)], null,
          `write at offset ${off}`, { timeout: 3000 });
        await this.need(STEP, null, `write at offset ${off}`);
        if (progress) progress(off + n, data.length);
      }
    } catch (e) {
      await this.fileClose();
      if (!opened) throw new Error(`${e.message} (nothing written)`);
      await sleep(200);
      const gone = await this.delete(name).catch(() => false);
      throw new Error(`${e.message} (${gone ? 'partial file deleted' : `check the list for a partial ${name}`})`);
    }
    await this.fileClose();
    const back = await this.readData(name);
    if (!same(back, data)) {
      await this.delete(name).catch(() => false);
      throw new Error(`read back ${back.length} bytes, ${back.length === data.length ? 'different' : `wrote ${data.length}`} (file deleted)`);
    }
  }

  // Delete a file: check, then 60 24 + name. True if the delete was answered (the caller checks
  // the listing).
  async delete(name) {
    try {
      await this.check(name);
      return (await this.cmd([0x60, 0x24], name)).length > 0;
    } finally {
      await this.fileClose();
    }
  }

  async patch() { throw new Error('patch: G1on family only'); }
  async knob() { throw new Error('knob: G1on family only'); }
  async program() { throw new Error('program: G1on family only'); }
}

// FLST_SEQ.ZDT edits (as file_probe.html; used for both pedal families): 13-byte records; a section
// is '>>>' 00 gid + 8 x 00, the effect records (name padded with 00 to 13 bytes), '<<<' 00 (the
// G1on's lists repeat the gid there). The file keeps its length: a record added at the end of its
// group takes 13 of the zero bytes at the end, a removed one gives them back.
const marker = (list, at) => (list[at + 3] === 0 ? String.fromCharCode(list[at], list[at + 1], list[at + 2]) : '');
const recordName = (list, at) => {
  const r = list.subarray(at, at + 12);
  const end = r.indexOf(0);
  return String.fromCharCode(...(end < 0 ? r : r.subarray(0, end))).toUpperCase();
};

// Records of effects (not section markers): [offset, UPPERCASE name].
function records(list) {
  const out = [];
  for (let at = 0; at + 13 <= list.length; at += 13)
    if (list[at] && !marker(list, at)) out.push([at, recordName(list, at)]);
  return out;
}

// The list with `name` added at the end of group `gid`, or null if it already lists `name`.
export function effectListAdd(list, gid, name) {
  if (records(list).some(([, n]) => n === name.toUpperCase())) return null;
  let start = -1;
  for (let at = 0; at + 13 <= list.length && start < 0; at += 13)
    if (marker(list, at) === '>>>' && list[at + 4] === gid) start = at + 13;
  if (start < 0) throw new Error(`${LIST_FILE} has no group ${gid}`);
  let end = start;
  while (end + 13 <= list.length && marker(list, end) !== '<<<') end += 13;
  if (end + 13 > list.length) throw new Error(`${LIST_FILE}: group ${gid} has no end`);
  if (list.subarray(list.length - 13).some(b => b)) throw new Error(`${LIST_FILE} has no room for another record`);
  const out = new Uint8Array(list.length);
  out.set(list.subarray(0, end));
  out.set(Array.from(name.toUpperCase(), c => c.charCodeAt(0) & 0x7F), end);
  out.set(list.subarray(end, list.length - 13), end + 13);
  return out;
}

// The list without the records of `names`, or null if it lists none of them.
export function effectListRemove(list, names) {
  const drop = new Set(names.map(n => n.toUpperCase()));
  const hits = records(list).filter(([, n]) => drop.has(n)).map(([at]) => at);
  if (!hits.length) return null;
  const out = new Uint8Array(list.length);
  let w = 0;
  for (let at = 0; at < list.length; at += 13) {
    if (hits.includes(at)) continue;
    out.set(list.subarray(at, at + 13), w);
    w += 13;
  }
  return out;
}
