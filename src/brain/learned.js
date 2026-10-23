// The shared skill library: scripts the AI wrote that WORKED, kept as data in skills/learned/*.json, shared by every agent.
//  - a skill takes what varies (items, counts, coordinates) from `api.args`, so one script serves many situations and many worlds
//  - every skill carries a track record (uses / successes / failures / version) so the best-proven one is offered first
//  - when a skill fails for somebody it is REPAIRED; a repaired version that works is saved (version+1, the old one kept in history),
//    so the next agent gets the improved script instead of rediscovering the bug
//  - only the few skills relevant to the task are put in front of the AI (tokens), not the whole library
const fs = require("fs");
const path = require("path");
const { log, writeJsonAtomic, readJsonSafe } = require("../runtime/util");

const DIR = process.env.MC_SKILLS_DIR || path.resolve(__dirname, "..", "..", "skills", "learned");
const slug = (s) => String(s || "skill").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "skill";
const fileOf = (name) => path.join(DIR, `${slug(name)}.json`);
const words = (t) => new Set(String(t || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

function normalise(s) {
  if (!s || !s.name || !s.code) return null;
  return {
    name: s.name, description: s.description || "", params: Array.isArray(s.params) ? s.params : [], tags: Array.isArray(s.tags) ? s.tags : [],
    code: s.code, version: s.version || 1, uses: s.uses || 0, successes: s.successes ?? s.uses ?? 0, failures: s.failures || 0,
    authors: s.authors || [], history: s.history || [], created: s.created || s.savedAt || null, updated: s.updated || s.savedAt || null, lastError: s.lastError || null
  };
}

function loadAll() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    return fs.readdirSync(DIR).filter((f) => f.endsWith(".json")).map((f) => normalise(readJsonSafe(path.join(DIR, f)))).filter(Boolean);
  } catch { return []; }
}
const find = (name) => normalise(readJsonSafe(fileOf(name)));
const broken = (s) => s.failures >= 3 && s.failures > s.successes * 2;
const rate = (s) => (s.successes + 1) / (s.successes + s.failures + 2);                     // smoothed success rate

function write(s) { s.updated = new Date().toISOString(); writeJsonAtomic(fileOf(s.name), s); return s; }

/** New skill, or a better version of an existing one. */
function save({ name, description, params, tags, code, by }, onSave) {
  try {
    const n = slug(name), prev = find(n);
    if (prev && prev.code.trim() === String(code).trim()) return n;                       // nothing new
    const s = prev
      ? { ...prev, code, description: description || prev.description, params: params?.length ? params : prev.params, version: prev.version + 1, failures: 0, lastError: null, history: [...prev.history, { v: prev.version, by: prev.authors.slice(-1)[0] || null, code: prev.code, t: prev.updated }].slice(-3) }
      : { name: n, description: String(description || "").slice(0, 160), params: Array.isArray(params) ? params.slice(0, 6) : [], tags: Array.isArray(tags) ? tags.slice(0, 6) : [], code, version: 1, uses: 0, successes: 0, failures: 0, authors: [], history: [], created: new Date().toISOString() };
    if (by && !s.authors.includes(by)) s.authors.push(by);
    write(s);
    log("learned", `${prev ? "improved" : "saved"} skill ${n} (v${s.version})`); if (onSave) onSave(n, s);
    return n;
  } catch (e) { log("learned", "save failed:", e.message); return null; }
}

/** Track record after a run (by anybody). A skill that keeps failing disappears from the offer until somebody repairs it. */
function record(name, { ok, error = null }) {
  const s = find(name); if (!s) return;
  s.uses++; if (ok) s.successes++; else { s.failures++; s.lastError = String(error || "").slice(0, 160); }
  write(s);
}

/** The few skills worth showing for this task, best match first. */
function relevant(text, k = 6) {
  const want = words(text);
  return loadAll().filter((s) => !broken(s)).map((s) => {
    const have = words(`${s.name} ${s.description} ${s.tags.join(" ")}`);
    let hit = 0; for (const w of want) if (have.has(w)) hit++;
    return { s, score: hit * 2 + rate(s) + Math.min(s.successes, 10) / 20 };
  }).sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.s);
}
const describe = (s) => `${s.name}(${s.params.map((p) => p.name).join(", ")}): ${s.description} [worked ${s.successes}x, failed ${s.failures}x, v${s.version}${s.params.length ? "; args: " + s.params.map((p) => `${p.name}=${p.desc || ""}`).join("; ") : ""}]`;
const catalog = (text) => relevant(text || "", 6).map(describe).join("\n");

module.exports = { loadAll, save, find, record, relevant, catalog, describe, slug, DIR };
