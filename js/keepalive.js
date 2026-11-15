// Keep-alive, as Custom-Zoom-ZDL-Effects' tools/g1on_keepalive.py --interval 30: one identity request every 30 s while
// connected, answered within 3 s. A ping that comes while an operation holds the port is skipped
// (the script skips when the ports are busy).
//
// The G1Xon sometimes stops answering SysEx after idle minutes until it is replugged
// (cause unknown). At the first missed reply the keep-alive stops and the connection is marked
// dead: further sends to a deaf pedal jam the Windows MIDI driver until a replug.

export const INTERVAL = 30;   // seconds

export class KeepAlive {
  // getZoom: () => the current pedal object (the profile can change on connect).
  constructor(getZoom, { onPing, onDead }) {
    this.getZoom = getZoom;
    this.onPing = onPing;
    this.onDead = onDead;
    this.timer = null;
    this.inFlight = false;
    this.pings = 0;
    this.last = null;           // Date of the last answered ping
  }

  get running() { return !!this.timer; }

  start() {
    this.stop();
    this.pings = 0;
    this.last = null;
    this.timer = setInterval(() => this.tick(), INTERVAL * 1000);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    const zoom = this.getZoom();
    if (this.inFlight || zoom.busy || !zoom.midi.isOpen) return;
    this.inFlight = true;
    try {
      await zoom.task(z => z.identify(false));
      this.pings++;
      this.last = new Date();
      this.onPing(this.pings);
    } catch (e) {
      this.stop();
      this.onDead(e);
    } finally {
      this.inFlight = false;
    }
  }
}
