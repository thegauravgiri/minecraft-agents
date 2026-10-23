// Pure planner: (goal, snapshot, hints) -> what to do next and how far from done we are.
// `remaining` is a single comparable number that must fall when real progress is made;
// the runtime uses it to verify every action instead of trusting the action's own report.
const { planAcquire, describeStep } = require("./acquire");
const { planBuildHouse } = require("./blueprint");
const Struct = require("./structure");

const STEP_SKILL = { gather: "mine", craft: "craft", smelt: "smelt", hunt: "hunt", place_station: "placeStation" };

const horiz = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function findPlayer(snap, name) {
  if (!name) return null;
  const n = name.toLowerCase();
  return snap.players.find((p) => p.username?.toLowerCase() === n) || null;
}

function haveGoalWants(goal) { return goal.items; }

// "a bed" means whichever colour we can already make; prefer the wool we hold
function normaliseWants(reg, wants, inv) {
  const out = {};
  for (const [item, n] of Object.entries(wants)) {
    if (/_bed$/.test(item)) {
      const color = reg.names.beds.map((b) => b.replace(/_bed$/, "")).find((c) => (inv[`${c}_wool`] || 0) >= 3);
      out[color ? `${color}_bed` : item] = n;
    } else out[item] = n;
  }
  return out;
}

function planHave(reg, goal, snap, hints) {
  const wants = normaliseWants(reg, haveGoalWants(goal), snap.inv);
  // "3 oak logs" / "8 planks" are satisfied by ANY wood type we hold (this world may only have birch...)
  const sumOf = (re) => Object.entries(snap.inv).reduce((n, [k, v]) => (re.test(k) ? n + v : n), 0);
  const folded = { ...snap.inv };
  for (const item of Object.keys(wants)) {
    if (/_log$/.test(item)) folded[item] = Math.max(folded[item] || 0, sumOf(/_log$/));
    if (/_planks$/.test(item)) folded[item] = Math.max(folded[item] || 0, sumOf(/_planks$/));
  }
  snap = { ...snap, inv: folded };
  // CREATIVE: every item is one click away - no gathering, crafting, smelting or hunting
  if (snap.gameMode === "creative") {
    const missing = {};
    for (const [item, n] of Object.entries(wants)) if (reg.hasItem(item) && (snap.inv[item] || 0) < n) missing[item] = n - (snap.inv[item] || 0);
    if (!Object.keys(missing).length) return { done: true, remaining: 0 };
    return { done: false, remaining: Object.keys(missing).length, action: { skill: "creative_give", args: { items: missing }, label: `take from the creative inventory: ${Object.entries(missing).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ")}` } };
  }
  const plan = planAcquire(reg, snap.inv, wants, {
    stations: hints.stations, knownBlocks: hints.knownBlocks, avoid: hints.avoid, allowHunt: hints.allowHunt
  });
  if (plan.ok && plan.steps.length === 0) return { done: true, remaining: 0 };
  if (!plan.ok) return { blocked: `cannot acquire ${plan.blockers.join(", ")}`, remaining: 1e6 };
  const step = plan.steps[0];
  const outline = plan.steps.map(describeStep);
  // before gathering anything raw: pick up matching drops lying nearby, then look in nearby chests (once)
  if (step.op === "gather" || step.op === "hunt") {
    const accept = step.accept || [step.item];
    const drops = snap.items.filter((i) => i.item && accept.includes(i.item) && i.dist < 24);
    if (drops.length) return { done: false, remaining: plan.cost, outline, action: { skill: "collect", args: { accept }, label: `pick up nearby ${accept[0].replace(/_/g, " ")} first` } };
    if (goal.progress && hints.chestsNearby > 0 && !(goal.progress.chestDone > 0)) {
      return { done: false, remaining: plan.cost, outline, action: { skill: "chest", args: { action: "take", items: accept }, label: `check nearby chests for ${accept[0].replace(/_/g, " ")}` } };
    }
  }
  return {
    done: false, remaining: plan.cost,
    action: { skill: STEP_SKILL[step.op], args: step, label: describeStep(step) },
    outline
  };
}

const WEAPON = /(_sword|_axe)$/;
const hasWeapon = (snap) => Object.keys(snap.inv).some((k) => WEAPON.test(k) && snap.inv[k] > 0);

// Resolve goal.targets (names, "*players", "*hostiles") against what we can see / have radar for.
function expandTargets(goal, snap, hints) {
  const killed = hints.killed || new Set();
  const out = [];
  const seen = new Set();
  const push = (t) => { const k = t.name.toLowerCase(); if (!seen.has(k) && !killed.has(k)) { seen.add(k); out.push(t); } };
  for (const spec of goal.targets || []) {
    if (spec === "*hostiles") { snap.hostiles.filter((h) => h.dist <= (goal.radius || 24) && h.name !== "enderman" && !(h.name === "creeper" && h.dist < 3)).forEach((h) => push({ name: `${h.name}#${h.id}`, live: h, mob: true })); continue; }
    if (spec === "*players") {
      const master = (goal.exclude || []).map((x) => x.toLowerCase());
      snap.players.filter((p) => !master.includes(p.username.toLowerCase())).forEach((p) => push({ name: p.username, live: p }));
      for (const n of hints.knownPlayers || []) if (!master.includes(n.toLowerCase()) && !seen.has(n.toLowerCase())) push({ name: n, where: hints.radar?.[n.toLowerCase()] || null });
      continue;
    }
    const live = snap.players.find((p) => p.username?.toLowerCase() === spec.toLowerCase())
      || snap.entities.find((e) => e.kind !== "item" && e.name === spec.toLowerCase());
    if (live) push({ name: live.username || `${live.name}#${live.id}`, live, mob: live.kind !== "player" });
    else push({ name: spec, where: hints.radar?.[spec.toLowerCase()] || null });
  }
  return out;
}

function planKill(reg, goal, snap, hints) {
  const targets = expandTargets(goal, snap, hints);
  if (!targets.length) return { done: true, remaining: 0 };
  // whoever hit us last (and is a target) takes priority, else the nearest visible one
  const live = targets.filter((t) => t.live).sort((a, b) => {
    const ha = hints.lastHurtBy && a.name.toLowerCase() === hints.lastHurtBy.toLowerCase() ? -1e3 : 0;
    const hb = hints.lastHurtBy && b.name.toLowerCase() === hints.lastHurtBy.toLowerCase() ? -1e3 : 0;
    return a.live.dist + ha - (b.live.dist + hb);
  });
  const t = live[0] || targets.find((x) => x.where) || targets[0];
  const near = t.live ? t.live.dist : (t.where?.sameDimension ? Math.hypot(t.where.pos.x - snap.pos.x, t.where.pos.z - snap.pos.z) : 1e3);

  // not armed and the target is far: prepare (re-checked every cycle, so we switch to fighting the moment they arrive)
  if (!hasWeapon(snap) && near > 14 && !hints.noPrepare) {
    const prep = planHave(reg, { items: { stone_sword: 1 } }, snap, hints);
    if (prep.action) return { ...prep, remaining: near + prep.remaining, prepare: true, watch: true, action: { ...prep.action, label: "prepare: " + prep.action.label } };
  }
  if (!t.live) {
    if (!t.where) return { blocked: `can't locate ${t.name}`, remaining: 1e6 };
    if (!t.where.sameDimension) return { done: false, remaining: 1e3, watch: true, action: { skill: "travel_dimension", args: { dimension: t.where.dimension, pos: t.where.pos }, label: `go to ${t.where.dimension} for ${t.name}` } };
    return { done: false, remaining: near, watch: true, action: { skill: "approach", args: { pos: t.where.pos, name: t.name }, label: `approach ${t.name}`, requires: boatNeeded(snap, hints) ? BOAT_REQ : undefined } };
  }
  const e = t.live;
  const dy = e.pos.y - snap.pos.y;
  const h = Math.hypot(e.pos.x - snap.pos.x, e.pos.z - snap.pos.z);
  const base = { done: false, remaining: e.dist, watch: true };
  const hard = hints.shaftHard ?? HARD_GROUND.test(snap.groundBlock);
  if (dy >= 2.3 && h < 7) return { ...base, action: { skill: "tower_to", args: { id: e.id }, label: `tower up to ${t.name}`, requires: { blocks: Math.ceil(dy) + 2 } } };
  if (dy <= -2.8 && h < 9) return { ...base, action: { skill: "dig_to", args: { id: e.id }, label: `dig down to ${t.name}`, requires: hard ? { tools: [{ category: "pickaxe", minTier: 1 }] } : undefined } };
  return { ...base, action: { skill: "fight", args: { id: e.id, username: e.username || undefined, opts: { timeoutMs: 60000 } }, label: `fight ${t.name}` } };
}

function planGive(reg, goal, snap, hints) {
  const delivered = goal.progress?.delivered || 0;
  if (delivered >= goal.count) return { done: true, remaining: 0 };
  const need = goal.count - delivered;
  if ((snap.inv[goal.item] || 0) >= need) {
    const p = findPlayer(snap, goal.player);
    return { done: false, remaining: 1 + (p ? p.dist : 50) / 10, action: { skill: "deliver", args: { player: goal.player, item: goal.item, count: need }, label: `give ${need} ${goal.item} to ${goal.player}` } };
  }
  const acq = planHave(reg, { items: { [goal.item]: need } }, snap, hints);
  if (acq.blocked) return acq;
  return { ...acq, remaining: acq.remaining + 5 };
}

function planSetSpawn(reg, goal, snap, hints) {
  if ((goal.progress?.spawnSet || 0) >= 1) return { done: true, remaining: 0 };
  const haveBed = Object.keys(snap.inv).some((k) => /_bed$/.test(k) && snap.inv[k] > 0);
  if (hints.stations?.bed || haveBed) return { done: false, remaining: 1, action: { skill: "set_spawn", args: { sleep: !!goal.sleep }, label: goal.sleep ? "go to bed" : "set respawn point" } };
  const acq = planHave(reg, { items: { white_bed: 1 } }, snap, hints);
  return acq.blocked ? acq : { ...acq, remaining: acq.remaining + 1 };
}

function planGoto(reg, goal, snap, hints) {
  const { x, y, z } = goal.pos;
  const h = Math.hypot(x - snap.pos.x, z - snap.pos.z);
  const dy = y == null ? 0 : Math.abs(y - snap.pos.y);
  if (h <= 2.5 && dy <= 3) return { done: true, remaining: 0 };
  const label = `go to ${Math.round(x)} ${y == null ? "~" : Math.round(y)} ${Math.round(z)}`;
  return { done: false, remaining: h + dy, action: { skill: "approach", args: { pos: { x, y: y ?? snap.pos.y, z }, range: 1.5 }, label, requires: boatNeeded(snap, hints) ? BOAT_REQ : { soft: true } } };
}

// Long, deep water between us and the target (ocean, wide river) and no boat yet: get one first.
const hasBoat = (snap) => Object.keys(snap.inv).some((k) => /_(boat|raft)$/.test(k) && snap.inv[k] > 0);
const boatObtainable = (snap, hints) => Object.keys(snap.inv).some((k) => /_(planks|log)$/.test(k) && snap.inv[k] > 0) || [...(hints.knownBlocks || [])].some((n) => /_log$/.test(n));
const boatNeeded = (snap, hints) => snap.gameMode !== "creative" && !!hints.waterCrossing && hints.waterCrossing.deepWater >= 12 && hints.waterCrossing.waterBlocks >= 16 && !hasBoat(snap) && boatObtainable(snap, hints);
const BOAT_REQ = { items: { oak_boat: 1 } };

const PICK = /_pickaxe$/;
const hasPickaxe = (snap) => Object.keys(snap.inv).some((k) => PICK.test(k) && snap.inv[k] > 0);
const HARD_GROUND = /stone|deepslate|cobble|andesite|diorite|granite|tuff|_ore|netherrack|basalt|blackstone|obsidian/;

// "come to me": walk if possible, but if they are below dig (getting a pickaxe first if the rock needs one),
// if above tower up. Everything is re-evaluated each cycle, so tools and blocks are fetched only when really needed.
function planCome(reg, goal, snap, hints) {
  const range = goal.range ?? 3.2;
  const p = findPlayer(snap, goal.player);
  if (p && p.dist <= range) return { done: true, remaining: 0 };
  if (!p) {
    const w = hints.radar?.[goal.player.toLowerCase()];
    if (w && !w.sameDimension) return { done: false, remaining: 1e3, watch: true, action: { skill: "chase_across_dimensions", args: { playerName: goal.player }, label: `follow ${goal.player} to ${w.dimension}` } };
    return { done: false, remaining: w ? Math.hypot(w.pos.x - snap.pos.x, w.pos.z - snap.pos.z) : 1e3, action: { skill: "follow", args: { player: goal.player, stopAt: range }, label: `come to ${goal.player}`, requires: boatNeeded(snap, hints) ? BOAT_REQ : undefined } };
  }
  const dy = p.pos.y - snap.pos.y;
  const h = Math.hypot(p.pos.x - snap.pos.x, p.pos.z - snap.pos.z);
  const base = { done: false, remaining: p.dist, watch: true };
  const hard = hints.shaftHard ?? HARD_GROUND.test(snap.groundBlock);
  if (dy <= -3 && h < 14) return { ...base, action: { skill: "dig_to", args: { id: p.id }, label: `dig down to ${goal.player}`, requires: hard ? { tools: [{ category: "pickaxe", minTier: 1 }] } : undefined } };
  if (dy >= 3 && h < 8) return { ...base, action: { skill: "tower_to", args: { id: p.id }, label: `tower up to ${goal.player}`, requires: { blocks: Math.ceil(dy) + 2 } } };
  return { ...base, action: { skill: "follow", args: { player: goal.player, stopAt: range }, label: `come to ${goal.player}`, requires: boatNeeded(snap, hints) ? BOAT_REQ : undefined } };
}

// Cheap, opportunistic improvements while pursuing any goal: craft a better tool when the materials are
// already in the bag, and wear better armor. Returns an action or null.
const GEAR_CRAFTS = ["shield", "iron_chestplate", "iron_leggings", "iron_helmet", "iron_boots"];
const TOOL_UPGRADES = [["pickaxe", ["stone_pickaxe", "iron_pickaxe", "diamond_pickaxe"]], ["sword", ["stone_sword", "iron_sword", "diamond_sword"]], ["axe", ["stone_axe", "iron_axe"]]];
const ARMOR_RANK = ["leather", "golden", "chainmail", "iron", "diamond", "netherite"];
const armorRank = (n) => (n ? ARMOR_RANK.findIndex((a) => n.startsWith(a)) + 1 : 0);

const FOODS = ["cooked_beef", "cooked_porkchop", "cooked_mutton", "cooked_chicken", "cooked_rabbit", "cooked_cod", "cooked_salmon", "bread", "baked_potato", "apple", "carrot", "golden_apple", "melon_slice", "sweet_berries"];

// Is it even plausible that we can craft `item` soon? (cheap check so the full planner is not run for ~13 gear items every time)
function plausibleCraft(reg, inv, item) {
  const recipes = reg.recipes[item] || [];
  return recipes.some((r) => {
    const need = Object.keys(r.ingredients).filter((n) => !/(_planks|stick|_log)$/.test(n));      // the "special" ingredients (cobblestone, iron_ingot, leather...)
    return need.length ? need.every((n) => (inv[n] || 0) > 0) : Object.keys(r.ingredients).some((n) => (inv[n] || 0) > 0);
  });
}

function opportunistic(reg, snap, hints) {
  if (snap.gameMode === "creative") {   // nothing to maintain: only wear better armor if we hold some
    for (const [slot, suffix] of [["head", "_helmet"], ["chest", "_chestplate"], ["legs", "_leggings"], ["feet", "_boots"]]) {
      const best = Math.max(0, ...Object.keys(snap.inv).filter((k) => k.endsWith(suffix)).map(armorRank));
      if (best > armorRank(snap.armor?.[slot])) return { skill: "equip_gear", args: {}, label: "put on better armor", key: `armor:${slot}:${best}` };
    }
    return null;
  }
  // hungry with nothing to eat: sort out food before it becomes an emergency (like a player would)
  if (snap.food <= 9 && !FOODS.some((f) => snap.inv[f] > 0) && !snap.hostiles.some((h) => h.dist < 10) && !hints.noFoodRun) {
    const run = planHave(reg, { items: { cooked_beef: 4 } }, snap, hints);
    if (run.action) return { ...run.action, label: `I'm hungry and have no food: ${run.action.label}`, key: "foodrun" };
  }
  // dark and holding torches: light the place up (also keeps mobs from spawning around the work site)
  if (snap.light <= 3 && snap.inv.torch > 0 && !hints.recentTorch) return { skill: "place_item", args: { item: "torch" }, label: "it's dark - placing a torch", key: `torch:${Math.floor(snap.pos.x / 6)},${Math.floor(snap.pos.z / 6)},${Math.floor(snap.pos.y / 4)}` };
  // nearly full inventory: crafted/mined items would be dropped on the ground
  if (Object.keys(snap.inv).length >= 33) return { skill: "tidy", args: {}, label: "inventory is almost full - dropping junk", key: `tidy:${Object.keys(snap.inv).length}` };
  for (const [cat, ladder] of TOOL_UPGRADES) {
    const cur = Math.max(0, ...Object.keys(snap.inv).filter((k) => reg.toolCategory(k) === cat && snap.inv[k] > 0).map((k) => reg.tierOf(k)));
    for (const target of ladder) {
      if (reg.tierOf(target) <= cur) continue;
      if (!plausibleCraft(reg, snap.inv, target)) continue;
      const plan = planAcquire(reg, snap.inv, { [target]: 1 }, { stations: hints.stations, knownBlocks: hints.knownBlocks, avoid: hints.avoid, allowHunt: false, maxDepth: 4 });
      if (plan.ok && plan.steps.length && plan.steps.length <= 3 && plan.steps.every((x) => x.op === "craft" || x.op === "place_station")) {
        const step = plan.steps[0];
        return { skill: STEP_SKILL[step.op], args: step, label: `upgrade ${cat}: ${describeStep(step)}`, key: `upgrade:${target}` };
      }
    }
  }
  for (const item of GEAR_CRAFTS) {
    const slotName = item === "shield" ? null : { chestplate: "chest", leggings: "legs", helmet: "head", boots: "feet" }[item.split("_")[1]];
    const wearing = slotName ? armorRank(snap.armor?.[slotName]) >= armorRank(item) : (snap.hasShield || snap.inv.shield > 0);
    if (wearing || (snap.inv[item] || 0) > 0) continue;
    if (!plausibleCraft(reg, snap.inv, item)) continue;
    const plan = planAcquire(reg, snap.inv, { [item]: 1 }, { stations: hints.stations, knownBlocks: hints.knownBlocks, avoid: hints.avoid, allowHunt: false, maxDepth: 4 });
    if (plan.ok && plan.steps.length && plan.steps.length <= 2 && plan.steps.every((x) => x.op === "craft")) return { skill: "craft", args: plan.steps[0], label: `craft ${item.replace(/_/g, " ")}`, key: `gear:${item}` };
  }
  for (const [slot, suffix] of [["head", "_helmet"], ["chest", "_chestplate"], ["legs", "_leggings"], ["feet", "_boots"]]) {
    const best = Math.max(0, ...Object.keys(snap.inv).filter((k) => k.endsWith(suffix)).map(armorRank));
    if (best > armorRank(snap.armor?.[slot])) return { skill: "equip_gear", args: {}, label: "put on better armor", key: `armor:${slot}:${best}` };
  }
  const hasWeaponNow = hasWeapon(snap);
  if (hasWeaponNow && !/(_sword|_axe)$/.test(snap.held || "") && !snap.hostiles.length === false) return null;
  return null;
}

// Cheapest sensible wall material: what we already carry plenty of, else stone if we can mine it, else dirt.
function pickHouseMaterial(snap) {
  const planks = Object.entries(snap.inv).filter(([k]) => /_planks$/.test(k)).reduce((n, [, v]) => n + v, 0);
  const cands = [["cobblestone", snap.inv.cobblestone || 0], ["dirt", snap.inv.dirt || 0], ["oak_planks", planks]].filter(([, n]) => n >= 70).sort((a, b) => b[1] - a[1]);
  if (cands.length) return cands[0][0];
  return hasPickaxe(snap) ? "cobblestone" : "dirt";
}

function planBuildHouseGoal(reg, goal, snap, hints) {
  if (!goal.material && !hints.house?.material) goal.material = pickHouseMaterial(snap); // sticky for the whole build
  const r = planBuildHouse({ ...goal, type: "build", what: "house" }, snap, hints);
  if (!r.needs) return r;
  // any planks type satisfies "planks": fold them together before planning the shortfall
  const inv = { ...snap.inv };
  for (const k of Object.keys(inv)) if (/_planks$/.test(k) && k !== "oak_planks") { inv.oak_planks = (inv.oak_planks || 0) + inv[k]; delete inv[k]; }
  const wants = {};
  for (const [k, v] of Object.entries(r.needs)) wants[k] = (inv[k] || 0) + v;
  const acq = planHave(reg, { items: wants }, { ...snap, inv }, hints);
  if (acq.blocked) return acq;
  return { ...acq, remaining: acq.remaining + r.remaining, action: acq.action && { ...acq.action, label: `house materials: ${acq.action.label}` } };
}

// ---- cook N meals (any meat), optionally hand them to a player ----
const MEATS = { cow: "beef", pig: "porkchop", sheep: "mutton", chicken: "chicken", rabbit: "rabbit", mooshroom: "beef" };
const COOKED = ["cooked_beef", "cooked_porkchop", "cooked_mutton", "cooked_chicken", "cooked_rabbit", "cooked_cod", "cooked_salmon"];
function planCook(reg, goal, snap, hints) {
  const have = COOKED.reduce((n, k) => n + (snap.inv[k] || 0), 0);
  const delivered = goal.progress?.delivered || 0;
  const count = goal.count || 8;
  if (have >= count || (goal.progress?.cooked || 0) >= count) {
    if (!goal.deliverTo) return { done: true, remaining: 0 };
    if (delivered >= count) return { done: true, remaining: 0 };
    const item = COOKED.filter((k) => snap.inv[k]).sort((a, b) => snap.inv[b] - snap.inv[a])[0];
    const p = findPlayer(snap, goal.deliverTo);
    if (!item) return { done: true, remaining: 0 };
    return { done: false, remaining: 1 + (p ? p.dist / 10 : 5), action: { skill: "deliver", args: { player: goal.deliverTo, item, count: Math.min(snap.inv[item], count - delivered) }, label: `give ${item.replace(/_/g, " ")} to ${goal.deliverTo}` } };
  }
  // choose the meat: raw we already carry, else the animal that is closest, else beef
  const raw = Object.values(MEATS).find((m) => snap.inv[m] > 0);
  const animal = snap.entities.find((e) => e.kind === "food_animal" && MEATS[e.name]);
  const meat = raw || (animal ? MEATS[animal.name] : "beef");
  const cooked = reg.SMELTING[meat];
  const acq = planHave(reg, { items: { [cooked]: (snap.inv[cooked] || 0) + (count - have) } }, snap, hints);
  return acq.blocked ? acq : { ...acq, remaining: acq.remaining + (goal.deliverTo ? 2 : 0) };
}

// ---- place a chest / crafting table / furnace / any block on request ----
function planPlace(reg, goal, snap, hints) {
  if ((goal.progress?.placed || 0) >= 1) return { done: true, remaining: 0 };
  if ((snap.inv[goal.item] || 0) >= 1) return { done: false, remaining: 1, action: { skill: "place_item", args: { item: goal.item, near: goal.near }, label: `place ${goal.item.replace(/_/g, " ")}` } };
  const acq = planHave(reg, { items: { [goal.item]: 1 } }, snap, hints);
  return acq.blocked ? acq : { ...acq, remaining: acq.remaining + 1 };
}

// ---- go back for dropped gear after dying ----
function planRecover(reg, goal, snap) {
  if (snap.dimension !== goal.dimension || snap.t > goal.deadline) return { done: true, remaining: 0 };
  // a few passes are enough; items that cannot be picked up must not keep us here forever
  if ((goal.progress?.collectRuns || 0) >= 4) return { done: true, remaining: 0 };
  const near = snap.items.filter((i) => i.dist < 18);
  // once drops are in sight, keep collecting (no ping-pong back to the death spot); only travel when none are visible
  if (near.length) return { done: false, remaining: near.length * 5 + near[0].dist, action: { skill: "collect", args: { accept: null }, label: "pick up my dropped gear" } };
  const d = Math.hypot(goal.pos.x - snap.pos.x, goal.pos.z - snap.pos.z);
  if (d > 7 && !(goal.progress?.arrived > 0)) return { done: false, remaining: d, action: { skill: "approach", args: { pos: goal.pos, range: 4 }, label: "go back for my dropped gear" } };
  return { done: true, remaining: 0 };
}

function planShelter(reg, goal, snap, hints) {
  if ((goal.progress?.sealed || 0) >= 1) return { done: true, remaining: 0 };
  return { done: false, remaining: 1, action: { skill: "shelter", args: {}, label: "wall myself in", requires: { blocks: 9 } } };
}

function planChest(reg, goal, snap) {
  if ((goal.progress?.chestDone || 0) >= 1) return { done: true, remaining: 0 };
  return { done: false, remaining: 1, action: { skill: "chest", args: { action: goal.action || "take", items: goal.items || "all", near: goal.anchor ? { x: goal.anchor.x, y: goal.anchor.y, z: goal.anchor.z } : null }, label: `${goal.action === "put" ? "put items in" : goal.action === "list" ? "look inside" : "open and empty"} the chest` } };
}

// ---- build anything: the AI designs a spec (once), then we gather what is missing and build + verify it ----
function planStructure(reg, goal, snap, hints) {
  if (hints.structureVerified) return { done: true, remaining: 0 };
  if (!goal.spec && goal.type === "assist") return { done: false, remaining: 60, action: { skill: "join_build", args: { owner: goal.owner }, label: `join ${goal.owner}'s build` } };
  if (!goal.spec && goal.type === "fixup") return { done: false, remaining: 60, action: { skill: "plan_fixup", args: { repair: goal.repair !== false, clean: goal.clean !== false, fill: goal.fill !== false }, label: "look over what needs fixing" } };
  if (!goal.spec && goal.type === "bridge") return { done: false, remaining: 60, action: { skill: "design_bridge", args: { where: goal.where || "facing", width: goal.width || 3, material: goal.material || null, pos: goal.pos || null, requester: goal.requester || null }, label: "plan the bridge route" } };
  if (!goal.spec) return { done: false, remaining: 60, action: { skill: "design_structure", args: { request: goal.request }, label: `design: ${goal.request}` } };
  const compiled = goal._compiled || (goal._compiled = Struct.compileStructure(goal.spec, reg));
  if (!compiled.ok) { goal.spec = null; goal._compiled = null; return { done: false, remaining: 60, action: { skill: "design_structure", args: { request: goal.request }, label: `redesign: ${goal.request}` } }; }
  const missing = hints.structureMissing || compiled.cells.filter((c) => c.kind !== "air");
  const total = missing.length;
  // PROGRESSIVE: build with what the bag covers, gather the next small batch only when it runs dry (never "collect everything first")
  // the builder reported exactly what it lacked last time: get that first (otherwise "buildable" other blocks hide the gap forever)
  const lacking = Object.entries(goal.needs || {}).filter(([k, n]) => (snap.inv[k] || 0) < Math.min(n, 64));
  if (lacking.length) {
    const want = Object.fromEntries(lacking.map(([k, n]) => [k, Math.max(n, 16)]));
    const acq = planHave(reg, { items: want }, snap, hints);
    if (!acq.blocked && !acq.done && acq.action) return { ...acq, remaining: acq.remaining + missing.length, action: { ...acq.action, label: `missing for ${goal.spec.name}: ${acq.action.label}` } };
  }
  const prog = Struct.progressivePlan(missing, snap.inv, { batch: 40 });
  const minBatch = Math.min(16, Math.max(1, prog.total));
  const buildNow = prog.buildable >= minBatch || (prog.buildable > 0 && !Object.keys(prog.wants).length);
  const needsTool = (kind) => prog.kinds.includes(kind);
  const wants = { ...prog.wants };
  delete wants.undefined;
  if (!buildNow) {
    if (needsTool("till") && !Object.keys(snap.inv).some((k) => /_hoe$/.test(k) && snap.inv[k] > 0)) wants.wooden_hoe = 1;
    if (needsTool("water") && !(snap.inv.water_bucket > 0) && !(snap.inv.bucket > 0)) wants.bucket = 1;
    if (needsTool("path") && !Object.keys(snap.inv).some((k) => /_shovel$/.test(k) && snap.inv[k] > 0)) wants.wooden_shovel = 1;
    if (Object.keys(wants).length) {
      const acq = planHave(reg, { items: wants }, snap, hints);
      if (acq.blocked) return acq;
      if (!acq.done && acq.action) return { ...acq, remaining: acq.remaining + total, action: { ...acq.action, label: `next batch for ${goal.spec.name}: ${acq.action.label}` } };
    }
  }
  return { done: false, remaining: total, action: { skill: "build_structure", args: { spec: goal.spec, id: goal.sid || goal.id }, label: `build ${goal.spec.name} (${total} blocks to go)` } };
}

function planHarvest(reg, goal, snap, hints) {
  if ((goal.progress?.harvestRuns || 0) >= 2 && !(hints.ripeCrops > 0)) return { done: true, remaining: 0 };
  if ((goal.progress?.harvestRuns || 0) >= 1 && !(hints.ripeCrops > 0)) return { done: true, remaining: 0 };
  return { done: false, remaining: 10 + (hints.ripeCrops || 0), action: { skill: "harvest", args: { radius: goal.radius || 28 }, label: "harvest ripe crops and replant" } };
}

const handlers = {
  tell: (reg, goal) => ((goal.progress?.told || 0) >= 1 ? { done: true, remaining: 0 } : { done: false, remaining: 1, action: { skill: "tell", args: { agent: goal.agent, command: goal.command }, label: `tell ${goal.agent}: ${goal.command}` } }),
  harvest: planHarvest,
  build: planStructure,
  bridge: planStructure,
  assist: planStructure,
  fixup: planStructure,
  chest: planChest,
  freeform: () => ({ blocked: "freeform tasks are handled by the AI director", remaining: 1e6 }),
  have: planHave,
  cook: planCook,
  place: planPlace,
  recover: planRecover,
  shelter: planShelter,
  build_house: planBuildHouseGoal,
  goto: planGoto,
  set_spawn: planSetSpawn,
  kill: planKill,
  give: planGive,

  follow(reg, goal, snap) {
    return { done: false, remaining: 0, action: { skill: "follow", args: { player: goal.player }, label: `follow ${goal.player}` }, ongoing: true };
  },

  come: planCome,

  collect(reg, goal, snap) {
    const items = snap.items.filter((i) => !goal.accept || !i.item || goal.accept.includes(i.item));
    if (!items.length) return { done: true, remaining: 0 };
    return { done: false, remaining: items.length * 5 + items[0].dist, action: { skill: "collect", args: { accept: goal.accept }, label: "collect drops" } };
  },

  // ---- riding: get on / get off / fly a happy ghast somewhere ----
  mount(reg, goal, snap, hints) {
    const want = String(goal.target || "").toLowerCase().replace(/\s+/g, "_");
    if (snap.vehicle && (!want || want === "nearest" || snap.vehicle.includes(want) || (want === "ghast" && snap.vehicle === "happy_ghast"))) return { done: true, remaining: 0 };
    // a happy ghast only carries a rider once it wears a harness: bring one (crafted / from the creative inventory) before getting on
    const gh = snap.entities.filter((e) => e.name === "happy_ghast").sort((a, b) => a.dist - b.dist)[0];
    const asksGhast = !want || want === "nearest" || want === "ghast" || want === "happy_ghast";
    if (gh && !gh.harnessed && asksGhast && !Object.keys(snap.inv).some((k) => /_harness$/.test(k) && snap.inv[k] > 0)) {
      const acq = planHave(reg, { items: { white_harness: 1 } }, snap, hints);
      if (acq.action) return { ...acq, remaining: acq.remaining + 5, action: { ...acq.action, label: `harness for the ghast: ${acq.action.label}` } };
    }
    return { done: false, remaining: 5, action: { skill: "mount_ride", args: { target: goal.target || null, withPlayer: goal.withPlayer || null }, label: `get on ${goal.withPlayer ? goal.withPlayer + "'s ride" : goal.target || "the nearest ride"}` } };
  },
  dismount(reg, goal, snap) {
    if (!snap.vehicle) return { done: true, remaining: 0 };
    return { done: false, remaining: 3, action: { skill: "dismount_ride", args: { land: true }, label: `get off the ${String(snap.vehicle).replace(/_/g, " ")}` } };
  },
  drive(reg, goal, snap) {
    if ((goal.progress?.arrived || 0) >= 1 && (!goal.land || !snap.vehicle)) return { done: true, remaining: 0 };
    const to = goal.to ? `${Math.round(goal.to.x)} ${Math.round(goal.to.z)}` : goal.player ? `${goal.player}` : "there";
    return { done: false, remaining: 10, action: { skill: "drive_ghast", args: { pos: goal.to || null, player: goal.player || null, land: !!goal.land, hover: goal.hover ?? 2 }, label: `fly the ghast to ${to}` } };
  },

  // wait out the night in a pit (done at first light)
  hideout(reg, goal, snap) {
    const night = snap.dayTime != null && snap.dayTime >= 12700 && snap.dayTime <= 22800;
    if (!night || (goal.progress?.hid || 0) >= 1) return { done: true, remaining: 0 };
    return { done: false, remaining: 1, action: { skill: "burrow", args: {}, label: "hide in a pit until daylight" } };
  },

  idle() { return { done: false, remaining: 0, action: null, ongoing: true }; }
};

// ---- generic prerequisite resolution ---------------------------------------------------------------
// Any action may declare what it needs: { tools:[{category,minTier}], items:{name:n}, blocks:n, weapon:true, soft:true }.
// If something is missing, the missing pieces become an ordinary acquire plan that runs first; the original
// action returns automatically once the requirements are met (the plan is recomputed every cycle).
const TOOL_LADDER = ["wooden", "stone", "iron", "diamond"];
const SCAFFOLD = ["dirt", "cobblestone", "cobbled_deepslate", "netherrack", "stone", "andesite", "diorite", "granite", "tuff", "oak_planks", "sand"];

function unmetWants(reg, snap, req) {
  const wants = {};
  for (const t of req.tools || []) {
    const min = t.minTier || 1;
    const have = Object.keys(snap.inv).some((k) => reg.toolCategory(k) === t.category && reg.tierOf(k) >= min && snap.inv[k] > 0);
    if (!have) wants[`${TOOL_LADDER[Math.min(Math.max(min, 1), 4) - 1]}_${t.category}`] = 1;
  }
  for (const [item, n] of Object.entries(req.items || {})) if ((snap.inv[item] || 0) < n) wants[item] = n;
  if (req.blocks) {
    const total = SCAFFOLD.reduce((n, k) => n + (snap.inv[k] || 0), 0);
    if (total < req.blocks) wants.dirt = (snap.inv.dirt || 0) + (req.blocks - total);
  }
  if (req.weapon && !hasWeapon(snap)) wants.stone_sword = 1;
  return wants;
}

function withPrerequisites(reg, r, snap, hints) {
  const req = r.action?.requires;
  if (!req || req.soft) return r;
  const wants = unmetWants(reg, snap, req);
  if (!Object.keys(wants).length) return r;
  const acq = planHave(reg, { items: wants }, snap, hints);
  if (!acq.action) return r; // cannot satisfy: attempt the action anyway, the stall ladder handles it
  const why = Object.keys(wants).map((k) => k.replace(/_/g, " ")).join(", ");
  return { ...acq, remaining: (r.remaining || 0) + acq.remaining, watch: r.watch, action: { ...acq.action, label: `to ${r.action.label} I need ${why}: ${acq.action.label}` } };
}

function plan(reg, goal, snap, hints = {}) {
  const h = handlers[goal.type];
  if (!h) return { blocked: `unknown goal type ${goal.type}`, remaining: 1e6 };
  return withPrerequisites(reg, h(reg, goal, snap, hints), snap, hints);
}

module.exports = { COOKED, HARD_GROUND, plan, findPlayer, handlers, STEP_SKILL, hasWeapon, expandTargets, opportunistic };
