// Command line: the same operations as the buttons, typed. `api` comes from main.js.

import { BLOCK } from './zoomg1.js';

// Flash blocks first, bytes after: "  8 blocks  (32714 B)".
const size = n => `${String(Math.ceil(n / BLOCK)).padStart(3)} block${Math.ceil(n / BLOCK) === 1 ? ' ' : 's'}  (${n} B)`.padEnd(26);

// One entry per command: usage, help text and what its arguments complete to
// ('pc' = PC files, 'pedal' = pedal files, 'any' = both, or a list of words).
const COMMANDS = [
  { name: 'help', usage: 'help', text: 'this list' },
  { name: 'list', usage: 'list [pc|pedal]', text: 'list files (both panels without an argument)', args: ['pc', 'pedal'] },
  { name: 'pick', usage: 'pick', text: 'pick a PC folder' },
  { name: 'connect', usage: 'connect', text: 'connect to the pedal (identity sent once)' },
  { name: 'disconnect', usage: 'disconnect', text: 'close the pedal\'s MIDI port' },
  { name: 'refresh', usage: 'refresh', text: 're-read both panels' },
  { name: 'info', usage: 'info NAME', text: 'name, category, knobs and picture of a ZDL', args: 'any', one: true },
  { name: 'put', aliases: ['upload'], usage: 'put NAME... [-y]', text: 'upload files from the PC folder to the pedal', args: 'pc' },
  { name: 'get', aliases: ['download'], usage: 'get NAME... [-y]', text: 'copy files from the pedal into the PC folder', args: 'pedal' },
  { name: 'delete', usage: 'delete NAME... [-y]', text: 'delete files on the pedal', args: 'pedal' },
  { name: 'pcdelete', usage: 'pcdelete NAME... [-y]', text: 'delete files in the PC folder', args: 'pc' },
  { name: 'ping', usage: 'ping', text: 'one identity request' },
  { name: 'keepalive', usage: 'keepalive', text: 'keep-alive state (a ping every 30 s while connected)' },
  { name: 'patch', usage: 'patch [NAME.syx]', text: 'current patch rows (G1on family; keeps unsaved edits), optionally saved to the PC folder' },
  { name: 'knob', usage: 'knob SLOT PARAM VALUE', text: 'set a knob live, not saved (G1on; slot 0..4, param 0 on/off, 2..10 knobs 1..9)' },
  { name: 'program', usage: 'program N', text: 'switch to patch N 0..99 (G1on; unsaved edits are lost)' },
  { name: 'current', usage: 'current', text: 'number of the current patch (G1on)' },
  { name: 'settings', usage: 'settings', text: 'global settings: tempo, tuner, rhythm, looper, ... (G1on)' },
  { name: 'patchinfo', usage: 'patchinfo', text: 'number of patches and patch size (G1on)' },
  { name: 'status', usage: 'status', text: 'status value (G1on; meaning unknown)' },
  { name: 'sysex', usage: 'sysex on|off', text: 'show SysEx traffic in the log', args: ['on', 'off'], one: true },
  { name: 'log', usage: 'log clear|save', text: 'clear the log / save the whole log as a text file', args: ['clear', 'save'], one: true },
];

const HELP = 'Commands (names are case-insensitive, * and ? work in file names):\n'
  + COMMANDS.flatMap(c => [c.name, ...(c.aliases || [])].map(n => `  ${c.usage.replace(c.name, n).padEnd(23)} ${c.text}`)).join('\n')
  + '\n-y skips the confirmation. Enter runs the command; Shift+Enter starts a new line, and'
  + ' several lines run one after another. Up / Down bring back earlier commands.'
  + '\nWhile you type, suggestions appear: Tab or a click takes one, Up / Down choose, Esc hides them.';

const findCommand = w => COMMANDS.find(c => c.name === w || c.aliases?.includes(w));

// Suggestions for the word being typed at the end of `line`:
// { from, items: [{ value, hint }] }, `from` = where that word starts.
export function suggest(line, api) {
  const from = line.search(/\S*$/);
  const word = line.slice(from).toLowerCase();
  const before = line.slice(0, from).trim().split(/\s+/).filter(Boolean);
  let items = [];
  if (!before.length) {
    items = COMMANDS.flatMap(c => [c.name, ...(c.aliases || [])].filter(n => n.startsWith(word)).map(n => ({ value: n, hint: c.text })));
  } else {
    const cmd = findCommand(before[0].toLowerCase());
    const given = before.slice(1).filter(w => w !== '-y');
    if (!cmd?.args || (cmd.one && given.length)) return { from, items: [] };
    let pool;
    if (Array.isArray(cmd.args)) pool = cmd.args.map(v => ({ value: v, hint: '' }));
    else {
      const pc = api.pcEntries().filter(e => e.kind === 'file').map(e => ({ value: e.name, hint: 'PC' }));
      const pedal = api.pedalFiles().map(f => ({ value: f.name, hint: 'pedal' }));
      pool = cmd.args === 'pc' ? pc : cmd.args === 'pedal' ? pedal : [...pc, ...pedal.filter(p => !pc.some(x => x.value.toUpperCase() === p.value.toUpperCase()))];
      pool = pool.filter(p => !given.some(g => g.toUpperCase() === p.value.toUpperCase()));
    }
    items = pool.filter(p => p.value.toLowerCase().startsWith(word) && p.value.toLowerCase() !== word);
  }
  return { from, items: items.slice(0, 12) };
}

const glob = pattern => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');

function match(names, patterns, log) {
  const out = [];
  for (const p of patterns) {
    const re = glob(p);
    const hits = names.filter(n => re.test(n));
    if (!hits.length) log(`no file matches ${p}`, 'warn');
    for (const h of hits) if (!out.includes(h)) out.push(h);
  }
  return out;
}

export async function runCommand(line, api) {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return;
  const yes = words.includes('-y');
  const [cmd, ...args] = words.filter(w => w !== '-y');
  const { log } = api;
  const pcFiles = () => api.pcEntries().filter(e => e.kind === 'file').map(e => e.name);
  const pedalFiles = () => api.pedalFiles().map(f => f.name);
  log('> ' + line.trim(), 'cmd');
  switch (findCommand(cmd.toLowerCase())?.name || cmd.toLowerCase()) {
    case 'help': case '?':
      log(HELP);
      break;
    case 'list': {
      const which = (args[0] || '').toLowerCase();
      if (which !== 'pedal') {
        const rows = api.pcEntries();
        log(`PC folder ${api.pcPath() || '(none picked)'}: ${rows.length} entries`);
        for (const e of rows) log(e.kind === 'dir' ? `${'<folder>'.padEnd(26)}${e.name}` : `${size(e.size)}${e.name}`);
      }
      if (which !== 'pc') {
        const rows = api.pedalFiles();
        log(`Pedal: ${rows.length} files`);
        for (const f of rows) log(`${size(f.size)}${f.name}`);
      }
      break;
    }
    case 'pick':
      await api.pick();
      break;
    case 'connect':
      await api.connect();
      break;
    case 'disconnect':
      api.disconnect();
      break;
    case 'refresh':
      await api.refresh();
      break;
    case 'info':
      if (!args[0]) { log('info NAME', 'warn'); break; }
      api.info(args.join(' '));
      break;
    case 'put': {
      const names = match(pcFiles(), args, log);
      if (names.length) await api.put(names, yes);
      break;
    }
    case 'get': {
      const names = match(pedalFiles(), args, log);
      if (names.length) await api.get(names, yes);
      break;
    }
    case 'delete': {
      const names = match(pedalFiles(), args, log);
      if (names.length) await api.rm(names, yes);
      break;
    }
    case 'pcdelete': {
      const names = match(pcFiles(), args, log);
      if (names.length) await api.pcrm(names, yes);
      break;
    }
    case 'ping':
      await api.ping();
      break;
    case 'keepalive':
      api.keepalive();
      break;
    case 'patch':
      if (args[0] && !/^[^\\/:*?"<>|]+$/.test(args[0])) { log('patch [NAME.syx]: a file name in the PC folder', 'warn'); break; }
      await api.patch(args[0]);
      break;
    case 'knob': {
      const n = args.map(Number);
      if (n.length !== 3 || !n.every(Number.isInteger)) { log('knob SLOT PARAM VALUE (whole numbers)', 'warn'); break; }
      await api.knob(...n);
      break;
    }
    case 'program':
      if (args.length !== 1 || !Number.isInteger(Number(args[0]))) { log('program N (0..99)', 'warn'); break; }
      await api.program(Number(args[0]));
      break;
    case 'current':
      await api.current();
      break;
    case 'settings':
      await api.settings();
      break;
    case 'patchinfo':
      await api.patchinfo();
      break;
    case 'status':
      await api.status();
      break;
    case 'sysex':
      api.verbose(args[0] !== 'off');
      break;
    case 'log':
      if (args[0] === 'clear') api.clearLog();
      else if (args[0] === 'save') api.saveLog();
      else log('log clear | log save', 'warn');
      break;
    default:
      log(`unknown command: ${cmd} (try help)`, 'warn');
  }
}
