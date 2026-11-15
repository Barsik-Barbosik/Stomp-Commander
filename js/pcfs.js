// PC side: a folder the user picks (File System Access API, Chrome / Edge).

import * as idb from './idb.js';

export const supported = () => 'showDirectoryPicker' in window;

export async function pick() {
  const dir = await window.showDirectoryPicker({ id: 'stomp-commander', mode: 'readwrite' });
  await idb.set('root', dir);
  return dir;
}

// The folder from the last visit: { dir, granted }. Re-granting needs a click (user activation).
export async function restore() {
  const dir = await idb.get('root');
  if (!dir) return null;
  const granted = (await dir.queryPermission({ mode: 'readwrite' })) === 'granted';
  return { dir, granted };
}

export async function grant(dir) {
  return (await dir.requestPermission({ mode: 'readwrite' })) === 'granted';
}

// Folders first, then files, both by name.
export async function list(dir) {
  const out = [];
  for await (const h of dir.values()) {
    if (h.kind === 'directory') out.push({ name: h.name, kind: 'dir', handle: h });
    else {
      const file = await h.getFile();
      out.push({ name: h.name, kind: 'file', handle: h, file, size: file.size, mtime: file.lastModified });
    }
  }
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return [...out.filter(e => e.kind === 'dir').sort(byName), ...out.filter(e => e.kind === 'file').sort(byName)];
}

export async function exists(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch { return false; }
}

export async function write(dir, name, data) {
  const h = await dir.getFileHandle(name, { create: true });
  const w = await h.createWritable();
  await w.write(data);
  await w.close();
}

export const remove = (dir, name) => dir.removeEntry(name);
