// The project board: how a group of agents agrees on WHO does WHAT (the part that makes them look like people playing together
// instead of seven bots all shouting orders at each other). Files only, no sockets, safe between processes:
//   data/shared/projects/<id>/project.json      written once by the coordinator (+ status changes by the coordinator)
//   data/shared/projects/<id>/tasks/<t>.json    task definition (immutable) + state (written by its owner only)
//   data/shared/projects/<id>/tasks/<t>.claim   created with O_EXCL: whoever creates it owns the task (exactly one winner, no race)
//   data/shared/projects/<id>/people/<name>.json  who joined, with a heartbeat
const fs = require("fs");
const path = require("path");

const root = () => path.join(process.env.MC_SHARED_DIR || path.resolve(__dirname, "..", "..", "data", "shared"), "projects");
const dirOf = (id) => path.join(root(), String(id).replace(/[^\w.-]/g, "_"));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
function writeAtomic(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, f); }

/** Atomic: only the first caller for an id gets true (mkdir is exclusive). */
function create(id, project) {
  try { fs.mkdirSync(root(), { recursive: true }); fs.mkdirSync(dirOf(id)); } catch { return false; }
  writeAtomic(path.join(dirOf(id), "project.json"), { ...project, id, created: Date.now(), state: "planning" });
  return true;
}
const exists = (id) => fs.existsSync(dirOf(id));
const get = (id) => readJson(path.join(dirOf(id), "project.json"));
function update(id, patch) { const p = get(id); if (!p) return null; const n = { ...p, ...patch, updated: Date.now() }; writeAtomic(path.join(dirOf(id), "project.json"), n); return n; }

function addTasks(id, tasks) {
  for (const t of tasks) writeAtomic(path.join(dirOf(id), "tasks", `${t.id}.json`), { ...t, state: "open", attempts: 0, failedBy: [] });
}
const taskFile = (id, t) => path.join(dirOf(id), "tasks", `${t}.json`);
const claimFile = (id, t) => path.join(dirOf(id), "tasks", `${t}.claim`);

function tasks(id) {
  const dir = path.join(dirOf(id), "tasks");
  let files = []; try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    const t = readJson(path.join(dir, f)); if (!t) continue;
    const c = readJson(claimFile(id, t.id));
    out.push({ ...t, owner: c?.owner || null, claimedAt: c?.t || null });
  }
  return out.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Try to take a task. Exactly one agent succeeds. */
function claim(id, t, owner) {
  try {
    const fd = fs.openSync(claimFile(id, t), "wx");
    fs.writeSync(fd, JSON.stringify({ owner, t: Date.now() })); fs.closeSync(fd);
    patchTask(id, t, { state: "claimed", owner });
    return true;
  } catch { return false; }
}
function release(id, t, owner, { failed = false, reason = null } = {}) {
  const c = readJson(claimFile(id, t));
  if (c && c.owner !== owner && owner !== "*") return false;           // only the owner (or "*": a janitor releasing a dead owner's task)
  try { fs.unlinkSync(claimFile(id, t)); } catch { /* already gone */ }
  const cur = readJson(taskFile(id, t)) || {};
  const patch = { state: "open", owner: null };
  if (failed) { patch.attempts = (cur.attempts || 0) + 1; patch.failedBy = [...new Set([...(cur.failedBy || []), c?.owner || owner])]; patch.lastError = reason; }
  patchTask(id, t, patch);
  return true;
}
const touch = (id) => { const p = get(id); if (p) writeAtomic(path.join(dirOf(id), "project.json"), { ...p, updated: Date.now() }); };
function patchTask(id, t, patch) { const cur = readJson(taskFile(id, t)); if (cur) writeAtomic(taskFile(id, t), { ...cur, ...patch, updated: Date.now() }); }
function finish(id, t, owner, result = {}) { patchTask(id, t, { state: "done", owner, result, doneAt: Date.now() }); touch(id); }
function progress(id, t, patch) { patchTask(id, t, { ...patch, heartbeat: Date.now() }); }

function join(id, name, info = {}) { writeAtomic(path.join(dirOf(id), "people", `${name}.json`), { name, ...info, joined: Date.now(), beat: Date.now() }); }
function beat(id, name) { const f = path.join(dirOf(id), "people", `${name}.json`); const c = readJson(f); if (c) writeAtomic(f, { ...c, beat: Date.now() }); }
function people(id) {
  const dir = path.join(dirOf(id), "people"); let files = []; try { files = fs.readdirSync(dir); } catch { return []; }
  return files.map((f) => readJson(path.join(dir, f))).filter(Boolean);
}

/** Every project ever started (any state) - used to never redo one that was finished or cancelled. */
function all() {
  let ids = []; try { ids = fs.readdirSync(root()); } catch { return []; }
  return ids.map(get).filter(Boolean);
}

/** Projects that are still running (planning/open/active), newest first. */
function active() {
  let ids = []; try { ids = fs.readdirSync(root()); } catch { return []; }
  return ids.map(get).filter((p) => p && ["planning", "open", "active"].includes(p.state) && Date.now() - (p.updated || p.created) < 4 * 3600000).sort((a, b) => b.created - a.created);
}

module.exports = { all, create, exists, get, update, addTasks, tasks, claim, release, finish, progress, join, beat, people, active };
