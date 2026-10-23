// Teamwork the way people do it: ONE person takes the lead, thinks it through, says the plan out loud; everybody then picks the job
// that suits them (first come, first served - never two on the same job), gets on with it, speaks up when done or stuck, and the
// leftovers of a failed job go to somebody else.  What makes this reliable is the board (runtime/project.js), not the chat.
const crypto = require("crypto");
const { log, sleep } = require("../runtime/util");
const board = require("../runtime/project");
const team = require("../runtime/team");
const { layoutPlots, roleFit } = require("../core/layout");
const requests = require("../runtime/requests");
const Struct = require("../core/structure");

const AGENTS = () => (process.env.MC_AGENT_NAMES || "").split(",").map((x) => x.trim()).filter(Boolean);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const GROUP = /\b(everyone|everybody|all of you|you all|you guys|guys|team|together|each other|each of you|all agents|civili[sz]ation)\b/i;
const RENOVATE = /\b(ren+o+v\w*|re?pa?i?r\w*|reap\w*|fix\w*|restor\w*|refurbish\w*|improv\w*|tidy up|clean up)\b.{0,50}\b(vill+age|town|settlement|base|houses?|buildings?)\b|\b(vill+age|town|houses)\b.{0,30}\b(ren+o+v\w*|re?pa?i?r\w*|reap\w*|fix\w*)/i;     // forgiving: "rennovate and reapir the village" is how people type
const BIG = /\b(village|town|city|settlement|base|fortress|castle|colony|kingdom)\b/i;

/** Which agents does this message speak to? */
function audience(message) {
  const l = String(message).toLowerCase();
  const at = (n) => l.search(new RegExp(`\\b${n.toLowerCase()}\\b`));
  const named = AGENTS().filter((n) => at(n) >= 0).sort((a, b) => at(a) - at(b));       // in the order the player said them: the first one named leads
  return { named, group: named.length >= 2 || GROUP.test(l) };                 // several names, or words addressing everybody (also "Vesper leads, you all build ...")
}

/**
 * Everybody computes the same answer from the same shared facts. The leader is whoever the player named FIRST ("Wren, finish it with Vesper" -> Wren);
 * nobody named ("everyone build a village") -> picked from the online team by the message itself, so leadership rotates instead of always being one bot.
 */
function electCoordinator(agent, candidates, message = "") {
  const me = agent.bot.username;
  const online = new Set([me, ...team.readTeam(me).map((t) => t.name)]);
  const named = (candidates || []).filter((n) => online.has(n));
  if (named.length) return named[0];
  const pool = [...online].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const h = crypto.createHash("sha1").update(String(message).toLowerCase().replace(/\W+/g, " ").trim()).digest();
  return pool[h[0] % pool.length];
}

/** A short, readable job title from the player's sentence: no coordinates, no "Vesper and Wren,", no trailing "together", cut at a word. */
function jobTitle(message) {
  const names = AGENTS().join("|");
  let t = String(message).replace(/(-?\d+)[\s,]+(-?\d+)[\s,]+(-?\d+)/g, " ")
    .replace(new RegExp(`^\\W*((${names || "$^"}|guys|everyone|everybody|team|you all|all of you|please|and|,|&)\\W*)+`, "i"), "")
    .replace(/\b(together|please|here)\b/gi, " ").replace(/\b(at|in|on|to)\s*$/i, "").replace(/\s+/g, " ").trim();
  if (t.length > 48) { t = t.slice(0, 48); t = t.slice(0, t.lastIndexOf(" ") > 20 ? t.lastIndexOf(" ") : 48); }
  return t || "the build";
}

class TeamProjects {
  constructor(agent) {
    this.agent = agent;
    this.joined = new Set();
    this.myTask = null;                    // {pid, task}
    this.lastBeat = 0;
    this.busy = false;
    this.cooldown = new Map();             // task id -> until (do not instantly re-take what just failed on me)
    setTimeout(() => { try { this.reviveFromChat(); } catch (e) { log("project", "revive error: " + e.message); } }, 30000 + Math.random() * 8000);
  }
  /** After a restart: a team request the humans gave recently that never became a project (or whose plan was lost) is picked up again by the leader. */
  reviveFromChat() {
    const a = this.agent;
    if (board.active().length) return;
    const VERB = /\b(build|building|make|making|construct|create|creating|start|set up|found|gather|work together)\b/i;
    const since = Math.max(Date.now() - 3 * 3600000, a.ctxStore.recall("lastResetAt") || 0);
    const handled = new Set(board.all ? board.all().map((p) => String(p.request || "").toLowerCase()) : []);
    const recent = [...a.ctxStore.chat].reverse().find((c) => !c.bot && !a.isAgent(c.speaker) && c.t > since && !/\?\s*$/.test(c.text) && VERB.test(c.text) && (audience(c.text).group || BIG.test(c.text)) && !handled.has(String(c.text).toLowerCase()));
    if (!recent || this.quickOrder(recent.speaker, recent.text)) return;                 // old simple orders (come here, follow me) are not replayed after a restart
    if (electCoordinator(a, audience(recent.text).named, recent.text) !== this.me) return;
    log("project", `no active project, but ${recent.speaker} asked the team earlier: "${recent.text.slice(0, 80)}" - taking it up`);
    this.onGroupMessage(recent.speaker, recent.text, { stableId: true }).catch((e) => log("project", "revive failed: " + e.message));
  }

  get me() { return this.agent.bot.username; }

  say(text) { try { this.agent.say(text, { noName: true, force: true }); } catch { /* chat is best effort */ } }

  // ------------------------------------------------------------------ the leader
  /** A human spoke to several of us (or to all). Exactly one agent reacts: the elected coordinator. */
  async onGroupMessage(speaker, message, { stableId = false, force = false } = {}) {
    const a = this.agent;
    a.autonomy.resume();                                                    // a new request from a human: no more waiting around after an old "stop"
    const { named } = audience(message);
    const coordinator = force ? this.me : electCoordinator(a, named, message);
    if (coordinator !== this.me) {
      log("project", `group request from ${speaker}: ${coordinator} leads, I wait for the plan`);
      // a leader who is busy, stuck or gone must not leave the request hanging: if no plan shows up, the next one takes the lead
      const t0 = Date.now();
      setTimeout(() => {
        if (board.all().some((p) => p.request === message && p.created >= t0 - 5000)) return;
        log("project", `${coordinator} did not take the lead on "${String(message).slice(0, 60)}" - I'll do it`);
        this.onGroupMessage(speaker, message, { stableId, force: true }).catch((e) => log("project", e.message));
      }, 30000 + Math.random() * 10000);
      return;
    }
    const id = crypto.createHash("sha1").update(speaker + "|" + String(message).toLowerCase().replace(/\W+/g, " ") + "|" + (stableId ? "revive" : Math.floor(Date.now() / 60000))).digest("hex").slice(0, 10);
    if (!board.create(id, { request: message, speaker, coordinator: this.me, name: "project" })) { log("project", "someone else already leads this one"); return; }
    this.lead(id, speaker, message, { revived: stableId }).catch((e) => { log("project", "planning failed: " + e.stack); board.update(id, { state: "cancelled" }); });
  }

  /** Simple, unambiguous team orders need no planner (and no 30 s of thinking): come/gather around me, come to x y z, follow me. */
  quickOrder(speaker, message) {
    const m = String(message).toLowerCase();
    const coords = m.match(/(-?\d+)[\s,]+(-?\d+)[\s,]+(-?\d+)/);
    if (/\b(build|make|create|craft|mine|dig|collect|farm|plant|village|house)\b/.test(m)) return null;
    if (/\b(come|go|gather|meet|assemble|regroup|move)\b.{0,30}\b(to|at)\b.{0,6}(-?\d+)/.test(m) && coords) return { kind: "order", reply: `everyone, come to ${coords[1]} ${coords[2]} ${coords[3]}`, goal: { type: "goto", pos: { x: +coords[1], y: +coords[2], z: +coords[3] } } };
    if (/\b(come|gather|meet|assemble|regroup)\b.{0,20}\b(around|near|to|with|here|me|us)\b/.test(m)) return { kind: "order", reply: `everyone, come to ${speaker}`, goal: { type: "come", player: speaker } };
    if (/\bfollow me\b/.test(m)) return { kind: "order", reply: `ok everyone, following ${speaker}`, goal: { type: "follow", player: speaker } };
    return null;
  }

  async lead(id, speaker, message, { revived = false } = {}) {
    const a = this.agent;
    if (speaker !== this.me) a.lastHumanCommand = Date.now();
    const quick = speaker === this.me ? null : this.quickOrder(speaker, message);
    if (quick) { board.update(id, { state: "cancelled" }); this.broadcastOrder(speaker, message, quick); return; }
    a.think(speaker === this.me ? "proposing a team project" : "a group request - I'll lead the planning");
    if (speaker !== this.me) this.say(pick([`${speaker}, give me a moment to work out a plan`, `ok ${speaker}, let me think how to split this up`, `sure - planning it out`]));
    const mates = team.readTeam(this.me);
    const roster = [{ name: this.me, role: a.role }, ...mates.map((m) => ({ name: m.name, role: m.role }))];
    const view = require("../runtime/spatial").resolveAnchor(a, speaker, "here");
    // the place the human MARKED is where the project goes (fresh mark: last 5 min; a revived request after a restart: any mark of the last 3 h)
    const marks = a.know.all().filter((e) => e.kind === "site" && e.source === "player" && e.pos).sort((x, y) => y.t - x.t);
    const mark = marks.find((e) => Date.now() - e.t < (revived ? 3 * 3600000 : 5 * 60000));
    // coordinates in the request win over everything: "build it at -506 68 -26" means exactly there
    const cm = String(message).match(/(-?\d+)[\s,]+(-?\d+)[\s,]+(-?\d+)/);
    const exact = !!cm;
    const center = cm ? { x: +cm[1], y: +cm[2] - 1, z: +cm[3] } : mark ? { x: mark.pos.x, z: mark.pos.z, y: mark.pos.y ?? 64 } : view ? { x: view.x, z: view.z, y: view.y } : { x: Math.round(a.bot.entity.position.x), z: Math.round(a.bot.entity.position.z), y: Math.round(a.bot.entity.position.y) - 1 };
    if (RENOVATE.test(message)) { await this.villageProject(id, speaker, center); return; }      // fix up what exists - not a new design
    // ONE object (a statue, a house, a tower...) is ONE job at ONE place - splitting it into "legs", "head", "arms" jobs scattered parts of it over the map
    const objects = (String(message).match(/\b(statue|house|tower|castle|ship|monument|mansion|temple|bridge|wall|pyramid|church|cabin|hut|arena|fountain|sculpture|replica|model|farm|field|well|pen|garden|barn|shed|stable|mine|base)\b/gi) || []).length;
    const oneThing = objects === 1 && /\b(statue|house|tower|castle|ship|monument|mansion|temple|bridge|wall|pyramid|church|cabin|hut|arena|fountain|sculpture|replica|model)\b/i.test(message) && !/\b(village|town|city|houses|buildings|statues|towers|several|multiple)\b/i.test(message);
    const plan = oneThing
      ? { kind: "project", name: "big build", summary: "One build, one place - I'll design it and we all build it together", tasks: [{ id: "main", title: jobTitle(message), request: String(message).replace(/(-?\d+)[\s,]+(-?\d+)[\s,]+(-?\d+)/g, "").replace(/\b(at|in|on)\s*$/i, "").slice(0, 400), roleHint: "builder", size: { w: 15, d: 15 }, zone: "center" }] }
      : await this.makePlan(message, speaker, roster, center);
    if (plan?.kind === "order") { board.update(id, { state: "cancelled" }); this.broadcastOrder(speaker, message, plan); return; }
    if (!plan || plan.kind === "chat" || !plan.tasks?.length) {
      board.update(id, { state: "cancelled" });
      if (plan?.reply) this.say(plan.reply);
      return;
    }
    try { a.know.add({ kind: "site", label: `${plan.name || "project"} site`, pos: { x: center.x, y: center.y, z: center.z }, source: "self", note: `said by ${speaker}` }); a.ctxStore.addPlace({ x: center.x, y: center.y, z: center.z, label: null, speaker, t: Date.now(), text: String(message).slice(0, 120) }); } catch { /* knowledge is best effort */ }
    const plots = layoutPlots(center, plan.tasks);
    if (exact && plan.tasks.length === 1) plots.set(plan.tasks[0].id, { x: center.x, z: center.z });
    const tasks = plan.tasks.map((t, i) => ({ ...t, order: i, plot: plots.get(t.id) || { x: center.x, z: center.z } }));
    board.addTasks(id, tasks);
    board.update(id, { name: plan.name, summary: plan.summary, style: plan.style, center, exact, state: "open", roster: roster.map((r) => r.name) });
    board.join(id, this.me, { role: a.role });
    this.joined.add(id);
    const list = tasks.slice(0, 8).map((t) => t.title).join(", ");
    this.say(`${String(plan.summary || plan.name).replace(/[.\s]+$/, "")}. Jobs: ${list}${tasks.length > 8 ? ", ..." : ""}. Take what fits your role - I'll go for ${this.bestFor(tasks)?.title || "whatever is left"}.`);
    log("project", `${this.me} planned "${plan.name}" with ${tasks.length} jobs at ${center.x},${center.z}`);
  }

  /** "Everyone come to 6 64 140": validate the goal (coordinates must come from the human's words), tell the whole team, do it myself too. */
  broadcastOrder(speaker, message, plan) {
    const a = this.agent;
    const { validateGoal } = require("./llm");
    let goal = validateGoal(plan.goal, { reg: a.reg, speaker, team: a.team });
    if (goal?.type === "goto") {
      const m = String(message).match(/(-?\d+)[\s,]+(-?\d+)[\s,]+(-?\d+)/);
      const ok = m && Math.abs(goal.pos.x - +m[1]) <= 2 && Math.abs(goal.pos.z - +m[3]) <= 2;
      if (!ok) goal = null;
    }
    if (!goal) { this.say(plan.reply || "I didn't get that - where should everyone go?"); return; }
    this.say(plan.reply || `everyone, ${goal.type === "come" ? "come to " + speaker : "move out"}`);
    const mates = team.readTeam(this.me);
    for (const m of mates) if (!((goal.type === "follow" || goal.type === "come") && goal.player === m.name)) team.send(this.me, m.name, { type: "order", text: plan.reply || goal.type, data: { goal, from: speaker } });
    log("project", `order from ${speaker}: ${JSON.stringify(goal)} -> ${mates.length} teammate(s) + me`);
    a.runOrder(goal);
  }

  /** "Renovate the village": survey it (buildings with damage, ground gaps, paths to the doors) and put the work on the board. */
  async villageProject(id, speaker, center) {
    const a = this.agent;
    if (Math.hypot(a.bot.entity.position.x - center.x, a.bot.entity.position.z - center.z) > 40) {    // the chunks must be loaded to look at the village
      a.think("going to the village to look at it");
      a.runOrder({ type: "goto", pos: { x: center.x, y: center.y ?? null, z: center.z } });
      const t0 = Date.now();
      while (Date.now() - t0 < 150000 && Math.hypot(a.bot.entity.position.x - center.x, a.bot.entity.position.z - center.z) > 30) await sleep(1000);
    }
    try { await a.bot.waitForChunksToLoad(); } catch { /* best effort */ }
    await sleep(1500);                                                       // chunks around a freshly arrived bot are still streaming in
    const { planRenovation } = require("./village");
    const { tasks, report } = planRenovation(a.bot, center);
    if (!tasks.length) { board.update(id, { state: "cancelled" }); this.say(`I looked over the village: ${report.buildings} building${report.buildings === 1 ? "" : "s"}, no damage, no gaps - it is in good shape.`); return; }
    board.addTasks(id, tasks.map((t, i) => ({ ...t, order: i })));
    board.update(id, { name: "village renovation", summary: "renovating the village", center, state: "open", roster: [this.me, ...team.readTeam(this.me).map((m) => m.name)] });
    board.join(id, this.me, { role: a.role }); this.joined.add(id);
    this.say(`Village check: ${report.buildings} buildings, ${report.damaged} need repairs${report.gaps ? `, ${report.gaps} ground gaps to fill` : ""}${report.path ? `, ${report.path} blocks of path to lay` : ""}. Jobs are up - grab one.`);
    log("project", `${this.me} village renovation: ${JSON.stringify(report)} -> ${tasks.length} jobs`);
  }

  async makePlan(message, speaker, roster, center) {
    const a = this.agent;
    const fallback = () => {
      const coords = String(message).match(/(-?\d+)[\s,]+(-?\d+)[\s,]+(-?\d+)/);
      if (/\b(come|gather|meet|assemble|go)\b/i.test(message) && !BIG.test(message)) return coords ? { kind: "order", reply: `everyone, come to ${coords[1]} ${coords[2]} ${coords[3]}`, goal: { type: "goto", pos: { x: +coords[1], y: +coords[2], z: +coords[3] } } } : { kind: "order", reply: `everyone, come to ${speaker}`, goal: { type: "come", player: speaker } };
      if (!BIG.test(message)) return null;
      const houses = Math.min(5, Math.max(2, roster.length - 2));
      const tasks = [{ id: "well", title: "village well", request: "village well with cobblestone walls and a roof", roleHint: "builder", size: { w: 7, d: 7 }, zone: "center" }];
      for (let i = 1; i <= houses; i++) tasks.push({ id: "house" + i, title: `house ${i}`, request: "proper village house with door, windows, bed and torches, oak planks and cobblestone", roleHint: i % 2 ? "builder" : "lumberjack", size: { w: 11, d: 11 }, zone: "ring" });
      tasks.push({ id: "farm1", title: "wheat farm", request: "fenced wheat farm with water in the middle and a scarecrow", roleHint: "hunter", size: { w: 11, d: 11 }, zone: "outer" });
      tasks.push({ id: "farm2", title: "carrot and potato farm", request: "fenced carrot and potato farm with water in the middle", roleHint: "hunter", size: { w: 11, d: 11 }, zone: "outer" });
      return { kind: "project", name: "village", summary: "Plan: a well in the middle, houses around it, farms outside", style: "oak planks, cobblestone, spruce roofs", tasks };
    };
    if (!a.brain?.available) return fallback();
    try {
      const prompt = `You are ${this.me}, a Minecraft player and the team leader for this request. A human (${speaker}) said to the whole team: "${message}"
Team (${roster.length}): ${roster.map((r) => `${r.name} (${r.role})`).join(", ")}.
First decide what this is: (a) "project" = build or make something together (needs a plan with jobs); (b) "order" = an immediate simple instruction to the whole team (come here / gather around me / go to x y z / follow me / stop) - no plan, everybody just does it; (c) "chat" = just talking (short friendly reply). For an order give "goal": {"type":"come","player":"<name of the human who is speaking>"} for come/gather around me, {"type":"goto","pos":{"x":..,"y":..,"z":..}} for coordinates (ONLY coordinates that appear in the human's message), {"type":"follow","player":..}, or {"type":"stop"}; and "reply": what I say to the team in chat (<=100 chars, address everyone, e.g. "everyone, come to 6 64 140").
For a project, be PROGRESSIVE, not perfect: the first jobs must be simple structures out of wood or cobblestone that can START IMMEDIATELY and be finished in a few minutes (no glass, iron or fancy blocks needed), small (at most ~9x9 and ~120 blocks); put nicer or bigger things LATER in the list (the list order is the order people pick jobs). Plan it like an experienced player would: break it into separate, concrete jobs, each ONE structure (or one job) that a single player can finish alone in ~5-20 minutes, so the team works in parallel. At most ${Math.min(14, roster.length * 2 + 2)} jobs. Give every job:
 id (short, unique, snake_case), title (<=5 words), request (a complete build instruction for the designer: what, materials, features - use the shared style so the project looks like one place), roleHint (one of leader|scout|miner|builder|lumberjack|hunter|smith - who suits it), size {w,d} estimate in blocks, zone ("center" for the one or two central landmarks like a well/town hall/plaza, "ring" for houses and workshops around it, "outer" for farms/pens/fields).
Cover what the human asked for (e.g. village = houses, wells, farms, maybe a storage/market hall), scaled to the team. NEVER split ONE object into parts as separate jobs (no \"statue legs\" + \"statue head\" jobs): every job is a complete, separate structure on its own plot. Do not invent coordinates - the layout is computed afterwards.
Reply ONLY JSON: {"kind":"project"|"order"|"chat","reply":"<=100 chars, for chat or order","goal":{...only for order...},"name":"<=3 words","summary":"<=100 chars: the plan in one friendly sentence, first person plural","style":"materials/look shared by all jobs","tasks":[{"id":"","title":"","request":"","roleHint":"","size":{"w":0,"d":0},"zone":""}]}`;
      const out = await a.brain.json(prompt, { timeoutMs: 40000, level: "LOW", strong: true });
      if (out?.kind === "chat") return { kind: "chat", reply: String(out.reply || "").slice(0, 120) };
      if (out?.kind === "order") return { kind: "order", reply: String(out.reply || "").slice(0, 140), goal: out.goal };
      const seen = new Set();
      const tasks = (Array.isArray(out?.tasks) ? out.tasks : []).filter((t) => t && t.id && t.request && !seen.has(t.id) && seen.add(t.id)).slice(0, 14).map((t) => ({
        id: String(t.id).replace(/\W+/g, "_").slice(0, 24), title: String(t.title || t.id).slice(0, 40), request: `${String(t.request).slice(0, 300)}${out.style ? ` (shared style: ${String(out.style).slice(0, 80)})` : ""}`,
        roleHint: String(t.roleHint || "builder"), size: { w: Math.max(3, Math.min(30, +t.size?.w || 10)), d: Math.max(3, Math.min(30, +t.size?.d || 10)) }, zone: ["center", "ring", "outer"].includes(t.zone) ? t.zone : "ring"
      }));
      if (!tasks.length) return fallback();
      return { kind: "project", name: String(out.name || "project").slice(0, 30), summary: String(out.summary || "").slice(0, 160), style: out.style, tasks };
    } catch (e) { log("project", "plan LLM failed: " + e.message); return fallback(); }
  }

  /** The leader's own initiative: nothing is going on and nobody asked - decide what the team should do next and start it (through the same board as a human's request). */
  async proposeProject() {
    const a = this.agent;
    if (this.proposing || Date.now() - (this.lastProposal || 0) < 15 * 60000 || board.active().length || !a.brain?.available) return;
    // the players are directing (someone gave any of us an order in the last 20 minutes): no projects of my own on top of theirs
    const mates0 = team.readTeam(this.me);
    const lastHuman = Math.max(a.lastHumanCommand || 0, ...mates0.map((m) => m.lastHuman || 0));
    if (Date.now() - lastHuman < 20 * 60000) return;
    this.proposing = true; this.lastProposal = Date.now();
    try {
      const mates = team.readTeam(this.me);
      if (!mates.length) return;
      const journal = a.autonomy.journal.slice(-6).map((e) => `${e.outcome === "done" ? "DONE" : "FAILED"}: ${e.goal}`).join("; ") || "nothing yet";
      const past = board.all().filter((p) => Date.now() - (p.created || 0) < 6 * 3600000).map((p) => `${p.state === "cancelled" ? "CANCELLED by the players (never propose again)" : p.state.toUpperCase()}: ${String(p.request || p.name).slice(0, 80)}`).join("; ") || "none";
      const prompt = `You are ${this.me}, the leader of a small Minecraft survival team (${mates.map((m) => `${m.name} the ${m.role}`).join(", ")}). Nobody has given an order and there is no shared project. Decide the ONE most useful thing for the team to build or set up next, like an experienced player would (a base needs: shelter/houses to sleep in, a storage chest area, a farm for food, a well, fences, torches, a small mine entrance...).
Known places: ${a.know.summary(8)}. Your recent work: ${journal}. Earlier team projects: ${past}. Game: survival; the team has wood/stone tools at best.
Reply ONLY JSON: {"request":"<one concrete project in plain words, buildable from wood and stone, or empty if nothing sensible>"}`;
      const out = await a.brain.json(prompt, { timeoutMs: 30000, level: "LOW", strong: true });
      const request = String(out?.request || "").trim();
      if (!request) return;
      const words = (t) => new Set(String(t).toLowerCase().split(/\W+/).filter((w) => w.length > 3));
      const rq = words(request);
      for (const p of board.all().filter((x) => x.state === "cancelled" || x.state === "done")) { const pw = words(p.request || p.name); const common = [...rq].filter((w) => pw.has(w)).length; if (common >= Math.max(2, Math.min(rq.size, pw.size) * 0.6)) { log("project", `not proposing "${request}" again (it was ${p.state})`); return; } }
      // a player is online: SUGGEST it and wait for a yes - never start a big project behind their back
      const humans = Object.keys(a.bot.players).filter((n) => n !== this.me && !a.isAgent(n));
      if (humans.length) {
        this.pendingProposal = { request, t: Date.now() };
        this.say(`Idea: we could ${request.replace(/^(build|make|set up)\s/i, (m) => m.toLowerCase())}. Want us to? (say "yes")`);
        log("project", `${this.me} suggests (waiting for a yes): ${request}`);
        return;
      }
      const id = crypto.createHash("sha1").update(this.me + "|" + request + "|" + Date.now()).digest("hex").slice(0, 10);
      if (!board.create(id, { request, speaker: this.me, coordinator: this.me, name: "project" })) return;
      log("project", `${this.me} proposes: ${request}`);
      await this.lead(id, this.me, request, { revived: true });
    } catch (e) { log("project", "proposal failed: " + e.message); } finally { this.proposing = false; }
  }

  /** A player said yes to my suggestion: now it starts, through the board like any request. */
  async acceptProposal(speaker) {
    const p = this.pendingProposal;
    if (!p || Date.now() - p.t > 5 * 60000) return false;
    this.pendingProposal = null;
    const id = crypto.createHash("sha1").update(this.me + "|" + p.request + "|" + Date.now()).digest("hex").slice(0, 10);
    if (!board.create(id, { request: p.request, speaker, coordinator: this.me, name: "project" })) return false;
    this.lead(id, speaker, p.request, { revived: true }).catch((e) => log("project", "accepted proposal failed: " + e.message));
    return true;
  }

  bestFor(tasks) { return [...tasks].sort((x, y) => roleFit(y, this.agent.role) - roleFit(x, this.agent.role))[0]; }

  // ------------------------------------------------------------------ everybody
  /** Called from the agent loop. Returns true if it started something (so autonomy waits). */
  async tick(snap) {
    if (this.busy || Date.now() - (this.lastTick || 0) < 2500) return false;            // the board is files: look at it every couple of seconds, not every tick
    this.lastTick = Date.now();
    this.busy = true;
    try { return await this.tick1(snap); } catch (e) { log("project", "tick error: " + e.stack); return false; } finally { this.busy = false; }
  }

  async tick1(snap) {
    const a = this.agent;
    // the project I am working for was cancelled (a player said "clear task" to any of us): stop right away, do not finish it
    if (a.goal?.project) {
      const p = board.get(a.goal.project.id);
      if (!p || !["planning", "open", "active"].includes(p.state)) {
        log("project", `${this.me}: "${a.goal.autoWhy}" was cancelled - dropping it`);
        a.goal = null; a.ledger = []; a.queue = []; a.abortCurrent("project_cancelled");
        this.myTask = null; a.autonomy.pause(90000);
        return false;
      }
    }
    const projects = board.active();
    for (const p of projects) {
      if (!this.joined.has(p.id)) { board.join(p.id, this.me, { role: a.role }); this.joined.add(p.id); log("project", `${this.me} joined "${p.name}"`); }
    }
    if (Date.now() - this.lastBeat > 10000) { this.lastBeat = Date.now(); for (const p of projects) board.beat(p.id, this.me); }
    for (const p of projects) { this.janitor(p); if (p.coordinator === this.me) this.finishIfDone(p); }

    // my job in progress: keep it alive (a human order may have interrupted it; resume once I am free again)
    if (this.myTask) {
      const { pid, task } = this.myTask;
      const cur = board.tasks(pid).find((t) => t.id === task.id);
      if (!cur || cur.state === "done" || cur.owner !== this.me) { this.myTask = null; return false; }
      if (a.goal?.project && a.goal.spec) this.askForMaterials(a.goal, cur);
      if (a.goal || a.director.ctl || a.queue.length) return false;
      if (this.unsafeNow()) return false;
      if (a.lastHumanCommand && Date.now() - a.lastHumanCommand < 15000) return false;
      this.startGoal(pid, cur, true);
      return true;
    }
    // nobody answered my call for materials: say so and get them myself, like a player would
    for (const r of this.myRequests || []) {
      if (r.done || Date.now() - r.t < 90000) continue;
      r.done = true;
      if (!requests.isClaimed(r.id)) { requests.withdraw(r.id); this.say(pick([`nobody can spare ${r.item.replace(/_/g, " ")}, I'll gather it myself`, `no takers for the ${r.item.replace(/_/g, " ")} - fine, I'll get it myself`])); }
    }
    // helping a teammate who asked comes before my own errand too
    if (a.goal?.auto && !a.goal.project && !a.goal.sub && !a.goal.requestId && a.goal.type !== "hideout" && a.goal.autoKey !== "n:sleep" && a.autonomy.canHelpAny(a.lastInv || {})) { log("project", `${this.me} drops "${a.goal.autoWhy}" to answer a teammate's request`); a.goal = null; a.ledger = []; a.abortCurrent("help_request"); a.autonomy.lastEnd = 0; }
    // a team job is more important than my own errand: put the errand down (not as a failure) and join in
    const ready = (p) => p.state === "open" && Date.now() - p.updated >= 7000 + this.stagger();
    const hasJob = (p) => board.tasks(p.id).some((t) => t.state === "open" && !(t.failedBy || []).includes(this.me) && (this.cooldown.get(p.id + t.id) || 0) < Date.now() && t.attempts < 3);
    if (projects.some((p) => ready(p) && hasJob(p))) {
      if (a.goal?.auto && !a.goal.project && !a.goal.sub && a.goal.type !== "hideout" && a.goal.autoKey !== "n:sleep") { log("project", `${this.me} drops "${a.goal.autoWhy}" for the team job`); a.goal = null; a.ledger = []; a.abortCurrent("team_job"); a.autonomy.lastEnd = 0; }
      else if (!a.goal && a.autonomy.current?.goal?.type === "freeform" && a.director.ctl) { a.director.cancel("team job"); a.autonomy.lastEnd = 0; }
    }
    if (Date.now() < (a.holdUntil || 0)) return false;                    // told to come and wait: wait
    if (!a.autonomy.free(true, { team: true })) return false;              // a team job is an explicit order: an earlier "stop" does not apply to it, nor does MC_AUTONOMY=off
    if (this.unsafeNow()) return false;
    if (!a.brain?.available) return false;                                 // building needs the designer (AI): do not take a job I cannot even start
    for (const p of projects) {
      if (p.state !== "open") continue;
      if (Date.now() - p.updated < 7000 + this.stagger()) continue;       // let the plan sink in; people do not all grab at the same instant
      const open = board.tasks(p.id).filter((t) => t.state === "open" && !(t.failedBy || []).includes(this.me) && (this.cooldown.get(p.id + t.id) || 0) < Date.now() && t.attempts < 3);
      if (!open.length) continue;
      const mine = this.bestFor(open);
      if (!mine || !board.claim(p.id, mine.id, this.me)) continue;
      this.myTask = { pid: p.id, task: mine };
      const others = board.tasks(p.id).filter((t) => t.owner && t.owner !== this.me).map((t) => `${t.owner}: ${t.title}`).slice(0, 4);
      this.say(pick([`I'll take the ${mine.title}`, `${mine.title} is mine`, `I've got the ${mine.title}`]) + (others.length && Math.random() < 0.4 ? ` - ${others[0]}, right?` : ""));
      this.startGoal(p.id, mine, false);
      return true;
    }
    return false;
  }

  /** Short of materials for my job? Ask the team (not the human): "need 80 oak planks - anyone?" The right person answers (see Autonomy.teamwork). */
  askForMaterials(goal, task) {
    this.asked ||= new Set();
    if (this.asked.has(task.id)) return;
    const a = this.agent;
    if (a.bot.game?.gameMode === "creative") return;                 // creative: every block is free, nobody has to bring anything
    const mates = team.readTeam(this.me);
    if (!mates.length) return;
    try {
      const compiled = goal._compiled || Struct.compileStructure(goal.spec, a.reg);
      if (!compiled.ok) return;
      const short = Struct.materialsFor(compiled.cells, a.lastInv || {}).short || {};
      const wanted = Object.entries(short).filter(([item, n]) => n >= 24 && requests.suppliers(item).length).sort((x, y) => y[1] - x[1]).slice(0, 2);
      this.asked.add(task.id);
      for (const [item, n] of wanted) {
        const count = Math.min(128, n);
        const rid = requests.post({ from: this.me, item, count, why: `for the ${task.title}` });
        (this.myRequests ||= []).push({ id: rid, t: Date.now(), item });
        this.say(pick([`anyone got ${count} ${item.replace(/_/g, " ")} to spare? need them for the ${task.title}`, `I'm short on ${item.replace(/_/g, " ")} for the ${task.title} - can somebody bring ~${count}?`]));
      }
    } catch (e) { log("project", "ask failed: " + e.message); }
  }

  /** Survival first: no team jobs without a weapon, none at night when it is dangerous out (the hideout/bed logic owns those hours). */
  unsafeNow() {
    const a = this.agent;
    const { nightRisk, hasWeapon } = require("./autonomy");
    const pseudo = { gameMode: a.bot.game?.gameMode, dimension: "overworld", dayTime: a.lastDayTime, inv: a.lastInv || {}, armor: {} };
    for (const [slot, i] of Object.entries({ head: 5, chest: 6, legs: 7, feet: 8 })) pseudo.armor[slot] = a.bot.inventory.slots[i]?.name || null;
    return pseudo.gameMode !== "creative" && (!hasWeapon(pseudo.inv) || nightRisk(pseudo, a.autonomy.bedNear()));
  }

  stagger() { let h = 0; for (const c of this.me) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 7) * 900; }

  startGoal(pid, task, resumed) {
    const a = this.agent;
    const { resolveAnchor } = require("../runtime/spatial");
    const anchor = resolveAnchor(a, this.me, "at", { x: task.plot.x, z: task.plot.z, y: null });
    const exactPlace = !!board.get(pid)?.exact;
    if (anchor) { anchor.flex = !exactPlace; if (task.origin) anchor.fixed = task.origin; }    // the plot may need a nudge (water, trees, a cliff) - but once chosen it never moves again
    if (task.mode === "repair" && !task.spec && task.anchor && anchor) { anchor.x = task.anchor.x; anchor.y = task.anchor.y; anchor.z = task.anchor.z; delete anchor.fixed; anchor.flex = false; }
    const goal = { type: "build", request: task.request, where: "at", pos: { x: task.plot.x, y: null, z: task.plot.z }, anchor, ...(task.mode ? { mode: task.mode } : {}), ...(task.spec ? { spec: task.spec } : {}), auto: true, internal: true, autoKey: "p:" + task.id, autoWhy: `${board.get(pid)?.name || "project"}: ${task.title}`, project: { id: pid, taskId: task.id } };
    log("project", `${this.me} ${resumed ? "resumes" : "starts"} "${task.title}" at ${task.plot.x},${task.plot.z}`);
    a.think(`${resumed ? "back to" : "starting"} ${task.title}`);
    board.progress(pid, task.id, { state: "active" });
    a.setGoal(goal);
  }

  /** Goal ended (called by Autonomy.onOutcome for goals that carry a project tag). */
  onTaskOutcome(goal, ok, text) {
    const { id, taskId } = goal.project;
    const task = board.tasks(id).find((t) => t.id === taskId);
    if (!task || task.owner !== this.me) return;
    if (ok) {
      board.finish(id, taskId, this.me, { origin: this.agent.mem.recall(`structure:${goal.sid}`)?.origin || null });
      this.myTask = null;
      const left = board.tasks(id).filter((t) => t.state !== "done").length;
      this.say(pick([`${task.title} is done`, `finished the ${task.title}`, `${task.title} - done`]) + (left ? `, ${left} job${left > 1 ? "s" : ""} left` : ""));
    } else if (!this.agent.brain?.available) {                             // not the job's fault: the AI is down. Put it back quietly, try again later
      board.release(id, taskId, this.me);
      this.cooldown.set(id + taskId, Date.now() + 60000);
      this.myTask = null;
    } else {
      board.release(id, taskId, this.me, { failed: true, reason: text });
      this.cooldown.set(id + taskId, Date.now() + 15 * 60000);
      this.myTask = null;
      this.say(pick([`I couldn't finish the ${task.title}, someone else can take it`, `the ${task.title} defeated me (${String(text).slice(0, 40)}) - passing it on`]));
    }
  }

  /** A task whose owner vanished (disconnected, crashed) goes back on the board. */
  janitor(p) {
    const alive = new Set([this.me, ...team.readTeam(this.me, 90000).map((t) => t.name)]);
    for (const t of board.tasks(p.id)) if (t.owner && t.state !== "done" && !alive.has(t.owner) && Date.now() - (t.updated || 0) > 90000) { board.release(p.id, t.id, "*"); log("project", `released "${t.title}" (${t.owner} is gone)`); }
  }

  finishIfDone(p) {
    const ts = board.tasks(p.id);
    if (!ts.length) return;
    const open = ts.filter((t) => t.state !== "done" && !(t.attempts >= 3));
    if (open.length) return;
    board.update(p.id, { state: ts.every((t) => t.state === "done") ? "done" : "partial" });
    const done = ts.filter((t) => t.state === "done").length;
    this.say(done === ts.length ? pick([`That's the whole ${p.name} - all ${done} jobs done. Nice work everyone!`, `${p.name} is finished, ${done}/${ts.length} jobs. Good teamwork!`]) : `${p.name}: ${done}/${ts.length} jobs done, the rest kept failing - need a hand with those.`);
  }
}

module.exports = { TeamProjects, audience, electCoordinator, jobTitle, BIG, RENOVATE };
