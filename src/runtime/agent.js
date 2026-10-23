// The control loop. Each cycle: observe -> reflexes -> plan (pure) -> act -> verify -> escalate.
// The plan is recomputed from real state every cycle, so interruptions and failures need no
// special "resume" logic: the next plan simply starts from wherever reality is.
const { Vec3 } = require("vec3");
const { observe } = require("./observe");
const { sleep, isAbort, invCount, log, pos3, timed, watchLag } = require("./util");
const { plan, opportunistic, HARD_GROUND } = require("../core/planner");
const { reflex } = require("../core/reflex");
const { assess, rung } = require("../core/progress");
const { Memory } = require("../core/memory");
const skills = require("../skills");
const { Radar } = require("./radar");
const { Director } = require("../brain/director");
const { Context } = require("../brain/context");

// actions that legitimately stay in one place for a while
const STATIONARY = new Set(["smelt", "craft", "chest", "set_spawn", "eat", "shelter", "placeStation", "place_item", "fight", "raise_shield", "follow", "tidy", "tell", "creative_give", "build_structure"]);

const SKILL_TIMEOUT = { drive_ghast: 240000, mount_ride: 60000, dismount_ride: 60000, burrow: 600000, harvest: 600000, tidy: 20000, build_structure: 1500000, design_structure: 150000, chest: 60000, shelter: 30000, flee: 12000, place_item: 40000, escape_hole: 60000, boat_to: 120000, swim_across: 90000, build_house: 600000, equip_gear: 15000, travel_dimension: 180000, chase_across_dimensions: 90000, set_spawn: 120000, deliver: 60000, tower_to: 60000, dig_to: 60000, approach: 40000, collect: 40000, mine: 240000, craft: 30000, smelt: 160000, hunt: 180000, follow: 6 * 3600000, placeStation: 20000, fight: 120000 };

class Agent {
  constructor(bot, reg, { say, advisor = null } = {}) {
    this.bot = bot; this.reg = reg; this.advisor = advisor;
    const selfName = (bot.username || "").toLowerCase();
    this.team = (process.env.MC_AGENT_NAMES || "").split(",").map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== selfName);   // other AI agents we can command
    this.mem = new Memory();
    this.teamReports = []; this.lastHumanCommand = 0; this.cmdTimes = [];
    this.ctxStore = new Context();
    this.know = new (require("../brain/knowledge").Knowledge)(bot.username || "agent");
    for (const k of ["bed", "house", "portals"]) { const v = this.ctxStore.recall(k); if (v) this.mem.facts[k] = v; }
    this.mem.onFact = (k, v) => { this.ctxStore.remember(k, v); try { if (k === "bed" && v) this.know.add({ kind: "bed", label: "bed", pos: v }); if (k === "house" && v?.origin) this.know.add({ kind: "home", label: "house", pos: v.origin }); } catch { /* knowledge is best effort */ } };
    this.ctxStore.onPlace = (p) => { try { this.know.add({ kind: p.label || "place", label: p.label || "place", pos: p, source: "player", note: `said by ${p.speaker}` }); } catch { /* best effort */ } };
    this.chatLog = this.ctxStore.chat;
    this.rawSay = say || ((m) => bot.chat(m));
    this.lastSay = { text: "", t: 0, any: 0 };
    this.queue = [];               // goals waiting behind the current one
    this.lastNarrate = { text: '', t: 0 };
    this.goal = null;              // explicit task
    this.baseGoal = { type: "idle" }; // what to do when there is no task
    this.autonomy = new (require("../brain/autonomy").Autonomy)(this);
    this.role = this.autonomy.role;
    this.projects = new (require("../brain/team-project").TeamProjects)(this);
    this.banter = new (require("../brain/banter").Banter)(this);
    this.master = null;            // player name we serve
    this.current = null;           // {name, ctl, reflex}
    this.active = new Set();       // EVERY running action's AbortController (exec, scripts, relocate): all cancellable
    this.ledger = [];
    this.interventions = 0;
    this.avoidUntil = new Map();   // block name -> expiry
    this.suppressed = new Map();   // reflex kind -> expiry
    this.lastHurt = null;
    this.lastBeat = Date.now();
    this.prog = { pos: null, inv: "", t: Date.now() };
    this.hintCache = { t: 0, v: null };
    this.radar = new Radar(bot);
    this.director = new Director(this);
    this.lastGoalOutcome = null;
    this.kills = new Map();       // lowercase name -> t (died while we were hunting)
    this.running = null;          // {action, plan, t} for the in-flight goal action
    this.lastWatch = 0;
    this.alive = false;
    this.dead = false;
    this.pendingInterrupt = null;
    this.stats = { actions: 0, reflexes: 0, replans: 0 };
    this.wire();
  }

  // ---------- public control ----------
  // Who is the bot talking to? The player who asked (or an explicit addressee). Other agents rely on this name to react.
  isAgent(name) { return !!name && this.team.some((t) => t.toLowerCase() === String(name).toLowerCase()); }

  nameise(msg, to = null) {
    const name = to || this.master;
    if (!name) return msg;
    if (this.isAgent(name)) return new RegExp(`@${name}\\b`, "i").test(msg) ? msg : `@${name} ${msg}`;   // agents only react to "@Name ..."
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(msg)) return msg;
    const lower = /^I\b|^[A-Z]{2}|^\d/.test(msg) ? msg : msg.charAt(0).toLowerCase() + msg.slice(1);
    return `${name}, ${lower}`;
  }

  // report: a completion/blocked/question message. Chatter (plans, acknowledgements) is never sent to another agent -
  // only reports are, otherwise two agents would answer each other forever.
  say(msg, { force = false, to = null, noName = false, report = false } = {}) {
    const now = Date.now();
    const who = to || this.master;
    if (!noName && this.isAgent(who)) {                       // an AI teammate is not talked to in chat: reports go to its inbox
      if (report || (force && /finish|done|can't|cannot|stuck|have \d|couldn't|failed|found/i.test(msg))) require("./team").send(this.bot.username, who, { type: "report", text: msg });
      else log("say", `(not sent to agent ${who}) ${msg}`);
      return;
    }
    const text = noName ? msg : this.nameise(msg, to);
    if (!force && text === this.lastSay.text && now - this.lastSay.t < 12000) return;
    if (now - this.lastSay.any < 700) return setTimeout(() => this.rawSay(text), 700);
    this.lastSay = { text, t: now, any: now };
    this.ctxStore.addChat(this.bot.username, text, { bot: true });
    require("../brain/episode").chatLine(this.bot.username, text);
    this.rawSay(text);
  }

  setGoals(list) { this.setGoal(list[0]); this.queue = list.slice(1); }

  // The faint "what I'm thinking / about to do" line is a private whisper to the player who asked (never broadcast);
  // with nobody to tell, it only goes to the console log.
  think(text) {
    const clean = String(text || "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
    if (!clean) return;
    const now = Date.now();
    if (clean === this.lastNarrate.text && now - this.lastNarrate.t < 4000) return;
    this.lastNarrate = { text: clean, t: now };
    log("think", clean);
    // the agent's reasoning, for "AI brain" cards in episode videos (not every step: only real thoughts, at most one per 8 s)
    if (clean.length > 25 && !/^(go to|walk to|craft \d|mine \d|collect|approach)/i.test(clean) && now - (this.lastThoughtMark || 0) > 8000) { this.lastThoughtMark = now; require("../brain/episode").mark(this.bot.username, "thought", clean); }
    const to = this.master;
    if (!to || !this.bot.players[to] || to === this.bot.username || this.isAgent(to)) return;      // thoughts are whispered to the human who asked, never to a teammate bot
    if (now - (this.lastWhisper || 0) < 2200) return;      // never let thoughts turn into spam
    this.seen ||= new Map();                                  // the same thought again within a minute is noise, not information
    if (now - (this.seen.get(clean) || 0) < 60000) return;
    this.seen.set(clean, now); if (this.seen.size > 80) this.seen.delete(this.seen.keys().next().value);
    this.lastWhisper = now;
    this.bot.chat(`/msg ${to} ~ ${clean}`);
  }
  narrate(text) { this.think(text); }

  advanceQueue() {
    const next = this.queue.shift();
    if (next) { next.fromQueue = true; this.setGoal(next, { keepQueue: true }); return true; }
    return false;
  }

  setGoal(goal, { announce = true, keepQueue = false } = {}) {
    if (!keepQueue) this.queue = [];
    // new work from a player (or a team order) ends an old "follow me": after the job the bot does NOT go back to trailing behind them
    if (!goal.auto && !goal.sub && !["follow", "idle", "stop"].includes(goal.type) && this.baseGoal?.type === "follow") { log("agent", `no longer following ${this.baseGoal.player}: new task ${goal.type}`); this.baseGoal = { type: "idle" }; }
    // Anything the typed planner can't express goes to the AI director (writes/repairs scripts, breaks the task down)
    if (goal.type === "freeform") {
      this.goal = null; this.abortCurrent("freeform");
      if (!this.brain?.available) { this.say("I need the AI planner (an AI provider in .env) for that kind of task - can you give me something simpler?", { force: true }); this.advanceQueue(); return; }
      this.ctxStore.noteGoal(goal, this.master);
      this.director.start(goal.text, this.master, { quiet: !!goal.auto }).finally(() => { this.autonomy.onOutcome(goal, "done", true); if (!this.goal) this.advanceQueue(); });
      return;
    }
    goal.id = (this.goalSeq = (this.goalSeq || 0) + 1);
    goal.startedAt = Date.now();
    goal.sid = goal.sid || Date.now().toString(36) + Math.random().toString(36).slice(2, 5); // unique across restarts (goal ids are not)
    goal.progress = goal.progress || {};
    this.kills.clear(); this.radar.untrackAll();
    if (goal.type === "kill") {
      for (const t of goal.targets || []) if (!t.startsWith("*")) this.radar.track(t);
      if ((goal.targets || []).includes("*players")) goal.exclude = goal.exclude || [this.master].filter(Boolean);
    }
    if ((goal.type === "follow" || goal.type === "come") && goal.player) this.radar.track(goal.player);
    this.goal = goal.type === "idle" ? null : goal;
    if (goal.type === "follow" || goal.type === "idle") { this.baseGoal = goal; this.goal = null; }
    this.toldBlind = false;
    this.ledger = []; this.interventions = 0; this.mem.clearStrikes(""); this.avoidUntil.clear();
    this.abortCurrent("new_goal");
    if (goal.type !== "idle") this.ctxStore.noteGoal(goal, this.master);
    log("agent", "goal ->", JSON.stringify(goal));
  }

  // give the current goal up for good (unrecoverable, already explained to the player); deferred so the running skill can return first
  abandon() {
    const human = this.goal && !this.goal.auto && !this.goal.internal;
    if (human) { this.autonomy.pause(150000); this.holdUntil = Date.now() + 150000; }      // a player's order that could not be done: wait for their answer, do not wander off to own errands
    setTimeout(() => { this.clearGoal(); this.advanceQueue?.(); }, 0);
  }

  clearGoal() { this.goal = null; this.abortCurrent("cleared"); }

  abortCurrent(why) {
    if (this.current) log("agent", `abort ${this.current.name}: ${why}`);
    this.current?.ctl.abort();
    for (const ctl of this.active) ctl.abort();   // also anything another component started (director scripts...)
  }

  // follow() calls this when the player is not a visible entity: cross dimensions / close distance
  async chaseOffscreen(ctx, player) {
    const w = this.radar.where(player);
    if (!w) { this.radar.track(player); return "unknown"; }
    const r = await skills.chase_across_dimensions({ ...ctx, agent: this }, player);
    return r.ok && r.data?.arrived ? "arrived" : "moving";
  }

  // After dying: go back for the dropped gear (if there was any worth getting), then resume what we were doing.
  planRecovery() {
    const d = this.deathInfo;
    if (!d) return;
    const valuable = Object.entries(d.inv).filter(([k, v]) => v > 0 && /(pickaxe|sword|axe|shovel|helmet|chestplate|leggings|boots|shield|diamond|iron_ingot|bow|cooked|golden|enchant)/.test(k)).length;
    (this.deathTimes ||= []).push(Date.now()); this.deathTimes = this.deathTimes.filter((t) => Date.now() - t < 600000);
    const night = this.lastDayTime != null && this.lastDayTime >= 12700 && this.lastDayTime <= 22800;
    if (this.deathTimes.length >= 2 || night) { this.think(this.deathTimes.length >= 2 ? "I keep dying around there - leaving that gear, not going back" : "it's night out there - leaving the gear until daylight"); if (night && this.deathTimes.length < 2) this.gearLater = { ...d, until: Date.now() + 12 * 60000 }; return; }
    if (valuable < 1 || Date.now() - d.t > 120000) return;
    const resume = this.goal && this.goal.type !== "recover" ? this.goal : null;
    const pos = { x: d.pos.x, y: d.pos.y, z: d.pos.z };
    const rec = { type: "recover", internal: true, pos, dimension: d.dimension, deadline: Date.now() + 240000 };
    this.say(`I died - going back for my gear at ${Math.round(pos.x)} ${Math.round(pos.y)} ${Math.round(pos.z)}.`, { force: true });
    const rest = [...(resume ? [resume] : []), ...this.queue];
    this.setGoal(rec);
    this.queue = rest;
  }

  // ---------- wiring ----------
  wire() {
    const { bot } = this;
    bot.on("entityHurt", (e) => {
      if (e !== bot.entity) return;
      const near = Object.values(bot.entities).filter((x) => x !== bot.entity && x.position && x.position.distanceTo(bot.entity.position) < 6 && (x.type === "hostile" || x.type === "player" || x.type === "mob"))
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      this.lastHurt = { t: Date.now(), by: near?.username || near?.name || null };
    });
    bot.on("entityDead", (e) => {
      if (e.username) this.kills.set(e.username.toLowerCase(), Date.now());
      this.kills.set(`${e.name}#${e.id}`.toLowerCase(), Date.now());
    });
    bot.on("death", () => {
      require("../brain/episode").mark(bot.username, "death", `died${this.lastHurt && Date.now() - this.lastHurt.t < 6000 ? " to " + this.lastHurt.by : ""}${this.goal ? " while doing: " + (this.goal.request || this.goal.type) : ""}`);
      this.deathInfo = { pos: this.lastDeathPos || bot.entity.position.clone(), dimension: this.lastDim || "overworld", inv: this.lastInv || {}, t: Date.now() }; this.dead = true; this.deathAt = { pos: bot.entity.position.clone(), t: Date.now(), dimension: bot.game.dimension }; this.abortCurrent("death"); log("agent", "died at", pos3(bot.entity.position)); });
    bot.on("spawn", () => { if (this.dead) { this.dead = false; log("agent", "respawned"); this.planRecovery(); } });
    let tick = 0, last = 0;
    bot.on("physicsTick", () => {
      if (!this.alive || this.dead || ++tick % 5) return;
      const now = Date.now();
      if (now - last < 180) return;
      last = now;
      this.monitor();
    });
  }

  // Human feel: with nothing to do, look at the nearest player (they are probably talking to us) or glance around.
  idleGaze(now) {
    if (this.dead || this.goal || this.director.ctl || this.bot.isSleeping || now < (this.nextGaze || 0)) return;
    this.nextGaze = now + 2200 + Math.random() * 4200;
    const me = this.bot.entity;
    if (!me) return;
    const near = Object.values(this.bot.players).map((p) => p.entity).filter((e) => e && e !== me && e.position.distanceTo(me.position) < 14)
      .sort((a, b) => a.position.distanceTo(me.position) - b.position.distanceTo(me.position))[0];
    if (near && Math.random() < 0.75) this.bot.lookAt(near.position.offset((Math.random() - 0.5) * 0.4, (near.height || 1.8) * 0.9, (Math.random() - 0.5) * 0.4), false).catch(() => {});
    else this.bot.look(me.yaw + (Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 0.5, false).catch(() => {});
  }

  // fast-path interrupt: runs ~5x/s while a (non-reflex) action is in flight
  monitor() {
    const cur = this.current || (this.active.size ? { name: "script", reflex: false } : null);
    if (!cur) { this.idleGaze(Date.now()); return; }
    const now = Date.now();
    if (now - this.lastBeat > 60000 && !["follow"].includes(cur.name)) { log("agent", "watchdog: no heartbeat 60s"); this.abortCurrent("hung"); return; }
    // no-progress watchdog: nothing moved, changed in the bag, or got better for a minute => interrupt and unstick
    if (this.digging) this.diggingSince ||= now; else this.diggingSince = 0;
    const digOk = this.digging && now - this.diggingSince < 45000;          // a dig may take a while, but not for ever
    const here = this.bot.entity.position;
    const invSig = this.bot.inventory.items().map((i) => i.name + i.count).sort().join(",");
    if (!this.prog.pos || here.distanceTo(this.prog.pos) > 2.5 || invSig !== this.prog.inv || this.bot.isSleeping || digOk) { this.prog = { pos: here.clone(), inv: invSig, t: now }; }
    else if (now - this.prog.t > 60000 && !STATIONARY.has(cur.name)) {
      log("agent", `watchdog: no progress for 60s during ${cur.name}`);
      this.think("no progress for a minute - interrupting to try something different");
      this.needUnstick = true; this.prog.t = now;
      this.abortCurrent("no_progress");
      return;
    }
    if (cur.reflex || this.bot.vehicle) return;
    let snap; try { snap = observe(this.bot); } catch { return; }
    if (this.running?.watch && this.goal && now - this.lastWatch > 700) {
      this.lastWatch = now;
      try {
        const np = plan(this.reg, this.goal, snap, this.allHints(snap));
        const a = np.action, r = this.running.action;
        const changed = np.done || !a || a.skill !== r.skill || (a.args?.id != null && a.args.id !== r.args?.id);
        const sig = np.done ? "done" : `${a.skill}:${a.args?.id ?? ""}`;
        if (!changed) this.switchCand = null;
        else if (this.switchCand?.sig === sig && now - this.switchCand.t >= 1200) {
          log("agent", `replan-switch: ${r.label} -> ${np.done ? "done" : a?.label}`); this.switchCand = null; this.abortCurrent("replan"); return;
        } else if (this.switchCand?.sig !== sig) this.switchCand = { sig, t: now };
      } catch (e) { log("agent", "watch error", e.message); }
    }
    const rx = reflex(snap, this.reflexCtx(snap));
    if (!rx || (this.suppressed.get(rx.kind) || 0) > now) return;
    // a block is mid-break: finish it before snacking or chasing a distant mob (real danger still pre-empts)
    if (this.digging && ((rx.kind === "eat" && snap.food > 6) || (rx.kind === "defend" && !(this.lastHurt && now - this.lastHurt.t < 3000)))) return;
    const threshold = rx.kind === "eat" || rx.kind === "defend" ? 40 : 80;
    if (rx.priority >= threshold) { this.pendingInterrupt = rx.kind; this.abortCurrent("reflex:" + rx.kind); }
  }

  reflexCtx(snap) {
    const mode = this.goal ? (this.goal.type === "kill" ? "kill" : "task") : this.baseGoal.type === "follow" ? "follow" : "idle";
    let master = null;
    const name = this.master || this.baseGoal.player;
    if (name) master = snap.players.find((p) => p.username?.toLowerCase() === name.toLowerCase()) || null;
    const allies = (snap.players || []).filter((p) => p.username && this.isAgent(p.username)).map((p) => ({ username: p.username, pos: p.pos }));
    const night = snap.dayTime != null && snap.dayTime >= 12700 && snap.dayTime <= 22800 && snap.dimension === "overworld";
    return { lastHurt: this.lastHurt, mode, master, now: snap.t, swimming: !!this.swimming, allies, night };
  }

  // ---------- world hints for the pure planner ----------
  // World hints. Stations (2 cheap lookups) are re-checked on demand; the expensive block-census scans run in the BACKGROUND,
  // in small slices that yield to the event loop, so they never freeze the bot (a 350 ms synchronous scan = 350 ms without movement).
  // Station detection without wide scans: remembered positions are re-verified in O(1), a tiny cube around the bot catches
  // freshly placed ones, and the wide search (findBlock cost ~ radius^3) only runs in the background refresh.
  scanStations() {
    const { bot } = this;
    const is = { crafting_table: (n) => n === "crafting_table", furnace: (n) => n === "furnace", bed: (n) => n.endsWith("_bed") };
    this.stationCache ||= {};
    const out = { crafting_table: false, furnace: false, bed: false };
    for (const k of Object.keys(out)) { const c = this.stationCache[k]; if (c && bot.entity.position.distanceTo(c) <= 36 && is[k](bot.blockAt(c)?.name || "")) out[k] = true; else delete this.stationCache[k]; }   // only stations the skill can still reach (it searches 48)
    for (const k of Object.keys(out)) {                                    // not cached: look for one within 30 blocks (a base's furnace is reused, not rebuilt)
      if (out[k]) continue;
      try {
        const ids = Object.values(bot.registry.blocksByName).filter((blk) => is[k](blk.name)).map((blk) => blk.id);
        const b = ids.length ? bot.findBlock({ matching: ids, maxDistance: 30, count: 1 }) : null;     // id lists use the chunk palette: fast
        if (b) { out[k] = true; this.stationCache[k] = b.position; }
      } catch { /* chunk edge */ }
    }
    return out;
  }

  async refreshWorld() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { bot, reg } = this;
      const idOf = (n) => bot.registry.blocksByName[n]?.id;
      const known = new Set();
      const groups = [
        reg.names.logs.slice(0, 8),
        ["coal_ore", "deepslate_coal_ore", "iron_ore", "deepslate_iron_ore", "copper_ore", "gold_ore", "diamond_ore", "deepslate_diamond_ore", "redstone_ore", "lapis_ore"],
        ["sand", "gravel", "water", "deepslate", "stone", "cobblestone", "dirt", "grass_block", "netherrack", "sandstone", "clay"]
      ];
      for (const g of groups) {
        const ids = g.map(idOf).filter((x) => x != null);
        if (ids.length) for (const p of bot.findBlocks({ matching: ids, maxDistance: 32, count: 32 })) { const b = bot.blockAt(p); if (b) known.add(b.name); }
        await new Promise((r) => setImmediate(r));                       // let the bot move/tick between scans
      }
      this.stationCache ||= {};
      const bedIds = Object.values(bot.registry.blocksByName).filter((b) => b.name.endsWith("_bed")).map((b) => b.id);
      for (const [k, ids] of [["crafting_table", [idOf("crafting_table")]], ["furnace", [idOf("furnace")]], ["bed", bedIds]]) {
        if (this.stationCache[k]) continue;
        const f = bot.findBlock({ matching: ids.filter((x) => x != null), maxDistance: 24 });
        if (f) this.stationCache[k] = f.position;
        await new Promise((r) => setImmediate(r));
      }
      const containerIds = ["chest", "trapped_chest", "barrel"].map(idOf).filter((x) => x != null);
      const chestsNearby = containerIds.length ? bot.findBlocks({ matching: containerIds, maxDistance: 24, count: 4 }).length : 0;
      this.hintCache = { t: Date.now(), v: { ...(this.hintCache.v || {}), stations: this.scanStations(), knownBlocks: known, chestsNearby } };
    } catch (e) { log("hints", "refresh failed:", e.message); }
    finally { this.refreshing = false; }
  }

  hints(snap) {
    const now = Date.now();
    if (!this.hintCache.v) { this.hintCache = { t: 0, v: { stations: this.scanStations(), knownBlocks: new Set(), chestsNearby: 0 } }; setTimeout(() => this.refreshWorld(), 0); }
    else if (now - this.hintCache.t > 6000 && !this.refreshing) setTimeout(() => this.refreshWorld(), 0);
    if (this.hintDirty) { this.hintCache.v.stations = this.scanStations(); this.hintDirty = false; }
    return { ...this.hintCache.v, avoid: this.avoidSet() };
  }

  // fast, per-cycle facts (cheap; unlike the world scan these are never cached)
  liveHints(snap) {
    const radar = {};
    for (const l of this.radar.tracked) { const w = this.radar.where(l); if (w) radar[l] = w; }
    const knownPlayers = Object.keys(this.bot.players).filter((n) => n !== this.bot.username);
    const killed = new Set();
    const since = this.goal?.startedAt || 0;
    for (const [n, t] of this.kills) if (t >= since) killed.add(n);
    const lastHurtBy = this.lastHurt && Date.now() - this.lastHurt.t < 6000 ? this.lastHurt.by : null;
    // ocean / big river between us and where we are going? (the planner turns that into "get a boat first")
    let waterCrossing = null;
    try {
      const g = this.goal;
      let tp = null;
      if (g?.type === "goto") tp = g.pos;
      else if (g?.type === "come") tp = snap.players.find((p) => p.username?.toLowerCase() === g.player.toLowerCase())?.pos || this.radar.where(g.player)?.pos;
      else if (g?.type === "kill") { const n = (g.targets || []).find((t) => !t.startsWith("*")); tp = n && (snap.players.find((p) => p.username?.toLowerCase() === n.toLowerCase())?.pos || this.radar.where(n)?.pos); }
      if (tp && Math.hypot(tp.x - snap.pos.x, tp.z - snap.pos.z) > 16) waterCrossing = require("../skills/boat").waterBetween(this.bot, this.bot.entity.position, new Vec3(tp.x, tp.y ?? snap.pos.y, tp.z));
    } catch { /* sampling is best effort */ }
    const lt = this.lastTorch;
    const recentTorch = !!lt && (Date.now() - lt.t < 25000 || Math.hypot(lt.x - snap.pos.x, lt.z - snap.pos.z) < 7);
    const ripeCrops = this.goal?.type === "harvest" ? require("../skills/farming").ripeCrops(this.bot, 28).length : 0;
    const out = { waterCrossing, ripeCrops, radar, knownPlayers, killed, lastHurtBy, shaftHard: this.shaftHard(snap), recentTorch };
    if ((this.goal?.type === "build" || this.goal?.type === "bridge" || this.goal?.type === "assist" || this.goal?.type === "fixup") && this.goal.spec) {
      const Struct = require("../core/structure");
      const compiled = this.goal._compiled || (this.goal._compiled = Struct.compileStructure(this.goal.spec, this.reg));
      const rec = this.mem.recall(`structure:${this.goal.sid}`);
      if (compiled.ok && rec) {
        const cells = compiled.cells.map((c) => Struct.abs(c, rec.origin));
        const d = Struct.diffStructure(cells, (p) => { const b = this.bot.blockAt(new Vec3(p.x, p.y, p.z)); return b ? { name: b.name, boundingBox: b.boundingBox } : null; });
        out.structureMissing = [...d.missing, ...(this.goal.mode === "repair" ? [] : d.wrong)].map((c) => ({ ...c }));
        out.structureVerified = (this.goal.progress?.verified || 0) >= 1 && ((d.missing.length + (this.goal.mode === "repair" ? 0 : d.wrong.length)) === 0 || !!this.goal.progress?.accepted);
      }
    }
    if (this.goal?.type === "build_house") {
      out.house = this.mem.recall("house");
      out.houseVerified = (this.goal.progress?.verified || 0) >= 1;
      out.houseBlockAt = (p) => { const b = this.bot.blockAt(new Vec3(p.x, p.y, p.z)); return b ? { name: b.name, boundingBox: b.boundingBox } : null; };
    }
    return out;
  }
  // Is there hard rock between us and a target below? (stable across the dig, unlike "what am I standing on")
  shaftHard(snap) {
    const g = this.goal;
    if (!g || (g.type !== "come" && g.type !== "kill")) return undefined;
    const name = g.type === "come" ? g.player : (g.targets || []).find((t) => !t.startsWith("*"));
    const t = name && snap.players.find((p) => p.username?.toLowerCase() === name.toLowerCase());
    if (!t || t.pos.y > snap.pos.y - 3) return undefined;
    const x = Math.floor(snap.pos.x), z = Math.floor(snap.pos.z);
    for (let y = Math.floor(snap.pos.y) - 1; y >= Math.floor(t.pos.y); y--) {
      const b = this.bot.blockAt(new Vec3(x, y, z));
      if (b && HARD_GROUND.test(b.name)) return true;
    }
    return false;
  }
  allHints(snap) { return { ...timed("hints/stations", () => this.hints(snap), 30), ...timed("liveHints", () => this.liveHints(snap), 30) }; }
  avoidSet() {
    const now = Date.now(); const s = new Set();
    for (const [k, t] of this.avoidUntil) { if (t > now) s.add(k); else this.avoidUntil.delete(k); }
    return s;
  }
  invalidateHints() { this.hintDirty = true; }

  // ---------- main loop ----------
  /** A simple instruction for the whole team (come / goto / follow / stop). */
  runOrder(goal) {
    this.autonomy.resume();
    this.director?.cancel("team order");                                         // my own AI errand stops: an order from the team comes first
    this.abortCurrent("team_order"); this.goal = null; this.ledger = []; this.queue = [];
    if (goal.type === "stop") { this.setGoal({ type: "idle" }); this.autonomy.pause(90000); return; }
    if ((goal.type === "follow" || goal.type === "come") && String(goal.player).toLowerCase() === this.bot.username.toLowerCase()) return;   // "follow Wren" is not an order for Wren
    this.setGoal({ ...goal, internal: true, order: true });
  }

  /** Shout for the team when I am in a fight: an alert in the inbox of everyone nearby (they come and fight) plus a short line in chat for the humans. */
  callForHelp(snap, threats) {
    const now = Date.now();
    if (now - (this.lastAlert || 0) < 25000 || !this.team.length || snap.gameMode === "creative") return;
    this.lastAlert = now;
    const team = require("./team");
    const mobs = [...new Set((threats || []).filter(Boolean).map((t) => t.name || "mob"))].slice(0, 3);
    const me = this.bot.entity.position;
    const mates = team.readTeam(this.bot.username, 30000).filter((m) => m.pos && Math.hypot(m.pos.x - me.x, m.pos.z - me.z) < 90);
    for (const m of mates) team.send(this.bot.username, m.name, { type: "alert", text: `${mobs.join(", ") || "mobs"} attacking`, data: { pos: { x: Math.round(me.x), y: Math.round(me.y), z: Math.round(me.z) }, mobs, hp: Math.round(snap.health) } });
    if (mates.length) this.say(`${mobs.join(" and ") || "mobs"} on me at ${Math.round(me.x)} ${Math.round(me.z)}${snap.health <= 10 ? ", low on health" : ""} - need help!`, { noName: true, force: true });
    log("team", `called for help (${mobs.join(",")}) - ${mates.length} teammate(s) alerted`);
    require("../brain/episode").mark(this.bot.username, "help", `${mobs.join(" and ") || "mobs"} attacking${snap.health <= 10 ? ", low on health" : ""} - called for help`);
  }

  /** A teammate shouted: go and fight beside them unless I am in no shape to (low health, asleep, far away) or already helping. */
  respondToAlert(m) {
    const now = Date.now(), snapHp = this.bot.health ?? 20;
    if (!this.alive || this.dead || this.bot.isSleeping || this.bot.game?.gameMode === "creative") return;
    if (snapHp < 10 || now - (this.lastAssist || 0) < 40000) return;
    const me = this.bot.entity.position, p = m.data?.pos;
    if (!p || Math.hypot(p.x - me.x, p.z - me.z) > 90) return;
    this.lastAssist = now;
    log("team", `${m.from} needs help against ${(m.data.mobs || []).join(",")} at ${p.x},${p.z} - going`);
    require("../brain/episode").mark(this.bot.username, "rescue", `running to help ${m.from} (${(m.data.mobs || []).join(", ") || "mobs"})`);
    this.say(`${m.from}, hold on, coming!`, { noName: true, force: true });
    // what I was doing (a build the player ordered...) is NOT forgotten: it goes back on the list right after the fight
    const resume = [this.goal, ...this.queue].filter((g) => g && !String(g.autoKey || "").startsWith("ally:") && !["hideout", "recover", "kill"].includes(g.type) && !(g.auto && !g.order)).map((g) => ({ ...g, fromQueue: false }));
    this.abortCurrent("ally_help"); this.goal = null; this.ledger = [];
    this.queue = [];
    this.setGoals([
      { type: "goto", pos: { x: p.x, y: p.y, z: p.z }, auto: true, internal: true, autoKey: "ally:" + m.from, autoWhy: `help ${m.from} fight ${(m.data.mobs || []).join(", ")}` },
      { type: "kill", targets: ["*hostiles"], auto: true, internal: true, autoKey: "ally:" + m.from, autoWhy: `help ${m.from} fight` },
      ...resume
    ]);
    if (resume.length) log("team", `will go back to ${resume[0].request || resume[0].type} after the fight`);
  }

  // Team link: publish my status for the others and act on what lands in my inbox (see runtime/team.js).
  teamTick() {
    const team = require("./team"), name = this.bot.username, now = Date.now();
    if (!this.bot.entity) return;
    if (now - (this.lastPub || 0) > 4000) {
      this.lastPub = now;
      const g = this.goal, p = this.bot.entity.position;
      let activity = "idle"; try { activity = require("../brain/status").describeActivity(this); } catch { /* status is cosmetic */ }
      team.publishStatus(name, { lastHuman: this.lastHumanCommand || 0, role: this.role, activity, goalType: g?.type || (this.director.ctl ? "freeform" : "idle"), auto: !!g?.auto, pos: { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }, hp: Math.round(this.bot.health ?? 20), food: Math.round(this.bot.food ?? 20), gameMode: this.bot.game?.gameMode, dimension: this.bot.game?.dimension });
    }
    this.banter.tick().catch((e) => log("banter", e.message));
    for (const m of team.drainInbox(name)) {
      if (m.type === "report") { this.teamReports.push({ from: m.from, text: m.text, t: m.t }); if (this.teamReports.length > 20) this.teamReports.shift(); log("team", `report from ${m.from}: ${m.text}`); continue; }
      if (m.type === "reset") { const R = require("./reset"); if (m.text === "tasks" || m.text === "everything") R.resetTasks(this); if (m.text !== "tasks") R.resetAgent(this, m.text === "chat" ? "chat" : "all"); continue; }
      if (m.type === "alert") { this.respondToAlert(m); continue; }
      if (m.type === "chat") { this.banter.onChat(m).catch(() => {}); continue; }
      if (m.type === "order" && m.data?.goal) {                                  // the whole team was told to do something simple: just do it
        log("team", `order from ${m.data.from} via ${m.from}: ${JSON.stringify(m.data.goal)}`);
        this.autonomy.resume(); this.lastHumanCommand = Date.now();
        this.runOrder(m.data.goal);
        continue;
      }
      if (m.type === "project") { log("team", `project request relayed: ${m.text.slice(0, 80)}`); this.projects.onGroupMessage(m.data?.speaker || m.from, m.text, { stableId: true }).catch((e) => log("project", e.message)); continue; }
      this.cmdTimes = this.cmdTimes.filter((t) => now - t < 60000);
      if (this.cmdTimes.length >= 6) { log("team", `dropped command from ${m.from} (too many)`); continue; }
      this.cmdTimes.push(now);
      log("team", `command from ${m.from}: ${m.text}`);
      if (/\?\s*$/.test(m.text)) {                              // a teammate asking ME a question: answer from the board, never turn it into an order
        const board = require("../runtime/project");
        const open = board.active().flatMap((p) => board.tasks(p.id).filter((t) => t.state === "open").map((t) => t.title));
        team.send(name, m.from, { type: "report", text: open.length ? `open jobs on the board: ${open.slice(0, 5).join(", ")} - just take one that fits you` : "nothing open on the board right now" });
        continue;
      }
      require("../brain/chat").handleChat(this, m.from, m.text, { trusted: true }).catch((e) => log("team", "command failed: " + e.message));
    }
  }

  async run() {
    this.alive = true;
    const my = this.loopId = (this.loopId || 0) + 1;                 // a revived loop replaces a wedged one: the old one exits when (if) it ever wakes
    this.cycleAt = Date.now();
    if (!this.loopGuard) this.loopGuard = setInterval(() => {         // last line of defence: ONE cycle may never take minutes, whatever it is awaiting
      if (!this.alive || this.dead || !this.bot.entity) return;
      const stuck = Date.now() - this.cycleAt;
      if (stuck > 240000 && Date.now() > (this.curDeadline || 0) + 30000) { log("agent", `main loop wedged for ${Math.round(stuck / 1000)}s - aborting the action and restarting the loop`); this.abortCurrent("loop_wedged"); this.digging = false; this.cycleAt = Date.now(); this.run(); }
    }, 10000);
    if (!this.teamTimer) this.teamTimer = setInterval(() => { try { this.teamTick(); } catch (e) { log("team", "tick error: " + e.message); } }, 1500);
    if (!this.lagTimer) this.lagTimer = watchLag();
    while (this.alive && my === this.loopId) {
      this.cycleAt = Date.now();
      if (!this.bot.entity || this.dead) { await sleep(300); continue; }
      try { await this.cycle(); }
      catch (e) { if (!isAbort(e)) log("agent", "cycle error:", e.stack || e.message); await sleep(150); }
      await sleep(15); // never spin: whatever a cycle did, the event loop gets air
    }
  }
  stop() { this.alive = false; clearInterval(this.lagTimer); clearInterval(this.teamTimer); clearInterval(this.loopGuard); this.lagTimer = this.teamTimer = this.loopGuard = null; this.abortCurrent("stop"); try { this.radar.stop(); } catch { /* ignore */ } }

  // Situation-aware recovery: climb out of a hole, get to the surface from deep underground, or relocate.
  async unstick() {
    const { enclosure } = require("../skills/vertical");
    const enc = enclosure(this.bot);
    const y = this.bot.entity.position.y;
    const skyBlocked = (() => { for (let dy = 2; dy < 40; dy++) { const b = this.bot.blockAt(this.bot.entity.position.offset(0, dy, 0)); if (b && b.boundingBox === "block") return true; } return false; })();
    this.unstickLevel = (this.unstickLevel || 0) + 1;
    const lvl = this.unstickLevel;
    let action;
    if (enc.walls >= 3 || enc.ceiling) action = { skill: "escape_hole", label: "climb out of this hole" };
    else if (skyBlocked && y < 58) action = { skill: "ascend_surface", label: "dig up to the surface" };
    else action = { skill: "wander", args: { distance: 20 + lvl * 15 }, label: "move somewhere else" };
    this.think(`unstick #${lvl}: ${action.label}`);
    const r = await this.exec(action, true);
    log("agent", `unstick ${action.skill} -> ${r.ok ? "ok" : r.reason}`);
    if (lvl >= 3 && this.brain?.available && !this.director.ctl && this.goal) {
      this.unstickLevel = 0;
      const g = this.goal; this.goal = null;
      this.think("still stuck - asking the AI to find another approach");
      this.director.start(`I keep getting stuck while doing ${JSON.stringify({ ...g, progress: undefined })}. Position y=${Math.round(this.bot.entity.position.y)}. Find a different way to accomplish it.`, this.master);
    }
  }

  async cycle() {
    if (this.needUnstick) { this.needUnstick = false; await this.unstick(); return; }
    this.autonomy.watch();
    const snap = timed("observe", () => observe(this.bot), 40);
    if (Date.now() - (this.lastSight || 0) > 20000) {                       // remember where animals are: hunting then starts from a known place
      this.lastSight = Date.now();
      const G = require("../skills/gather"), seen = new Set();
      for (const e of snap.entities) if (e.kind === "food_animal" && !seen.has(e.name)) { seen.add(e.name); G.noteResource({ agent: this }, [], e.pos, "animal:" + e.name, 40); }
    }
    this.mem.noteVisit(snap.pos);
    this.lastInv = snap.inv; this.lastDayTime = snap.dayTime; this.lastDeathPos = new Vec3(snap.pos.x, snap.pos.y, snap.pos.z); this.lastDim = snap.dimension;

    const rx = reflex(snap, this.reflexCtx(snap));
    if (rx && (this.suppressed.get(rx.kind) || 0) <= Date.now() && !(this.bot.vehicle && !/^(surface|escape_lava|extinguish)$/.test(rx.kind))) { await this.runReflex(rx, snap); return; }     // riding: fighting/fleeing on foot makes no sense
    this.pendingInterrupt = null;

    const goal = this.goal || this.baseGoal;
    const hints = timed("allHints", () => this.allHints(snap), 40);
    // cheap upgrades (better pickaxe/sword/armor) when the materials are already in the bag
    if (!snap.hostiles.some((h) => h.dist < 8) && !(goal.type === "kill")) {
      // the upgrade search is expensive: recompute only when the bag, armor or surroundings changed (or every 10 s)
      const okey = JSON.stringify([snap.inv, snap.armor, snap.hasShield, hints.stations]);
      if (!this.oppCache || this.oppCache.key !== okey || Date.now() - this.oppCache.t > 10000) this.oppCache = { key: okey, t: Date.now(), value: timed("opportunistic", () => opportunistic(this.reg, snap, hints), 50) };
      const up = this.oppCache.value;
      if (up && this.mem.strikesOf(up.key) < 2) {
        this.think(up.label);
        if (up.skill === "place_item" && up.args?.item === "torch") this.lastTorch = { t: Date.now(), x: snap.pos.x, z: snap.pos.z };   // cooldown starts on the attempt, not the success
        const r = await this.exec(up, true);
        if (!r.ok && !r.aborted) this.mem.strike(up.key);
        if (up.skill === "place_item" && up.args?.item === "torch") this.lastTorch = { t: Date.now(), x: snap.pos.x, z: snap.pos.z };
        if (/craft|placeStation/.test(up.skill)) this.invalidateHints();
        if (r.ok) return;
      }
    }
    if (this.baseGoal.type === "idle" && await this.projects.tick(snap)) return;     // a team job comes before my own ideas
    if (!this.goal && this.baseGoal.type === "idle" && await this.autonomy.tick(snap)) return;
    const p = timed("plan", () => plan(this.reg, goal, snap, hints), 50);
    this.stats.replans++;

    if (p.done) {
      if (this.goal) {
        const finished = this.goal;
        // Only the player's MAIN request earns a public reply + "anything else?". Sub-steps run for a bigger task (director),
        // earlier items of a multi-step request and internal jobs (gear recovery) finish quietly - just a whispered thought.
        const internal = finished.sub || finished.internal || this.director.ctl;
        if (internal || this.queue.length) this.think(this.doneMessage(finished).replace(/^./, (c) => c.toUpperCase()));
        else this.say(this.doneMessage(finished) + (this.isAgent(this.master) ? "" : " Is there anything else you need?"), { force: true, report: true });
        log("agent", "goal done:", finished.type);
        if (!finished.sub && !(finished.auto && !finished.project)) require("../brain/episode").mark(this.bot.username, "done", this.doneMessage(finished));
        this.autonomy.onOutcome(finished, "done", true);
        if (finished.type === "come") { this.holdUntil = Date.now() + (finished.order ? 120000 : 240000); this.autonomy.pause(finished.order ? 120000 : 240000); this.think("standing by with you"); }   // "come here" means come and WAIT, not wander off again after a few seconds
        this.lastGoalOutcome = { id: finished.id, text: "done" };
        this.goal = null; this.ledger = []; this.unstickLevel = 0;
        this.advanceQueue();
      }
      else await sleep(250);
      return;
    }
    if (p.blocked) { await this.onBlocked(goal, p, snap); return; }
    if (!p.action) { await sleep(200); return; }

    if (p.outline && p.outline.length >= 3 && this.goal && !this.goal.announced && !this.goal.sub && !this.goal.fromQueue && !this.goal.internal) {
      this.goal.announced = true;
      this.say(`here's my plan: ${p.outline.slice(0, 4).join(" > ")}${p.outline.length > 4 ? " > ..." : ""}`);
      log("plan", p.outline.join(" | "));
    }

    if (this.goal && !goal.ongoing) this.narrate(p.action.label);
    const t0 = Date.now();
    this.running = { action: p.action, plan: p, watch: !!p.watch, t: t0 };
    const res = await this.exec(p.action, false);
    this.running = null;
    if (res.ok && p.action.skill === "chest" && res.data && !(this.goal?.auto || this.goal?.sub || this.goal?.internal)) {
      // say exactly what happened - "I took care of the chest" left the player guessing whether anything moved at all
      const moved = Object.entries(res.data.moved || {}).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ");
      const at = res.data.chest ? ` (chest at ${res.data.chest.x} ${res.data.chest.y} ${res.data.chest.z})` : "";
      if (p.action.args?.action === "put") this.say(moved ? `Put ${moved} into the chest${at}.` : res.data.kept?.length ? `I have nothing to put in except my gear (${res.data.kept.join(", ")}).` : "My bag is empty - nothing to put in.", { force: true });
      else this.say(/^nothing/.test(res.data.list) ? (this.goal?.type === "have" ? "Nothing useful in the chests." : "The chest is empty.") : `Chest had: ${res.data.list}.${moved ? ` I took: ${moved}.` : ""}`, { force: true });
      this.goal.chestReported = true;
    }
    if (this.goal?.spec) this.lastSpec = this.goal.spec;
    if (this.goal && !res.ok && res.reason === "need_materials" && res.data?.need) this.goal.needs = { ...res.data.need };     // the builder says exactly what it lacks: fetch that next
    if (res.progress && this.goal) for (const [k, v] of Object.entries(res.progress)) this.goal.progress[k] = (this.goal.progress[k] || 0) + v;
    if (this.dead) return;
    this.stats.actions++;
    if (/^(craft|placeStation|smelt)$/.test(p.action.skill)) this.invalidateHints();

    // ---- verify against reality ----
    const snap2 = observe(this.bot);
    const after = plan(this.reg, goal, snap2, this.allHints(snap2));
    const sig = `${p.action.skill}:${p.action.label}`;
    const entry = { sig, before: p.remaining, after: after.done ? 0 : after.remaining ?? 1e6, ok: res.ok, reason: res.reason, pos: snap2.pos };
    if (!goal.ongoing && goal.type !== "follow") this.ledger.push(entry);
    if (this.ledger.length > 30) this.ledger.shift();
    log("act", `${sig} -> ${res.ok ? "ok" : "FAIL " + res.reason} (${Date.now() - t0}ms) remaining ${entry.before.toFixed ? entry.before.toFixed(1) : entry.before} -> ${entry.after.toFixed ? entry.after.toFixed(1) : entry.after}`);

    // repetition guard: the same action over and over without getting anywhere is a loop, whatever the skill reports
    const here = this.bot.entity.position;
    (this.recentActs ||= []).push({ sig, t: Date.now(), x: here.x, z: here.z, ok: res.ok, improved: entry.after < entry.before - 1e-6 });
    this.recentActs = this.recentActs.filter((a) => Date.now() - a.t < 120000);
    const same = this.recentActs.filter((a) => a.sig === sig);
    if (same.length >= 5 && !same.some((a) => a.improved)) {
      const span = Math.hypot(Math.max(...same.map((a) => a.x)) - Math.min(...same.map((a) => a.x)), Math.max(...same.map((a) => a.z)) - Math.min(...same.map((a) => a.z)));
      this.think(`I keep doing "${p.action.label}" without getting anywhere - changing approach`);
      log("agent", `repetition guard: ${sig} x${same.length}, moved ${span.toFixed(1)} blocks`);
      this.recentActs = [];
      if (p.action.skill === "mine" && p.action.args?.blocks?.[0]) this.avoidUntil.set(p.action.args.blocks[0], Date.now() + 300000);   // try another source
      this.mem.banCell(this.bot.entity.position, 180000);
      this.needUnstick = true;
    }
    if (!res.ok && !res.aborted) {
      this.mem.strike(sig);
      this.narrate(`${p.action.label} failed: ${String(res.reason || "unknown").replace(/_/g, " ").slice(0, 50)} - adapting`);
    }
    if (!goal.ongoing) await this.checkStall(goal, p, res);
  }

  doneMessage(g) {
    switch (g.type) {
      case "have": return `I have ${Object.entries(g.items).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ")} now.`;
      case "come": return "I'm here with you now.";
      case "goto": return "I've arrived at the spot.";
      case "set_spawn": return g.sleep ? "I'm done at the bed." : "my respawn point is set.";
      case "kill": return "the target is down.";
      case "give": return `I gave you ${g.count} ${g.item.replace(/_/g, " ")}.`;
      case "collect": return "I picked everything up.";
      case "assist": return `I helped finish ${g.owner}'s build${g.progress?.verified ? " and checked it" : ""}.`;
      case "fixup": return "All fixed up - holes filled, junk cleared.";
      case "bridge": return g.progress?.verified ? "I finished the bridge and checked it block by block." : "I built the bridge.";
      case "build": return `I finished building the ${g.spec?.name || "structure"}${g.progress?.verified ? " and checked that every block is in place" : ""}.`;
      case "tell": return `I passed that on to ${g.agent}.`;
      case "harvest": return "I harvested the crops and replanted them.";
      case "cook": return g.deliverTo ? "the food is cooked and handed over." : "the food is cooked.";
      case "place": return `I placed the ${String(g.item || "block").replace(/_/g, " ")}.`;
      case "chest": return g.chestReported ? "Done with the chest." : "I took care of the chest.";
      case "shelter": return "I'm sealed in safely.";
      case "recover": return "I picked up what I could of my dropped gear.";
      default: return "I finished that.";
    }
  }

  // ---------- execution ----------
  async exec(action, isReflex) {
    const fn = skills[action.skill];
    if (!fn) return { ok: false, reason: "no_skill:" + action.skill };
    const ctl = new AbortController();
    const cur = { name: action.skill, ctl, reflex: isReflex };
    this.current = cur;
    this.active.add(ctl);
    this.lastBeat = Date.now();
    this.prog = { pos: null, inv: "", t: Date.now() };     // a fresh action gets a fresh no-progress clock
    const ctx = { bot: this.bot, reg: this.reg, mem: this.mem, agent: this, signal: ctl.signal, beat: () => { this.lastBeat = Date.now(); } };
    const limit = SKILL_TIMEOUT[action.skill] || 120000;
    this.curDeadline = Date.now() + limit;
    const timer = setTimeout(() => ctl.abort(), limit);
    try {
      // A skill that ignores its abort signal (a dig the server never answers, a promise that never settles) must not hold the whole
      // agent hostage: 4 s after an abort the cycle moves on whether or not the skill noticed. (This is what froze Vesper and Wren.)
      let giveUp;
      const orphaned = new Promise((_, rej) => { giveUp = () => setTimeout(() => rej(Object.assign(new Error("skill ignored abort"), { name: "AbortError", orphaned: true })), 4000); ctl.signal.addEventListener("abort", giveUp, { once: true }); });
      const r = await Promise.race([fn(ctx, action.args || {}), orphaned]);
      return r || { ok: true };
    } catch (e) {
      if (e.orphaned) log("agent", `skill ${action.skill} ignored its abort - moving on without it`);
      if (isAbort(e)) return { ok: false, aborted: true, reason: "aborted" };
      log("agent", `skill ${action.skill} threw:`, e.stack || e.message);
      return { ok: false, reason: "exception:" + e.message };
    } finally {
      clearTimeout(timer);
      this.active.delete(ctl);
      if (ctl.signal.aborted) { this.digging = false; try { this.bot.stopDigging(); } catch { /* not digging */ } }
      for (const c of ["forward", "back", "left", "right", "sprint", "jump"]) this.bot.setControlState(c, false);
      try { this.bot.pathfinder.stop(); } catch { /* not pathing */ }
      if (this.current === cur) this.current = null;
    }
  }

  async runReflex(rx, snap) {
    this.stats.reflexes++;
    let action = null;
    switch (rx.kind) {
      case "escape_lava": action = { skill: "escape_lava" }; break;
      case "extinguish": action = { skill: "extinguish" }; break;
      case "surface": action = { skill: "surface" }; break;
      case "eat": action = { skill: "eat", args: { item: rx.item } }; break;
      case "evade_creeper": action = { skill: "flee", args: { from: [{ pos: rx.target.pos }] } }; break;          // a creeper is outrun, not out-fought: get beyond its blast, then deal with it from range
      case "defend": action = { skill: "fight", args: { id: rx.target.id, opts: { timeoutMs: 30000, giveUpHealth: snap.gameMode === "creative" ? 0 : 7 } } }; if (!rx.ally) this.callForHelp(snap, [rx.target]); break;       // retreat at 7 hp instead of fighting to the death
      case "outnumbered": {
        this.callForHelp(snap, rx.threats || [rx.target]);
        const blocks = ["dirt", "cobblestone", "cobbled_deepslate", "netherrack", "stone", "oak_planks"].reduce((n, k) => n + (snap.inv[k] || 0), 0);
        const nearest = Math.min(...(rx.threats || [rx.target]).map((t) => t.dist));
        // walling in takes a couple of seconds: only when they are not on top of us yet (it failed under attack and killed two agents); else fight with the back to a wall
        action = blocks >= 9 && nearest > 4.5 && !this.mem.strikesOf("reflex:shelter") ? { skill: "shelter" } : { skill: "fight", args: { id: rx.target.id, opts: { timeoutMs: 20000, giveUpHealth: 5 } } };
        break;
      }
      case "flee_or_block": {
        this.callForHelp(snap, rx.threats || []);
        const blocks = ["dirt", "cobblestone", "cobbled_deepslate", "netherrack", "stone", "oak_planks"].reduce((n, k) => n + (snap.inv[k] || 0), 0);
        const threats = rx.threats || [];
        const nearest = Math.min(...threats.map((t) => t.dist), 99);
        const FAST = /^(spider|cave_spider|zombie|husk|drowned|zombie_villager|vindicator|piglin_brute|hoglin|zoglin|wither_skeleton)$/;   // you do not outrun these in the open
        if (blocks >= 9 && nearest > 4.5 && !this.mem.strikesOf("reflex:shelter")) action = { skill: "shelter" };
        else if (threats.length && threats.some((t) => FAST.test(t.name || "")) && threats[0]) action = { skill: "fight", args: { id: threats.sort((a, b) => a.dist - b.dist)[0].id, opts: { timeoutMs: 25000, giveUpHealth: 0 } } };   // cornered by something faster: eat what helps and fight on
        else action = { skill: "flee", args: { from: threats.map((t) => ({ pos: t.pos })) } };
        break;
      }
    }
    if (!action) { this.suppressed.set(rx.kind, Date.now() + 3000); return; }
    log("reflex", rx.kind, rx.target?.name || "");
    const t0 = Date.now();
    const res = await this.exec(action, true);
    if (!res.ok && !res.aborted) {
      const n = this.mem.strike("reflex:" + rx.kind);
      if (n >= 2) { this.suppressed.set(rx.kind, Date.now() + 8000); }
    } else this.mem.clearStrikes("reflex:" + rx.kind);
    // a reflex that "succeeds" instantly (already sealed in, nothing to do) must not re-fire in a hot loop
    if (Date.now() - t0 < 400) this.suppressed.set(rx.kind, Date.now() + 2500);
    if (rx.kind === "flee_or_block" && res.ok) {
      // sealed in / out of reach: recover (eat if possible) instead of re-triggering
      const food = this.reflexFood(snap);
      if (food) await this.exec({ skill: "eat", args: { item: food } }, true);
      else await sleep(1000);
    }
    await sleep(60); // always yield to the event loop between reflexes
  }

  reflexFood(snap) { const { bestFood } = require("../core/reflex"); return snap.food < 20 ? bestFood(snap.inv, { allowRaw: false }) : null; }

  // ---------- escalation ----------
  async onBlocked(goal, p, snap) {
    log("agent", "blocked:", p.blocked);
    if (this.goal) this.lastGoalOutcome = { id: this.goal.id, text: `blocked: ${p.blocked}` };
    if (this.goal?.auto) {                                   // my own idea did not work out: note it, move on, never ask anybody about it
      this.autonomy.onOutcome(this.goal, `blocked: ${p.blocked}`, false);
      this.goal = null; this.ledger = [];
      return;
    }
    // the typed planner can't do it directly: hand the problem to the AI, which can find another way or write a script
    if (this.brain?.available && this.goal && !this.director.ctl && goal.type !== "freeform") {
      this.think(`my planner can't do this directly (${p.blocked}) - asking the AI to find another way`);
      const g = this.goal; this.goal = null;
      this.director.start(`Accomplish this goal ${JSON.stringify({ ...g, progress: undefined })}. The built-in planner reported: ${p.blocked}. Find another way (different resources, a workaround, or a script).`, this.master);
      return;
    }
    this.say(`I can't do that: ${p.blocked}. Can you help me with that, or shall I do something else?`, { force: true, report: true });
    this.goal = null;
    if (!this.advanceQueue()) this.queue = [];
    await sleep(300);
  }

  async checkStall(goal, p, res) {
    const a = assess(this.ledger);
    if (a.state === "ok") return;
    const level = rung(this.interventions++);
    log("agent", `stall (${a.state}) sig=${a.sig || a.sigs} reason=${a.reason} -> ${level}`);
    const last = p.action;
    switch (level) {
      case "retry": {
        const enc = require("../skills/vertical").enclosure(this.bot);
        log("agent", `unstick: enclosure walls=${enc.walls} ceiling=${enc.ceiling}`);
        await this.exec({ skill: enc.walls >= 3 || enc.ceiling ? "escape_hole" : "wander", args: {} }, true).catch(() => {});
        break;
      }
      case "avoid_source":
        if (last.skill === "mine" && last.args?.blocks?.[0]) this.avoidUntil.set(last.args.blocks[0], Date.now() + 240000);
        this.invalidateHints();
        break;
      case "relocate":
        this.mem.banCell(this.bot.entity.position, 120000);
        await this.relocate(80);
        break;
      case "ask_advisor": {
        if (this.brain?.available && !this.director.ctl && !this.goal?.auto) {          // (my own / team jobs keep their identity: no hand-over to the script planner)
          this.think("normal planning is stuck - switching to AI script mode");
          const text = `Accomplish this goal ${JSON.stringify({ ...goal, progress: undefined })}. The standard planner got stuck on "${p.action?.label}" (${a.reason || a.state}); find a different approach.`;
          this.director.start(text, this.master);
          this.ledger = []; this.interventions = 0;
          return;
        }
        await this.relocate(120);
        break;
      }
      default:
        if (this.goal?.auto) {                               // autonomous work: drop it quietly, the journal remembers it failed
          this.autonomy.onOutcome(this.goal, `stuck on ${p.action?.label} (${a.reason || a.state})`, false);
          this.goal = null; this.ledger = []; this.interventions = 0;
          break;
        }
        this.say(`I'm stuck on "${p.action?.label}" (${a.reason || a.state}) and giving up on it. What would you like me to do instead?`, { force: true, report: true });
        if (this.goal) this.lastGoalOutcome = { id: this.goal.id, text: `gave up: stuck on ${p.action?.label} (${a.reason || a.state})` };
        this.goal = null; this.ledger = []; this.interventions = 0;
        this.advanceQueue();
    }
    this.ledger = this.ledger.slice(-2);
  }

  async relocate(dist) {
    const { explore } = require("../skills/gather");
    const ctl = new AbortController();
    this.current = { name: "relocate", ctl, reflex: true };
    this.active.add(ctl);
    const ctx = { bot: this.bot, reg: this.reg, mem: this.mem, agent: this, signal: ctl.signal, beat: () => { this.lastBeat = Date.now(); } };
    try { await explore(ctx, { distance: dist, why: "relocating after stall" }); }
    catch (e) { if (!isAbort(e)) log("agent", "relocate error", e.message); }
    finally { this.active.delete(ctl); if (this.current?.ctl === ctl) this.current = null; }
  }
}

module.exports = { Agent };
