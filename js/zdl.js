// ZDL reader: header fields, ELF symbols, effect descriptor and the 128x64 screen picture.
//
// A ZDL is a 76-byte Zoom header followed by an ELF32 (TI C674x) shared object.
// The picture is the data of the symbol `picEffectType_<name>`, Zoom's RLE of
// 1,024 raw bytes: 8 row blocks x 128 columns, bit z of a byte = row block*8 + z.

export const PIC_W = 128;
export const PIC_H = 64;
const RAW_LEN = PIC_W * PIC_H / 8;

// Category ids as in header byte 0x3C and the pedal's FLST_SEQ.ZDT groups (equal for all
// effects on the G1Xon). Byte 0x43 differs for bass effects: 0x14 / 0x16 have 0x43 = 1.
export const GROUPS = {
  1: 'Dynamics', 2: 'Filter', 3: 'Drive', 4: 'Amp', 5: 'Bass amp', 6: 'Modulation',
  7: 'SFX', 8: 'Delay', 9: 'Reverb', 11: 'Pedal', 15: 'Common',
  12: 'Bass drive (MS-60)', 13: 'Bass preamp (MS-60)',
  0x14: 'Bass drive', 0x16: 'Bass preamp',        // G1on family
};
export const groupName = id => GROUPS[id] || `group ${id}`;

const ENTRY = 0x30;             // descriptor entry: name, max, default, ..., cost +0x28, flags +0x2C

function cstr(b, o, max) {
  let s = '';
  for (let i = 0; i < max && o + i < b.length; i++) {
    const c = b[o + i];
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s;
}

const printable = s => s.replace(/[^ -~]/g, '').trim();

export function findElf(b) {
  for (let i = 0; i + 4 <= b.length; i++)
    if (b[i] === 0x7F && b[i + 1] === 0x45 && b[i + 2] === 0x4C && b[i + 3] === 0x46) return i;
  return -1;
}

// Sections and symbols of the inner ELF; offsets returned are absolute in `b`.
export function parseElf(b, base) {
  const v = new DataView(b.buffer, b.byteOffset + base, b.length - base);
  const shoff = v.getUint32(0x20, true);
  const shentsize = v.getUint16(0x2E, true);
  const shnum = v.getUint16(0x30, true);
  const secs = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    secs.push({
      type: v.getUint32(o + 4, true), addr: v.getUint32(o + 12, true),
      offset: v.getUint32(o + 16, true), size: v.getUint32(o + 20, true), link: v.getUint32(o + 24, true),
    });
  }
  const symbols = [], unnamed = [];   // unnamed: builds that strip symbol names (anon_abi_syms)
  for (const type of [2, 11]) {          // .symtab (stock effects), .dynsym (our linker's output)
    for (const s of secs.filter(x => x.type === type)) {
      const strs = secs[s.link];
      for (let k = 0; k + 16 <= s.size; k += 16) {
        const o = s.offset + k;
        const name = cstr(b, base + strs.offset + v.getUint32(o, true), 128);
        const sym = { name, value: v.getUint32(o + 4, true), size: v.getUint32(o + 8, true) };
        if (name) symbols.push(sym); else if (sym.size) unnamed.push(sym);
      }
    }
  }
  const toOffset = va => {
    for (const s of secs)
      if (s.type !== 8 && s.addr && va >= s.addr && va < s.addr + s.size) return base + s.offset + va - s.addr;
    return -1;
  };
  return { secs, symbols, unnamed, toOffset };
}

// Zoom RLE: every byte is copied; a byte equal to the one before it is followed by a repeat count.
export function decodeRle(input) {
  const out = new Uint8Array(RAW_LEN);
  let n = 0, prev = -1, armed = false;
  for (const b of input) {
    if (n >= RAW_LEN) break;
    if (armed) {
      for (let i = 0; i < b && n < RAW_LEN; i++) out[n++] = prev;
      armed = false;
      prev = -1;
    } else {
      out[n++] = b;
      armed = prev === b;
      prev = b;
    }
  }
  return n >= RAW_LEN ? out : null;
}

export const pixel = (raw, x, y) => (raw[(y >> 3) * PIC_W + x] >> (y & 7)) & 1;

// Draw a raw picture into a canvas of any size (the pedal's pixels are ~1.33x taller than wide).
// Colours come from the page's --pic-on / --pic-off (--pic-empty without a picture). A set bit is a dark pixel on the pedal.
export function drawPicture(canvas, raw) {
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(PIC_W, PIC_H);
  const css = getComputedStyle(document.documentElement);
  const on = parseColor(css.getPropertyValue('--pic-on')) || [24, 24, 26];
  const off = parseColor(css.getPropertyValue(raw ? '--pic-off' : '--pic-empty')) || parseColor(css.getPropertyValue('--pic-off')) || [240, 240, 234];
  for (let y = 0; y < PIC_H; y++)
    for (let x = 0; x < PIC_W; x++) {
      const c = raw && pixel(raw, x, y) ? on : off;
      img.data.set([c[0], c[1], c[2], 255], (y * PIC_W + x) * 4);
    }
  const tmp = new OffscreenCanvas(PIC_W, PIC_H);
  tmp.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = canvas.width < PIC_W;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
}

function parseColor(s) {
  const m = /#([0-9a-f]{6})/i.exec(s || '');
  return m ? [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16)) : null;
}

// Everything the panels show about one file. Never throws: problems go into `error`.
export function parseZdl(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const r = { isZdl: false, picture: null, knobs: [] };
  try {
    if (b.length < 0x4C || cstr(b, 4, 4) !== 'SIZE') return r;
    r.isZdl = true;
    r.fxid = b[0x40] | (b[0x41] << 8);
    r.family = b[0x42];
    r.gid = b[0x3C];
    r.group = groupName(r.gid);
    r.version = printable(cstr(b, 0x44, 4));
    const base = findElf(b);
    if (base < 0) throw new Error('no ELF inside');
    const elf = parseElf(b, base);

    const pic = elf.symbols.find(s => s.name.startsWith('picEffectType_'));
    if (pic) {
      const o = elf.toOffset(pic.value);
      if (o >= 0) r.picture = decodeRle(b.subarray(o, o + pic.size));
    } else {
      const info = elf.symbols.find(s => /^effectTypeImageInfo\d*$/.test(s.name));
      const o = info ? elf.toOffset(info.value) : -1;
      if (o >= 0) {
        const p = elf.toOffset(new DataView(b.buffer, b.byteOffset).getUint32(o + 0x14, true));
        if (p >= 0) r.picture = decodeRle(b.subarray(p));
      }
    }
    if (!r.picture) {
      // Names stripped: effectTypeImageInfo is the 212-byte object whose +0x14 points at the picture.
      const dv = new DataView(b.buffer, b.byteOffset, b.length);
      for (const s of elf.unnamed.filter(x => x.size === 212)) {
        const o = elf.toOffset(s.value);
        if (o < 0 || o + 0x18 > b.length) continue;
        const va = dv.getUint32(o + 0x14, true);
        const p = elf.toOffset(va);
        if (p < 0) continue;
        const sym = elf.unnamed.find(x => x.value === va);
        r.picture = decodeRle(b.subarray(p, sym ? p + sym.size : b.length));
        if (r.picture) break;
      }
    }

    // Descriptor table: entry 0 "OnOff", entry 1 the effect (name, DSP cost), then the knobs.
    const dv = new DataView(b.buffer, b.byteOffset, b.length);
    for (const s of [...elf.symbols, ...elf.unnamed]) {
      if (s.size < 2 * ENTRY || s.size % ENTRY) continue;
      const o = elf.toOffset(s.value);
      if (o < 0 || cstr(b, o, 6) !== 'OnOff') continue;
      r.name = printable(cstr(b, o + ENTRY, 12));
      r.cost = Math.round(dv.getFloat32(o + ENTRY + 0x28, true) * 100) / 100;
      for (let e = 2; e < s.size / ENTRY; e++) {
        const k = o + e * ENTRY;
        const name = printable(cstr(b, k, 12));
        if (!name || name === 'Dummy') continue;
        r.knobs.push({ name, max: dv.getUint32(k + 0x0C, true), def: dv.getUint32(k + 0x10, true) });
      }
      break;
    }
  } catch (e) {
    r.error = e.message;
  }
  return r;
}
