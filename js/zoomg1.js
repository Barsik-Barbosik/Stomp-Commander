// G1on / G1Xon family ("ZOOM 1 Series") file protocol, normal mode (no firmware update).

const ZOOM = 0x52;
export const BLOCK = 4090;          // file-system data block
export const MAX_FILES = 200;       // the OS refuses a 201st file
export const LIST_FILE = 'FLST_SEQ.ZDT';

// Zoom device ids (identity reply byte 5) -> name, protocol family ('g1' = this file, 'ms' =
// zoomms.js) and whether writes were tried on that pedal. Other ids get the G1on profile; writes on
// an untested pedal need the user's OK first.
export const DEVICES = {
  0x64: { name: 'G1on family', family: 'g1', tested: true },
  0x66: { name: 'B1Xon', family: 'g1', tested: true },
  0x61: { name: 'MS-70CDR', family: 'ms', tested: true },    // file writes tried with themanro's file_probe.html
  0x58: { name: 'MS-50G', family: 'ms', tested: false },
  0x5F: { name: 'MS-60B', family: 'ms', tested: false },
};

// The pedal's effect list (LIST_FILE): 13-byte records (12-char name + NUL); ">>>\0" + group id
// opens a group, "<<<\0" + id closes it. Returns UPPERCASE file name -> group id.
export function parseEffectList(data) {
  const groups = new Map();
  let group = null;
  for (let o = 0; o + 13 <= data.length; o += 13) {
    const r = data.subarray(o, o + 13);
    const marker = r[3] === 0 ? String.fromCharCode(r[0], r[1], r[2]) : '';
    if (marker === '>>>') group = r[4];
    else if (marker === '<<<') group = null;
    else if (r[0] && group !== null) {
      const end = r.indexOf(0);
      groups.set(String.fromCharCode(...r.subarray(0, end < 0 || end > 12 ? 12 : end)).toUpperCase(), group);
    }
  }
  return groups;
}
const CHECK_OK = [0x60, 0x03, 0, 0, 0, 0, 0];

// File system in the SPI flash (Zoom Firmware Editor's layout, as b1on's zfe_inject.py):
// 4096-byte blocks; four file-table copies of 2 blocks at blocks 3, 5, 7, 9 (32-byte items:
// first block u16 @0, size u32 @4, name @8); data block k at block 10 + k, each with a
// 6-byte header (previous u16, next u16, data size u16).
export const FS_BASE = 0xA5000;
const FS_MAGIC = [0x55, 0xAA, 0x00, 0x01, 0x04, 0x00];
const FS_BLOCK = 4096;
const FS_HEAD = 6;
const FS_FIRST_DATA = 10;
const FS_ITEM = 32;
const FS_EMPTY = 0xFFFF;
const READ_CHUNK = 768;             // bigger flash-read replies got lost and left the pedal deaf
const le16 = (b, o) => b[o] | (b[o + 1] << 8);
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ascii = s => [...Array.from(s, c => c.charCodeAt(0) & 0x7F), 0x00];
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const fmt = r => r.map(x => x.slice(3).map(v => v.toString(16).padStart(2, '0')).join(' ')).join(' | ') || 'no reply';

export const u35 = v => [v & 0x7F, (v >>> 7) & 0x7F, (v >>> 14) & 0x7F, (v >>> 21) & 0x7F, (v >>> 28) & 0x0F];
const fromU35 = b => b.reduce((s, x, i) => s + x * 2 ** (7 * i), 0);

// 7-bit groups: a header byte holds the MSBs, bit 6 = first data byte.
export function pack7(data) {
  const out = [];
  for (let g = 0; g < data.length; g += 7) {
    const grp = data.subarray(g, g + 7);
    let hi = 0;
    grp.forEach((b, i) => { hi |= ((b >> 7) & 1) << (6 - i); });
    out.push(hi, ...Array.from(grp, b => b & 0x7F));
  }
  return out;
}

export function unpack7(packet) {
  const out = [];
  let loop = -1, hi = 0;
  for (const b of packet) {
    if (loop !== -1) { out.push(hi & (1 << loop) ? b | 0x80 : b); loop--; }
    else { hi = b; loop = 6; }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data) {
  let c = 0xFFFFFFFF;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export class ZoomG1 {
  constructor(midi) {
    this.midi = midi;
    this.dev = null;
    this.firmware = '';
    this.chain = Promise.resolve();
    this.busy = false;
  }

  // Whole operations (several messages) run one at a time; the keep-alive waits for them.
  task(fn) {
    const run = async () => {
      this.busy = true;
      try { return await fn(this); } finally { this.busy = false; }
    };
    const p = this.chain.then(run);
    this.chain = p.catch(() => {});
    return p;
  }

  // Identity request, sent once and answered within 3 s. Retrying makes a deaf pedal worse.
  async identify(settle = true) {
    if (settle) await sleep(500);
    for (const r of await this.midi.xfer([0x7E, 0x7F, 0x06, 0x01], { timeout: 3000 })) {
      if (r[0] === 0x7E && r[2] === 0x06 && r[3] === 0x02 && r.length > 5 && r[4] === ZOOM) {
        this.dev = r[5];
        this.firmware = String.fromCharCode(...r.slice(9, 13));
        return this.dev;
      }
    }
    throw new Error('no identity reply from the pedal (replug it)');
  }

  get family() { return 'g1'; }
  get maxFiles() { return MAX_FILES; }

  async cmd(body, name = null, opts = undefined) {
    const data = [ZOOM, 0x00, this.dev, ...body, ...(name === null ? [] : ascii(name))];
    const replies = await this.midi.xfer(data, opts);
    return replies.filter(r => r[0] === ZOOM && r[1] === 0x00 && r[2] === this.dev);
  }

  pcmode(on) { return this.cmd([on ? 0x52 : 0x53]); }   // not acked on G1Xon fw 1.21

  // PC mode on for the operation, off afterwards so the pedal returns to its normal screen.
  async session(fn) {
    await this.pcmode(true);
    try { return await fn(); } finally { await this.pcmode(false); }
  }

  async find(first, pattern = '*') {
    for (const r of await this.cmd([0x60, first ? 0x25 : 0x26, 0x00, 0x00], pattern)) {
      if (r.length >= 34 && r[4] === 0x04) {
        const raw = r.slice(14, 29);
        const end = raw.indexOf(0);
        return { name: String.fromCharCode(...(end < 0 ? raw : raw.slice(0, end))), size: fromU35(r.slice(29, 34)) };
      }
    }
    return null;
  }

  findClose() { return this.cmd([0x60, 0x27]); }

  async listing() {
    const out = [];
    let hit = await this.find(true);
    while (hit && out.length < 1000) {
      out.push(hit);
      hit = await this.find(false);
    }
    await this.findClose();
    return out;
  }

  async stat(name) {
    const hit = await this.find(true, name);
    await this.findClose();
    return hit;
  }

  async fileClose() {
    await this.cmd([0x60, 0x21, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00]);
    await this.cmd([0x60, 0x09, 0x00]);
  }

  // { max, avail } in bytes, or null.
  async diskUsage() {
    for (const r of await this.cmd([0x60, 0x29]))
      if (r.length >= 20 && r[4] === 0x04) return { max: fromU35(r.slice(10, 15)), avail: fromU35(r.slice(15, 20)) };
    return null;
  }

  // Raw SPI flash read (read-only OS sub-command 0x30). Keep `length` <= 768: bigger replies
  // got lost on Windows and left the pedal deaf until a replug.
  async flashRead(addr, length) {
    for (const r of await this.cmd([0x60, 0x30, ...u35(addr), ...u35(length)])) {
      if (r.length > 15 && r[4] === 0x04 && r[5] === 0x30) {
        const n = r[8] | (r[9] << 7);
        const block = Uint8Array.from(unpack7(r.slice(10, -5)).slice(0, n));
        const crc = (r.at(-5) | (r.at(-4) << 7) | (r.at(-3) << 14) | (r.at(-2) << 21) | ((r.at(-1) & 0x0F) << 28)) >>> 0;
        if (((crc ^ 0xFFFFFFFF) >>> 0) !== crc32(block)) throw new Error(`flash read @0x${addr.toString(16)}: CRC mismatch`);
        if (n !== length) throw new Error(`flash read @0x${addr.toString(16)}: got ${n} bytes, asked ${length}`);
        return block;
      }
    }
    throw new Error(`flash read @0x${addr.toString(16)}: no data reply`);
  }

  // Any length, in READ_CHUNK pieces.
  async readFlash(addr, length) {
    const out = new Uint8Array(length);
    for (let at = 0; at < length; at += READ_CHUNK)
      out.set(await this.flashRead(addr + at, Math.min(READ_CHUNK, length - at)), at);
    return out;
  }

  // Map UPPERCASE name -> { name, addr, size } from the main file-table copy.
  async fileTable() {
    const head = await this.flashRead(FS_BASE, 16);
    if (!FS_MAGIC.every((b, i) => head[i] === b)) throw new Error('no Zoom file system at 0xA5000 in the flash');
    this.fsBlocks = le16(head, 8);
    let main = -1, alt = -1;
    for (let i = 0; i < 4 && main < 0; i++) {
      const pos = FS_BASE + FS_BLOCK * (3 + 2 * i);
      const h = await this.flashRead(pos, 8);
      if (h[1] === 0xA5 && h[5] === 0xFF) {
        if (h[4] === 0xFF) main = pos;
        else if (alt < 0) alt = pos;
      }
    }
    const pos = main >= 0 ? main : alt;
    if (pos < 0) throw new Error('file table not found in the flash');
    const t = await this.readFlash(pos, 2 * FS_BLOCK);
    const files = new Map();
    for (let o = 8; o + FS_ITEM <= t.length; o += FS_ITEM) {
      if (t.subarray(o, o + 8).every(b => b === 0xFF)) continue;
      const raw = t.subarray(o + 8, o + 20);
      const end = raw.indexOf(0);
      const name = String.fromCharCode(...(end < 0 ? raw : raw.subarray(0, end)));
      if (name && !files.has(name.toUpperCase())) files.set(name.toUpperCase(), { name, addr: le16(t, o), size: le32(t, o + 4) });
    }
    return files;
  }

  // Read one file through raw flash reads (the G1Xon's own file read returns no data).
  async readFile(name, table, progress) {
    const ent = table.get(name.toUpperCase());
    if (!ent) throw new Error(`${name} is not in the flash file table`);
    const out = new Uint8Array(ent.size);
    let cur = 0, prev = FS_EMPTY, addr = ent.addr;
    for (let guard = 0; guard < 4096; guard++) {
      if (FS_FIRST_DATA + addr >= (this.fsBlocks || 0)) throw new Error(`${name}: block ${addr} outside the file system`);
      const at = FS_BASE + FS_BLOCK * (FS_FIRST_DATA + addr);
      const first = await this.flashRead(at, Math.min(READ_CHUNK, FS_HEAD + ent.size - cur));
      const dsz = le16(first, 4);
      if (dsz > FS_BLOCK - FS_HEAD || cur + dsz > ent.size) throw new Error(`${name}: bad block size ${dsz} in block ${addr}`);
      if (prev !== FS_EMPTY && le16(first, 0) !== prev) throw new Error(`${name}: broken block chain at block ${addr}`);
      const data = new Uint8Array(dsz);
      data.set(first.subarray(FS_HEAD, FS_HEAD + dsz));
      if (first.length - FS_HEAD < dsz) data.set(await this.readFlash(at + first.length, dsz - (first.length - FS_HEAD)), first.length - FS_HEAD);
      out.set(data, cur);
      cur += dsz;
      if (progress) progress(cur, ent.size);
      prev = addr;
      const next = le16(first, 2);
      if (next === FS_EMPTY) {
        if (cur !== ent.size) throw new Error(`${name}: chain ends after ${cur} of ${ent.size} bytes`);
        return out;
      }
      addr = next;
    }
    throw new Error(`${name}: block chain does not end`);
  }

  // The first `length` bytes of a file (at most one data block), e.g. a ZDL's 76-byte header:
  // one flash read instead of the whole file. `ent` is a fileTable() entry.
  async readHead(ent, length) {
    const n = Math.min(length, ent.size, FS_BLOCK - FS_HEAD, READ_CHUNK - FS_HEAD);
    if (FS_FIRST_DATA + ent.addr >= (this.fsBlocks || 0)) throw new Error(`${ent.name}: block ${ent.addr} outside the file system`);
    const b = await this.flashRead(FS_BASE + FS_BLOCK * (FS_FIRST_DATA + ent.addr), FS_HEAD + n);
    if (le16(b, 4) < n) throw new Error(`${ent.name}: first block holds ${le16(b, 4)} bytes`);
    return b.subarray(FS_HEAD, FS_HEAD + n);
  }

  // Write a file in 512-byte chunks. On a bad reply the partial file is deleted and an Error thrown.
  async upload(name, data, progress) {
    await this.cmd([0x60, 0x27]);                                            // file mode (ends a search)
    const op = await this.cmd([0x60, 0x20, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0], name);   // open for write
    if (!op.length || op[0][4] !== 0x04) throw new Error(`open for write refused: ${fmt(op)}`);
    try {
      for (let off = 0; off < data.length; off += 512) {
        const chunk = data.subarray(off, off + 512);
        const chk = await this.cmd([0x60, 0x05, 0x00]);
        if (!chk.some(r => same(r.slice(3), CHECK_OK))) throw new Error(`status check before offset ${off} failed: ${fmt(chk)}`);
        const crc = (crc32(chunk) ^ 0xFFFFFFFF) >>> 0;
        const rep = await this.cmd([0x60, 0x23, 0x40, 0, 0, 0, 0, ...u35(chunk.length), ...pack7(chunk), ...u35(crc), 0x00]);
        if (!rep.length || rep[0][4] !== 0x04) throw new Error(`write at offset ${off} refused: ${fmt(rep)}`);
        if (progress) progress(off + chunk.length, data.length);
      }
    } catch (e) {
      await this.fileClose();
      await sleep(200);
      await this.delete(name);
      throw new Error(`${e.message} (partial file deleted)`);
    }
    await this.fileClose();
  }

  async delete(name) {
    const replies = await this.cmd([0x60, 0x24], name);
    return replies.some(r => same(r.slice(3), CHECK_OK));
  }

  // --- current patch (no PC mode: 51 and 53 both reload the patch from flash and drop unsaved edits)

  // Rows of the current (edit) patch: 29 is answered (28 + 112 packed bytes) only while
  // editor mode (50) is on. Editor mode is left on.
  async patch() {
    await this.cmd([0x50]);
    return (await this.cmd([0x29])).filter(r => r.length > 4 && r[3] === 0x28);
  }

  // Set one parameter of the current patch live, not saved (31 slot param lo hi, no reply;
  // read back with patch()). Slots 0..4; param 0 = on/off, 2..10 = knobs 1..9 (1 = effect type: refused).
  async knob(slot, param, value) {
    if (!(slot >= 0 && slot <= 4 && (param === 0 || (param >= 2 && param <= 10)) && value >= 0 && value < 1 << 14))
      throw new Error('knob: slot 0..4, param 0 or 2..10, value 0..16383');
    await this.cmd([0x50]);
    await this.cmd([0x31, slot, param, value & 0x7F, value >> 7]);
  }

  // Switch to patch 0..99 (MIDI Program Change, channel 1; unsaved edits are lost; no reply).
  async program(n) {
    if (!(n >= 0 && n <= 99)) throw new Error('program: patch 0..99');
    await this.midi.sendShort([0xC0, n]);
  }
}
