// Conversation + world context that survives restarts: chat history (both sides), places players mention
// ("base at 100 64 -20"), and durable bot facts (bed, house, portals). Stored in data/context.json.
const fs = require("fs");
const path = require("path");
const { log, writeJsonAtomic, readJsonSafe } = require("../runtime/util");
const SCHEMA = 2;

const fileFor = () => path.join(process.env.BOT_DATA_DIR || path.resolve(__dirname, "..", "..", "data"), "context.json");
const NUM = "(-?\\d+(?:\\.\\d+)?)";
const COORD_RE = new RegExp(`(?:x\\s*[:=]?\\s*)?${NUM}[\\s,]+(?:y\\s*[:=]?\\s*)?${NUM}[\\s,]+(?:z\\s*[:=]?\\s*)?${NUM}|${NUM}\\s*,\\s*${NUM}(?![\\d.])`, "gi");
const LABELS = ["base", "home", "house", "camp", "farm", "mine", "portal", "village", "spawn", "bed", "cave", "tower", "castle", "shop", "nether", "stronghold"];

// Coordinates only count as a PLACE when a human said them to us. Server command feedback ("Teleported X to ..."), our own
// narration, and other bots' status lines contain coordinates too; remembering those is how a bot ends up "knowing" nonsense.
const NOT_A_PLACE = /teleported|changed the block|set the block|filled \d|\bgave \d|killed |i died|going back for my gear|\bI need\b|^~ |^\[|dig down|flying to|^to go to|mine \d+x|\bunstick\b/i;
const agentNames = () => (process.env.MC_AGENT_NAMES || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const trustedPlaceSource = (text, speaker) => !NOT_A_PLACE.test(String(text || "")) && !agentNames().includes(String(speaker || "").toLowerCase()) && String(speaker || "") !== "";

function extractPlaces(text, speaker, now = Date.now()) {
  const out = [];
  if (!trustedPlaceSource(text, speaker)) return out;
  const t = String(text || "");
  let m;
  COORD_RE.lastIndex = 0;
  while ((m = COORD_RE.exec(t))) {
    const nums = [m[1], m[2], m[3]].every((x) => x != null) ? [m[1], m[2], m[3]].map(Number) : [m[4], m[5]].every((x) => x != null) ? [Number(m[4]), null, Number(m[5])] : null;
    if (!nums) continue;
    const before = t.slice(Math.max(0, m.index - 40), m.index).toLowerCase();
    const label = LABELS.find((l) => before.includes(l)) || null;
    out.push({ x: nums[0], y: nums[1], z: nums[2], label, speaker, t: now, text: t.slice(0, 120) });
  }
  return out;
}

class Context {
  constructor() { this.file = fileFor(); this.chat = []; this.places = []; this.facts = {}; this.goals = []; this.timer = null; this.load(); }
  load() {
    try {
      const j = readJsonSafe(this.file);
      if (!j) throw new Error("no saved context");
      this.chat = (j.chat || []).filter((c) => c && typeof c.text === "string" && typeof c.speaker === "string"); this.places = (j.places || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.z) && trustedPlaceSource(p.text, p.speaker)); this.facts = j.facts || {}; this.goals = j.goals || [];
      log("context", `restored ${this.chat.length} chat lines, ${this.places.length} places`);
    } catch { /* first run */ }
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        writeJsonAtomic(this.file, { v: SCHEMA, saved: Date.now(), chat: this.chat.slice(-80), places: this.places.slice(-40), facts: this.facts, goals: this.goals.slice(-20) });
      } catch (e) { log("context", "save failed:", e.message); }
    }, 800);
  }
  addChat(speaker, text, { bot = false } = {}) {
    this.chat.push({ speaker, text: String(text).slice(0, 240), t: Date.now(), bot });
    if (this.chat.length > 80) this.chat.shift();
    if (!bot) for (const p of extractPlaces(text, speaker)) this.addPlace(p);
    this.save();
  }
  addPlace(p) {
    this.places = this.places.filter((q) => !(Math.abs(q.x - p.x) < 2 && Math.abs(q.z - p.z) < 2 && q.label === p.label));
    this.places.push(p);
    this.onPlace?.(p);
    if (this.places.length > 40) this.places.shift();
  }
  noteGoal(goal, speaker) {
    this.goals.push({ goal: JSON.parse(JSON.stringify({ ...goal, progress: undefined, id: undefined, startedAt: undefined })), speaker, t: Date.now() });
    this.save();
  }
  lastPlace(label = null) {
    for (let i = this.places.length - 1; i >= 0; i--) if (!label || this.places[i].label === label) return this.places[i];
    return null;
  }
  remember(k, v) {
    this.facts[k] = v;
    const sk = Object.keys(this.facts).filter((x) => x.startsWith("structure:"));       // per-build records: only the recent ones matter
    for (const old of sk.slice(0, Math.max(0, sk.length - 8))) delete this.facts[old];
    this.save();
  }
  recall(k) { return this.facts[k]; }
  summary() {
    const places = this.places.slice(-6).map((p) => `${p.label || "place"} at ${p.x} ${p.y ?? "~"} ${p.z} (said by ${p.speaker})`).join("; ");
    const goals = this.goals.slice(-4).map((g) => `${g.goal.type}${g.goal.pos ? " " + JSON.stringify(g.goal.pos) : ""}${g.goal.items ? " " + JSON.stringify(g.goal.items) : ""}`).join("; ");
    const house = this.facts.house, bed = this.facts.bed;
    const home = house?.origin ? `house at x${house.origin.x} y${house.origin.y} z${house.origin.z}${bed ? `, bed at x${bed.x} y${bed.y} z${bed.z}` : ""}` : bed ? `bed at x${bed.x} y${bed.y} z${bed.z}` : "unknown";
    return { places: places || "none", goals: goals || "none", home, history: this.chat.slice(-20).map((c) => `${c.speaker}: ${c.text}`).join("\n") };
  }
}

module.exports = { Context, extractPlaces, LABELS };
