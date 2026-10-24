#!/usr/bin/env node
// Reset the agents.   node scripts/reset-context.js [tasks|chat|all|everything] [Name ...] [--hold <ms>]
//   tasks      - drop every running/queued task, team job and request; agents stand by for new orders (memory kept)
//   chat       - forget the conversation only
//   all        - forget conversation, places, landmarks, journal, projects (skills are kept)
//   everything - tasks + all
//   no names = every agent that has a data folder (data/<Name>)
// Running agents are told through the team inbox (they clear their memory in place); stopped ones get their files removed.
const fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
// --hold <ms>: how long the agents stand by after dropping their tasks (default 120000; 0 = take the next job at once)
const holdAt = args.indexOf("--hold"); const hold = holdAt >= 0 ? Number(args.splice(holdAt, 2)[1]) : undefined;
const scope = ["tasks", "chat", "all", "everything"].includes(args[0]) ? args.shift() : "tasks";
const dataDir = path.join(root, "data");
const all = [...fs.readdirSync(dataDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !["shared", "run"].includes(d.name)).map((d) => d.name)];
const names = args.length ? args : all;
const team = require(path.join(root, "src/runtime/team"));
const running = new Set(team.readTeam("__nobody__", 30000).map((s) => s.name));
for (const n of names) {
  if (running.has(n)) { team.send("console", n, { type: "reset", text: scope, data: Number.isFinite(hold) ? { pauseMs: hold } : undefined }); console.log(`${n}: running - told to reset (${scope})`); continue; }
  if (scope === "tasks") { console.log(`${n}: not running - no tasks to drop`); continue; }
  const dir = path.join(dataDir, n);
  const files = scope === "all" || scope === "everything" ? ["context.json", "context.json.bak", "knowledge.json", "knowledge.json.bak", "journal.json", "journal.json.bak"] : [];
  if (scope === "chat") {
    for (const f of ["context.json", "context.json.bak"]) { const p = path.join(dir, f); try { const j = JSON.parse(fs.readFileSync(p, "utf8")); j.chat = []; fs.writeFileSync(p, JSON.stringify(j)); } catch { /* none */ } }
  } else for (const f of files) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch { /* none */ } }
  console.log(`${n}: not running - ${scope === "all" ? "memory files removed" : "chat history cleared"}`);
}
if (scope !== "chat" && !args.length) {
  const board = require(path.join(root, "src/runtime/project"));
  for (const p of board.active()) board.update(p.id, { state: "cancelled" });
  console.log("team projects cancelled");
}
if ((scope === "all" || scope === "everything") && !args.length) {
  const shared = path.join(dataDir, "shared");
  for (const e of ["projects", "requests", "inbox", "builds.json", "landmarks.json", "landmarks.json.bak"]) fs.rmSync(path.join(shared, e), { recursive: true, force: true });
  console.log("shared team board (projects, requests, landmarks) cleared");
}
