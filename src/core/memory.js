// Failure memory: what has already failed, so the planner stops proposing it.
// Entries expire so a bad spot is retried later instead of being banned forever.
const cell = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

class Memory {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.bannedCells = new Map();   // "x,y,z" -> expiry ms
    this.strikes = new Map();       // signature -> {n, last}
    this.visited = new Map();       // coarse chunk key -> visits (exploration)
    this.facts = {};                // free-form durable facts (home, bed, portals, death)
  }

  banCell(pos, ttl = 120000) { this.bannedCells.set(cell(pos), this.now() + ttl); }
  isBanned(pos) {
    const k = cell(pos); const e = this.bannedCells.get(k);
    if (e == null) return false;
    if (e < this.now()) { this.bannedCells.delete(k); return false; }
    return true;
  }

  strike(sig) {
    const s = this.strikes.get(sig) || { n: 0, last: 0 };
    s.n++; s.last = this.now();
    this.strikes.set(sig, s);
    return s.n;
  }
  strikesOf(sig, window = 180000) {
    const s = this.strikes.get(sig);
    if (!s) return 0;
    if (this.now() - s.last > window) { this.strikes.delete(sig); return 0; }
    return s.n;
  }
  clearStrikes(prefix) { for (const k of this.strikes.keys()) if (k.startsWith(prefix)) this.strikes.delete(k); }

  noteVisit(pos) {
    const k = `${Math.floor(pos.x / 16)},${Math.floor(pos.z / 16)}`;
    this.visited.set(k, (this.visited.get(k) || 0) + 1);
  }
  visits(pos) { return this.visited.get(`${Math.floor(pos.x / 16)},${Math.floor(pos.z / 16)}`) || 0; }

  remember(k, v) { this.facts[k] = v; this.onFact?.(k, v); }
  recall(k) { return this.facts[k]; }
}

module.exports = { Memory };
