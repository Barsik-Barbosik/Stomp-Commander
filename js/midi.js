// Web MIDI transport: one SysEx out, every SysEx reply until the line goes quiet.
//
// Messages are passed without F0 / F7, so indexes match Custom-Zoom-ZDL-Effects' tools/g1on_sysex.py.
// Requests run strictly one at a time.

export const hex = (bytes, max = 48) => {
  const s = Array.from(bytes.slice(0, max), x => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  return bytes.length > max ? `${s} ... (${bytes.length} bytes)` : s;
};

export class Midi {
  constructor(log) {
    this.log = log;               // (text, cls) => void
    this.access = null;
    this.input = null;
    this.output = null;
    this.collector = null;
    this.queue = Promise.resolve();
    this.lastActivity = 0;
    this.onstate = () => {};
  }

  get isOpen() { return !!(this.input && this.output); }

  async init() {
    if (this.access) return;
    if (!navigator.requestMIDIAccess) throw new Error('Web MIDI is not available here: use Chrome over https or localhost.');
    this.access = await navigator.requestMIDIAccess({ sysex: true });
    this.access.onstatechange = e => {
      const p = e.port;
      if (p.state === 'disconnected' && (p === this.input || p === this.output)) {
        this.log(`MIDI port "${p.name}" disconnected`, 'warn');
        this.close();
      }
      this.onstate();
    };
  }

  // Only ports that are there now: after a replug or power cycle Windows can add the pedal as a new
  // port and keep the old one, with the same name, as "disconnected". Opening that one sends nowhere.
  live(map) { return [...map.values()].filter(p => p.state === 'connected'); }

  outputNames() { return [...new Set(this.live(this.access.outputs).map(p => p.name))]; }

  async open(name) {
    await this.close();
    const outs = this.live(this.access.outputs);
    const ins = this.live(this.access.inputs);
    // After a replug Chrome can list the old port as still connected next to the new one with the
    // same name; the new one comes last.
    const last = list => list[list.length - 1];
    const sameOut = outs.filter(p => p.name === name);
    const out = last(sameOut);
    const inp = last(ins.filter(p => p.name === name)) || last(ins.filter(p => p.name.includes('ZOOM 1 Series')))
      || last(ins.filter(p => p.manufacturer === out?.manufacturer));
    if (sameOut.length > 1) this.log(`${sameOut.length} MIDI outputs named "${name}"; using the newest`, 'warn');
    if (!out || !inp) throw new Error(`no MIDI in/out pair for "${name}"`);
    try {
      await inp.open();
      await out.open();
    } catch (e) {
      throw new Error(`can't open "${name}" (${e.message}). Is Zoom Effect Manager or another MIDI program using it?`);
    }
    inp.onmidimessage = e => this._message(e.data);
    this.input = inp;
    this.output = out;
    this.log(`MIDI open: in "${inp.name}", out "${out.name}"`);
  }

  // Resolves once both ports are closed (a reconnect waits for it).
  close() {
    const done = [];
    if (this.input) { this.input.onmidimessage = null; done.push(this.input.close().catch(() => {})); }
    if (this.output) done.push(this.output.close().catch(() => {}));
    this.input = this.output = null;
    return Promise.all(done);
  }

  _message(d) {
    if (d[0] !== 0xF0) return;
    const body = Array.from(d.subarray(1, d[d.length - 1] === 0xF7 ? d.length - 1 : d.length));
    if (this.collector) this.collector(body);
    else this.log('<< (stray) ' + hex(body), 'sysex');
  }

  // Send one short message (e.g. a Program Change), in turn with the SysEx requests; no reply.
  sendShort(bytes) {
    const run = async () => {
      if (!this.isOpen) throw new Error('MIDI port not open');
      this.log('>> ' + hex(bytes), 'sysex');
      this.output.send(bytes);
      this.lastActivity = performance.now();
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }

  // Send one SysEx; resolve with all replies (stops `quiet` ms after the last one, at most `timeout` ms).
  xfer(body, { timeout = 1000, quiet = 50 } = {}) {
    const run = () => new Promise((resolve, reject) => {
      if (!this.isOpen) { reject(new Error('MIDI port not open')); return; }
      const replies = [];
      const deadline = performance.now() + timeout;
      let timer;
      const finish = () => {
        this.collector = null;
        this.lastActivity = performance.now();
        if (!replies.length) this.log('   (no reply)', 'sysex');
        resolve(replies);
      };
      this.collector = r => {
        this.log('<< ' + hex(r), 'sysex');
        replies.push(r);
        clearTimeout(timer);
        timer = setTimeout(finish, Math.max(0, Math.min(deadline, performance.now() + quiet) - performance.now()));
      };
      this.log('>> ' + hex(body), 'sysex');
      try {
        this.output.send([0xF0, ...body, 0xF7]);
      } catch (e) {
        this.collector = null;
        reject(e);
        return;
      }
      this.lastActivity = performance.now();
      timer = setTimeout(finish, timeout);
    });
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }
}
