// Stomp Commander: PC folder (left) and the file list of a G1on-family or MultiStomp pedal (right).

import * as pcfs from './pcfs.js';
import * as idb from './idb.js';
import { parseZdl, drawPicture, groupName } from './zdl.js';
import { Midi, hex } from './midi.js';
import { ZoomG1, DEVICES, BLOCK, LIST_FILE, parseEffectList, GLOBAL_FIELDS, describePatch, unpack7 } from './zoomg1.js';
import { ZoomMS, effectListAdd, effectListRemove } from './zoomms.js';
import { KeepAlive, INTERVAL } from './keepalive.js';
import { runCommand, suggest } from './cli.js';

export const VERSION = '1.0.2';
const DRAG_TYPE = 'application/x-stomp-commander';

const $ = id => document.getElementById(id);
const isZdlName = name => /\.zdl$/i.test(name);
// An effect id as shown: gid + fxid, e.g. 7 + 520 (identity is both together).
const fxidText = (gid, fxid) => `${gid} + ${fxid}`;
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const fmtSize = n => n < 10240 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
const blocks = n => Math.ceil(n / BLOCK);
const fmtBlocks = n => `${n} block${n === 1 ? '' : 's'}`;

// Size cell: flash blocks first (what the pedal counts), bytes after it.
function sizeCell(td, size) {
  const b = document.createElement('span');
  b.className = 'blocks';
  b.textContent = fmtBlocks(blocks(size));
  const by = document.createElement('span');
  by.className = 'bytes';
  by.textContent = ` (${fmtSize(size)})`;
  td.replaceChildren(b, by);
}

// ---------------------------------------------------------------- log, status

const logText = [];
let showSysex = false;

function log(text, cls = '') {
  const t = new Date().toTimeString().slice(0, 8);
  logText.push(`${t}  ${text}`);
  if (logText.length > 50000) logText.splice(0, 10000);
  if (cls === 'sysex' && !showSysex) return;
  const el = $('log');
  const line = document.createElement('div');
  line.className = cls === 'sysex' ? 'dim' : cls;
  line.textContent = `${t}  ${text}`;
  el.append(line);
  while (el.childElementCount > 3000) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}

// What the pedal panel is doing (shown in its footer while an operation runs).
let statusText = '';
const status = text => { statusText = text; $('pedal-busy').textContent = busyOps ? text : ''; };

// Loading bar under a panel's header: done null = off, total 0 = running without a known end.
function loadbar(side, done, total = 0) {
  const el = $(`${side}-load`);
  el.classList.toggle('on', done !== null);
  el.classList.toggle('indet', done !== null && !total);
  el.firstElementChild.style.width = done !== null && total ? `${(100 * done / total).toFixed(1)}%` : '';
  el.closest('.panel').classList.toggle('loading', done !== null);
  document.body.classList.toggle('busy', $('pc-load').classList.contains('on') || $('pedal-load').classList.contains('on'));
  renderButtons();   // the spinner locks both panels
}

// Byte progress of the running pedal transfer (null = back to "working").
function progress(done, total) {
  if (done === null) { loadbar('pedal', busyOps ? 0 : null); $('pedal-busy').textContent = busyOps ? statusText : ''; return; }
  loadbar('pedal', done, total);
  $('pedal-busy').textContent = `${statusText} ${Math.floor(100 * done / total)} %`;
}

function saveLog() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([logText.join('\r\n') + '\r\n'], { type: 'text/plain' }));
  a.download = `stomp-commander_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---------------------------------------------------------------- state

const pc = { stack: [], entries: [], sel: new Set(), anchor: null, gen: 0, showAll: false, urls: [], sort: { key: 'name', dir: 1 } };
const pedal = { files: [], du: null, flst: null, sel: new Set(), anchor: null, connected: false, dead: false, untestedOk: false, sort: { key: 'name', dir: 1 } };
const parsed = new Map();          // name|size|mtime -> parseZdl result

const midi = new Midi(log);
let zoom = new ZoomG1(midi);       // replaced by a ZoomMS on connect when the pedal is a MultiStomp
const keepalive = new KeepAlive(() => zoom, {
  onPing: () => {},
  onDead: e => markDead(`Keep-alive: ${e.message}`),
});
const deviceName = dev => DEVICES[dev]?.name || `Zoom device 0x${dev.toString(16).toUpperCase()}`;
const isMs = () => zoom.family === 'ms';

// The protocol of the identified pedal (identify() itself is the same for both).
function useProfile(dev) {
  const Kind = DEVICES[dev]?.family === 'ms' ? ZoomMS : ZoomG1;
  if (zoom.constructor === Kind) return;
  const z = new Kind(midi);
  z.dev = zoom.dev;
  z.firmware = zoom.firmware;
  zoom = z;
}

const pcDir = () => pc.stack[pc.stack.length - 1];
// Chrome never tells a page where a picked folder is on the disk: the path starts at its name.
const pcPath = () => pc.stack.map(d => d.name).join('/');

// A pedal file shows the picture of a PC file with the same name and size.
const pcTwin = f => pc.entries.find(e => e.kind === 'file' && e.name.toUpperCase() === f.name.toUpperCase() && e.size === f.size);
const zdlOf = (side, e) => (side === 'pc' ? e.zdl : pcTwin(e)?.zdl);

// Category of a row: { gid, group, fxid, from }. A pedal file takes the group from the pedal's
// FLST_SEQ.ZDT when the list has it, else from a PC copy's header; fxid only from a PC copy.
function catOf(side, e) {
  const z = zdlOf(side, e);
  const listed = side === 'pedal' ? pedal.flst?.get(e.name.toUpperCase()) : undefined;
  if (listed !== undefined)
    return { gid: listed, group: groupName(listed), fxid: z?.isZdl && z.gid === listed ? z.fxid : undefined, from: LIST_FILE };
  return z?.isZdl ? { gid: z.gid, group: z.group, fxid: z.fxid, from: side === 'pc' ? 'file' : 'PC copy' } : null;
}
const catText = c => (c ? c.group : '');

// Column sort; PC folders stay on top, files of unknown name / category at the end either way.
function compareRows(side, a, b) {
  const { key, dir } = (side === 'pc' ? pc : pedal).sort;
  if (side === 'pc' && (a.kind === 'dir') !== (b.kind === 'dir')) return a.kind === 'dir' ? -1 : 1;
  let c = 0;
  if (key === 'size') c = (a.size ?? 0) - (b.size ?? 0);
  else if (key === 'effect') {
    const na = zdlOf(side, a)?.name, nb = zdlOf(side, b)?.name;
    if (!na !== !nb) return na ? -1 : 1;
    if (na) c = na.localeCompare(nb, undefined, { sensitivity: 'base' });
  }
  else if (key === 'category') {
    const ca = catOf(side, a), cb = catOf(side, b);
    if (!ca !== !cb) return ca ? -1 : 1;
    if (ca) c = ca.group.localeCompare(cb.group) || (ca.fxid ?? -1) - (cb.fxid ?? -1);
  }
  return dir * c || dir * byName(a, b);
}

function sortRows(side) {
  (side === 'pc' ? pc.entries : pedal.files).sort((a, b) => compareRows(side, a, b));
}

function onHeaderClick(ev) {
  const th = ev.target.closest('th[data-sort]');
  if (!th) return;
  const side = th.closest('.list').dataset.side;
  const st = side === 'pc' ? pc : pedal;
  st.sort = st.sort.key === th.dataset.sort ? { key: th.dataset.sort, dir: -st.sort.dir } : { key: th.dataset.sort, dir: 1 };
  sortRows(side);
  renderList(side);
}

function renderHeaders(side) {
  const { key, dir } = (side === 'pc' ? pc : pedal).sort;
  for (const th of $(`${side}-list`).querySelectorAll('th[data-sort]')) {
    th.classList.toggle('sorted', th.dataset.sort === key);
    th.classList.toggle('desc', th.dataset.sort === key && dir < 0);
    th.setAttribute('aria-sort', th.dataset.sort !== key ? 'none' : dir > 0 ? 'ascending' : 'descending');
  }
}

// ---------------------------------------------------------------- rendering

const MISSING_SVG = '<svg viewBox="0 0 24 16" width="22" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">'
  + '<rect x="1.5" y="1.5" width="21" height="13" rx="2"/><path d="M4 12l5-5 4 4 3-3 4 4"/><path d="M3 15L21 1"/></svg>';

const LIST_SVG = '<svg viewBox="0 0 24 16" width="22" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">'
  + '<circle cx="4" cy="3.5" r="1" fill="currentColor"/><circle cx="4" cy="8" r="1" fill="currentColor"/><circle cx="4" cy="12.5" r="1" fill="currentColor"/>'
  + '<path d="M8 3.5h13M8 8h13M8 12.5h13"/></svg>';
const DRUM_SVG = '<svg viewBox="0 0 24 16" width="22" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">'
  + '<ellipse cx="12" cy="6.5" rx="7" ry="2.2"/><path d="M5 6.5v5.5c0 1.2 3.1 2.2 7 2.2s7-1 7-2.2V6.5"/>'
  + '<path d="M8 8.6v5.3M12 8.8v5.4M16 8.6v5.3"/><path d="M14 5.5L21 1M10 5.5L4 1"/></svg>';
const FOLDER_SVG = '<svg viewBox="0 0 24 16" width="22" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">'
  + '<path d="M3 2.5h6l2 2h10v9.5H3z" fill="currentColor" fill-opacity=".18"/></svg>';
const UP_SVG = '<svg viewBox="0 0 24 16" width="22" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">'
  + '<path d="M3 2.5h6l2 2h10v9.5H3z" fill="currentColor" fill-opacity=".18"/><path d="M12 12.5V7M9.5 9.5L12 7l2.5 2.5"/></svg>';
const ICONS = {
  zdl: [MISSING_SVG, 'No picture'], zdt: [LIST_SVG, 'Effect list'], raw: [DRUM_SVG, 'Drum sample data'],
  dir: [FOLDER_SVG, 'Folder (double-click to open)'], up: [UP_SVG, 'Parent folder (double-click or Backspace)'],
};
const fileType = name => (/\.(zdl|zdt|raw)$/i.exec(name) || [])[1]?.toLowerCase();

// Row picture: a ZDL's screen picture, else an icon for ZDL (no picture), ZDT and RAW files.
function thumb(raw, type) {
  if (!raw) {
    const s = document.createElement('span');
    const icon = ICONS[type];
    s.className = icon ? 'thumb-missing' : 'thumb-none';
    if (icon) { s.innerHTML = icon[0]; s.title = icon[1]; }
    return s;
  }
  const c = document.createElement('canvas');
  c.className = 'thumb';
  c.width = 96;
  c.height = 64;
  drawPicture(c, raw);
  return c;
}

function makeRow(side, e) {
  const tr = document.createElement('tr');
  tr.dataset.side = side;
  tr.dataset.name = e.name;
  tr.draggable = e.kind !== 'dir';   // folders aren't copied
  if (e.kind === 'dir') tr.className = 'dir';
  for (const cls of ['pic', 'name', 'effect', 'meta', 'size']) {
    const td = document.createElement('td');
    td.className = cls;
    tr.append(td);
  }
  tr.cells[1].textContent = e.name;
  if (e.kind !== 'dir') sizeCell(tr.cells[4], e.size);
  e.row = tr;
  fillRow(side, e);
  return tr;
}

function fillRow(side, e) {
  const z = zdlOf(side, e);
  const cat = catOf(side, e);
  const [pic, , effect, meta] = e.row.cells;
  pic.replaceChildren(thumb(z?.picture, e.kind === 'dir' ? 'dir' : fileType(e.name)));
  effect.textContent = z?.isZdl ? z.name || '' : '';
  meta.textContent = e.kind === 'dir' ? 'Folder' : catText(cat);
  e.row.title = cat ? `${z?.name || e.name}: ${cat.group}${cat.fxid === undefined ? '' : `, gid + fxid ${fxidText(cat.gid, cat.fxid)}`} (from ${cat.from})` : '';
}

// The ".." row of a subfolder: double-click (or Backspace) goes up.
function upRow() {
  const tr = document.createElement('tr');
  tr.className = 'dir up';
  tr.dataset.up = '1';
  tr.title = 'Parent folder (double-click or Backspace)';
  for (const cls of ['pic', 'name', 'effect', 'meta', 'size']) {
    const td = document.createElement('td');
    td.className = cls;
    tr.append(td);
  }
  tr.cells[0].append(thumb(null, 'up'));
  tr.cells[1].textContent = '..';
  tr.cells[3].textContent = 'Parent folder';
  return tr;
}

function renderList(side) {
  const rows = side === 'pc' ? pc.entries : pedal.files;
  const trs = rows.map(e => makeRow(side, e));
  if (side === 'pc' && pc.stack.length > 1) trs.unshift(upRow());
  $(`${side}-list`).querySelector('tbody').replaceChildren(...trs);
  renderHeaders(side);
  renderSel(side);
  renderSums();
}

function renderSel(side) {
  const st = side === 'pc' ? pc : pedal;
  for (const tr of $(`${side}-list`).querySelectorAll('tbody tr')) tr.classList.toggle('sel', st.sel.has(tr.dataset.name));
  renderButtons();
  renderSums();
}

// Files of a list that Select all / Ctrl+A pick (folders are left out).
const selectable = side => (side === 'pc' ? pc.entries : pedal.files).filter(e => e.kind !== 'dir');

// Select all files of a list, or none when all are already selected.
function selectAll(side, toggle = true) {
  const st = side === 'pc' ? pc : pedal;
  const names = selectable(side).map(e => e.name);
  const all = names.length && names.every(n => st.sel.has(n));
  st.sel = new Set(toggle && all ? [] : names);
  renderSel(side);
}

// "3 selected (12 blocks)" for the files selected in a list, '' when none.
function selSum(side) {
  const st = side === 'pc' ? pc : pedal;
  const sel = selectable(side).filter(e => st.sel.has(e.name));
  return sel.length ? `${sel.length} selected (${fmtBlocks(sel.reduce((s, e) => s + blocks(e.size || 0), 0))})` : '';
}

function renderSums() {
  const files = pc.entries.filter(e => e.kind === 'file');
  const pcSel = selSum('pc'), pedalSel = selSum('pedal');
  $('pc-sum').textContent = pcDir()
    ? (pcSel ? `${pcSel} · ` : '') + `${files.length} files, ${fmtBlocks(files.reduce((s, e) => s + blocks(e.size), 0))} (${fmtSize(files.reduce((s, e) => s + e.size, 0))})`
    : '';
  const du = pedal.du;
  $('pedal-sum').textContent = pedal.connected
    ? (pedalSel ? `${pedalSel} · ` : '') + `${pedal.files.length}${zoom.maxFiles ? ` / ${zoom.maxFiles}` : ''} files` + (du ? `, ${Math.floor(du.avail / BLOCK)} blocks free` : '')
    : '';
  for (const side of ['pc', 'pedal']) {
    const st = side === 'pc' ? pc : pedal;
    const names = selectable(side);
    $(`${side}-selall`).textContent = names.length && names.every(e => st.sel.has(e.name)) ? 'Select none' : 'Select all';
  }
  setTitle('pc-title', 'PC folder', pcDir() ? pcPath() : '');
  $('pc-list').classList.toggle('off', !pcDir());   // no folder, no drops
  $('pc-title').title = pcDir() ? `${pcPath()} (Chrome shows a page only the picked folder’s name, not where it is on the disk)` : 'No folder picked';
}

// Panel title: bold label, then the value in normal weight.
function setTitle(id, label, value) {
  const b = document.createElement('b');
  b.textContent = value ? `${label}:` : label;
  $(id).replaceChildren(b, value ? ` ${value}` : '');
  if (id === 'pedal-title') $(id).title = value;
}

function renderPedalInfo() {
  const b = $('pedal-connect');
  b.textContent = pedal.connected && !pedal.dead ? 'Disconnect' : 'Connect';
  b.dataset.icon = pedal.connected && !pedal.dead ? 'unplug' : 'plug';
  $('midi-port').hidden = pedal.connected && !pedal.dead;   // only needed to pick a port before connecting
  $('pedal-list').classList.toggle('off', !pedal.connected || pedal.dead);   // no list, no drops
  let text = '';
  if (pedal.dead) text = 'not answering (replug it, then Connect)';
  else if (pedal.connected)
    text = `${deviceName(zoom.dev)}, firmware ${zoom.firmware}`;
  setTitle('pedal-title', 'Pedal', text);
  renderSums();
  renderButtons();
}

// Operations that change or re-read files (copy, delete, upload, list refresh) lock both
// lists and the buttons until they end; so does any loading bar (spinner) in either panel.
let busyOps = 0;
const isBusy = () => busyOps > 0 || document.querySelector('.panel.loading') !== null;

async function locked(fn) {
  busyOps++;
  renderButtons();
  try { return await fn(); } finally { busyOps--; renderButtons(); }
}

function renderButtons() {
  const busy = isBusy();
  document.body.classList.toggle('locked', busy);
  for (const id of ['pc-pick', 'pc-grant', 'pc-all', 'midi-port']) $(id).disabled = busy;
  const ok = pedal.connected && !pedal.dead;
  const pcFiles = [...pc.sel].filter(n => pc.entries.find(e => e.name === n)?.kind === 'file');
  $('pc-copy').disabled = busy || !ok || !pcFiles.length;
  $('pc-delete').disabled = busy || !pcFiles.length;
  $('pc-refresh').disabled = busy || !pcDir();
  $('pedal-delete').disabled = busy || !ok || !pedal.sel.size;
  $('pedal-copy').disabled = busy || !ok || !pedal.sel.size || !pcDir();
  $('pedal-copy').title = !pcDir() ? 'Pick a PC folder first' : `Copy the selected files into the PC folder${isMs() ? '' : ' (~10 KB/s)'}`;
  $('pedal-refresh').disabled = busy || !ok;
  $('pedal-connect').disabled = busy;
  $('pc-selall').disabled = busy || !pcDir() || !selectable('pc').length;
  $('pedal-selall').disabled = busy || !ok || !selectable('pedal').length;
}

// ---------------------------------------------------------------- preview

// Description rows, shared by the preview panel and the info command:
// name, fxid, category, size, DSP cost, version (the knobs follow separately).
function infoRows(e, z, cat) {
  const size = `${fmtBlocks(blocks(e.size))} (${e.size.toLocaleString()} B)`;
  const rows = [];
  if (z?.isZdl) {
    rows.push(['Name', z.name || '?'], ['Gid + fxid', fxidText(cat?.gid ?? z.gid, z.fxid)], ['Category', `${cat.group} (${cat.gid})`], ['Size', size]);
    if (z.cost !== undefined) rows.push(['DSP cost', z.cost]);
    rows.push(['Version', z.version || '?']);
  } else {
    if (cat) rows.push(['Category', `${cat.group} (${cat.gid})`]);
    rows.push(['Size', size]);
  }
  return rows;
}

function preview(side, name) {
  const info = $('preview-info');
  const canvas = $('preview');
  const e = side === 'pc' ? pc.entries.find(x => x.name === name) : pedal.files.find(x => x.name === name);
  if (!e || e.kind === 'dir') {
    drawPicture(canvas, null);
    info.innerHTML = '<p class="dim">Select a ZDL file to see its description.</p>';
    return;
  }
  const twin = side === 'pedal' ? pcTwin(e) : null;
  const z = side === 'pc' ? e.zdl : twin?.zdl;
  drawPicture(canvas, z?.picture || null);
  if (!z?.picture) noPicture(canvas);
  const cat = catOf(side, e);
  const rows = infoRows(e, z, cat);
  const h = document.createElement('h3');
  h.textContent = e.name;
  const dl = document.createElement('dl');
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    dl.append(dt, dd);
  }
  const parts = [h, dl];
  // Knobs: the list starts on the label's row.
  if (z?.knobs?.length) {
    const kt = document.createElement('dt');
    const kd = document.createElement('dd');
    kt.textContent = 'Knobs';
    const ol = document.createElement('ol');
    for (const k of z.knobs) {
      const li = document.createElement('li');
      li.textContent = `${k.name} (0..${k.max})`;
      ol.append(li);
    }
    kd.append(ol);
    dl.append(kt, kd);
  }
  const note = document.createElement('p');
  note.className = 'dim';
  if (side === 'pedal') note.textContent = (twin ? 'Picture from the PC copy (same name and size).' : 'Copy it to the PC to see its picture (a PC file with the same name and size shows it).')
    + (cat?.from === LIST_FILE ? ` Group from ${LIST_FILE}.` : '');
  else if (z?.error) note.textContent = `Could not read it: ${z.error}`;
  else if (isZdlName(e.name) && z && !z.isZdl) note.textContent = 'Not a ZDL (no Zoom header).';
  else if (z?.isZdl && !z.picture) note.textContent = 'No screen picture (a library or helper file).';
  if (note.textContent) parts.push(note);
  info.replaceChildren(...parts);
}

function noPicture(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#8a8a84';
  ctx.font = '15px system-ui, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('No picture', canvas.width / 2, canvas.height / 2);
}

// ---------------------------------------------------------------- selection

// Mouse sweep: press on a row that isn't selected (or on empty list space) and move over
// rows to select a range; pressing on a selected row drags the selection instead.
let sweep = null;
let skipClick = false;

function onMouseDown(ev) {
  if (ev.button !== 0 || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.target.closest('thead')) return;
  const list = ev.currentTarget;
  const side = list.dataset.side;
  const st = side === 'pc' ? pc : pedal;
  const tr = ev.target.closest('tbody tr');
  if (tr && (!tr.dataset.name || st.sel.has(tr.dataset.name))) return;
  if (!tr && ev.offsetX > list.clientWidth) return;   // the scroll bar
  ev.preventDefault();                                 // no drag and drop, no text selection
  list.focus();
  const name = tr ? tr.dataset.name : null;
  sweep = { side, anchor: name, moved: false };
  st.sel = new Set(name ? [name] : []);
  if (name) st.anchor = name;
  renderSel(side);
  if (name) preview(side, name);
}

function onSweepOver(ev) {
  if (!sweep) return;
  const tr = ev.target.closest('tbody tr');
  if (!tr?.dataset.name || tr.dataset.side !== sweep.side) return;
  const st = sweep.side === 'pc' ? pc : pedal;
  const names = (sweep.side === 'pc' ? pc.entries : pedal.files).map(e => e.name);
  if (sweep.anchor === null) sweep.anchor = st.anchor = tr.dataset.name;
  const [a, b] = [names.indexOf(sweep.anchor), names.indexOf(tr.dataset.name)].sort((x, y) => x - y);
  st.sel = new Set(names.slice(a, b + 1));
  sweep.moved = sweep.moved || tr.dataset.name !== sweep.anchor;
  renderSel(sweep.side);
}

// While sweeping, scroll the list when the pointer is near or past its top / bottom edge.
function onSweepMove(ev) {
  if (!sweep) return;
  const list = $(`${sweep.side}-list`);
  const r = list.getBoundingClientRect();
  if (ev.clientY < r.top + 40) list.scrollTop -= 12;
  else if (ev.clientY > r.bottom - 16) list.scrollTop += 12;
}

function onSweepEnd() {
  if (!sweep) return;
  skipClick = sweep.moved;
  sweep = null;
  setTimeout(() => { skipClick = false; }, 0);
}

function onClick(ev) {
  if (skipClick) return;
  const tr = ev.target.closest('tbody tr');
  if (!tr || !tr.dataset.name) return;
  const side = tr.dataset.side;
  const st = side === 'pc' ? pc : pedal;
  const names = (side === 'pc' ? pc.entries : pedal.files).map(e => e.name);
  const name = tr.dataset.name;
  if (ev.shiftKey && st.anchor !== null && names.includes(st.anchor)) {
    const [a, b] = [names.indexOf(st.anchor), names.indexOf(name)].sort((x, y) => x - y);
    if (!ev.ctrlKey) st.sel.clear();
    names.slice(a, b + 1).forEach(n => st.sel.add(n));
  } else if (ev.ctrlKey || ev.metaKey) {
    st.sel.has(name) ? st.sel.delete(name) : st.sel.add(name);
    st.anchor = name;
  } else {
    st.sel = new Set([name]);
    st.anchor = name;
  }
  renderSel(side);
  preview(side, name);
}

function onKey(ev) {
  if (isBusy()) return;
  const side = ev.currentTarget.dataset.side;
  const st = side === 'pc' ? pc : pedal;
  const rows = side === 'pc' ? pc.entries : pedal.files;
  if (ev.key === 'a' && (ev.ctrlKey || ev.metaKey)) {
    selectAll(side, false);
  } else if (ev.key === 'Delete') {
    side === 'pc' ? deletePc([...pc.sel]) : deletePedal([...pedal.sel]);
  } else if (ev.key === 'Backspace' && side === 'pc') {
    up();
  } else if (ev.key === 'Enter' && side === 'pc' && pc.sel.size === 1) {
    const e = pc.entries.find(x => x.name === pc.anchor);
    if (e?.kind === 'dir') enter(e);
  } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    if (!rows.length) return;
    const i = rows.findIndex(e => e.name === st.anchor);
    const j = Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + (ev.key === 'ArrowDown' ? 1 : -1)));
    st.sel = new Set([rows[j].name]);
    st.anchor = rows[j].name;
    renderSel(side);
    preview(side, rows[j].name);
    rows[j].row?.scrollIntoView({ block: 'nearest' });
  } else return;
  ev.preventDefault();
}

// ---------------------------------------------------------------- PC panel

// Show a folder (a FileSystemDirectoryHandle, or anything with its name / values()) in the PC panel.
export async function openFolder(dir) {
  pc.stack = [dir];
  $('pc-grant').hidden = true;
  await refreshPc(true);
}

async function pick() {
  if (!pcfs.supported()) { log('This browser cannot open folders: use Chrome or Edge.', 'err'); return; }
  try {
    await openFolder(await pcfs.pick());
  } catch (e) {
    if (e.name !== 'AbortError') log(`Folder: ${e.message}`, 'err');
  }
}

async function enter(e) {
  pc.stack.push(e.handle);
  await refreshPc(true);
}

async function up() {
  if (pc.stack.length < 2) return;
  const left = pc.stack.pop().name;
  await refreshPc(true);
  pc.sel = new Set([left]);
  pc.anchor = left;
  renderSel('pc');
}

async function refreshPc(newDir = false) {
  const gen = ++pc.gen;
  const dir = pcDir();
  if (!dir) { pc.entries = []; renderList('pc'); return; }
  let entries;
  loadbar('pc', 0);
  try {
    entries = await pcfs.list(dir);
  } catch (e) {
    log(`Can't read ${dir.name}: ${e.message}`, 'err');
    loadbar('pc', null);
    return;
  }
  if (gen !== pc.gen) return;
  pc.urls.forEach(u => URL.revokeObjectURL(u));
  pc.urls = [];
  pc.entries = entries.filter(e => e.kind === 'dir' || pc.showAll || isZdlName(e.name));
  if (newDir) { pc.sel.clear(); pc.anchor = null; }
  else pc.sel = new Set([...pc.sel].filter(n => pc.entries.some(e => e.name === n)));
  for (const e of pc.entries) if (e.kind === 'file') e.zdl = parsed.get(`${e.name}|${e.size}|${e.mtime}`);
  sortRows('pc');
  renderList('pc');
  renderList('pedal');
  // Pictures: read the ZDLs one by one so the list shows at once.
  const todo = pc.entries.filter(e => e.kind === 'file' && !e.zdl && isZdlName(e.name) && e.size <= 4 << 20);
  for (const [i, e] of todo.entries()) {
    loadbar('pc', i, todo.length);
    const key = `${e.name}|${e.size}|${e.mtime}`;
    try {
      e.zdl = parseZdl(new Uint8Array(await e.file.arrayBuffer()));
    } catch (err) {
      e.zdl = { isZdl: false, knobs: [], error: err.message };
    }
    parsed.set(key, e.zdl);
    if (gen !== pc.gen) return;
    fillRow('pc', e);
    if (pc.anchor === e.name) preview('pc', e.name);
  }
  loadbar('pc', null);
  // Categories are known now: re-sort lists sorted by them.
  if (pc.sort.key === 'category') { sortRows('pc'); renderList('pc'); }
  if (pedal.sort.key === 'category') { sortRows('pedal'); renderList('pedal'); }
  else for (const f of pedal.files) if (f.row) fillRow('pedal', f);
}

async function deletePc(names, yes = false) {
  const files = names.filter(n => pc.entries.find(e => e.name === n)?.kind === 'file');
  if (!files.length) return;
  if (!yes && !confirm(`Delete from the PC folder ${pcPath()}:\n\n${files.join('\n')}`)) return;
  await locked(() => deletePcFiles(files));
}

async function deletePcFiles(files) {
  for (const n of files) {
    try {
      await pcfs.remove(pcDir(), n);
      log(`Deleted ${n} from the PC folder`, 'ok');
    } catch (e) {
      log(`Can't delete ${n}: ${e.message}`, 'err');
    }
  }
  await refreshPc();
}

async function saveToPc(files) {
  if (!pcDir()) { log('Pick a PC folder first.', 'warn'); return; }
  await locked(() => saveFilesToPc(files));
}

async function saveFilesToPc(files) {
  for (const f of files) {
    try {
      if (await pcfs.exists(pcDir(), f.name) && !confirm(`${f.name} already exists in ${pcPath()}. Replace it?`)) continue;
      await pcfs.write(pcDir(), f.name, f);
      log(`Copied ${f.name} into ${pcPath()}`, 'ok');
    } catch (e) {
      log(`Can't write ${f.name}: ${e.message}`, 'err');
    }
  }
  await refreshPc();
}

// ---------------------------------------------------------------- pedal

function markDead(why) {
  pedal.dead = true;
  keepalive.stop();
  log(`${why}. Replug the pedal's USB cable, wait until it has started, then press "Connect".`, 'err');
  renderPedalInfo();
}

function ready() {
  if (pedal.dead) { log('The pedal stopped answering: replug it, then press "Connect".', 'err'); return false; }
  if (!pedal.connected) { log('Not connected to the pedal.', 'warn'); return false; }
  return true;
}

// Writes (and the G1on's raw flash reads) on a pedal they were never tried on need one OK per
// connection.
function writable() {
  if (!ready()) return false;
  if (DEVICES[zoom.dev]?.tested || pedal.untestedOk) return true;
  pedal.untestedOk = confirm(`${deviceName(zoom.dev)}: Stomp Commander has never written to this pedal (protocol: ${isMs() ? 'MultiStomp' : 'G1on family'}).`
    + '\n\nKeep a backup of its effects (Zoom Effect Manager or the updater can restore them). Allow changes on it until you disconnect?');
  if (!pedal.untestedOk) log(`Cancelled: ${deviceName(zoom.dev)} is untested.`, 'warn');
  return pedal.untestedOk;
}

// Run one pedal operation with the buttons locked; errors go to the log.
async function op(label, fn) {
  busyOps++;
  status(label);
  loadbar('pedal', 0);
  renderButtons();
  try {
    const r = await zoom.task(fn);
    return r;
  } catch (e) {
    if (/identity|no data reply/.test(e.message)) markDead(e.message);
    else log(e.message, 'err');
  } finally {
    busyOps--;
    progress(null);
    if (!busyOps) loadbar('pedal', null);
    renderButtons();
  }
}

async function fillPorts() {
  const sel = $('midi-port');
  const names = midi.outputNames();
  const saved = await idb.get('port');
  sel.replaceChildren(...names.map(n => new Option(n, n)));
  const pickName = names.find(n => n === saved) || names.find(n => /ZOOM 1 Series/i.test(n)) || names.find(n => /zoom/i.test(n));
  if (pickName) sel.value = pickName;
  if (!names.length) sel.append(new Option('no MIDI output', ''));
}

async function connect() {
  if (pedal.connected && !pedal.dead) { disconnect(); return; }
  pedal.connected = false;
  try {
    await midi.init();
    await fillPorts();
  } catch (e) {
    log(`MIDI: ${e.message}`, 'err');
    return;
  }
  const name = $('midi-port').value;
  if (!name) { log('No MIDI output found. Plug in the pedal, wait until it has started, then press "Connect".', 'warn'); return; }
  try {
    await midi.open(name);
  } catch (e) {
    log(e.message, 'err');
    return;
  }
  idb.set('port', name);
  pedal.dead = false;
  pedal.untestedOk = false;
  const dev = await op('Asking the pedal who it is…', z => z.identify());
  if (dev === undefined) {
    midi.close();
    log('If a replug doesn\'t help, Chrome\'s MIDI service is still holding the old port: quit Chrome completely (in Task Manager, end every "Google Chrome" process, including ones running in the background), replug the pedal, then start Chrome again.', 'warn');
    renderPedalInfo();
    return;
  }
  useProfile(dev);
  pedal.connected = true;
  log(`Connected: ${deviceName(dev)} (device 0x${dev.toString(16).toUpperCase()}), firmware ${zoom.firmware}`, 'ok');
  if (!DEVICES[dev]) log('Unknown device: the G1on-family protocol is used; changes on the pedal ask first.', 'warn');
  else if (!DEVICES[dev].tested) log(`${DEVICES[dev].name}: writes are untested on it; changes on the pedal ask first.`, 'warn');
  keepalive.start();
  renderPedalInfo();
  await refreshPedal();
}

function disconnect() {
  keepalive.stop();
  midi.close();
  pedal.connected = false;
  pedal.untestedOk = false;
  pedal.files = [];
  pedal.du = null;
  pedal.flst = null;
  pedal.sel.clear();
  log('Disconnected');
  renderList('pedal');
  renderPedalInfo();
}

// Reload / close: stop the keep-alive and close the MIDI ports while the page is still alive,
// instead of leaving it to Chrome's teardown.
addEventListener('pagehide', () => {
  keepalive.stop();
  midi.close();
});

// F5 / Ctrl+R / Ctrl+Shift+R: close the ports first and wait until Chrome confirms, then reload.
// (The toolbar's reload button can't be caught; pagehide above covers it.)
addEventListener('keydown', async ev => {
  const reload = ev.key === 'F5' || ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'r');
  if (!reload || !midi.isOpen) return;
  ev.preventDefault();
  if (busyOps > 0 && !confirm('An operation on the pedal is still running. Reload anyway?')) return;
  keepalive.stop();
  await midi.close();
  location.reload();
}, true);

// Reload or close while connected: Chrome asks first ("Leave site?"; its text can't be changed),
// because leaving with the port open can hang Chrome's MIDI service until every Chrome process ends.
addEventListener('beforeunload', ev => {
  if (!midi.isOpen) return;
  ev.preventDefault();
  ev.returnValue = '';
  log('Press "Disconnect" before you reload or close this page: an open MIDI port can hang Chrome.', 'warn');
});

async function refreshPedal() {
  if (!ready()) return;
  // The empty list says what is happening while the first listing loads (connect).
  const empty = $('pedal-list').querySelector('.empty');
  const idle = empty.textContent;
  if (!pedal.files.length) empty.textContent = 'Connected. Loading file list…';
  const r = await op('Reading the pedal’s file list…', z => z.session(async () => {
    const files = await z.listing();
    const du = await z.diskUsage();
    let flst = null;
    if (DEVICES[z.dev] && files.some(f => f.name.toUpperCase() === LIST_FILE)) {
      status(`Reading the effect list ${LIST_FILE}…`);
      try {
        flst = parseEffectList(await z.readFile(LIST_FILE, await z.fileTable()));
      } catch (e) {
        if (/no data reply/.test(e.message)) throw e;
        log(`Can't read ${LIST_FILE}: ${e.message}`, 'warn');
      }
    }
    return { files, du, flst };
  }));
  empty.textContent = idle;
  if (!r) return;
  if (!r.du && !r.files.length) { markDead('No reply to the file list'); return; }
  pedal.files = r.files;
  pedal.flst = r.flst;
  sortRows('pedal');
  pedal.du = r.du;
  pedal.sel = new Set([...pedal.sel].filter(n => pedal.files.some(f => f.name === n)));
  renderList('pedal');
  renderPedalInfo();
  log(`Pedal: ${pedal.files.length} files` + (r.du ? `, ${Math.floor(r.du.avail / BLOCK)} blocks free` : '')
    + (r.flst ? `; ${LIST_FILE} gives the group of ${pedal.files.filter(f => r.flst.has(f.name.toUpperCase())).length}` : `; no ${LIST_FILE}`));
}

// The pedal's name for an uploaded file: as the tools do, .ZDL names upper case.
function pedalName(name) {
  const n = isZdlName(name) ? name.toUpperCase() : name;
  return /^[\x21-\x7E]{1,8}\.[\x21-\x7E]{1,3}$/.test(n) && !/[\\/:*?"<>|]/.test(n) ? n : null;
}

// ---------------------------------------------------------------- effect ids
//
// An effect's identity is gid + fxid (ZDL header bytes 0x3C and 0x40..0x41), not its file name:
// two files with the same id can't be told apart in a patch. Original MS pedals keep only
// 10 bits of the fxid in a patch, so ids are compared as fxid & 0x3FF (the G1on family keeps
// more, but the same ZDL may run on both).
const ZDL_HEAD = 0x4C;
const idKey = (gid, fxid) => `${gid}:${fxid & 0x3FF}`;
const idText = (gid, fxid) => `${fxidText(gid, fxid)} (${groupName(gid)})`;

// Pedal file headers by name|size|first block, kept between visits (a rewritten file gets a
// new entry). Value: [gid, fxid], or null for a file without a Zoom header.
let headCache = null;

async function loadHeadCache() {
  if (!headCache) {
    const saved = await idb.get('heads');
    headCache = new Map(saved && typeof saved === 'object' ? Object.entries(saved) : []);
  }
  return headCache;
}

// UPPERCASE name -> { name, gid, fxid } for every ZDL on the pedal. Reads one header per file
// not in the cache (~1 flash read each). Files whose header can't be read are left out (logged).
async function pedalIds(z, files) {
  const cache = await loadHeadCache();
  const table = await z.fileTable();
  const zdls = files.filter(f => isZdlName(f.name));
  const out = new Map();
  let read = 0, changed = false;
  for (const [i, f] of zdls.entries()) {
    const ent = table.get(f.name.toUpperCase());
    if (!ent) { log(`Effect id of ${f.name} unknown: not in the flash file table`, 'warn'); continue; }
    const key = `${ent.name.toUpperCase()}|${ent.size}|${ent.addr}`;
    let v = cache.get(key);
    if (v === undefined) {
      status(`Reading effect ids… ${f.name}`);
      progress(i, zdls.length);
      try {
        const h = parseZdl(await z.readHead(ent, ZDL_HEAD));
        v = h.isZdl ? [h.gid, h.fxid] : null;
      } catch (e) {
        if (/no data reply/.test(e.message)) throw e;
        log(`Effect id of ${f.name} unknown: ${e.message}`, 'warn');
        continue;
      }
      cache.set(key, v);
      read++;
      changed = true;
    }
    if (v) out.set(f.name.toUpperCase(), { name: f.name, gid: v[0], fxid: v[1] });
  }
  progress(null);
  if (changed) {
    // Drop entries of files no longer on the pedal, then save.
    const live = new Set([...table.values()].map(e => `${e.name.toUpperCase()}|${e.size}|${e.addr}`));
    for (const k of [...cache.keys()]) if (!live.has(k)) cache.delete(k);
    idb.set('heads', Object.fromEntries(cache));
  }
  if (read) log(`Read the effect ids of ${read} pedal file${read === 1 ? '' : 's'}`);
  return out;
}

// items: [{ name, data: Uint8Array }]
async function upload(items, yes = false) {
  if (!writable()) return;
  const jobs = [];
  for (const it of items) {
    const name = pedalName(it.name);
    if (!name) { log(`SKIP ${it.name}: the pedal needs an 8.3 name (at most 8 characters + extension)`, 'err'); continue; }
    if (isZdlName(name) && !parseZdl(it.data).isZdl) { log(`SKIP ${it.name}: not a ZDL (no Zoom header)`, 'err'); continue; }
    jobs.push({ name, data: it.data });
  }
  if (!jobs.length) return;
  if (!yes && !confirm(`Upload to the pedal:\n\n${jobs.map(j => `${j.name}  ${fmtBlocks(blocks(j.data.length))} (${fmtSize(j.data.length)})`).join('\n')}`)) return;
  await op('Uploading…', z => z.session(async () => {
    let files = await z.listing();
    let du = await z.diskUsage();
    // Effect ids on the pedal (only needed when a ZDL goes up); uploads of this run join it.
    const ids = jobs.some(j => isZdlName(j.name)) ? await pedalIds(z, files) : new Map();
    const adds = [];   // uploaded effects for the effect list: { name, gid }
    for (const job of jobs) {
      const hz = isZdlName(job.name) ? parseZdl(job.data) : null;
      const there = files.find(f => f.name.toUpperCase() === job.name.toUpperCase());
      // Same gid + fxid as another file: the pedal and its patches can't tell the two apart.
      const clash = hz && [...ids.values()].find(i => i.name.toUpperCase() !== job.name
        && idKey(i.gid, i.fxid) === idKey(hz.gid, hz.fxid));
      if (clash) {
        const same = clash.fxid === hz.fxid ? '' : ` (fxid ${clash.fxid} vs ${hz.fxid}: equal in an original-MS patch, which keeps 10 bits)`;
        const what = `${job.name} has the effect id ${idText(hz.gid, hz.fxid)} of ${clash.name} on the pedal${same}`;
        if (yes || !confirm(`${what}. Patches can't tell the two apart.

Delete ${clash.name} and upload ${job.name} instead?
(Cancel skips ${job.name}; or change its fxid and rebuild.)`)) {
          log(`SKIP ${job.name}: ${what}. Delete ${clash.name} first, or give ${job.name} another fxid.`, 'err');
          continue;
        }
        if (!await listRemove(z, [clash.name])) { log(`FAIL ${job.name}: ${clash.name} kept (effect list not updated)`, 'err'); continue; }
        if (!await z.delete(clash.name)) { log(`FAIL ${job.name}: could not delete ${clash.name}`, 'err'); continue; }
        files = files.filter(f => f.name.toUpperCase() !== clash.name.toUpperCase());
        ids.delete(clash.name.toUpperCase());
        du = await z.diskUsage();
        log(`Deleted ${clash.name} (same effect id as ${job.name})`);
      }
      if (there) {
        if (!yes && !confirm(`${job.name} is already on the pedal (${there.size} bytes). Replace it?`)) { log(`SKIP ${job.name}: kept the pedal's copy`); continue; }
        if (!await z.delete(there.name)) { log(`FAIL ${job.name}: could not delete the old copy`, 'err'); continue; }
        files = files.filter(f => f !== there);
        ids.delete(job.name);
        du = await z.diskUsage();
        log(`Deleted the old ${there.name}`);
      }
      if (z.maxFiles && files.length >= z.maxFiles) { log(`SKIP ${job.name}: the pedal has ${files.length} files and refuses more than ${z.maxFiles}. Delete one first.`, 'err'); continue; }
      const need = blocks(job.data.length) * BLOCK;
      if (du && du.avail < need) { log(`SKIP ${job.name}: needs ${blocks(job.data.length)} blocks, ${Math.floor(du.avail / BLOCK)} free. Delete something first.`, 'err'); continue; }
      status(`Uploading ${job.name}…`);
      const t0 = performance.now();
      try {
        await z.upload(job.name, job.data, (d, t) => progress(d, t));
      } catch (e) {
        log(`FAIL ${job.name}: ${e.message}`, 'err');
        continue;
      } finally {
        progress(null);
      }
      const hit = await z.stat(job.name);
      du = await z.diskUsage();
      if (hit && hit.size === job.data.length) {
        log(`OK ${job.name}: ${job.data.length} bytes in ${((performance.now() - t0) / 1000).toFixed(1)} s`, 'ok');
        files.push(hit);
        if (hz?.isZdl) ids.set(job.name, { name: hit.name, gid: hz.gid, fxid: hz.fxid });
        if (hz?.isZdl) adds.push({ name: job.name, gid: hz.gid });
      } else log(`FAIL ${job.name}: wrote ${job.data.length} bytes, the list says ${hit ? hit.size : 'missing'}`, 'err');
    }
    // The pedal lists only effects named in its effect list: files first, then their records.
    if (adds.length) await listAdd(z, adds);
    await z.identify();   // still talking to us?
  }));
  await refreshPedal();
}

async function deletePedal(names, yes = false) {
  if (!names.length || !writable()) return;
  const hasList = names.some(n => n.toUpperCase() === LIST_FILE);
  if (hasList && isMs()) { log(`${LIST_FILE} stays on a MultiStomp: deleting an effect removes its record from it.`, 'err'); return; }
  if (!yes && !confirm(`Delete from the pedal (cannot be undone; keep a backup of Zoom's effects):\n\n${names.join('\n')}`
    + (hasList ? `\n\n${LIST_FILE} is the effect list; the pedal makes a new one (every effect, in its own order) with the next upload or when it starts.` : ''))) return;
  await op('Deleting…', z => z.session(async () => {
    // The records go first, so the list never names a missing file (not when the list goes too).
    if (!hasList && !await listRemove(z, names)) {
      log('Nothing deleted.', 'err');
      return;
    }
    for (const n of names) {
      const ok = await z.delete(n);
      const gone = !(await z.stat(n));
      log(`${ok && gone ? 'OK' : 'FAIL'} delete ${n}` + (ok && gone ? '' : ` (ack ${ok ? 'good' : 'unexpected'}, gone ${gone})`), ok && gone ? 'ok' : 'err');
      if (ok && gone && n.toUpperCase() === LIST_FILE)
        log(`Restart the pedal: it makes a new ${LIST_FILE} with every effect, in its own order.`, 'warn');
    }
    await z.identify();
  }));
  pedal.sel.clear();
  await refreshPedal();
}

// ---------------------------------------------------------------- effect list (FLST_SEQ.ZDT)
//
// The pedal lists only the effects named in FLST_SEQ.ZDT: an uploaded effect gets a record at the
// end of its group (gid = header byte 0x3C), a deleted one loses it. Effect files are written
// before their records and a record is removed before its file; every list write is read back,
// and a failed one puts the old list back.
// Both families the same way; the G1on can have no list (the pedal writes one by itself with the
// next upload, or when it starts): then nothing is edited. The menu shows the change at once.

// The pedal's list, or null when a G1on-family pedal has none.
async function listRead(z) {
  if (z.family === 'g1' && !await z.stat(LIST_FILE)) return null;
  const list = await z.readFile(LIST_FILE, await z.fileTable());
  if (!list.length) throw new Error(`can't read ${LIST_FILE}`);
  return list;
}

// Write the list: replace the file, then read it back. The MultiStomp's upload does both itself;
// the G1on's upload doesn't replace, so the old list is deleted first, and the read goes through
// the flash.
async function listPut(z, data) {
  if (z.family !== 'g1') return z.upload(LIST_FILE, data);
  if (await z.stat(LIST_FILE) && (!await z.delete(LIST_FILE) || await z.stat(LIST_FILE))) throw new Error('could not delete the old list');
  await z.upload(LIST_FILE, data);
  const back = await z.readFile(LIST_FILE, await z.fileTable());
  if (back.length !== data.length || back.some((b, i) => b !== data[i]))
    throw new Error(`read back ${back.length} bytes, ${back.length === data.length ? 'different' : `wrote ${data.length}`}`);
}

async function listWrite(z, list, next, what) {
  status(`Updating ${LIST_FILE}…`);
  try {
    await listPut(z, next);
    log(`${LIST_FILE}: ${what}`, 'ok');
    return true;
  } catch (e) {
    log(`FAIL ${LIST_FILE} (${what}): ${e.message}; writing the old list back`, 'err');
    try {
      await listPut(z, list);
      log(`${LIST_FILE}: old list written back`, 'warn');
    } catch (e2) {
      downloadFile(`pedal-${LIST_FILE}`, list);
      log(`WRITING THE OLD ${LIST_FILE} BACK FAILED: ${e2.message}. It was saved as a download: upload it (put) before restarting the pedal.`, 'err');
    }
    return false;
  }
}

// Add uploaded effects ([{ name, gid }]) to the list, one write for all.
async function listAdd(z, adds) {
  const names = adds.map(a => a.name).join(', ');
  let list;
  try {
    status(`Reading ${LIST_FILE}…`);
    list = await listRead(z);
  } catch (e) {
    log(`${names} on the pedal but not in ${LIST_FILE} (${e.message}): the pedal won't list ${adds.length > 1 ? 'them' : 'it'}.`, 'err');
    return false;
  }
  if (!list) { log(`No ${LIST_FILE} on the pedal: it lists every effect after a restart.`, 'warn'); return true; }
  let next = list;
  const added = [];
  for (const a of adds) {
    try {
      const n = effectListAdd(next, a.gid, a.name);
      if (n) { next = n; added.push(`${a.name} to ${groupName(a.gid)}`); }   // null: already listed (a replaced effect)
    } catch (e) {
      log(`${a.name} is on the pedal but not in ${LIST_FILE} (${e.message}): the pedal won't list it.`, 'err');
    }
  }
  if (!added.length) return true;
  return listWrite(z, list, next, `added ${added.join(', ')}`);
}

async function listRemove(z, names) {
  try {
    const list = await listRead(z);
    const next = list && effectListRemove(list, names);
    return !next || await listWrite(z, list, next, `removed ${names.join(', ')}`);
  } catch (e) {
    log(`Can't update ${LIST_FILE}: ${e.message}`, 'err');
    return false;
  }
}

function downloadFile(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// Pedal -> PC: G1on family through raw flash reads (~10 KB/s; the file table is read once per
// run), MultiStomp through its own file read.
async function copyToPc(names, yes = false) {
  if (!names.length || !writable()) return;
  if (!pcDir()) { log('Pick a PC folder first.', 'warn'); return; }
  const jobs = [];
  for (const n of names) {
    const f = pedal.files.find(x => x.name === n);
    if (!f) continue;
    if (!yes && await pcfs.exists(pcDir(), n) && !confirm(`${n} already exists in ${pcPath()}. Replace it?`)) { log(`SKIP ${n}: kept the PC copy`); continue; }
    jobs.push(f);
  }
  if (!jobs.length) return;
  await op('Reading the pedal’s file table…', z => z.session(async () => {
    const table = await z.fileTable();
    for (const f of jobs) {
      status(`Copying ${f.name} to the PC…`);
      const t0 = performance.now();
      let data;
      try {
        data = await z.readFile(f.name, table, (d, t) => progress(d, t));
      } catch (e) {
        if (/no data reply/.test(e.message)) throw e;   // the pedal may have stopped answering
        log(`FAIL ${f.name}: ${e.message}`, 'err');
        continue;
      } finally {
        progress(null);
      }
      if (data.length !== f.size) { log(`FAIL ${f.name}: read ${data.length} bytes, the list says ${f.size}`, 'err'); continue; }
      try {
        await pcfs.write(pcDir(), f.name, data);
        log(`OK ${f.name}: ${data.length} bytes in ${((performance.now() - t0) / 1000).toFixed(1)} s -> ${pcPath()}`, 'ok');
      } catch (e) {
        log(`FAIL ${f.name}: can't write it: ${e.message}`, 'err');
      }
    }
    await z.identify();   // still talking to us?
  }));
  await refreshPc();
}

async function copySelectedToPedal(yes = false, names = [...pc.sel]) {
  const items = [];
  for (const n of names) {
    const e = pc.entries.find(x => x.name === n && x.kind === 'file');
    if (e) items.push({ name: e.name, data: new Uint8Array(await e.file.arrayBuffer()) });
  }
  await upload(items, yes);
}

// ---------------------------------------------------------------- drag and drop

let dragSide = null;

function onDragStart(ev) {
  const tr = ev.target.closest('tbody tr');
  if (!tr || !tr.dataset.name) return;
  const side = tr.dataset.side;
  const st = side === 'pc' ? pc : pedal;
  if (!st.sel.has(tr.dataset.name)) {
    st.sel = new Set([tr.dataset.name]);
    st.anchor = tr.dataset.name;
    renderSel(side);
  }
  dragSide = side;
  ev.dataTransfer.effectAllowed = 'copy';
  ev.dataTransfer.setData(DRAG_TYPE, side);
  // Chrome: one PC file can also be dragged out to the desktop or Explorer.
  const e = side === 'pc' && st.sel.size === 1 ? pc.entries.find(x => x.name === tr.dataset.name && x.kind === 'file') : null;
  if (e) {
    const url = URL.createObjectURL(e.file);
    pc.urls.push(url);
    ev.dataTransfer.setData('DownloadURL', `application/octet-stream:${e.name}:${url}`);
  }
}

function setupDrop(list) {
  const side = list.dataset.side;
  const accepts = ev => ev.dataTransfer.types.includes('Files') || (ev.dataTransfer.types.includes(DRAG_TYPE) && dragSide !== side);
  list.addEventListener('dragover', ev => {
    if (!accepts(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    list.classList.add('drop');
  });
  list.addEventListener('dragleave', ev => { if (!list.contains(ev.relatedTarget)) list.classList.remove('drop'); });
  list.addEventListener('drop', async ev => {
    list.classList.remove('drop');
    if (!accepts(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer.types.includes(DRAG_TYPE)) {
      if (side === 'pedal') await copySelectedToPedal();
      else await copyToPc([...pedal.sel]);
      return;
    }
    const files = [...ev.dataTransfer.files];
    if (side === 'pc') { await saveToPc(files); return; }
    const items = [];
    for (const f of files) {
      try { items.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }); }
      catch { log(`SKIP ${f.name}: can't read it (a folder?)`, 'err'); }
    }
    await upload(items);
  });
}

document.addEventListener('dragend', () => { dragSide = null; });

// ---------------------------------------------------------------- command line

const history = [];
let histPos = 0;

const api = {
  log,
  pcEntries: () => pc.entries,
  pcPath: () => (pcDir() ? pcPath() : ''),
  pedalFiles: () => pedal.files,
  pick, connect: () => (pedal.connected && !pedal.dead ? log('Already connected.') : connect()), disconnect,
  refresh: async () => { await refreshPc(); if (pedal.connected) await refreshPedal(); },
  info: name => {
    const e = pc.entries.find(x => x.kind === 'file' && x.name.toLowerCase() === name.toLowerCase());
    const f = pedal.files.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!e && !f) { log(`no file ${name} in the PC folder or on the pedal`, 'warn'); return; }
    const side = e ? 'pc' : 'pedal';
    const z = e ? e.zdl : pcTwin(f)?.zdl;
    preview(side, (e || f).name);
    const cat = catOf(side, e || f);
    const rows = infoRows(e || f, z, cat);
    if (z?.knobs?.length) z.knobs.forEach((k, i) => rows.push([i ? '' : 'Knobs', `${i + 1}. ${k.name} (0..${k.max})`]));
    log(`${(e || f).name}${side === 'pedal' && !z ? ' (pedal; copy it to the PC for its description)' : ''}`);
    for (const [k, v] of rows) log(`  ${k.padEnd(10)} ${v}`);
  },
  put: (names, yes) => copySelectedToPedal(yes, names),
  get: (names, yes) => copyToPc(names, yes),
  rm: (names, yes) => deletePedal(names, yes),
  pcrm: (names, yes) => deletePc(names, yes),
  ping: async () => {
    if (!ready()) return;
    if (await op('Ping…', z => z.identify(false)) !== undefined) log('Pedal answered.', 'ok');
  },
  keepalive: () => {
    if (!keepalive.running) { log(`Keep-alive: every ${INTERVAL} s while connected (not running now)`); return; }
    log(`Keep-alive: every ${INTERVAL} s, ${keepalive.pings} ping${keepalive.pings === 1 ? '' : 's'} answered`
      + (keepalive.last ? `, last at ${keepalive.last.toTimeString().slice(0, 8)}` : ''));
  },
  // The current patch, as Custom-Zoom-ZDL-Effects' tools/g1on_sysex.py (G1on family): no PC mode, unsaved edits stay.
  patch: async name => {
    if (!g1Only('patch')) return;
    if (name && !pcDir()) { log('Pick a PC folder first (or leave out the file name).', 'warn'); return; }
    const rows = await op('Reading the current patch…', z => z.patch());
    if (rows === undefined) return;
    if (!rows.length) { log('FAIL no patch reply', 'err'); return; }
    for (const r of rows) {
      log(`${String(r.length + 2).padStart(5)} B  F0 ${hex(r, r.length)} F7`);
      for (const line of describePatch(unpack7(r.slice(4)).slice(0, 112))) log('   ' + line);
    }
    if (!name) return;
    try {
      await pcfs.write(pcDir(), name, Uint8Array.from(rows.flatMap(r => [0xF0, ...r, 0xF7])));
      log(`OK ${rows.length} repl${rows.length === 1 ? 'y' : 'ies'} -> ${pcPath()}/${name}`, 'ok');
    } catch (e) {
      log(`Can't write ${name}: ${e.message}`, 'err');
    }
    await refreshPc();
  },
  knob: async (slot, param, value) => {
    if (!g1Only('knob')) return;
    if (await op('Setting a knob…', z => z.knob(slot, param, value).then(() => true)))
      log(`OK slot ${slot} param ${param} = ${value} (sent, not saved)`, 'ok');
  },
  program: async n => {
    if (!g1Only('program')) return;
    if (await op('Switching patch…', z => z.program(n).then(() => true)))
      log(`OK program change ${n} (sent; unsaved edits of the old patch are lost)`, 'ok');
  },
  // Pedal state, read-only, as tools/g1on_sysex.py current / settings / patchinfo / status.
  current: async () => {
    if (!g1Only('current')) return;
    const n = await op('Reading the patch number…', z => z.currentPatch());
    if (n === undefined) return;
    if (n === null) log('FAIL no Program Change reply', 'err');
    else log(`OK current patch ${n}`, 'ok');
  },
  settings: async () => {
    if (!g1Only('settings')) return;
    const values = await op('Reading the global settings…', z => z.globalSettings());
    if (values === undefined) return;
    if (values === null) { log('FAIL no 2A reply', 'err'); return; }
    GLOBAL_FIELDS.forEach(([, name, show], i) => log(`   ${name.padEnd(18)} ${show(values[i])}`));
  },
  patchinfo: async () => {
    if (!g1Only('patchinfo')) return;
    const f = await op('Reading the patch format…', z => z.patchFormat());
    if (f === undefined) return;
    if (f === null) log('FAIL no 06 reply', 'err');
    else log(`OK ${f[0]} patches x ${f[1]} bytes`, 'ok');
  },
  status: async () => {
    if (!g1Only('status')) return;
    const v = await op('Reading the status…', z => z.status());
    if (v === undefined) return;
    if (v === null) log('FAIL no 17 reply', 'err');
    else log(`OK status ${v} (0x${v.toString(16)})`, 'ok');
  },
  verbose: on => { showSysex = on; log(`SysEx in log: ${on ? 'on' : 'off'}`); },
  clearLog: () => { $('log').replaceChildren(); },
  saveLog,
};

function g1Only(what) {
  if (!ready()) return false;
  if (DEVICES[zoom.dev]?.family === 'g1') return true;
  log(`${what}: G1on family only`, 'warn');
  return false;
}

// Suggestions for the word being typed (commands, then their files / words), shown above the input.
let sug = { from: 0, items: [], idx: -1 };

function updateSuggest() {
  const ta = $('cli');
  const box = $('suggest');
  const caret = ta.selectionStart;
  const lineStart = ta.value.lastIndexOf('\n', caret - 1) + 1;
  const line = ta.value.slice(lineStart, caret);
  const atEnd = caret === ta.selectionEnd && !/\S/.test(ta.value.slice(caret).split('\n')[0]);
  const s = line.trim() && atEnd ? suggest(line, api) : { from: 0, items: [] };
  sug = { from: lineStart + s.from, items: s.items, idx: -1 };
  box.hidden = !s.items.length;
  if (box.hidden) return;
  box.style.bottom = `${ta.offsetHeight + 2}px`;
  box.replaceChildren(...s.items.map((it, i) => {
    const li = document.createElement('li');
    li.dataset.i = i;
    const v = document.createElement('span');
    v.textContent = it.value;
    const h = document.createElement('span');
    h.className = 'dim';
    h.textContent = it.hint;
    li.append(v, h);
    return li;
  }));
}

function markSuggest() {
  [...$('suggest').children].forEach((li, i) => li.classList.toggle('on', i === sug.idx));
  $('suggest').children[sug.idx]?.scrollIntoView({ block: 'nearest' });
}

function takeSuggest(i) {
  const ta = $('cli');
  const it = sug.items[i];
  if (!it) return;
  const end = ta.selectionStart;
  ta.value = ta.value.slice(0, sug.from) + it.value + ' ' + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = sug.from + it.value.length + 1;
  ta.focus();
  updateSuggest();
}

const hideSuggest = () => { $('suggest').hidden = true; sug.items = []; };

async function onCli(ev) {
  const ta = ev.currentTarget;
  if (sug.items.length && !$('suggest').hidden) {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const n = sug.items.length;
      sug.idx = ev.key === 'ArrowDown' ? (sug.idx + 1) % n : (sug.idx <= 0 ? n - 1 : sug.idx - 1);
      markSuggest();
      return;
    }
    if (ev.key === 'Tab' || (ev.key === 'Enter' && !ev.shiftKey && sug.idx >= 0)) {
      ev.preventDefault();
      takeSuggest(Math.max(0, sug.idx));
      return;
    }
    if (ev.key === 'Escape') { ev.preventDefault(); hideSuggest(); return; }
  }
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    hideSuggest();
    const lines = ta.value.split('\n').map(l => l.trim()).filter(Boolean);
    ta.value = '';
    for (const line of lines) {
      history.push(line);
      try { await runCommand(line, api); } catch (e) { log(e.message, 'err'); }
    }
    histPos = history.length;
  } else if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && !ta.value.includes('\n')) {
    if (!history.length) return;
    ev.preventDefault();
    histPos = Math.max(0, Math.min(history.length, histPos + (ev.key === 'ArrowUp' ? -1 : 1)));
    ta.value = history[histPos] || '';
  }
}

// ---------------------------------------------------------------- resize handles

// Sizes are a per-browser convenience: kept in localStorage, fine to lose.
const loadSize = key => { try { return localStorage.getItem(key); } catch { return null; } };
const saveSize = (key, v) => { try { v === null ? localStorage.removeItem(key) : localStorage.setItem(key, v); } catch { /* not kept */ } };

// One handle: `place(clientX, clientY)` applies a size and returns it; arrow keys move it too.
function handle(el, key, place, step, reset) {
  let last = null;
  const cursor = getComputedStyle(el).cursor;
  el.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    el.setPointerCapture(ev.pointerId);
    el.classList.add('drag');
    document.body.classList.add('resizing');
    document.body.style.cursor = cursor;
  });
  el.addEventListener('pointermove', ev => { if (el.hasPointerCapture(ev.pointerId)) last = place(ev.clientX, ev.clientY); });
  const end = () => {
    el.classList.remove('drag');
    document.body.classList.remove('resizing');
    document.body.style.cursor = '';
    if (last !== null) saveSize(key, last);
    last = null;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('lostpointercapture', end);
  el.addEventListener('dblclick', () => { reset(); saveSize(key, null); });
  el.addEventListener('keydown', ev => {
    const d = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[ev.key];
    if (!d) return;
    ev.preventDefault();
    const r = el.getBoundingClientRect();
    saveSize(key, place(r.left + r.width / 2 + d * step, r.top + r.height / 2 + d * step));
  });
}

function setupHandles() {
  const main = document.querySelector('.panels');
  const root = document.documentElement;
  const bottom = document.querySelector('.bottom');
  const left = loadSize('stomp-commander.left');
  const height = loadSize('stomp-commander.bottom');
  if (left) main.style.setProperty('--left', left);
  if (height) root.style.setProperty('--bottom-h', height);
  // Between the panels: the PC panel's share of the width, each panel at least 280 px.
  handle($('split-x'), 'stomp-commander.left', x => {
    const r = main.getBoundingClientRect();
    const w = Math.max(280, Math.min(r.width - 288, x - r.left - 4));
    const v = `${(100 * w / r.width).toFixed(2)}%`;
    main.style.setProperty('--left', v);
    return v;
  }, 24, () => main.style.removeProperty('--left'));
  // Above the bottom row: its height, at least 120 px, leaving the panels at least 220 px.
  handle($('split-y'), 'stomp-commander.bottom', (x, y) => {
    const h = Math.round(Math.max(120, Math.min(window.innerHeight - 300, bottom.getBoundingClientRect().bottom - y - 4)));
    root.style.setProperty('--bottom-h', `${h}px`);
    return `${h}px`;
  }, 16, () => root.style.removeProperty('--bottom-h'));
}

// ---------------------------------------------------------------- start

async function start() {
  setupHandles();
  for (const list of [$('pc-list'), $('pedal-list')]) {
    list.tabIndex = 0;
    list.addEventListener('click', onClick);
    list.addEventListener('mousedown', onMouseDown);
    list.addEventListener('mouseover', onSweepOver);
    list.querySelector('thead').addEventListener('click', onHeaderClick);
    list.addEventListener('keydown', onKey);
    list.addEventListener('dragstart', onDragStart);
    setupDrop(list);
  }
  document.addEventListener('mousemove', onSweepMove);
  document.addEventListener('mouseup', onSweepEnd);
  $('pc-list').addEventListener('dblclick', ev => {
    const tr = ev.target.closest('tbody tr');
    if (tr?.dataset.up) { up(); return; }
    const e = tr && pc.entries.find(x => x.name === tr.dataset.name);
    if (e?.kind === 'dir') enter(e);
  });
  $('pc-pick').onclick = pick;
  $('pc-refresh').onclick = () => refreshPc();
  $('pc-all').onchange = ev => { pc.showAll = ev.target.checked; refreshPc(); };
  $('pc-copy').onclick = () => copySelectedToPedal();
  $('pc-delete').onclick = () => deletePc([...pc.sel]);
  $('pc-selall').onclick = () => selectAll('pc');
  $('pedal-selall').onclick = () => selectAll('pedal');
  $('pedal-connect').onclick = connect;
  $('pedal-refresh').onclick = refreshPedal;
  $('pedal-delete').onclick = () => deletePedal([...pedal.sel]);
  $('pedal-copy').onclick = () => copyToPc([...pedal.sel]);
  $('cli').addEventListener('keydown', onCli);
  $('cli').addEventListener('input', updateSuggest);
  $('cli').addEventListener('blur', () => setTimeout(hideSuggest, 150));
  $('suggest').addEventListener('mousedown', ev => {
    const li = ev.target.closest('li');
    ev.preventDefault();   // keep the focus in the input
    if (li) takeSuggest(Number(li.dataset.i));
  });
  midi.onstate = () => {
    if (!midi.isOpen && pedal.connected) {
      pedal.connected = false;
      keepalive.stop();
      renderPedalInfo();
    }
    if (midi.access) fillPorts();
  };

  $('midi-port').append(new Option('MIDI port', ''));
  drawPicture($('preview'), null);
  renderList('pc');
  renderPedalInfo();
  log(`Stomp Commander v${VERSION}. Type help for commands.`);
  log('How to start:\n'
    + '  1. Press "Pick folder…" and choose a folder with ZDL files (allow access when Chrome asks).\n'
    + '  2. Plug the pedal into USB and switch it on. If it was already on, switch it off and on again, '
    + 'then wait until it has fully started. Close Zoom Effect Manager: it blocks the MIDI port.\n'
    + '  3. Press "Connect" (allow MIDI access when Chrome asks). If the pedal doesn\'t answer, replug it '
    + `and press "Connect" again. While connected, a keep-alive ping goes out every ${INTERVAL} s.`);
  if (!pcfs.supported() || !navigator.requestMIDIAccess) log('Use Chrome or Edge: this browser lacks folder access or Web MIDI.', 'warn');

  if (pcfs.supported()) {
    const last = await pcfs.restore();
    if (last?.granted) await openFolder(last.dir);
    else if (last) {
      const b = $('pc-grant');
      b.hidden = false;
      b.textContent = `Reopen ${last.dir.name}`;
      b.onclick = async () => { if (await pcfs.grant(last.dir)) await openFolder(last.dir); };
    }
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname)))
    navigator.serviceWorker.register(new URL('../service-worker.js', import.meta.url)).catch(e => log(`Offline cache: ${e.message}`, 'warn'));
}

start();
