// Cross-distance, cross-dimension player tracking. Uses live entities when in render range,
// otherwise polls `/data get entity` (needs op) at a low rate and caches the answer.
const { Vec3 } = require("vec3");
const { normDim } = require("./observe");

class Radar {
  constructor(bot) {
    this.bot = bot;
    this.cache = new Map();   // lowercase name -> {pos:Vec3|null, dimension, t, live}
    this.pending = new Map(); // lowercase name -> t (last poll)
    this.tracked = new Set();
    bot.on("messagestr", (m) => this.onMessage(m));
    this.timer = setInterval(() => this.poll(), 1500);
  }
  stop() { clearInterval(this.timer); }
  track(name) { if (name) this.tracked.add(name.toLowerCase()); }
  untrack(name) { this.tracked.delete(String(name).toLowerCase()); }
  untrackAll() { this.tracked.clear(); }

  properName(l) { return Object.keys(this.bot.players).find((k) => k.toLowerCase() === l) || l; }

  poll() {
    const now = Date.now();
    for (const l of this.tracked) {
      const live = this.live(l);
      if (live) { this.cache.set(l, { pos: live.position.clone(), dimension: normDim(this.bot.game?.dimension), t: now, live: true }); continue; }
      if (now - (this.pending.get(l) || 0) < 3500) continue;
      this.pending.set(l, now); this.lastPollAt = now;
      const n = this.properName(l);
      try { this.bot.chat(`/data get entity ${n} Pos`); if (now - (this.dimAsked?.[l] || 0) > 12000) { (this.dimAsked ||= {})[l] = now; this.bot.chat(`/data get entity ${n} Dimension`); } } catch { /* disconnected */ }
    }
  }

  live(l) {
    const key = Object.keys(this.bot.players).find((k) => k.toLowerCase() === l);
    const e = key ? this.bot.players[key]?.entity : null;
    return e && this.bot.entities[e.id] && e.isValid !== false ? e : null;
  }

  onMessage(msg) {
    const m = String(msg).trim();
    if (/unknown or incomplete command|do not have permission|permission/i.test(m) && Date.now() - (this.lastPollAt || 0) < 2500) this.denied = true;
    let r = m.match(/^(\S+) has the following entity data: \[(-?[\d.eE+-]+)d?, (-?[\d.eE+-]+)d?, (-?[\d.eE+-]+)d?\]/);
    if (r) {
      const l = r[1].toLowerCase();
      const prev = this.cache.get(l) || {};
      this.cache.set(l, { ...prev, pos: new Vec3(parseFloat(r[2]), parseFloat(r[3]), parseFloat(r[4])), t: Date.now(), live: false, dimension: prev.dimension || "overworld" });
      return;
    }
    r = m.match(/^(\S+) has the following entity data: \[(-?[\d.eE+-]+)f, (-?[\d.eE+-]+)f\]/);
    if (r) {
      const l = r[1].toLowerCase();
      const prev = this.cache.get(l) || {};
      this.cache.set(l, { ...prev, rot: { yaw: parseFloat(r[2]), pitch: parseFloat(r[3]) }, rotT: Date.now() });
      return;
    }
    r = m.match(/^(\S+) has the following entity data: "([^"]+)"/);
    if (r) {
      const l = r[1].toLowerCase();
      const prev = this.cache.get(l) || {};
      this.cache.set(l, { ...prev, dimension: normDim(r[2]), t: prev.t || Date.now() });
    }
  }

  /** Ask the server which way a far-away player is facing (needs op); resolves when the answer arrives or after ~2 s. */
  async askRotation(name) {
    const l = String(name).toLowerCase();
    const t0 = Date.now();
    try { this.bot.chat(`/data get entity ${this.properName(l)} Rotation`); } catch { return null; }
    while (Date.now() - t0 < 2000) { const c = this.cache.get(l); if (c?.rotT >= t0) return c.rot; await new Promise((r) => setTimeout(r, 100)); }
    return null;
  }

  /** Best knowledge of where a player is: {pos, dimension, sameDimension, live, age} or null */
  where(name) {
    const l = String(name).toLowerCase();
    const live = this.live(l);
    const myDim = normDim(this.bot.game?.dimension);
    if (live) return { pos: live.position, dimension: myDim, sameDimension: true, live: true, age: 0 };
    const c = this.cache.get(l);
    if (!c || !c.pos) return null;
    return { pos: c.pos, dimension: c.dimension, sameDimension: c.dimension === myDim, live: false, age: Date.now() - c.t };
  }
}

module.exports = { Radar };
