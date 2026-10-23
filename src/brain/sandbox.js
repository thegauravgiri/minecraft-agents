// Runs LLM-written scripts against a small, abort-aware API. Scripts are plain async function bodies:
//   await api.goto(x, y, z); await api.mine(["stone"], 5); ...
// They get no require/process/fs, a hard timeout, and are cancelled when the goal changes.
const vm = require("vm");
const { Vec3 } = require("vec3");
const { goals } = require("mineflayer-pathfinder");
const skills = require("../skills");
const { sleep, throwIfAborted, invCount, log } = require("../runtime/util");
const { configureMovements } = require("../skills/move");
const { digBlock, placeAt } = require("../skills/blocks");

// Bad numbers (NaN/undefined/strings) make the pathfinder spin forever: refuse them with an error the AI can repair.
const finite = (fn, ...names) => (...args) => {
  names.forEach((n, i) => { if (typeof args[i] !== "number" || !Number.isFinite(args[i])) throw new Error(`api.${fn}: argument "${n}" must be a finite number, got ${String(args[i])}`); });
  return args;
};

// scripts may pass (x,y,z) or a position object ({x,y,z}, a Vec3, an entity-like {position}/{pos}); normalise to numbers
function xyz(args) {
  const a0 = args[0];
  if (a0 && typeof a0 === "object") { const p = a0.position || a0.pos || a0; return [p.x, p.y, p.z, ...args.slice(1)]; }
  return args;
}

function buildApi(ctx, logs, args = {}) {
  const { bot, agent } = ctx;
  const must = async (p) => { const r = await p; if (r && r.ok === false) throw new Error(r.data?.message ? `${r.reason}: ${r.data.message}` : (r.reason || "failed")); return r?.data ?? r; };
  const api = {
    bot, Vec3, goals,
    args: Object.freeze({ ...(args || {}) }),
    log: (...a) => { logs.push(a.join(" ").slice(0, 200)); },
    say: (m) => agent.say(String(m)),
    think: (m) => agent.think(String(m)),
    sleep: (ms) => sleep(ms, ctx.signal),
    aborted: () => !!ctx.signal.aborted,
    inventory: () => Object.fromEntries(bot.inventory.items().map((i) => [i.name, 0]).map(([n]) => [n, invCount(bot, n)])),
    count: (name) => invCount(bot, name),
    pos: () => { const p = bot.entity.position; return { x: p.x, y: p.y, z: p.z, floor: () => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }), floored: () => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }) }; },
    vec: (x, y, z) => new Vec3(x, y, z),
    state: () => ({ health: bot.health, food: bot.food, oxygen: bot.oxygenLevel, held: bot.heldItem?.name || null, dimension: bot.game?.dimension }),
    blocksAround: (radius = 6) => { const out = {}; const p = bot.entity.position.floored(); for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -3; dy <= 4; dy++) { const b = bot.blockAt(p.offset(dx, dy, dz)); if (b && b.name !== "air") out[b.name] = (out[b.name] || 0) + 1; } return out; },
    blockAt: (x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name || null,
    findBlocks: (name, maxDistance = 32, count = 8) => {
      const id = bot.registry.blocksByName[name]?.id;
      return id == null ? [] : bot.findBlocks({ matching: id, maxDistance, count }).map((p) => ({ x: p.x, y: p.y, z: p.z }));
    },
    entities: (filter = {}) => Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && (!filter.name || e.name === filter.name || e.username === filter.name) && (!filter.maxDist || e.position.distanceTo(bot.entity.position) <= filter.maxDist))
      .map((e) => ({ id: e.id, name: e.username || e.name, x: e.position.x, y: e.position.y, z: e.position.z, dist: e.position.distanceTo(bot.entity.position) })).sort((a, b) => a.dist - b.dist),
    goto: (...a0) => { const a = xyz(a0); const [x, y, z, range = 1.5] = (finite("goto", "x", "y", "z")(...a), a); return must(require("../skills/move").goto(ctx, new goals.GoalNear(x, y, z, range), { timeout: 60000, towardPos: new Vec3(x, y, z) })); },
    mine: (blocks, count = 1) => must(skills.mine(ctx, { blocks: [].concat(blocks), accept: [].concat(blocks).map((b) => bot.registry.blocksByName[b]?.drops?.[0]).map((id) => bot.registry.items[id]?.name).filter(Boolean).concat([].concat(blocks)), count })),
    craft: (item, count = 1) => must(skills.craft(ctx, { item, times: Math.max(1, Math.ceil(count / 1)), count, table: true })),
    fight: (target) => must(skills.fight(ctx, typeof target === "number" ? { id: target } : { username: target, names: [target] }, {})),
    dig: async (...a0) => {
      const a = xyz(a0); finite("dig", "x", "y", "z")(...a);
      const pos = new Vec3(Math.floor(a[0]), Math.floor(a[1]), Math.floor(a[2]));
      if (bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.5) await must(require("../skills/move").goto(ctx, new goals.GoalNear(pos.x, pos.y, pos.z, 3), { timeout: 30000, towardPos: pos }));   // walk/fly into reach first
      return must(digBlock(ctx, bot.blockAt(pos)));
    },
    place: (item, ...r0) => { const [x, y, z] = xyz(r0); finite("place", "x", "y", "z")(x, y, z); const it = bot.inventory.items().find((i) => i.name === item); if (!it) throw new Error("no item " + item); return must(placeAt(ctx, it, new Vec3(x, y, z))); },
    pillar: (steps = 1) => must(skills.pillar(ctx, { steps })),
    digDown: (targetY) => { finite("digDown", "targetY")(targetY); return must(require("../skills/vertical").digDown(ctx, { targetY })); },
    escapeHole: () => must(skills.escape_hole(ctx, {})),
    collect: () => must(skills.collect(ctx, {})),
    eat: () => must(skills.eat(ctx, {})),
    follow: (player, stopAt) => must(skills.follow(ctx, { player, stopAt })),
    chest: (action = 'take', items = 'all') => must(skills.chest(ctx, { action, items })),
    fill: (...a) => { finite("fill", "x1", "y1", "z1", "x2", "y2", "z2")(...a); return must(require("../skills/commands").fillBox(ctx, ...a.slice(0, 6), a[6] || "air")); },
    setblock: (x, y, z, block = "stone") => { finite("setblock", "x", "y", "z")(x, y, z); return must(require("../skills/commands").setBlock(ctx, x, y, z, block)); },
    fill: (...a) => { finite("fill", "x1", "y1", "z1", "x2", "y2", "z2")(...a); return must(require("../skills/commands").fillBox(ctx, ...a.slice(0, 6), a[6] || "air")); },
    setblock: (x, y, z, block = "stone") => { finite("setblock", "x", "y", "z")(x, y, z); return must(require("../skills/commands").setBlock(ctx, x, y, z, block)); },
    gameMode: () => bot.game?.gameMode,
    view: (name) => { const v = require("../runtime/spatial").viewOf(agent, name || agent.master); return v ? { pos: v.block, facing: v.facing || null, lookingAt: v.lookingAt || null, standingOn: v.standingOn } : null; },
    water: (name) => { const sp = require("../runtime/spatial"); const v = sp.viewOf(agent, name || agent.master); return sp.waterScan(bot, v ? new (require("vec3").Vec3)(v.pos.x, v.pos.y, v.pos.z) : bot.entity.position, { heading: v?.dir }); },
    give: (item, count = 1) => must(skills.creative_give(ctx, { items: { [item]: count } })),
    fly: (...a0) => { const a = xyz(a0); finite("fly", "x", "y", "z")(...a); return must(skills.fly_to(ctx, { x: a[0], y: a[1], z: a[2] })); },
    setSpawn: () => must(skills.set_spawn(ctx, {})),
    wander: (d = 25) => must(skills.wander(ctx, { distance: d }))
  };
  return api;
}

async function runScript(ctx, code, { timeoutMs = 90000, args = {} } = {}) {
  const logs = [];
  const api = buildApi(ctx, logs, args);
  const body = String(code).trim().replace(/^```[a-z]*\n?/i, "").replace(/```$/, "");
  // refuse a script that calls an API that does not exist BEFORE it does anything (a half-executed script leaves a mess)
  const unknown = [...new Set([...body.matchAll(/\bapi\.([A-Za-z_]\w*)/g)].map((m) => m[1]))].filter((n) => !(n in api));
  if (unknown.length) return { ok: false, error: `unknown API: ${unknown.map((n) => "api." + n).join(", ")} - these do not exist. Available: ${Object.keys(api).filter((k) => typeof api[k] === "function").join(", ")}`, logs };
  try { new vm.Script(`(async () => {\n${body}\n})`, { filename: "ai-script.js" }); }
  catch (e) { return { ok: false, error: `SyntaxError: ${e.message}`, logs }; }
  const sandbox = vm.createContext({ api, Math, JSON, Date, Promise, Vec3, goals, console: { log: api.log } }, { codeGeneration: { strings: false, wasm: false } });
  let timer;
  try {
    const script = new vm.Script(`(async () => {\n${body}\n})()`, { filename: "ai-script.js" });
    const run = script.runInContext(sandbox, { timeout: 5000, breakOnSigint: false });
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("script_timeout")), timeoutMs); });
    const aborted = new Promise((_, rej) => ctx.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
    const value = await Promise.race([run, timeout, aborted]);
    return { ok: true, value: value === undefined ? null : value, logs };
  } catch (e) {
    if (e.name === "AbortError") throw e;
    return { ok: false, error: String(e.message || e).slice(0, 300), logs };
  } finally { clearTimeout(timer); }
}

const API_DOC = `Script API (async function body; use await; throw on failure; check api.aborted() in loops). api.args = the parameters this run was given (a plain object; read what varies from there so the script is reusable):
api.goto(x,y,z,range) api.mine(["block_id"],count) api.craft("item_id",count) api.fight(entityIdOrName) api.dig(x,y,z)
api.place("item_id",x,y,z) api.pillar(steps) api.digDown(targetY) api.escapeHole() api.collect() api.eat() api.follow(player,stopAt)
api.chest('take'|'put'|'list', 'all'|{item:count}) (opens nearest chest; never dig chests) api.fill(x1,y1,z1,x2,y2,z2,'block_id'='air') / api.setblock(x,y,z,'block_id') [needs cheats: instant /fill - use for flattening terrain, clearing areas, big builds, hundreds of times faster than digging block by block] api.fill(x1,y1,z1,x2,y2,z2,'block_id'='air') / api.setblock(x,y,z,'block_id') [needs cheats; refuses areas near remembered houses/structures; instant - use for flattening terrain, clearing areas, big builds instead of digging block by block] api.gameMode() ('creative'|'survival') api.view('player') [{pos,facing,lookingAt,standingOn} of a player: where they stand, which way they face, the block they look at] api.water('player') [nearest water, river/lake shape, shortest crossing {entry,exit,width}, and water straight ahead of the player] api.give('item_id',count) [CREATIVE ONLY: instantly puts items in the inventory] api.fly(x,y,z) [CREATIVE ONLY] api.setSpawn() api.wander(dist) api.say(msg) api.think(msg) api.sleep(ms) api.inventory() api.count("item") api.pos()
api.blockAt(x,y,z) api.findBlocks("block_id",dist,count) -> [{x,y,z}] (plain objects: b.x, b.y, b.z - NO b.position) -> [{x,y,z}] (plain objects: b.x, b.y, b.z - NO b.position) api.entities({name,maxDist}) api.bot (raw mineflayer bot) Vec3 goals(mineflayer-pathfinder)\nTypes: api.pos() -> {x,y,z} plain numbers (NOT a Vec3; use api.vec(x,y,z) if you need one); api.entities() -> [{id,name,x,y,z,dist}] (x/y/z directly, no .position); api.goto/api.dig/api.place accept (x,y,z) or a position object; api.state() -> {health,food,oxygen,held}; api.blocksAround(r) -> {block_name:count}.\nThe script body is the inside of an async function: use await, throw on failure, return a short result string/number. Keep scripts SHORT and single-purpose; check api.aborted() in loops.`;

module.exports = { runScript, buildApi, API_DOC };
