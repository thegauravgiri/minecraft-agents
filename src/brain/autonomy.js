// Autonomy: what an agent does when nobody is telling it anything - the thing that makes it a player instead of a command line.
// Layers, cheapest first (an LLM call is the last resort, not the default):
//   1. needs        - hungry / hurt / bag full: fix it (no LLM)
//   2. teamwork     - a teammate is building and I am free: join them (no LLM)
//   3. milestones   - the survival tech tree every player climbs: tools -> stone -> furnace -> food -> iron -> bed (no LLM)
//   4. curriculum   - the strong model picks the next worthwhile thing for MY role, given the team, the base and my journal
// Any human (or leader) command pre-empts all of it; when that task is done, autonomy simply resumes.
const path = require("path");
const { log, writeJsonAtomic, readJsonSafe } = require("../runtime/util");
const team = require("../runtime/team");
const shared = require("../runtime/shared");
const requests = require("../runtime/requests");

const ROLES = {
  leader: { title: "coordinator and architect", focus: "decide what the team needs next, design and build the main base and big structures, delegate with tell, keep everyone supplied" },
  scout: { title: "scout and explorer", focus: "explore new areas, find villages / ores / water / good building land, and make the findings known; gather what you pass" },
  miner: { title: "miner", focus: "mine stone, coal, iron (and diamonds): keep the team stocked with ore, ingots and cobblestone; store surplus in a chest at the base" },
  builder: { title: "builder", focus: "build structures (houses, farms, walls, bridges), join teammates' builds, collect the blocks you need" },
  lumberjack: { title: "lumberjack and carpenter", focus: "chop trees (replant saplings), turn logs into planks, sticks, tables, chests and doors for the team" },
  hunter: { title: "hunter and cook", focus: "hunt animals, cook food, keep a food stock for yourself and the team" },
  smith: { title: "smith and crafter", focus: "craft tools, armor, weapons and furnaces; smelt ore; equip yourself first, then supply teammates" }
};
const ROSTER = { aibot: "leader", scout: "scout", atlas: "miner", bolt: "builder", cedar: "lumberjack", dune: "hunter", ember: "smith" };
const ROLE_ORDER = ["builder", "miner", "lumberjack", "hunter", "smith", "scout"];
function roleFor(name) {
  const k = String(name).toLowerCase();
  if (ROSTER[k]) return ROSTER[k];
  let h = 0; for (const c of k) h = (h * 31 + c.charCodeAt(0)) >>> 0;       // any future agent gets a stable role too
  return ROLE_ORDER[h % ROLE_ORDER.length];
}

const TIER = { wooden: 1, stone: 2, golden: 2, iron: 3, diamond: 4, netherite: 5 };
const tierOf = (name) => TIER[name.split("_")[0]] || 0;
const hasTool = (inv, kind, min) => Object.keys(inv).some((k) => inv[k] > 0 && k.endsWith("_" + kind) && tierOf(k) >= min);
const count = (inv, re) => Object.entries(inv).reduce((n, [k, v]) => n + (re.test(k) ? v : 0), 0);
const FOOD = /^(cooked_|bread|apple|carrot|baked_potato|golden_|melon_slice|dried_kelp|sweet_berries)/;

/** The survival ladder. Returns the first rung this player has not climbed yet, as a typed goal. */
function nextMilestone(inv, food = 20, { sheep = false } = {}) {
  if (!hasWeapon(inv)) return { key: "m:weapon", goal: { type: "have", items: { wooden_sword: 1 } }, why: "I have no weapon - a sword first" };
  if (Object.keys(inv).some((k) => /_bed$/.test(k) && inv[k] > 0)) return { key: "m:place_bed", goal: { type: "set_spawn", sleep: false }, why: "I have a bed - set my respawn point here" };
  if (!hasTool(inv, "pickaxe", 1)) return { key: "m:wood_tools", goal: { type: "have", items: { wooden_pickaxe: 1, wooden_axe: 1, wooden_sword: 1 } }, why: "I have no pickaxe yet - wood tools (and a sword) first" };
  if (!hasTool(inv, "pickaxe", 2) || !hasTool(inv, "axe", 2) || (!hasTool(inv, "sword", 2))) return { key: "m:stone_tools", goal: { type: "have", items: { stone_pickaxe: 1, stone_axe: 1, stone_sword: 1 } }, why: "stone tools make everything faster" };
  if (count(inv, FOOD) < 4 && food <= 14) return { key: "m:food", goal: { type: "cook", count: 4, deliverTo: null }, why: "my food stock is low - hunt and cook" };
  if (!inv.furnace) return { key: "m:furnace", goal: { type: "have", items: { furnace: 1 } }, why: "a furnace is needed for ore and cooking" };
  if (!hasTool(inv, "pickaxe", 3)) return { key: "m:iron_pickaxe", goal: { type: "have", items: { iron_pickaxe: 1 } }, why: "iron pickaxe unlocks diamonds" };
  if (!hasTool(inv, "sword", 3)) return { key: "m:iron_sword", goal: { type: "have", items: { iron_sword: 1 } }, why: "an iron sword for safety" };
  if (!inv.shield) return { key: "m:shield", goal: { type: "have", items: { shield: 1 } }, why: "a shield stops arrows and blows" };
  if ((sheep || count(inv, /_wool$/) >= 3) && !Object.keys(inv).some((k) => /_bed$/.test(k))) return { key: "m:bed", goal: { type: "set_spawn", sleep: false }, why: "a bed sets my respawn point near the base" };
  if (!Object.keys(inv).some((k) => /^iron_chestplate$/.test(k))) return { key: "m:iron_armor", goal: { type: "have", items: { iron_chestplate: 1, iron_leggings: 1, iron_helmet: 1, iron_boots: 1 } }, why: "iron armor" };
  return null;
}

/** Night and no bed to sleep in: nobody stays out (a real player sleeps or digs in until daylight). */
function nightRisk(snap, bed) {
  if (snap.gameMode === "creative" || snap.dimension !== "overworld" || snap.dayTime == null) return false;
  const night = snap.dayTime >= 12700 && snap.dayTime <= 22800;
  if (!night || bed) return false;
  return true;                                                         // no bed: dig in. Gear does not save you from a creeper at 2 a.m. (the player asked for exactly this)
}
const hasWeapon = (inv) => Object.keys(inv).some((k) => /_(sword|axe)$/.test(k) && inv[k] > 0);

class Autonomy {
  constructor(agent) {
    this.agent = agent;
    this.file = path.join(process.env.BOT_DATA_DIR || path.resolve(__dirname, "..", "..", "data"), "journal.json");
    const j = readJsonSafe(this.file);
    this.journal = Array.isArray(j?.entries) ? j.entries.slice(-40) : [];
    this.fails = new Map();                 // goal key -> {n, until}
    this.current = null;                    // {key, goal, t}
    this.lastEnd = Date.now() + 8000;       // settle a few seconds after joining before taking initiative
    this.lastLLM = 0;
    this.thinking = false;
    this.role = roleFor(agent.bot.username);
    this.enabled = (process.env.MC_AUTONOMY || "on").toLowerCase() !== "off";
    this.pausedUntil = 0;
  }

  pause(ms) { this.pausedUntil = Date.now() + ms; }
  resume() { this.pausedUntil = 0; }                                     // any new instruction from a human ends the pause
  save() { try { writeJsonAtomic(this.file, { v: 1, entries: this.journal.slice(-40) }); } catch { /* best effort */ } }
  note(entry) { this.journal.push({ t: Date.now(), ...entry }); this.save(); }

  /** A bed counts only if it is close enough to walk to tonight (a remembered bed 500 blocks away made bots craft a new one in the dark). */
  bedNear(pos) {
    const b = this.agent.mem.recall("bed");
    const p = pos || this.agent.bot.entity?.position;
    return b && p && Math.hypot(b.x - p.x, b.z - p.z) < 48 ? b : null;
  }

  /** Called by the agent whenever any goal ends. */
  onOutcome(goal, text, ok) {
    this.lastEnd = Date.now() + 2000 + Math.random() * 6000;           // a natural pause before the next idea
    if (goal?.project) { try { this.agent.projects.onTaskOutcome(goal, ok, text); } catch (e) { log("project", "outcome hook failed: " + e.message); } }
    if (goal?.requestId) { if (ok) { requests.fulfil(goal.requestId, this.agent.bot.username); this.agent.say(`${goal.player}, delivered ${goal.count} ${String(goal.item).replace(/_/g, " ")}`, { noName: true, force: true }); } else requests.release(goal.requestId); }
    if (!goal?.auto) return;
    const key = goal.autoKey || goal.type;
    this.current = null;
    this.note({ goal: goal.autoWhy || goal.type, outcome: ok ? "done" : text });
    if (!ok) { const f = this.fails.get(key) || { n: 0 }; f.n++; f.until = Date.now() + Math.min(40, f.n * 8) * 60000; this.fails.set(key, f); }
    else if (Date.now() - (goal.startedAt || 0) < 8000) this.fails.set(key, { n: 1, until: Date.now() + 10 * 60000 });   // "done" instantly = nothing to do: do not pick it again in a loop
    else this.fails.delete(key);
  }
  blocked(key) { const f = this.fails.get(key); return !!f && f.until > Date.now(); }

  /** Own projects get a time box: a goal that drags on (no animals, no ore, unreachable) is dropped and remembered as failed, so the agent moves on like a player would. */
  watch() {
    const a = this.agent, g = a.goal;
    // dusk: put the errand down and go to bed / dig in (the job stays claimed and is resumed in the morning)
    // never for a teammate's call for help: that is exactly when you go out in the dark
    if (g && (g.auto || g.internal) && !g.order && g.type !== "hideout" && g.type !== "recover" && g.autoKey !== "n:sleep" && !g.humanOrder && !String(g.autoKey || "").startsWith("ally:")) {
      const pseudo = { gameMode: a.bot.game?.gameMode, dimension: "overworld", dayTime: a.lastDayTime, inv: a.lastInv || {}, armor: {} };
      for (const [slot, i] of Object.entries({ head: 5, chest: 6, legs: 7, feet: 8 })) pseudo.armor[slot] = a.bot.inventory.slots[i]?.name || null;
      if (nightRisk(pseudo, this.bedNear()) && !(a.bot.entity && require("../skills/vertical").enclosure(a.bot).ceiling)) {
        log("auto", `${a.bot.username}: night is falling - leaving "${g.autoWhy || g.type}" for later`);
        this.fails.set(g.autoKey || g.type, { n: (this.fails.get(g.autoKey || g.type)?.n || 0), until: Date.now() + 8 * 60000 });   // not picked up again a second later
        a.goal = null; a.ledger = []; a.abortCurrent("night"); this.lastEnd = 0; this.blockedUntilNight = 0;
        return;
      }
    }
    if (!g?.auto || g.type === "freeform") return;
    const limit = g.type === "cook" ? 6 * 60000 : g.type === "build" || g.type === "assist" ? 25 * 60000 : 10 * 60000;
    if (Date.now() - g.startedAt > limit) {
      log("auto", `${a.bot.username}: "${g.autoWhy}" is taking too long - moving on`);
      this.onOutcome(g, "timed out", false);
      a.goal = null; a.ledger = [];
      a.abortCurrent("auto_timeout");
    }
  }

  /** Is the agent free to follow its own initiative right now? */
  free(ignorePause = false) {
    const a = this.agent;
    if (!this.enabled || !a.alive || a.dead || this.thinking) return false;
    if (a.goal || a.queue.length || a.director.ctl) return false;
    if (a.baseGoal?.type === "follow") {                                // told to follow: a standing order - until the player has gone quiet for a long while
      const since = Math.max(a.baseGoal.startedAt || 0, a.lastHumanCommand || 0);
      if (Date.now() - since < 15 * 60000) return false;
      log("auto", `${a.bot.username}: nobody has talked to me for 15 min - no longer following ${a.baseGoal.player}`);
      a.say(`${a.baseGoal.player}, I'll get back to my own work - say "follow me" if you need me.`, { noName: true, force: true });
      a.baseGoal = { type: "idle" };
    }
    if ((!ignorePause && Date.now() < this.pausedUntil) || Date.now() < this.lastEnd) return false;
    if (a.lastHumanCommand && Date.now() - a.lastHumanCommand < 15000) return false;
    return true;
  }

  needs(snap) {
    const inv = snap.inv;
    // night + a bed I know of: sleep (no mobs, and the respawn point is set); a real player does not wander around in the dark
    const night = snap.dayTime != null && snap.dayTime >= 12700 && snap.dayTime <= 22800;
    const bed = this.bedNear(snap.pos);
    const hasBedItem = Object.keys(inv).some((k) => /_bed$/.test(k) && inv[k] > 0);
    const gl = this.agent.gearLater;                                           // gear left behind at night: fetch it in daylight
    if (gl && !night && snap.dayTime != null && Date.now() < gl.until && snap.dimension === gl.dimension) { this.agent.gearLater = null; return { key: "n:gear", goal: { type: "recover", internal: true, pos: { x: gl.pos.x, y: gl.pos.y, z: gl.pos.z }, dimension: gl.dimension, deadline: Date.now() + 240000 }, why: "daylight - going back for my gear" }; }
    if (gl && Date.now() >= gl.until) this.agent.gearLater = null;
    // night with no bed to go to and nothing to fight with: dig in until morning (the alternative was a death every few minutes)
    if (nightRisk(snap, bed || hasBedItem) && !this.blocked("n:hide")) return { key: "n:hide", goal: { type: "hideout" }, why: "night and no bed - digging in until daylight" };
    if (night && snap.dimension === "overworld" && (bed || hasBedItem) && !snap.hostiles.some((h) => h.dist < 12) && !this.blocked("n:sleep")) return { key: "n:sleep", goal: { type: "set_spawn", sleep: true }, why: "it's night - going to sleep" };
    if ((snap.food <= 10 || snap.health <= 10) && count(inv, FOOD) === 0 && !this.blocked("n:food")) return { key: "n:food", goal: { type: "cook", count: 6, deliverTo: null }, why: "I'm hungry and have no food" };
    if (Object.keys(inv).length >= 34 && !this.blocked("n:tidy")) return { key: "n:tidy", goal: { type: "chest", action: "put", items: "all" }, why: "my bag is nearly full - store things in a chest" };
    return null;
  }

  /** Is there an open request I could answer? (checked even while busy with my own errand - helping a teammate comes first) */
  canHelpAny(inv) {
    const me = this.agent.bot.username;
    return requests.open(me).some((r) => !this.blocked("r:" + r.id) && ((inv[r.item] || 0) >= Math.min(r.count, 16) || requests.suppliers(r.item).includes(this.role)));
  }

  /** A teammate asked for something: answer if it is mine to give (I carry it, or it is what my role produces). First come, first served. */
  helpRequests(snap) {
    const a = this.agent;
    for (const r of requests.open(a.bot.username)) {
      if (this.blocked("r:" + r.id)) continue;
      const have = snap.inv[r.item] || 0;
      const mine = requests.suppliers(r.item).includes(this.role);
      if (have < Math.min(r.count, 16) && !mine) continue;
      if (!requests.claim(r.id, a.bot.username)) continue;
      a.say(`${r.from}, I'll bring the ${Math.min(r.count, 128)} ${r.item.replace(/_/g, " ")}`.replace(/\s+/g, " "), { noName: true, force: true });
      return { key: "r:" + r.id, goal: { type: "give", player: r.from, item: r.item, count: Math.min(r.count, 128), requestId: r.id }, why: `${r.from} asked for ${r.count} ${r.item.replace(/_/g, " ")}` };
    }
    return null;
  }

  teamwork() {
    const a = this.agent;
    for (const t of team.readTeam(a.bot.username)) {
      const b = (t.goalType === "build" || t.goalType === "assist") ? shared.buildOf(t.name) : null;
      if (b && !b.done && !this.blocked("t:assist:" + t.name)) {
        if (Math.random() < 0.6 || this.role === "builder") return { key: "t:assist:" + t.name, goal: { type: "assist", owner: t.name, request: "assist" }, why: `${t.name} is building - I'll help` };
      }
    }
    return null;
  }

  /** A player walks up after a long time: say hi once, like a person would (never more than one greeting per 20 minutes per player). */
  social(snap) {
    const a = this.agent;
    this.greeted ||= new Map();
    for (const p of snap.players) {
      if (!p.username || a.isAgent(p.username) || p.dist > 9) continue;
      if (Date.now() - (this.greeted.get(p.username) || 0) < 20 * 60000) continue;
      this.greeted.set(p.username, Date.now());
      let what = ""; try { what = require("./status").describeActivity(a); } catch { /* cosmetic */ }
      const lines = [`hey ${p.username}!`, `${p.username}! good to see you`, `hi ${p.username}${what && what !== "idle" ? ", I'm " + what.replace(/^i'?m /i, "") : ""}`];
      a.say(lines[Math.floor(Math.random() * lines.length)], { to: p.username, noName: true, force: true });
      return;
    }
  }

  async tick(snap) {
    this.social(snap);
    if (!this.free()) return false;
    const a = this.agent;
    let pick = this.needs(snap) || this.helpRequests(snap) || this.teamwork();
    if (!pick) { const sheep = this.agent.know.all().some((e) => e.kind === "resource" && e.label === "animal:sheep");
      const m = nextMilestone(snap.inv, snap.food, { sheep }); if (m && !this.blocked(m.key)) pick = m; }
    if (!pick) pick = await this.curriculum(snap);
    if (!pick || !this.free()) { this.lastEnd = Date.now() + 5000; return false; }
    const goal = { ...pick.goal, auto: true, internal: true, autoKey: pick.key, autoWhy: pick.why };
    this.current = { key: pick.key, goal, t: Date.now() };
    log("auto", `${a.bot.username} (${this.role}): ${pick.why} -> ${JSON.stringify(pick.goal).slice(0, 140)}`);
    a.think(pick.why);
    if (goal.type === "freeform" && !a.brain?.available) {            // no AI (budget/outage): explore by hand instead of asking a planner that is not there
      this.lastEnd = Date.now() + 4000;
      await a.exec({ skill: "wander", args: { distance: 60 }, label: "explore" }, true);
      this.onOutcome(goal, "done", true);
      return true;
    }
    a.setGoal(goal);
    return true;
  }

  async curriculum(snap) {
    const a = this.agent;
    if (!a.brain?.available || Date.now() - this.lastLLM < 20000) return this.fallback(snap);      // (no AI: milestones + fallback keep the agent busy)
    this.lastLLM = Date.now() + Math.random() * 5000;
    this.thinking = true;
    try {
      const { GOAL_DOC, validateGoal } = require("./llm");
      const { describeWorld } = require("./status");
      const role = ROLES[this.role];
      const mates = team.readTeam(a.bot.username).map((t) => `${t.name} [${t.role}] ${t.activity || "idle"}${t.pos ? ` at x${t.pos.x} z${t.pos.z}` : ""} hp ${t.hp}`).join("; ") || "nobody else online";
      const reports = (a.teamReports || []).slice(-5).map((r) => `${r.from}: ${r.text}`).join(" | ") || "none";
      const journal = this.journal.slice(-8).map((e) => `${e.outcome === "done" ? "DONE" : "FAILED"}: ${e.goal}${e.outcome !== "done" ? ` (${e.outcome})` : ""}`).join("\n") || "(nothing yet)";
      const avoid = [...this.fails.entries()].filter(([, f]) => f.until > Date.now()).map(([k]) => k).join(", ") || "none";
      const prompt = `You are ${a.bot.username}, an autonomous Minecraft player living in a shared world with teammates. Nobody is giving you orders right now: decide what to do next like a sensible, hard-working human player would.
Your role: ${role.title} - ${role.focus}.
World state:\n${describeWorld(a, snap)}
Teammates: ${mates}
Recent reports from teammates: ${reports}
Your journal (newest last):\n${journal}
Goals that keep failing right now (do not pick them): ${avoid}
${GOAL_DOC}
Rules: pick ONE concrete, finishable next goal (minutes of work, not hours) that helps you or the team and fits your role. Prefer typed goals. Use "freeform" only for exploration/odd tasks. Do not repeat what you just did. Never invent coordinates: only use places listed under known landmarks. "tell" is only for coordination, when the team needs a hand. If survival basics are missing (tools, food, shelter) do those first. If the base lacks something obvious (storage chest, bed, farm, fence, torches) build/craft it.
Reply ONLY JSON: {"thought":"<=100 chars why","goal":<typed goal>}`;
      const out = await a.brain.json(prompt, { timeoutMs: 30000, level: "LOW", strong: true });
      const goal = validateGoal(out?.goal, { reg: a.reg, speaker: a.bot.username, team: a.team });
      if (!goal || goal.type === "stop" || goal.type === "follow" || goal.type === "come" || goal.type === "tell") return this.fallback(snap);      // no errands for teammates: coordination goes through the project board and requests
      const key = "c:" + JSON.stringify(goal).slice(0, 80);
      if (this.blocked(key)) return this.fallback(snap);
      return { key, goal, why: String(out?.thought || goal.type).slice(0, 100) };
    } catch (e) {
      log("auto", `curriculum failed: ${e.message}`);
      return this.fallback(snap);
    } finally { this.thinking = false; }
  }

  /** No idea (or no LLM): be useful anyway - pick up what lies around, else look for new ground. */
  fallback(snap) {
    if (snap.items.length && !this.blocked("f:collect")) return { key: "f:collect", goal: { type: "collect" }, why: "picking up items nearby" };
    if (this.blocked("f:explore")) return null;
    return { key: "f:explore", goal: { type: "freeform", text: "explore: walk 60-100 blocks to an unexplored area, note anything useful (water, trees, ore, villages), then come back toward where you started" }, why: "exploring for resources" };
  }
}

module.exports = { nightRisk, hasWeapon, Autonomy, ROLES, roleFor, nextMilestone };
