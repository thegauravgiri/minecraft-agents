// Pure tech-tree planner: (inventory, wants, world hints) -> ordered steps.
// Deterministic and side-effect free, so it is cheap to re-run after every step.
// That re-planning is what keeps the bot honest: the plan is always f(real state).
const MAX_DEPTH = 9;
const BUDGET_MS = 250;      // a plan must never freeze a bot's event loop: past this, search narrows to the first candidate
const INF = 1e9;

const COST = { gatherBase: 4, gatherPerBlock: 2, craft: 1, smelt: 3, hunt: 6, unknownBlock: 30 };

function cloneInv(inv) { return { ...inv }; }
const count = (inv, n) => inv[n] || 0;

function bestFuel(reg, inv) {
  for (const f of reg.FUEL_ITEMS) if (count(inv, f) > 0) return f;
  for (const n of reg.names.planks) if (count(inv, n) > 0) return n;
  for (const n of reg.names.logs) if (count(inv, n) > 0) return n;
  return null;
}

/**
 * @param reg    registry from makeRegistry()
 * @param inv    { itemName: count }
 * @param wants  { itemName: count }  -> total desired in inventory afterwards
 * @param ctx    { stations:{crafting_table,furnace}, knownBlocks:Set, avoid:Set, allowHunt }
 * @returns { ok, steps, cost, blockers, inv }
 */
const MEMO = new Map();
const MEMO_MAX = 200;

function planAcquire(reg, inv, wants, ctx = {}) {
  // pure function of its inputs: identical consecutive calls (every cycle, every monitor tick) are answered from cache
  const key = JSON.stringify([reg.version, Object.entries(inv).sort(), Object.entries(wants).sort(), ctx.stations || null, ctx.knownBlocks ? [...ctx.knownBlocks].sort() : null, ctx.avoid ? [...ctx.avoid].sort() : null, ctx.allowHunt]);
  const hit = MEMO.get(key);
  if (hit) return hit;
  const result = planAcquireUncached(reg, inv, wants, ctx);
  if (MEMO.size >= MEMO_MAX) MEMO.delete(MEMO.keys().next().value);
  MEMO.set(key, result);
  return result;
}

function planAcquireUncached(reg, inv, wants, ctx = {}) {
  ctx = { ...ctx, _deadline: Date.now() + BUDGET_MS };
  const state = { inv: cloneInv(inv), steps: [], cost: 0, tableAvail: !!ctx.stations?.crafting_table, furnaceAvail: !!ctx.stations?.furnace };
  const blockers = [];
  for (const [item, n] of Object.entries(wants)) {
    const r = need(reg, state, item, n, ctx, new Set(), 0);
    if (r === INF) blockers.push(item);
  }
  return { ok: blockers.length === 0, steps: hoistGathers(state.steps), cost: state.cost, blockers, inv: state.inv };
}

// Several "get a log" steps become one trip: first occurrence carries the combined quantity.
function hoistGathers(steps) {
  const out = [];
  const firstByKey = new Map();
  for (const s of steps) {
    if (s.op !== "gather") { out.push(s); continue; }
    const key = s.accept.join(",") + "|" + (s.tool || "");
    const prev = firstByKey.get(key);
    if (prev) { prev.blocksNeeded += s.blocksNeeded; prev.count += s.count; }
    else { const c = { ...s }; firstByKey.set(key, c); out.push(c); }
  }
  return out;
}

// Mutates `state`; returns the cost added (or INF if impossible).
function need(reg, state, item, qty, ctx, visiting, depth) {
  const have = count(state.inv, item);
  if (have >= qty) return 0;
  if (depth > (ctx.maxDepth ?? MAX_DEPTH) || visiting.has(item) || !reg.hasItem(item)) return INF;
  const deficit = qty - have;
  visiting = new Set(visiting).add(item);

  const candidates = [];
  const tryCandidate = (build) => {
    if (candidates.length && Date.now() > ctx._deadline) return;          // out of time: keep what we already have
    const trial = { inv: cloneInv(state.inv), steps: [], cost: 0, tableAvail: state.tableAvail, furnaceAvail: state.furnaceAvail };
    const c = build(trial);
    if (c < INF) candidates.push({ trial, cost: trial.cost });
  };

  // 1. gather from blocks
  const ranked = [...(reg.blockSources[item] || [])].sort((a, b) => reg.rarity(a.block) - reg.rarity(b.block) || reg.woodRank(a.block) - reg.woodRank(b.block) || b.perBlock - a.perBlock);
  for (const src of ranked.slice(0, 5)) {
    tryCandidate((t) => gatherFrom(reg, t, item, deficit, src, ctx, visiting, depth));
  }
  // 2. craft
  const seen = new Set();
  for (const rec of (reg.recipes[item] || []).slice(0, 14)) {
    const sig = Object.entries(rec.ingredients).sort().join("|");
    if (seen.has(sig)) continue;
    seen.add(sig);
    tryCandidate((t) => craftVia(reg, t, item, deficit, rec, ctx, visiting, depth));
  }
  // 3. smelt
  for (const [input, out] of Object.entries(reg.SMELTING)) {
    if (out === item) tryCandidate((t) => smeltVia(reg, t, item, deficit, input, ctx, visiting, depth));
  }
  // 4. hunt
  if (ctx.allowHunt !== false && reg.mobSources[item]) {
    for (const m of reg.mobSources[item].slice(0, 3)) {
      tryCandidate((t) => {
        const kills = Math.ceil(deficit / m.perKill);
        t.steps.push({ op: "hunt", item, mobs: [m.mob], count: deficit, kills });
        t.cost += COST.hunt * kills;
        t.inv[item] = count(t.inv, item) + deficit;
        return t.cost;
      });
    }
  }

  if (!candidates.length) return INF;
  candidates.sort((a, b) => a.cost - b.cost);
  const best = candidates[0].trial;
  state.inv = best.inv; state.steps.push(...best.steps); state.cost += best.cost;
  state.tableAvail = best.tableAvail; state.furnaceAvail = best.furnaceAvail;
  return best.cost;
}

function gatherFrom(reg, t, item, deficit, src, ctx, visiting, depth) {
  const { block, perBlock } = src;
  if (ctx.avoid?.has(block)) return INF;
  const blocks = Math.ceil(deficit / perBlock);
  let toolItem = null;

  const harvest = reg.harvestToolsOf(block);
  if (harvest && harvest.length) {
    const held = harvest.find((h) => count(t.inv, h) > 0);
    if (held) toolItem = held;
    else {
      // cheapest feasible tool among those that can harvest this block
      const options = [...harvest].sort((a, b) => reg.tierOf(a) - reg.tierOf(b));
      let chosen = null;
      for (const opt of options.slice(0, 4)) {
        const trial = { inv: cloneInv(t.inv), steps: [], cost: 0, tableAvail: t.tableAvail, furnaceAvail: t.furnaceAvail };
        if (need(reg, trial, opt, 1, ctx, visiting, depth + 1) < INF) {
          if (!chosen || trial.cost < chosen.trial.cost) chosen = { opt, trial };
        }
      }
      if (!chosen) return INF;
      t.inv = chosen.trial.inv; t.steps.push(...chosen.trial.steps); t.cost += chosen.trial.cost;
      t.tableAvail = chosen.trial.tableAvail; t.furnaceAvail = chosen.trial.furnaceAvail;
      toolItem = chosen.opt;
    }
  } else {
    // Optional speed tool: only when it costs a handful of crafts from what we already hold.
    const cat = reg.toolCategoryForBlock(block);
    if (cat && blocks >= 3 && !Object.keys(t.inv).some((k) => reg.toolCategory(k) === cat && t.inv[k] > 0)) {
      const wood = `wooden_${cat}`;
      const trial = { inv: cloneInv(t.inv), steps: [], cost: 0, tableAvail: t.tableAvail, furnaceAvail: t.furnaceAvail };
      const onlyCrafts = () => trial.steps.every((s) => s.op === "craft");
      if (reg.hasItem(wood) && need(reg, trial, wood, 1, ctx, new Set([...visiting, item]), depth + 1) < INF && onlyCrafts()) {
        t.inv = trial.inv; t.steps.push(...trial.steps); t.cost += trial.cost;
        t.tableAvail = trial.tableAvail; t.furnaceAvail = trial.furnaceAvail;
        toolItem = wood;
      }
    }
  }

  let cost = COST.gatherBase + COST.gatherPerBlock * blocks + reg.rarity(block) * 3;
  if (ctx.knownBlocks && !ctx.knownBlocks.has(block)) cost += COST.unknownBlock;
  // any log type satisfies a log need; the runtime picks whichever is nearest
  const isLog = /_log$/.test(item);
  const accept = isLog ? reg.names.logs : [item];
  // every comparably-common block that drops this item (cobblestone <- stone, cobblestone, ...)
  const sameClass = (reg.blockSources[item] || []).filter((o) => reg.rarity(o.block) <= reg.rarity(block) && o.perBlock >= perBlock * 0.99 && !ctx.avoid?.has(o.block)).map((o) => o.block);
  const targets = isLog ? reg.names.logs.filter((l) => reg.rarity(l) === 0) : [...new Set([block, ...sameClass])];
  t.steps.push({ op: "gather", item, blocks: targets, accept, blocksNeeded: blocks, count: deficit, perBlock, tool: toolItem });
  t.cost += cost;
  t.inv[item] = count(t.inv, item) + blocks * perBlock;
  return t.cost;
}

function ensureStation(reg, t, station, ctx, visiting, depth) {
  const flag = station === "crafting_table" ? "tableAvail" : "furnaceAvail";
  if (t[flag] || count(t.inv, station) > 0) return 0;
  const c = need(reg, t, station, 1, ctx, visiting, depth + 1);
  if (c >= INF) return INF;
  t.steps.push({ op: "place_station", station });
  t[flag] = true;
  t.inv[station] = Math.max(0, count(t.inv, station) - 1);
  return c;
}

function craftVia(reg, t, item, deficit, rec, ctx, visiting, depth) {
  const times = Math.ceil(deficit / rec.result.count);
  if (rec.needsTable && ensureStation(reg, t, "crafting_table", ctx, visiting, depth) >= INF) return INF;
  for (const [ing, per] of Object.entries(rec.ingredients)) {
    if (need(reg, t, ing, per * times, ctx, visiting, depth + 1) >= INF) return INF;
  }
  for (const [ing, per] of Object.entries(rec.ingredients)) t.inv[ing] = count(t.inv, ing) - per * times;
  t.steps.push({ op: "craft", item, times, count: times * rec.result.count, table: rec.needsTable });
  t.cost += COST.craft * times;
  t.inv[item] = count(t.inv, item) + times * rec.result.count;
  return t.cost;
}

function smeltVia(reg, t, item, deficit, input, ctx, visiting, depth) {
  if (ensureStation(reg, t, "furnace", ctx, visiting, depth) >= INF) return INF;
  if (need(reg, t, input, deficit, ctx, visiting, depth + 1) >= INF) return INF;
  t.inv[input] = count(t.inv, input) - deficit;
  // fuel: 1 coal smelts 8; wood burns 1.5 items per plank-equivalent
  let fuel = bestFuel(reg, t.inv);
  const fuelUnits = fuel === "coal" || fuel === "charcoal" ? Math.ceil(deficit / 8) : Math.ceil(deficit / 1.5);
  if (!fuel || count(t.inv, fuel) < fuelUnits) {
    fuel = "coal";
    if (need(reg, t, "coal", Math.ceil(deficit / 8), ctx, visiting, depth + 1) >= INF) {
      // fall back to burning planks
      fuel = reg.names.planks.find((p) => reg.hasItem(p)) || "oak_planks";
      if (need(reg, t, fuel, Math.ceil(deficit / 1.5), ctx, visiting, depth + 1) >= INF) return INF;
    }
  }
  t.steps.push({ op: "smelt", input, item, count: deficit, fuel });
  t.cost += COST.smelt + deficit;
  t.inv[item] = count(t.inv, item) + deficit;
  return t.cost;
}

function describeStep(s) {
  switch (s.op) {
    case "gather": return `mine ${s.blocksNeeded}x ${s.blocks[0]}${s.tool ? ` with ${s.tool}` : ""}`;
    case "craft": return `craft ${s.count}x ${s.item}`;
    case "smelt": return `smelt ${s.count}x ${s.item}`;
    case "hunt": return `hunt ${s.mobs[0]} for ${s.item}`;
    case "place_station": return `place ${s.station}`;
    default: return s.op;
  }
}

module.exports = { planAcquire, describeStep, COST, INF };
