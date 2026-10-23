// Structured world knowledge: every entry is a measured/declared fact with provenance, so prompts only contain things that
// are true and the AI is never tempted to invent coordinates. Each bot keeps its own file; builds and landmarks are also
// published to a file all agents read, so a teammate knows where Vesper's mansion is.
const path = require("path");
const { writeJsonAtomic, readJsonSafe, log } = require("../runtime/util");

const SCHEMA = 1;
const sharedFile = () => path.join(process.env.MC_SHARED_DIR || path.resolve(__dirname, "..", "..", "data", "shared"), "landmarks.json");
const ownFile = () => path.join(process.env.BOT_DATA_DIR || path.resolve(__dirname, "..", "..", "data"), "knowledge.json");
const dist = (a, b) => Math.hypot(a.x - b.x, (a.z ?? 0) - (b.z ?? 0));

class Knowledge {
  constructor(owner) { this.owner = owner; this.items = []; this.timer = null; this.load(); }

  load() {
    const j = readJsonSafe(ownFile());
    this.items = (j?.items || []).filter((e) => e && e.pos && Number.isFinite(e.pos.x) && Number.isFinite(e.pos.z));
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        writeJsonAtomic(ownFile(), { v: SCHEMA, items: this.items.slice(-200) });
        const mine = this.items.filter((e) => e.shared !== false && e.source !== "teammate");
        const db = readJsonSafe(sharedFile()) || { v: SCHEMA, items: [] };
        db.items = [...(db.items || []).filter((e) => e.by !== this.owner), ...mine.map((e) => ({ ...e, by: this.owner }))].slice(-400);
        writeJsonAtomic(sharedFile(), db);
      } catch (e) { log("knowledge", "save failed: " + e.message); }
    }, 600);
  }

  /** kind: build|bed|home|chest|portal|water|place|resource ... ; source: self|player|teammate */
  add({ kind, label, pos, size = null, source = "self", dim = "overworld", note = null, shared = true }) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return null;
    const p = { x: Math.floor(pos.x), y: Number.isFinite(pos.y) ? Math.floor(pos.y) : null, z: Math.floor(pos.z) };
    this.items = this.items.filter((e) => !(e.kind === kind && e.label === label && dist(e.pos, p) < 6));
    const e = { kind, label: label || kind, pos: p, size, source, dim, note, shared, t: Date.now() };
    this.items.push(e);
    this.save();
    return e;
  }
  /** Own entries + what teammates published. */
  all() {
    const db = readJsonSafe(sharedFile());
    const others = (db?.items || []).filter((e) => e.by && e.by !== this.owner).map((e) => ({ ...e, source: "teammate" }));
    return [...this.items, ...others];
  }
  nearest(kind, pos) { return this.all().filter((e) => e.kind === kind).sort((a, b) => dist(a.pos, pos) - dist(b.pos, pos))[0] || null; }
  find(text) { const t = String(text).toLowerCase(); return this.all().filter((e) => t.includes(String(e.label).toLowerCase()) || t.includes(e.kind)); }

  /** Prompt text: only verified facts, newest first. */
  summary(max = 12) {
    const rows = this.all().sort((a, b) => b.t - a.t).slice(0, max).map((e) => `${e.label} (${e.kind}) at x${e.pos.x}${e.pos.y != null ? " y" + e.pos.y : ""} z${e.pos.z}${e.size ? ` size ${e.size.w}x${e.size.d}x${e.size.h}` : ""} [${e.source}${e.by ? " " + e.by : ""}]`);
    return rows.length ? rows.join("; ") : "none known";
  }
  /** Is this coordinate something the AI could legitimately know (landmark / given place)? */
  grounds(pos, tol = 4) { return this.all().some((e) => dist(e.pos, pos) <= tol + (e.size ? Math.max(e.size.w, e.size.d) : 0)); }
}

module.exports = { Knowledge };
