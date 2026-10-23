// Forgetting on purpose. Long sessions pile up chat history, places, landmarks and journal entries; old context makes the AI slower,
// more expensive and more likely to act on stale facts. Two levels:
//   "chat" - the conversation only (what was said; places and knowledge stay)
//   "all"  - conversation, remembered places/facts, landmarks, journal, own projects/requests (the skill library always stays)
// Works on a running agent (in memory AND on disk) - triggered from chat ("AIBot reset your memory") or by scripts/reset-context.js via the team inbox.
const fs = require("fs");
const path = require("path");
const { log } = require("./util");

function resetAgent(agent, scope = "chat") {
  const c = agent.ctxStore;
  c.chat = [];
  if (scope === "all") {
    c.places = []; c.goals = [];
    for (const k of Object.keys(c.facts)) if (!/^(bed)$/.test(k)) delete c.facts[k];      // the bed still exists in the world: keep where it is
    agent.know.items = agent.know.items.filter((e) => e.kind === "bed");
    agent.know.save();
    agent.autonomy.journal = []; agent.autonomy.fails.clear(); agent.autonomy.save();
    agent.teamReports = [];
    agent.projects.myTask = null; agent.projects.joined.clear();
    for (const k of Object.keys(agent.mem.facts || {})) if (/^structure:/.test(k)) delete agent.mem.facts[k];
  }
  c.save();
  log("reset", `${agent.bot.username}: ${scope === "all" ? "memory" : "conversation"} reset`);
}

/** Drop every task: current goal, queue, AI planner run, autonomous errand, claimed team jobs, open help requests. The agent then stands by. */
function resetTasks(agent, { pauseMs = 120000 } = {}) {
  const board = require("./project");
  try { agent.director.cancel("reset"); } catch { /* not running */ }
  agent.queue = []; agent.goal = null; agent.ledger = [];
  agent.abortCurrent("reset");
  agent.baseGoal = { type: "idle" };
  if (agent.projects.myTask) { try { board.release(agent.projects.myTask.pid, agent.projects.myTask.task.id, agent.bot.username); } catch { /* gone */ } agent.projects.myTask = null; }
  for (const p of board.active()) for (const t of board.tasks(p.id)) if (t.owner === agent.bot.username && t.state !== "done") board.release(p.id, t.id, agent.bot.username);
  agent.autonomy.current = null;
  // the team work goes too: an open project on the board would simply be picked up again by everyone (that was the "wheat farm" / "enderman torso" loop)
  cancelTeamWork();
  agent.ctxStore.remember("lastResetAt", Date.now());                    // nothing older than this is ever revived after a restart
  agent.projects.lastProposal = Date.now() + 20 * 60000;                  // and the leader does not propose something new right away
  agent.autonomy.pause(pauseMs);                                          // stand by for new orders instead of instantly picking up an old errand
  agent.holdUntil = Date.now() + pauseMs;
  try { agent.bot.pathfinder.stop(); } catch { /* idle */ }
  for (const c of ["forward", "back", "left", "right", "sprint", "jump", "sneak"]) agent.bot.setControlState(c, false);
  log("reset", `${agent.bot.username}: all tasks dropped, standing by`);
}

/** Every team project and request is cancelled (they stay on disk as history only). */
function cancelTeamWork() {
  const board = require("./project");
  for (const p of board.active()) board.update(p.id, { state: "cancelled" });
  const root = process.env.MC_SHARED_DIR || path.resolve(__dirname, "..", "..", "data", "shared");
  for (const e of ["requests", "inbox"]) { try { fs.rmSync(path.join(root, e), { recursive: true, force: true }); } catch { /* gone */ } }
  log("reset", "team projects cancelled, requests and inbox cleared");
}

/** The shared team board (projects, requests, inbox, builds, landmarks) - only the leader / the script does this. */
function resetShared() {
  const root = process.env.MC_SHARED_DIR || path.resolve(__dirname, "..", "..", "data", "shared");
  for (const e of ["projects", "requests", "inbox", "builds.json", "landmarks.json", "landmarks.json.bak"]) { try { fs.rmSync(path.join(root, e), { recursive: true, force: true }); } catch { /* gone */ } }
  log("reset", "shared team board cleared");
}

module.exports = { resetAgent, resetShared, resetTasks, cancelTeamWork };
