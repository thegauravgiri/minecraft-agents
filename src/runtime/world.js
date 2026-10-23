// Which world am I in? A new world must mean a clean mind: coordinates, landmarks, projects and journals from another world are
// worse than nothing. The server's login packet carries the hashed world seed; that is the world's fingerprint.
// Wiped on a change: context/knowledge/journal of this agent and the shared board (projects, requests, builds, landmarks, inbox, statuses).
// Kept: the learned skill library (scripts are portable - they take their coordinates as arguments).
const fs = require("fs");
const path = require("path");
const { log, writeJsonAtomic, readJsonSafe } = require("./util");

const sharedRoot = () => process.env.MC_SHARED_DIR || path.resolve(__dirname, "..", "..", "data", "shared");
const ownRoot = () => process.env.BOT_DATA_DIR || path.resolve(__dirname, "..", "..", "data");
const OWN_FILES = ["context.json", "context.json.bak", "knowledge.json", "knowledge.json.bak", "journal.json", "journal.json.bak"];
const SHARED_ENTRIES = ["builds.json", "landmarks.json", "agents", "inbox", "projects", "requests"];

/** Start listening for the login packet (call right after createBot, before spawn). */
function capture(bot) {
  bot._client.on("login", (p) => {
    const hs = p?.worldState?.hashedSeed;
    bot.worldFingerprint = hs != null ? (Array.isArray(hs) ? hs.map(String).join(":") : String(hs)) : null;
  });
}

const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* already gone */ } };

/** Compare with what this agent remembers; wipe what belongs to another world. Returns true if it was a new world. */
function reconcile(bot, name) {
  const fp = bot.worldFingerprint;
  if (!fp) return false;                                           // server did not tell us: keep everything
  let fresh = false;
  // shared board first (the first agent to notice wipes it; the others find the new fingerprint already there)
  const sf = path.join(sharedRoot(), "world.json");
  const shared = readJsonSafe(sf);
  if (!shared || shared.fingerprint !== fp) {
    for (const e of SHARED_ENTRIES) rmrf(path.join(sharedRoot(), e));
    writeJsonAtomic(sf, { fingerprint: fp, since: Date.now(), by: name });
    log("world", `new world (${fp}) - shared team memory cleared`);
  }
  // my own memory
  const of = path.join(ownRoot(), "world.json");
  const own = readJsonSafe(of);
  if (!own || own.fingerprint !== fp) {
    for (const f of OWN_FILES) rmrf(path.join(ownRoot(), f));
    writeJsonAtomic(of, { fingerprint: fp, since: Date.now() });
    log("world", `${name}: ${own ? "a different world" : "no record of this world"} - starting with a clean memory (skills are kept)`);
    fresh = true;
  }
  return fresh;
}

module.exports = { capture, reconcile };
