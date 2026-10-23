// Chat router: who is talking to the bot, and what goal does that translate to.
// Order: local intent parser (instant) -> local status answers -> LLM interpretation -> help text.
const { parseIntent, parseSequence } = require("./intent");
const { answerStatus, describeActivity, invSummary } = require("./status");
const { observe } = require("../runtime/observe");
const { log } = require("../runtime/util");

const addressed = (agent, msg) => {
  const n = agent.bot.username.toLowerCase();
  const l = msg.toLowerCase();
  if (l.includes(n)) return true;
  if (process.env.MC_GENERIC_TRIGGER === "false") return false;      // several agents: only the bot's own name wakes it
  return /^(ai|bot)\b[,:\s]/.test(l) || /\b(hey|yo|hi)\s+(ai|bot)\b/.test(l);
};

// Multi-agent safety: other AI agents (MC_AGENT_NAMES=Alice,Bob) only trigger this bot with an explicit "@<BotName> <command>";
// plain replies like "<BotName>, I finished - anything else?" are ignored so two agents can never chat in a loop.
// Every speaker is also rate-limited.
const AGENTS = (process.env.MC_AGENT_NAMES || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const recentBySpeaker = new Map();
function tooChatty(speaker) {
  const now = Date.now();
  const list = (recentBySpeaker.get(speaker) || []).filter((t) => now - t < 60000);
  list.push(now); recentBySpeaker.set(speaker, list);
  return list.length > 8;
}

const recordChat = (agent, speaker, text) => agent.ctxStore.addChat(speaker, text);

// Pin "here" / "in front of me" / coordinates to a concrete spot NOW, from where the requester actually is and faces.
// A coordinate the AI produced must come from somewhere real: the player's own words, a known landmark, a player/bot position.
// Otherwise it is a hallucination and the bot would walk off to nowhere.
function groundGoals(agent, speaker, message, goals) {
  const { extractPlaces } = require("./context");
  const said = extractPlaces(message, speaker);
  const real = [...said, ...agent.ctxStore.places];
  const home = agent.ctxStore.facts.house?.origin, bed = agent.ctxStore.facts.bed;
  if (home) real.push(home); if (bed) real.push(bed);
  for (const p of Object.values(agent.bot.players)) if (p.entity) real.push(p.entity.position);
  real.push(agent.bot.entity.position);
  const ok = (pos) => !pos || pos.x == null || real.some((r) => Math.hypot(r.x - pos.x, r.z - pos.z) <= 4) || agent.know.grounds(pos, 4);
  return goals.filter((g) => {
    const pos = g.type === "goto" ? g.pos : g.type === "build" && g.where === "at" ? g.pos : null;
    if (ok(pos)) return true;
    log("chat", `ungrounded coordinates rejected: ${JSON.stringify(pos)}`);
    agent.say("I don't know where that is - give me coordinates or tell me a place I know.", { to: speaker });
    return false;
  });
}

async function anchorGoals(agent, speaker, goals) {
  const sp = require("../runtime/spatial");
  for (const g of goals) {
    if (g.type === "fixup") { const a = sp.resolveAnchor(agent, speaker, g.where || "here"); if (a) g.anchor = a; continue; }
    if (g.type === "chest" && g.where) { const a = sp.resolveAnchor(agent, speaker, g.where); if (a) g.anchor = a; continue; }
    if ((g.type !== "build" && g.type !== "bridge") || (g.type === "build" && !g.where)) continue;
    if (g.type === "bridge") { g.requester = g.requester || speaker; continue; }       // the bridge planner measures the water itself
    if (g.where !== "at" && !agent.bot.players[speaker]?.entity) await agent.radar.askRotation(speaker).catch(() => null);
    const a = sp.resolveAnchor(agent, speaker, g.where, g.where === "at" ? g.pos : null);
    if (a) { g.anchor = a; log("chat", `anchor for "${g.request}": ${JSON.stringify(a)}`); }
    else agent.think(`I couldn't tell where ${speaker} is (no position fix) - building near me instead`);
  }
}

function applyGoal(agent, speaker, intent, { quiet = false } = {}) {
  agent.master = speaker;
  if (intent.type === "freeform") { agent.director.start(intent.text, speaker); return; }
  agent.director?.cancel("new request");
  if (intent.type === "stop") { agent.clearGoal(); if (!agent.isAgent(speaker)) agent.autonomy.pause(90000); agent.setGoal({ type: "idle" }); agent.say("I stopped. What should I do now?", { to: speaker }); return; }
  if (intent.type === "kill" && intent.targets.includes("*players")) intent.exclude = [speaker];
  agent.setGoal(intent);
  const say = {
    follow: `Following ${speaker}.`,
    come: null,
    goto: `Heading to ${intent.pos ? [intent.pos.x, intent.pos.y, intent.pos.z].filter((v) => v != null).map(Math.round).join(" ") : ""}.`,
    have: `On it: ${intent.items ? Object.entries(intent.items).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ") : ""}`,
    kill: `Hunting ${(intent.targets || []).join(", ").replace("*players", "everyone").replace("*hostiles", "hostiles")}.`,
    give: `Getting ${intent.count} ${String(intent.item).replace(/_/g, " ")} for you.`,
    build_house: "Building a house.", set_spawn: "Setting up a bed.", collect: "Collecting drops."
  }[intent.type];
  if (say && !quiet) agent.say(say, { to: speaker });
}

function applyGoals(agent, speaker, goals) {
  agent.master = speaker;
  agent.director?.cancel("new request");
  const hasStop = goals.some((g) => g.type === "stop");
  if (hasStop) return applyGoal(agent, speaker, { type: "stop" });
  agent.say(`here is my plan: ${goals.map((g) => describeGoal(g)).join(" > ")}`, { force: true, to: speaker });
  agent.setGoals(goals);
}

function describeGoal(g) {
  switch (g.type) {
    case "goto": return `go to ${[g.pos.x, g.pos.y, g.pos.z].filter((v) => v != null).map(Math.round).join(" ")}`;
    case "have": return `get ${Object.entries(g.items).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ")}`;
    case "set_spawn": return "set spawn";
    case "kill": return `kill ${g.targets.join("/")}`;
    case "give": return `give ${g.count} ${String(g.item).replace(/_/g, " ")}`;
    default: return g.type.replace(/_/g, " ");
  }
}

// Only these are executed without asking the AI: unambiguous one-word commands (instant, nothing to misread).
const FAST = /^(?:please\s+)?(stop|stay|wait|halt|freeze|cancel|follow me|follow|come|come here|come to me|come on)[.!\s]*$/i;

// "mark this place" / "this is where the village goes" / "build it here": WRITE DOWN the player's exact position the moment they say it
// (name + x y z + y level), so that after hours of gathering everybody still knows which place was meant.
const MARK = /\b(mark|remember|note|save|log|record|set)\b.{0,30}\b(this|here|current|my)\b.{0,25}\b(location|coordinates?|coords?|place|spot|position|point|site|area)\b|\bthis (is|will be) (the )?(place|spot|location|site|centre|center|area)\b|\bthis is where\b|\bhere (is|will be) (the |our )?(base|village|home|camp|farm|site)\b|\b(build|make|set up|start|found)\b.{0,60}\b(here|in this (place|area|location|spot)|where i am)\b/i;
async function markPlace(agent, speaker, message) {
  if (!MARK.test(message) || agent.isAgent(speaker)) return null;
  const { LABELS } = require("./context");
  const spatial = require("../runtime/spatial");
  let v = spatial.viewOf(agent, speaker);
  if (!v) {                                                           // far away: ask the server where the player is right now (radar polls /data), up to ~5 s
    agent.radar.track(speaker);
    for (let i = 0; i < 25 && !v; i++) { await new Promise((r) => setTimeout(r, 200)); v = spatial.viewOf(agent, speaker); }
  }
  if (!v) return null;
  const words = String(message).toLowerCase();
  const thing = (words.match(/\b(village|town|city|base|home|house|farm|mine|castle|tower|fortress|camp|market|portal|bridge|shop)\b/) || [])[1] || LABELS.find((l) => words.includes(l)) || "marked";
  const label = thing === "marked" ? "marked spot" : `${thing} site`;
  const pos = { x: v.block.x, y: v.block.y - 1, z: v.block.z };
  agent.know.add({ kind: "site", label, pos, source: "player", note: `said by ${speaker}` });
  agent.ctxStore.addPlace({ x: pos.x, y: pos.y, z: pos.z, label: thing === "marked" ? null : thing, speaker, t: Date.now(), text: String(message).slice(0, 120) });
  agent.ctxStore.save();
  log("chat", `marked "${label}" at ${pos.x} ${pos.y} ${pos.z} for ${speaker}`);
  return { label, pos };
}

// "where is the village?" -> from what is written down, never from imagination
const CONTINUE = /\b(continue|resume|finish|complete|carry on|keep (going|building|working)|get back to|go back to|back to (work|the|your)|what about|how about)\b/i;
function continueBuild(agent, speaker, message) {
  if (!CONTINUE.test(message)) return false;
  if (/^\W*(\w+[,:]?\s+)?(did|have|has|are|is|was|were|when|why|how (is|far|long|much))\b/i.test(message)) return false;    // a question about it, not an order
  const me = agent.bot.username, shared = require("../runtime/shared");
  const { named } = require("./team-project").audience(message);
  if (!named.length && !addressed(agent, message)) return false;
  if (named.length && !named.some((n) => n.toLowerCase() === me.toLowerCase())) return false;
  const words = (t) => String(t || "").toLowerCase().split(/\W+/).filter((w) => w.length > 3 && !/^(build|building|with|that|this|your|about|finish|complete|continue|resume)$/.test(w));
  const refersTo = (b) => /\b(it|task|job|build|building|work|that|this)\b/i.test(message) || words(b.name).some((w) => message.toLowerCase().includes(w));
  // whose build? the first named agent that has an unfinished one (or mine)
  const owners = named.length ? named : [me];
  const owner = owners.find((n) => { const b = shared.buildOf(n); return b && !b.done && refersTo(b); });
  if (!owner) return false;
  const b = shared.buildOf(owner);
  if (owner.toLowerCase() === me.toLowerCase()) {
    log("chat", `${speaker}: ${message} => continue my ${b.name} at ${b.origin.x},${b.origin.y},${b.origin.z}`);
    agent.lastHumanCommand = Date.now(); agent.autonomy.resume();
    applyGoal(agent, speaker, { type: "build", request: b.request || b.name, humanOrder: true, anchor: { mode: "coords", fixed: b.origin, x: b.origin.x, y: b.origin.y, z: b.origin.z } }, { quiet: true });
    agent.say(`${speaker}, back on the ${b.name} at ${b.origin.x} ${b.origin.y} ${b.origin.z}${named.length > 1 ? " - " + named.filter((n) => n !== owner).join(", ") + " is helping" : ""}.`, { force: true });
  } else {
    log("chat", `${speaker}: ${message} => help ${owner} finish the ${b.name}`);
    agent.lastHumanCommand = Date.now(); agent.autonomy.resume();
    applyGoal(agent, speaker, { type: "assist", owner, request: "assist", humanOrder: true }, { quiet: true });
    agent.say(`coming to help ${owner} with the ${b.name}.`, { force: true });
  }
  return true;
}

function whereIs(agent, text) {
  const m = String(text).trim().match(/^where(?:'s| is| are| was)\s+(?:the |our |my |your )?([a-z][a-z ]{2,30}?)\??$/i);
  if (!m) return null;
  const q = m[1].toLowerCase();
  const hit = agent.know.all().filter((e) => String(e.label).toLowerCase().includes(q) || q.includes(String(e.label).toLowerCase().replace(/ site$/, "")) || e.kind === q).sort((a, b) => b.t - a.t)[0];
  if (!hit) return null;
  const me = agent.bot.entity.position, d = Math.round(Math.hypot(hit.pos.x - me.x, hit.pos.z - me.z));
  return `the ${hit.label} is at x${hit.pos.x}${hit.pos.y != null ? " y" + hit.pos.y : ""} z${hit.pos.z}, ${d} blocks from me`;
}

async function handleChat(agent, speaker, message, { whisper = false, trusted = false } = {}) {
  recordChat(agent, speaker, message);
  // Agents never act on each other's CHAT (every bot hears every line; an LLM reads status chatter as orders and they thank each
  // other forever). They talk through runtime/team.js; `trusted` marks a message that arrived that way.
  if (AGENTS.includes(String(speaker).toLowerCase()) && !trusted) {
    // a teammate talking in chat is not an ORDER (orders come through the team inbox) - but if it talks to me, I answer like a person would
    const l = String(message).toLowerCase();
    if (speaker !== agent.bot.username && (l.includes(agent.bot.username.toLowerCase()) || /\b(everyone|guys|team|anyone|all of you)\b/.test(l))) agent.banter?.onChat({ from: speaker, text: message, data: { hops: 0 } }).catch(() => {});
    return;
  }
  if (!trusted && !agent.isAgent(speaker)) {
    const marked = await markPlace(agent, speaker, message);
    if (marked) {
      const { audience: aud0, electCoordinator } = require("./team-project");
      if (electCoordinator(agent, aud0(message).named, message) === agent.bot.username) agent.say(`marked ${marked.pos.x} ${marked.pos.y} ${marked.pos.z} as the ${marked.label}`, { to: speaker });
    }
  }
  // "yes" to the leader's suggestion ("Idea: we could build a mine entrance. Want us to?")
  if (!trusted && !agent.isAgent(speaker) && agent.projects.pendingProposal && /^\s*(?:\w+[,:]?\s+)?(yes|yeah|yep|sure|ok|okay|go ahead|do it|let'?s do it|sounds good|go for it)\b/i.test(message)) {
    if (await agent.projects.acceptProposal(speaker)) return;
  }
  if (!trusted && !agent.isAgent(speaker) && agent.projects.pendingProposal && /^\s*(?:\w+[,:]?\s+)?(no|nope|not now|don'?t|nah)\b/i.test(message)) { agent.projects.pendingProposal = null; agent.say("Okay, forget it.", { to: speaker }); return; }
  // "reset all tasks / cancel everything / drop what you are doing": every goal, queued step, team job and request goes; they stand by for new orders
  if (!trusted && !agent.isAgent(speaker) && /\b(reset|cancel|drop|clear|stop|abort)\b.{0,25}\b(all|every|your|the)?\s*(tasks?|jobs?|work|everything|all)\b/i.test(message) && !/\b(memory|memories|context|chat|history|conversation)\b/i.test(message)) {
    const { audience, electCoordinator } = require("./team-project");
    const aud = audience(message);
    const forMe = aud.named.some((n) => n.toLowerCase() === agent.bot.username.toLowerCase()) || (aud.group && !aud.named.length) || /\b(everyone|everybody|all of you|you all)\b/i.test(message);
    if (forMe || addressed(agent, message)) {
      const R = require("../runtime/reset");
      R.resetTasks(agent);
      if ((aud.group || /\b(everyone|everybody|team)\b/i.test(message)) && electCoordinator(agent, aud.named, message) === agent.bot.username) R.cancelTeamWork();
      agent.say("All tasks dropped - standing by for new orders.", { to: speaker });
    }
    return;
  }
  // "reset your memory / forget the chat": handled here, never by the AI (it is about the AI's own context). "everyone ..." resets all of us.
  if (!trusted && !agent.isAgent(speaker) && /\b(reset|clear|wipe|forget|erase)\b.{0,25}\b(context|memory|memories|chat|history|conversation|everything)\b/i.test(message)) {
    const { audience, electCoordinator } = require("./team-project");
    const aud = audience(message);
    const forMe = aud.named.some((n) => n.toLowerCase() === agent.bot.username.toLowerCase()) || (aud.group && !aud.named.length) || (aud.group && aud.named.length === 0);
    if (forMe || addressed(agent, message)) {
      const scope = /\b(everything|memory|memories|all)\b/i.test(message) ? "all" : "chat";
      require("../runtime/reset").resetAgent(agent, scope);
      if (scope === "all" && aud.group && electCoordinator(agent, aud.named, message) === agent.bot.username) require("../runtime/reset").resetShared();
      agent.say(scope === "all" ? "Done - I forgot our conversation, places and plans. Fresh start." : "Done - conversation forgotten.", { to: speaker });
    }
    return;
  }
  // "continue your task" / "what about the cooking house?" / "Wren, finish it with Vesper": the unfinished build is picked up again AT ITS PLACE
  // (its owner builds, the others named come and help) - not a new project, not a trip somewhere
  if (!trusted && !agent.isAgent(speaker) && continueBuild(agent, speaker, message)) return;
  // A message to several of us (or to everyone) is NOT answered by everyone: one elected leader plans it, the rest pick jobs from the board.
  if (!trusted && !agent.isAgent(speaker)) {
    const { audience, BIG, RENOVATE } = require("./team-project");
    const aud = audience(message);
    const bigJob = aud.named.some((n) => n.toLowerCase() === agent.bot.username.toLowerCase()) && ((BIG.test(message) && /\b(build|building|make|making|construct|create|creating|set up|found|start)\b/i.test(message)) || RENOVATE.test(message));
    if ((aud.group || bigJob) && !/\b(stop|stay|wait|halt|freeze|cancel|progress|update|status|how is|how are)\b/i.test(message)) { agent.lastHumanCommand = Date.now(); return agent.projects.onGroupMessage(speaker, message); }
  }
  // A message that names other agents but not me is none of my business (the elected leader / the named ones handle it; I find my work on the board).
  if (!trusted && !agent.isAgent(speaker)) {
    const named = require("./team-project").audience(message).named;
    if (named.length && !named.some((n) => n.toLowerCase() === agent.bot.username.toLowerCase())) { log("chat", `${speaker}'s message is for ${named.join("/")}, not me`); return; }
  }
  if (!whisper && !trusted && !addressed(agent, message)) return;
  if (!trusted && tooChatty(speaker)) { log("chat", `ignoring ${speaker}: too many messages in the last minute`); return; }
  if (!agent.isAgent(speaker)) { agent.lastHumanCommand = Date.now(); if (!/^\s*(?:\w+[,:]?\s+)?(stop|stay|wait|halt|freeze|cancel)\b/i.test(message)) agent.autonomy.resume(); }             // a human is talking to me: my own plans wait, and an old "stop" is over
  const bare = message.replace(new RegExp(agent.bot.username, "ig"), "").replace(/^[\s,:@]*(hey|yo|hi)?\s*(ai|bot)?[\s,:]*/i, "").trim();
  const opts = { reg: agent.reg, speaker, botName: agent.bot.username, places: agent.ctxStore.places, ctx: agent.ctxStore };

  // 1. instant path for trivial commands
  if (FAST.test(bare)) {
    const intent = parseIntent(message, opts);
    if (intent) { log("chat", `${speaker}: ${message} => fast ${JSON.stringify(intent)}`); return applyGoal(agent, speaker, intent); }
  }
  { const w = whereIs(agent, bare); if (w) return agent.say(w, { to: speaker }); }
  // 2. questions about the bot itself are answered from real state
  const st = answerStatus(agent, bare);
  if (st) return agent.say(st, { to: speaker });

  // 3. the AI understands everything else, with history, places and home
  if (agent.brain?.available) {
    agent.think("understanding your request...");
    const snap = observe(agent.bot);
    const res = await agent.brain.interpret({
      speaker, message: bare || message, history: agent.ctxStore.chat, memory: { ...agent.ctxStore.summary(), landmarks: agent.know.summary(), known: agent.know }, reg: agent.reg, team: agent.team, fromAgent: agent.isAgent(speaker),
      space: agent.isAgent(speaker) ? "" : (() => { try { return require("../runtime/spatial").describeSpace(agent, speaker); } catch (e) { return ""; } })(),
      status: { pos: `x${Math.round(snap.pos.x)} y${Math.round(snap.pos.y)} z${Math.round(snap.pos.z)}`, gameMode: snap.gameMode, botName: agent.bot.username, hp: Math.round(snap.health), food: Math.round(snap.food), activity: describeActivity(agent), inventory: invSummary(snap.inv, 12), players: snap.players.map((p) => p.username).join(", ") || "none nearby" }
    });
    if (res) {
      log("chat", `${speaker}: ${message} => llm ${JSON.stringify(res)}`);
      const goals = res.goals?.length ? res.goals : res.goal ? [res.goal] : [];
      if (agent.isAgent(speaker)) goals.splice(0, goals.length, ...goals.filter((g) => g.type !== "tell"));    // an order from a teammate is done by ME, not passed on again (that was the "can you bring me logs" ping-pong)
      goals.splice(0, goals.length, ...groundGoals(agent, speaker, message, goals));
      if (!goals.length && (res.goal || res.goals?.length)) return;
      await anchorGoals(agent, speaker, goals);
      if (res.reply && !agent.isAgent(speaker)) agent.say(res.reply, { to: speaker });
      if (goals.length > 1) return applyGoals(agent, speaker, goals);
      if (goals.length === 1) return applyGoal(agent, speaker, goals[0], { quiet: !!res.reply });
      return;                                              // the AI answered and decided no action is needed (thanks, chit-chat, a report): that is an answer, not an outage
    }
    agent.think("the AI was unavailable - using my built-in parser");
  }

  if (agent.brain?.blockedUntil > Date.now() && Date.now() - (agent.quotaTold || 0) > 600000) { agent.quotaTold = Date.now(); agent.say("My AI service is out of budget right now (API spending cap), so I only understand simple commands until that is fixed.", { to: speaker }); }
  // 4. fallback: local parser (sequences first)
  const seq = parseSequence(message, opts);
  if (Array.isArray(seq)) return applyGoals(agent, speaker, seq);
  const intent = parseIntent(message, opts);
  log("chat", `${speaker}: ${message} => local ${intent ? JSON.stringify(intent) : "(none)"}`);
  if (intent) return applyGoal(agent, speaker, intent);
  agent.say("I'm not sure what you want. Try: follow me, come, get 5 wood, craft an iron pickaxe, or build a house.", { to: speaker });
}

module.exports = { handleChat, addressed, recordChat };
