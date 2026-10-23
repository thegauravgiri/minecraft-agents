// How agents talk to each other: files, not chat. Chat is for humans (and is noisy: every agent hears everything, an LLM
// misreads a status line as an order, and two bots politely thank each other forever). Here every message has a type:
//   command  - an order: the receiver interprets it like a human request, and reports back when done
//   report   - information (done / failed / found): recorded, never answered
// Statuses are one file per agent (single writer), inbox messages one file each (no write races between processes).
const fs = require("fs");
const path = require("path");

const root = () => process.env.MC_SHARED_DIR || path.resolve(__dirname, "..", "..", "data", "shared");
const statusDir = () => path.join(root(), "agents");
const inboxDir = (name) => path.join(root(), "inbox", String(name).toLowerCase());
const safe = (n) => String(n).replace(/[^\w.-]/g, "_");

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
}

function publishStatus(name, status) {
  try { writeAtomic(path.join(statusDir(), safe(name) + ".json"), JSON.stringify({ ...status, name, updated: Date.now() })); } catch { /* best effort */ }
}
/** Everyone else's recent status (stale ones - agent gone - are dropped). */
function readTeam(selfName, maxAgeMs = 45000) {
  const out = [];
  try {
    for (const f of fs.readdirSync(statusDir())) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(statusDir(), f), "utf8"));
        if (s.name && s.name !== selfName && Date.now() - s.updated < maxAgeMs) out.push(s);
      } catch { /* half-written / gone */ }
    }
  } catch { /* no team yet */ }
  return out;
}

let seq = 0;
function send(from, to, { type = "command", text, data = null }) {
  try {
    const file = path.join(inboxDir(to), `${Date.now()}-${process.pid}-${seq++}-${safe(from)}.json`);
    writeAtomic(file, JSON.stringify({ from, to, type, text: String(text).slice(0, 400), data, t: Date.now() }));
    return true;
  } catch { return false; }
}
/** Take (and delete) everything addressed to `name`, oldest first. Messages older than 10 minutes are dropped as stale. */
function drainInbox(name) {
  const dir = inboxDir(name), out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return out; }
  for (const f of files) {
    const p = path.join(dir, f);
    try { const m = JSON.parse(fs.readFileSync(p, "utf8")); if (Date.now() - m.t < 600000) out.push(m); } catch { /* corrupt: drop */ }
    try { fs.unlinkSync(p); } catch { /* already taken */ }
  }
  return out;
}

module.exports = { publishStatus, readTeam, send, drainInbox };
