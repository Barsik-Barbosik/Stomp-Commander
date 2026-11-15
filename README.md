# Stomp Commander

<img src="icon.svg" width="64" height="64" alt="Stomp Commander icon: a pedal with a screen, three knobs and a footswitch">

A browser app with two panels: a folder on the PC (left) and the files on a Zoom
G1on-family pedal (G1on, G1Xon, B1on, B1Xon) or a MultiStomp (MS-70CDR,
MS-50G, MS-60B) (right). Copy ZDL effects to the pedal, delete them, see each
effect's screen picture, knobs and ids.
Plain HTML + JavaScript modules, no build step.

## Run

Chrome or Edge (Web MIDI with SysEx and folder access are Chromium-only). Close
Zoom Effect Manager and other MIDI programs first: Windows lets only one
program use the pedal's MIDI port.

```
cd Stomp-Commander
python -m http.server 8000
```

Open http://localhost:8000/ (a page opened as `file://` can't use MIDI). Chrome
asks once for MIDI device access and once per visit for the folder.

## Features

- **Lists**: columns Name, Category (gid + fxid, e.g. `7 + 520`, in the row tooltip and the preview)
  and Size (flash blocks, bytes in brackets); click a column title to sort,
  again to reverse. Select: click, Ctrl+click, Shift+click, or press on an
  unselected row and sweep over others (pressing on a selected row drags the
  selection instead), Ctrl+A or **Select all** (again: **Select none**; folders
  are left out). The footer shows how many files are selected and their flash
  blocks. Icons for ZDLs without a picture, `.ZDT` (effect list)
  and `.RAW` (drum samples).
- **PC panel**: pick a folder (remembered; after a reload one click re-grants
  it), subfolders (double-click; the `..` row or Backspace goes up). The path
  starts at the picked folder: Chrome doesn't tell pages where it is on disk.
  ZDL files show their screen picture; "All files" shows other files too.
- **Pedal panel**: Connect sends one identity request, then reads the file list
  and free space (PC mode on only during each operation, as the Python tools do;
  a MultiStomp gets no mode switch, so unsaved patch edits stay). The device id picks the protocol:
  0x64 / 0x66 G1on family, 0x61 / 0x58 / 0x5F MultiStomp, any other id the
  G1on family's.
  Categories: if the pedal has `FLST_SEQ.ZDT` (its effect list), it is read
  (~22 flash reads) and gives the group of every file it lists; files it
  doesn't list take the category of a PC file with the same name and size.
  The list's group ids are header byte 0x3C (same for all 195 listed effects
  on the G1Xon; byte 0x43 is 1 for the bass drive / preamp groups 0x14 / 0x16).
  Port: when Chrome lists several MIDI outputs with the same name (after a
  replug it can keep the old one as connected), the newest is used. No reply
  at Connect: replug the pedal; if that doesn't help, Chrome's MIDI service
  still holds the old port: end every Chrome process (Task Manager, background
  ones too), replug, start Chrome again.
- **Reload / close**: the MIDI ports are closed before the page goes. F5 /
  Ctrl+R while connected wait until the ports are closed, then reload (the
  toolbar's reload button can't be held back; the ports still close as the
  page goes). During a pedal operation, reloading or closing the tab asks
  first.
- **Copy to pedal**: button, drag a PC row onto the pedal panel, or drop files
  from Explorer. Checks before writing: 8.3 name, ZDL header, 200-file limit
  (G1on family), free 4,090-byte blocks, effect id; asks before replacing a file.
  Effect id = gid + fxid (header bytes 0x3C, 0x40), the effect's identity in a
  patch, compared as fxid & 0x3FF (original MS patches keep 10 bits): a ZDL
  whose id another pedal file already has is refused, or with your OK that
  file is deleted first (`put -y` always refuses). The ids come from one
  76-byte flash read per pedal ZDL (~200 reads the first time), cached in the
  browser by name, size and first block. After every upload the
  list is read again to confirm the size.
- **Effect list**: the pedal lists only effects named in `FLST_SEQ.ZDT`, so
  uploaded ZDLs get a record at the end of their group (header byte 0x3C; one
  list write per upload batch) and a deleted one (or one replaced for an id
  clash) loses it. Effect files go up before their records, a record goes
  before its file; every list write is read back, a failed one puts the old
  list back (if that fails too, the old list is offered as a download).
  Same for both families; a gid with no group in the list is an error (the
  effect isn't listed). MultiStomp: the list is always there and never
  deleted. G1on family (untested on hardware): the list is read through the
  flash and written as delete + upload; with no list nothing is edited (the
  pedal writes one with the next upload, or when it starts). The pedal's
  menu shows the change without a restart. `delete FLST_SEQ.ZDT` (command line,
  G1on family) still deletes the list.
- **Copy to PC**: button, or drag pedal rows onto the PC panel. A MultiStomp
  sends files with its own file read (512-byte blocks, CRC-checked). The G1Xon's
  own file read returns no data, so its files come through raw flash reads
  (768-byte pieces, CRC-checked, ~10 KB/s: a 30 KB effect takes a few
  seconds) via the flash file table; the size must match the pedal's list.
- **Locked lists**: while an operation runs (copy, delete, upload, reading
  the pedal or a PC folder; the spinner shows), both lists are greyed out and
  ignore clicks and keys, and all buttons are disabled.
- **Resizable**: drag the handle between the panels or above the bottom row
  (arrow keys work when it has focus, double-click resets); sizes are kept in
  the browser.
- **Loading bars** under each panel's header while it works; the pedal
  panel's footer names the running operation and its percentage. Results go
  to the log (no status bar).
- **Panel titles**: "PC folder: folder/subfolder" and "Pedal: G1on family, firmware
  1.21"; the MIDI port picker shows only while not connected.
- **No picture**: ZDLs without a picture get a crossed-out picture mark in
  the list and "No picture" in the preview.
- **Delete** on either side (Delete key or button), always with a confirmation.
- **Drag out**: drag one PC row to the desktop / Explorer (Chrome) to copy it.
- **Preview**: the 128x64 screen picture (drawn 3x4, the pedal's pixels are
  taller than wide), effect name, group, fxid, version, DSP cost and knobs.
  Builds with stripped symbol names (e.g. SongBox) work too: the picture is
  found through the 212-byte image info object, the knob table by its
  contents ("OnOff" first).
  Pedal files show the picture of a PC file with the same name and size
  (copy one to the PC to see it).
- **Keep-alive**: one identity
  request every 30 s while connected, answered within 3 s; a ping that comes
  while an operation runs is skipped. At the first missed reply it stops and
  asks for a replug (further sends to a deaf pedal jam the Windows MIDI
  driver). No setting; `keepalive` shows the pings answered. Whether it
  prevents the pedal's idle deafness is untested.
- **Untested pedals**: MS-50G, MS-60B and unknown device ids list files freely;
  the first change on them (upload, delete, copy to PC) asks once per
  connection.
- **Command line** under the log: `help` lists the commands (`list`, `info`,
  `put`, `get`, `delete`, `pcdelete`, `ping`, `keepalive`, `sysex`, `log save`, ...);
  G1on family also `patch [NAME.syx]` (current patch rows; editor mode, no PC
  mode, so unsaved edits stay; optionally saved to the PC folder), `knob SLOT
  PARAM VALUE` (set live, not saved) and `program N` (Program Change; unsaved
  edits are lost);
  suggestions for commands and file names appear while typing (Tab or click
  takes one, Up / Down choose, Esc hides);
  `*` / `?` work in names, `-y` skips confirmations; several lines run in order.
- **Offline**: a service worker caches the app; after one visit it starts
  without a connection. New versions show on the load after they were fetched
  (bump `CACHE` in `service-worker.js` with each release).

## Not yet

- Pictures of pedal files without copying them (would read every file, ~5 min
  for 200; needs a picture cache).
- The MultiStomp profile is tried only against a fake pedal (`tests/ms.test.html`);
  its commands are those themanro checked on an MS-70CDR 2.10 with
  `tools/file_probe.html` in [themanro/ZoomMultistompZDL](https://github.com/themanro/ZoomMultistompZDL) (MIT). MS-50G and MS-60B untested.
- MultiStomp: a new effect's record goes at the end of its group; Zoom Effect
  Manager keeps stock effects in its own master order (custom effects after
  them, as here).

## Files

| File | What |
|---|---|
| `js/main.js` | UI: panels, selection, drag and drop, preview, operations |
| `js/zoomg1.js` | G1on protocol (same bytes as Custom-Zoom-ZDL-Effects' Python tools: files, flash read, `patch` / `knob` / `program`); device table |
| `js/zoomms.js` | MultiStomp protocol (file commands as themanro's `file_probe.html`), `FLST_SEQ.ZDT` record add / remove (both families) |
| `js/midi.js` | Web MIDI: one SysEx out, all replies until quiet |
| `js/zdl.js` | ZDL header, ELF symbols, descriptor, picture RLE decode |
| `js/pcfs.js`, `js/idb.js` | folder access, remembered settings |
| `js/keepalive.js`, `js/cli.js` | keep-alive, command line |
| `service-worker.js` | offline cache of the app files |
| `icon.svg`, `manifest.webmanifest` | app icon (tab and installed app: a stomp box with screen, three knobs, footswitch), app manifest |
| `tests/zdl.test.html` | decoder + protocol tests (upload message byte-exact; copy to PC from the flash backup `fs_a5000.bin`, all files byte-exact) |
| `tests/ui.test.html` | the app with the G1Xon backup as a fake PC folder |
| `tests/pedal.test.html` | the app against a fake G1Xon (fake Web MIDI, flash backup + saved `FLST_SEQ.ZDT`) |
| `tests/g1list.test.html` | the app against a fake G1Xon file system (in-memory, no MIDI): effect list kept up to date on upload, id clash, delete; gid without a group; no list; a pedal that writes its own list over the upload (old list written back, download, no delete) |
| `tests/ms.test.html` | the app against a fake MS-70CDR (in-memory files): upload, id clash, delete, list records, write message = `file_probe.html`'s, keep-alive |

Tests: serve this folder (`python -m http.server 8000`) and open
`http://localhost:8000/tests/zdl.test.html` (and the others) in Chrome. They
need files in `tests/fixtures/` that are not in the repository (Zoom's stock
effects and a flash backup can't be shared): see `tests/fixtures/README.md`.

## Credits

- The MultiStomp file commands follow themanro's `tools/file_probe.html` in
  [themanro/ZoomMultistompZDL](https://github.com/themanro/ZoomMultistompZDL)
  (MIT, Copyright (c) 2026 Roman Rusinov).
- Those commands, including the per-file check before writes and deletes,
  were first worked out for the ZD2 pedals by mungewell's
  [zoom-zt2](https://github.com/mungewell/zoom-zt2) (MIT).
- The ZDL reader (header, ELF symbols, the RLE screen picture) builds on the
  format work in [repeat98/ZoomMultistompZDL](https://github.com/repeat98/ZoomMultistompZDL)
  (MIT) and ELynx's notes in
  [zoom-fx-modding](https://github.com/ELynx/zoom-fx-modding).
- The G1on-family protocol comes from my
  [Custom-Zoom-ZDL-Effects](https://github.com/Barsik-Barbosik/Custom-Zoom-ZDL-Effects)
  ([`tools/g1on_sysex.py`](https://github.com/Barsik-Barbosik/Custom-Zoom-ZDL-Effects/tree/main/tools)).

## License

MIT, see `LICENSE`. Zoom, MultiStomp and G1on are trademarks of Zoom
Corporation; this project is not affiliated with Zoom.
