// Blackboard shared by all agents in the world (separate processes): the builds in progress, so a teammate can join the SAME
// blueprint at the SAME place instead of designing its own copy. A plain JSON file; writes are atomic (rename).
const fs = require("fs");
const path = require("path");

const dir = () => process.env.MC_SHARED_DIR || path.resolve(__dirname, "..", "..", "data", "shared");
const file = () => path.join(dir(), "builds.json");

function load() { try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return {}; } }
function save(db) {
  try { fs.mkdirSync(dir(), { recursive: true }); const tmp = file() + "." + process.pid; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, file()); } catch { /* best effort */ }
}

/** Owner publishes / updates its current build. */
function publishBuild(owner, patch) {
  const db = load();
  db[owner] = { ...(db[owner] || {}), ...patch, owner, updated: Date.now() };
  save(db);
  return db[owner];
}
const clearBuild = (owner) => { const db = load(); delete db[owner]; save(db); };
/** The newest usable build of an owner (needs spec + origin), or null. Stale (>3 h) entries are ignored. */
function buildOf(owner) {
  const b = load()[Object.keys(load()).find((k) => k.toLowerCase() === String(owner).toLowerCase())];
  return b && b.spec && b.origin && Date.now() - b.updated < 3 * 3600 * 1000 ? b : null;
}

module.exports = { publishBuild, clearBuild, buildOf };
