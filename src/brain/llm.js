// The AI (any provider - see providers.js) is used sparingly: fuzzy chat -> a validated goal, and "what now?" advice when the bot is genuinely stuck.
// It never writes code and never chooses individual steps; the deterministic planner does that.
const { resolveItem } = require("../core/items");
const { log } = require("../runtime/util");

const GOAL_DOC = `Allowed goals (JSON "goal" field), use null when the player is only chatting or asking a question:
- {"type":"have","items":{"<minecraft_item_id>":<count>}}  get/craft/mine/smelt/collect items into MY inventory
- {"type":"give","player":"<name>","item":"<minecraft_item_id>","count":<n>}  get an item and hand it to a player
- {"type":"kill","targets":["<player name>"|"*players"|"*hostiles"|"<mob name e.g. zombie>"]}
- {"type":"goto","pos":{"x":<n>,"y":<n or null>,"z":<n>}}  walk to coordinates (use remembered places when the player says "there", "the location I gave", "base" ...)
- {"type":"follow","player":"<name>"}   {"type":"come","player":"<name>"}   {"type":"stop"}
- {"type":"chest","action":"take|put|list","items":"all" or {"<item_id>":<count>},"where":"here|looking|null"}  open a chest and take/put/list items (NEVER break chests). where:"here" = the chest next to the player ("the chest here"), "looking" = the chest they look at; null = nearest to me
- {"type":"shelter"}  wall myself in with blocks right now (hide / take cover from mobs)
- {"type":"place","item":"chest|crafting_table|furnace|torch|bed|<item_id>","near":"<player or null>"}  get that item if needed and place it down
- {"type":"cook","count":<n>,"deliverTo":"<player>|null"}  cook meat (hunt, smelt) and optionally hand it to a player
- {"type":"harvest"}  harvest all ripe crops nearby and replant them (farm upkeep)
- {"type":"tell","agent":"<teammate name>","command":"<what they should do, in plain words>"}  give a TEAMMATE AI agent an order (they hear "@Name command"). Use it to lead/coordinate the team; they report back to you. TO MAKE A TEAMMATE HELP WITH A BUILD: return goals in this order: first the tell (command like "help <me> build the <thing>" - they then join MY blueprint via assist), THEN your own build goal. Never ask them to build their own copy.
- {"type":"collect"}  pick up dropped items nearby
- {"type":"build","request":"<EXACTLY what to build with every detail the player gave: storeys, size, material, style, purpose>","where":"here|facing|looking|at|null","pos":{"x":..,"z":..},"mode":"new|repair|renovate"}  ANY structure: house (any number of storeys), farm, tower, wall, pool, statue... a designer plans it and the bot builds it and verifies it. WHERE: "here" = on the spot the player stands ("where I am standing", "right here", "on me"); "facing" = right in front of the player ("in front of me", "next to me"); "looking" = the spot the crosshair rests on, possibly far ("there", "where I am looking", "over there"); "at" + pos = explicit coordinates the player gave; null = no place given (the bot picks a nice flat spot near itself). ALWAYS set where when the player says anything about the place. MODE: "new" (default) builds something new; "repair" = fix holes/damage of an EXISTING building ("fix this house", "repair the wall"); "renovate" = change/upgrade an EXISTING building ("renovate this", "add a second floor", "make it stone") - for both, where is the building the player means ("looking" when they point at it, "here" when they stand in it) and request says what to do.
- {"type":"bridge","where":"facing|nearest","width":3,"material":"<block or null>"}  build a bridge across water: the bot FINDS the water itself using the player's position/facing (see SPATIAL context) and bridges at the narrowest sensible crossing. "facing" = the water in front of the player ("this river", "across there"), "nearest" = the closest water. NEVER use build for bridges.
- {"type":"assist","owner":"<teammate>"}  JOIN a teammate AI's build in progress: build the SAME blueprint at the SAME spot together with them (the owner designs; you help place blocks). Use this when asked to help/assist with someone's build; never design a second copy.
- {"type":"fixup","repair":true|false,"clean":true|false,"fill":true|false,"where":"here|looking|null"}  FIX UP an area/building: repair = fill holes in buildings (walls/roof/floor, missing doors), clean = remove junk blocks (dirt/gravel/scaffold) from inside, on and around buildings, fill = fill holes/pits in the ground. Use for "fill the holes", "clean up the dirt", "tidy up around the house", "fix the ground". (For a single building's repair the build goal with mode repair also works.)
- {"type":"mount","target":"happy_ghast|boat|horse|minecart|nearest","withPlayer":"<player whose ride to join>|null"}  get on a rideable (a ghast without a harness gets one first). "ride with me" = withPlayer the speaker.
- {"type":"dismount"}  get off whatever I am riding (lands first when in the air)
- {"type":"drive","to":{"x":..,"z":..}|null,"player":"<player to fly to>|null","land":true|false}  fly the happy ghast I sit on (I mount one first if needed): to coordinates or to a player; land:true = come down and get off there
- {"type":"set_spawn","sleep":true|false}  (go to a bed and set the respawn point; sleep:true to actually sleep when it is night)
- {"type":"freeform","text":"<the task in plain words>"}  ONLY when no typed goal above can express the task (multi-step puzzles, custom builds, unusual requests); a planner agent then works it out step by step`;

class Brain {
  /** config: { provider, apiKey, model, strongModel, baseURL } (see providers.resolveConfig), or a resolved config from .env when omitted. */
  constructor(config = null) {
    const { resolveConfig, createProvider } = require("./providers");
    const cfg = config && config.kind ? config : resolveConfig();
    this.provider = null; this.providerName = cfg.name || null; this.setupError = cfg.error || null;
    this.model = cfg.model || null;
    this.strongModel = cfg.strongModel || null;       // the careful model: code, designs, critique (slower, much better)
    if (!cfg.error) {
      try { this.provider = createProvider(cfg); }
      catch (e) { this.setupError = `${cfg.name} SDK unavailable: ${e.message}`; log("llm", this.setupError); }
    }
  }
  get label() { return this.provider ? `${this.providerName}: fast ${this.model}${this.strongModel ? ", strong " + this.strongModel : ""}` : `off (${this.setupError || "no provider"})`; }
  // `available` is false while the account is out of budget, EXCEPT that every 20 s one request may probe: the moment the budget is
  // raised (or the quota resets) the next chat message works again, no restart and no 30-minute wait.
  // Quota is tracked PER MODEL: the strong model (pro) can be out of quota while the fast one works fine - that must degrade the
  // quality, not switch the AI off. A blocked model is probed again after a short wait, so recovery needs no restart.
  state(model) { return (this.q ||= {})[model] ||= { until: 0, step: 0 }; }
  isBlocked(model) { const q = this.state(model); return Date.now() < q.until; }
  get blockedUntil() { return this.state(this.model).until; }                 // (chat/status code asks about the fast model)
  get available() { return !!this.provider && !this.isBlocked(this.model); }
  noteQuota(e, model = this.model) {
    if (!/spending cap|exceeded your (current )?quota|billing|quota.*exceeded|insufficient.*(quota|credit|balance)|credit balance is too low|insufficient_quota|payment required|\b402\b/i.test(String(e?.message || e))) return false;
    const q = this.state(model);
    if (Date.now() >= q.until) log("llm", `${model}: budget/quota exhausted (${String(e.message).replace(/\s+/g, " ").slice(0, 100)}) - ${model === this.model ? "degraded mode" : "falling back to " + this.model}, probing again soon`);
    q.step = Math.min(q.step + 1, 4);
    q.until = Date.now() + (model === this.model ? [20000, 20000, 30000, 45000, 60000][q.step] : [60000, 120000, 300000, 600000, 900000][q.step]);
    return true;
  }
  noteOk(model = this.model) { const q = this.state(model); if (q.until) log("llm", `${model} is back`); q.until = 0; q.step = 0; }

  async json(prompt, { timeoutMs = 11000, level = "LOW", strong = false } = {}) {
    if (!this.provider) throw new Error("llm_unavailable");
    if (strong && this.strongModel && !this.isBlocked(this.strongModel)) {
      try { return await this.json1(prompt, { timeoutMs: Math.round(timeoutMs * 1.6), level, model: this.strongModel }); }
      catch (e) { log("llm", `strong model ${this.strongModel} failed (${String(e.message).replace(/\s+/g, " ").slice(0, 80)}) - using ${this.model}`); }
    }
    if (this.isBlocked(this.model)) throw new Error("llm_budget_exhausted");
    return this.json1(prompt, { timeoutMs, level, model: this.model });
  }

  // many agents share one API key: rate-limit / overload answers are retried with jitter instead of being treated as "AI unavailable"
  async json1(prompt, opts) {
    for (let attempt = 0; ; attempt++) {
      try { const r = await this.json2(prompt, opts); this.noteOk(opts.model); return r; }
      catch (e) {
        if (this.noteQuota(e, opts.model)) throw e;
        if (attempt >= 2 || !/\b(429|500|502|503|504|529)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|rate.?limit|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(String(e.message))) throw e;
        await new Promise((r) => setTimeout(r, 1200 + Math.random() * 2500 * (attempt + 1)));
      }
    }
  }

  async json2(prompt, { timeoutMs, level, model }) {
    const { parseJson } = require("./providers");
    return parseJson(await this.provider.generate({ model, prompt, timeoutMs, level }));
  }

  /** Chat -> {goal|null, reply}. Goal is validated; unknown items/types are rejected. */
  async interpret({ speaker, message, history, status, reg, memory, team = [], fromAgent = false, space = "" }) {
    const prompt = `You are ${status.botName}, a Minecraft co-op companion bot talking to "${speaker}".
Player said: "${message}"
Conversation so far (oldest first; includes my own replies):\n${history.slice(-20).map((h) => `${h.speaker}: ${h.text}`).join("\n") || "(none)"}
Places mentioned earlier (use these for "there", "the location I gave", "base"...): ${memory?.places || "none"}
Known landmarks (measured/declared facts, newest first - the ONLY coordinates you may use besides ones in the player's message and the SPATIAL context; if a place is not listed, ask or use a typed goal that finds it, NEVER invent coordinates): ${memory?.landmarks || "none"}
Goals I was given recently: ${memory?.goals || "none"}
SPATIAL context (live, measured by the bot - trust it over guesses): ${space || "unknown"}
My own position: ${status.pos || "unknown"}
My home: ${memory?.home || "unknown"} ("home"/"base" means this unless a place said otherwise)
Teammate AI agents in this world: ${team.length ? team.join(", ") : "none"}${fromAgent ? `\nIMPORTANT: "${speaker}" is a teammate AI agent, not a human. If it is reporting that it finished something or only chatting/thanking, DO NOT reply and DO NOT start anything (return goal null and an empty reply) unless it clearly orders you to do something (then do it) or you are the leader and the report means the next team step should be delegated (use tell).` : ""}
Game mode: ${status.gameMode || "survival"}${status.gameMode === "creative" ? " (CREATIVE: any item can be taken instantly - a request for items is simply {type:have}; never plan gathering; the bot can fly and is invulnerable)" : ""}
My status: hp ${status.hp}/20, food ${status.food}/20, activity: ${status.activity}, inventory: ${status.inventory}, players online: ${status.players}.
${GOAL_DOC}
You are the brain that decides what the bot does for EVERY request. Map the request onto the closest typed goal(s) when one truly fits; if the request has several parts, return them in order in "goals" (e.g. "come home to sleep" = goto home, then set_spawn with sleep:true); if NO typed goal can do it (anything custom, creative, unusual, or a multi-step puzzle) return a single freeform goal and a script-writing planner will take over. Never refuse; never say you cannot - use freeform. Understand typos and slang. If the request is a task, choose the single best goal. If it refers to earlier chat ("do that again", "build it"), resolve it from the history.
If the player asks for several things in order, return them in "goals" (array, in order) instead of "goal".
Reply ONLY JSON: {"goal": <goal or null>, "goals": [<goal>...] (optional), "reply": "<=60 chars friendly gamer reply, no emojis, empty if nothing to say"}`;
    let out;
    try { out = await this.json(prompt); } catch (e) { log("llm", "interpret failed:", e.message); return null; }
    const list = (Array.isArray(out?.goals) ? out.goals : []).map((g) => validateGoal(g, { reg, speaker, team })).filter(Boolean);
    return { goal: validateGoal(out?.goal, { reg, speaker, team }), goals: list, reply: typeof out?.reply === "string" ? out.reply.slice(0, 120) : "" };
  }

  /** Stuck advice: which resources to avoid / what to tell the player. */
  async advise({ goal, p, ledger, snap }) {
    const prompt = `A Minecraft bot is stuck. Goal: ${JSON.stringify(goal)}. Planned action: ${p?.action?.label}. Recent attempts (newest last): ${JSON.stringify(ledger.map((e) => ({ a: e.sig, ok: e.ok, why: e.reason })))}.
Position y=${Math.round(snap.pos.y)}, dimension ${snap.dimension}, inventory ${JSON.stringify(snap.inv).slice(0, 400)}.
Reply ONLY JSON: {"avoidBlocks":["<block ids that are not working>"], "say":"<=60 chars message to the player or empty"}`;
    try { return await this.json(prompt, { timeoutMs: 7000 }); } catch { return null; }
  }
}

function validateGoal(g, opts = {}) {
  const { reg, speaker } = opts;
  if (!g || typeof g !== "object" || !g.type) return null;
  switch (g.type) {
    case "have": {
      if (!g.items || typeof g.items !== "object") return null;
      const items = {};
      for (const [k, v] of Object.entries(g.items)) {
        const name = reg.hasItem(k) ? k : resolveItem(reg, k);
        const n = Math.max(1, Math.min(2304, parseInt(v, 10) || 1));
        if (name) items[name] = n;
      }
      return Object.keys(items).length ? { type: "have", items } : null;
    }
    case "give": {
      const item = reg.hasItem(g.item) ? g.item : resolveItem(reg, g.item);
      return item ? { type: "give", player: g.player || speaker, item, count: Math.max(1, Math.min(2304, parseInt(g.count, 10) || 1)) } : null;
    }
    case "kill": return Array.isArray(g.targets) && g.targets.length ? { type: "kill", targets: g.targets.map(String).slice(0, 8) } : null;
    case "goto": { const p = g.pos || {}; const n = (v) => (v == null ? null : Number(v)); return Number.isFinite(n(p.x)) && Number.isFinite(n(p.z)) ? { type: "goto", pos: { x: n(p.x), y: Number.isFinite(n(p.y)) ? n(p.y) : null, z: n(p.z) } } : null; }
    case "follow": case "come": return { type: g.type, player: g.player || speaker };
    case "freeform": return typeof g.text === "string" && g.text.trim() ? { type: "freeform", text: g.text.slice(0, 300) } : null;
    case "chest": return { type: "chest", action: ["take", "put", "list"].includes(g.action) ? g.action : "take", items: g.items === "all" || !g.items ? "all" : g.items, ...(["here", "looking"].includes(g.where) ? { where: g.where } : {}) };
    case "set_spawn": return g.sleep ? { type: "set_spawn", sleep: true } : { type: "set_spawn" };
    case "build": {
      if (typeof g.request !== "string" || !g.request.trim()) return null;
      const out = { type: "build", request: g.request.slice(0, 400) };
      if (["here", "facing", "looking", "at"].includes(g.where)) out.where = g.where;
      if (g.mode === "repair" || g.mode === "renovate") { out.mode = g.mode; if (!out.where) out.where = "looking"; }
      const px = Number(g.pos?.x), pz = Number(g.pos?.z);
      if (g.where === "at" && Number.isFinite(px) && Number.isFinite(pz)) out.pos = { x: Math.floor(px), y: Number.isFinite(Number(g.pos?.y)) ? Math.floor(Number(g.pos.y)) : null, z: Math.floor(pz) };
      else if (g.where === "at") delete out.where;
      return out;
    }
    case "bridge": return { type: "bridge", where: g.where === "nearest" ? "nearest" : "facing", width: Math.max(1, Math.min(7, parseInt(g.width, 10) || 3)), material: typeof g.material === "string" ? g.material : null, requester: speaker, request: "bridge" };
    case "assist": { const o = opts.team?.find((t) => t.toLowerCase() === String(g.owner).toLowerCase()); return o ? { type: "assist", owner: o, request: "assist" } : null; }
    case "harvest": return { type: "harvest" };
    case "hideout": return { type: "hideout" };
    case "fixup": return { type: "fixup", repair: g.repair !== false, clean: g.clean !== false, fill: g.fill !== false, where: ["here", "looking"].includes(g.where) ? g.where : "here", request: "fix-up" };
    case "mount": return { type: "mount", target: typeof g.target === "string" ? g.target.slice(0, 30) : null, withPlayer: typeof g.withPlayer === "string" ? g.withPlayer : null };
    case "dismount": return { type: "dismount" };
    case "drive": { const x = Number(g.to?.x), z = Number(g.to?.z); const to = Number.isFinite(x) && Number.isFinite(z) ? { x, y: Number.isFinite(Number(g.to?.y)) ? Number(g.to.y) : null, z } : null; return to || g.player ? { type: "drive", to, player: g.player || null, land: !!g.land } : null; }
    case "tell": return opts.team?.some((t) => t.toLowerCase() === String(g.agent).toLowerCase()) && typeof g.command === "string" && g.command.trim() ? { type: "tell", agent: opts.team.find((t) => t.toLowerCase() === String(g.agent).toLowerCase()), command: g.command.slice(0, 200) } : null;
    case "shelter": return { type: "shelter" };
    case "place": { const item = reg.hasItem(g.item) ? g.item : resolveItem(reg, g.item); return item ? { type: "place", item, near: g.near || speaker } : null; }
    case "cook": return { type: "cook", count: Math.max(1, Math.min(64, parseInt(g.count, 10) || 8)), deliverTo: g.deliverTo || null };
    case "stop": case "collect": return { type: g.type };
    default: return null;
  }
}

module.exports = { Brain, validateGoal, GOAL_DOC };
