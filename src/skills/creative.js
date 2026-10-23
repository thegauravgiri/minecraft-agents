// Creative mode: items come straight from the creative inventory, the bot can fly, blocks break instantly (no drops),
// and it cannot be hurt or starve. Everything survival-style (gathering, crafting, hunting, boats, fleeing) is pointless here.
const { Vec3 } = require("vec3");
const { sleep, throwIfAborted, ok, fail, log } = require("../runtime/util");

const isCreative = (bot) => bot.game?.gameMode === "creative";

function freeSlot(bot) {
  for (const i of [...Array(9).keys()].map((k) => 36 + k)) if (!bot.inventory.slots[i]) return i;       // hotbar first
  for (let i = 9; i <= 35; i++) if (!bot.inventory.slots[i]) return i;
  return -1;
}

/** Creative inventories are free to refill: when full, bin the stack we need least (never something being requested now). */
async function makeRoom(ctx, wanted) {
  const { bot } = ctx;
  const keep = /pickaxe|axe$|shovel|sword|sword|helmet|chestplate|leggings|boots|shield|bucket|bow$|boat/;
  const need = new Set();                                          // blocks the current build still uses stay put
  for (const c of ctx.agent?.goal?._compiled?.cells || []) if (c.block) need.add(c.block);
  let best = -1, bestScore = -1;
  for (let i = 9; i <= 35; i++) {                                  // main inventory only; hotbar stays
    const it = bot.inventory.slots[i];
    if (!it || wanted[it.name] || need.has(it.name)) continue;
    const score = (keep.test(it.name) ? 0 : 100) + (64 - it.count);   // junk and small stacks go first
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0) return -1;
  try { await bot.creative.setInventorySlot(best, null); } catch { return -1; }
  log("creative", `inventory full - binned ${best}`);
  return best;
}

/** Take items from the creative inventory: {item_name: count}. Tops up existing stacks, then fills free slots. */
async function giveItems(ctx, { items }) {
  const { bot, signal } = ctx;
  if (!isCreative(bot)) return fail("not_creative");
  const Item = require("prismarine-item")(bot.registry);
  const given = {};
  for (const [name, want] of Object.entries(items || {})) {
    const def = bot.registry.itemsByName[name];
    if (!def || !(want > 0)) continue;
    let left = Math.min(Math.ceil(want), 2304);
    const stack = def.stackSize || 64;
    while (left > 0) {
      throwIfAborted(signal);
      let slot = -1;
      for (let i = 9; i <= 44; i++) { const it = bot.inventory.slots[i]; if (it && it.name === name && it.count < stack) { slot = i; break; } }
      const cur = slot >= 0 ? bot.inventory.slots[slot] : null;
      if (slot < 0) slot = freeSlot(bot);
      if (slot < 0) slot = await makeRoom(ctx, items);
      if (slot < 0) return Object.keys(given).length ? ok({ given, partial: "inventory_full" }) : fail("inventory_full");
      const add = Math.min(left, stack - (cur?.count || 0));
      try { await bot.creative.setInventorySlot(slot, new Item(def.id, (cur?.count || 0) + add)); }
      catch (e) { if (e.name === "AbortError") throw e; log("creative", `give ${name} failed: ${e.message}`); return fail("give_failed:" + e.message); }
      left -= add; given[name] = (given[name] || 0) + add;
    }
  }
  return ok({ given });
}

const solidAt = (bot, p) => { const b = bot.blockAt(p); return !!b && b.boundingBox === "block"; };

/** Builder helper: hover beside a cell (never inside its column) so it can be placed/dug from the air, like a creative player does. */
async function hoverNear(ctx, cell, maxDist = 4.2) {
  const { bot } = ctx;
  const spots = [];
  for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2], [3, 0], [-3, 0], [0, 3], [0, -3]])
    for (const dy of [1, 2, 0, 3]) spots.push(new Vec3(cell.x + 0.5 + dx, cell.y + dy, cell.z + 0.5 + dz));
  const here = bot.entity.position;
  spots.sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
  const free = spots.find((p) => !solidAt(bot, p) && !solidAt(bot, p.offset(0, 1, 0)) && !solidAt(bot, p.offset(0, 1.7, 0)));
  if (!free) return false;
  const okFly = await flyTo(ctx, free.x, free.y, free.z, { keep: true });          // over the walls, not through them
  return okFly;
}

/** Fly to a point: climb to a cruising altitude above the terrain, cross, descend. Abortable; stops at walls. */
async function flyTo(ctx, tx, ty, tz, { keep = false, direct = false } = {}) {
  const { bot, signal } = ctx;
  if (!isCreative(bot)) return false;
  const start = bot.entity.position.clone();
  // cruising altitude: 3 above the highest solid block we would pass over
  let top = Math.max(start.y, ty);
  const span = Math.hypot(tx - start.x, tz - start.z);
  for (let t = 0; t <= span; t += 3) {
    const f = span ? t / span : 0, x = Math.floor(start.x + (tx - start.x) * f), z = Math.floor(start.z + (tz - start.z) * f);
    for (let y = Math.floor(start.y) + 50; y > Math.floor(start.y) - 30; y--) { if (solidAt(bot, new Vec3(x, y, z))) { top = Math.max(top, y + 1); break; } }
  }
  const cruise = Math.ceil(top + 3);
  const hi = Math.max(start.y, ty);
  const legs = direct ? [new Vec3(start.x, hi, start.z), new Vec3(tx, hi, tz), new Vec3(tx, ty, tz)] : [new Vec3(start.x, cruise, start.z), new Vec3(tx, cruise, tz), new Vec3(tx, ty, tz)];
  let digs = 0;
  try {
    bot.creative.startFlying();
    const deadline = Date.now() + 20000 + (span / 6) * 1000;       // generous, but never forever
    let bestLeft = Infinity, bestAt = Date.now();
    for (const dest of legs) {
      bestLeft = Infinity; bestAt = Date.now();
      for (;;) {
        throwIfAborted(signal);
        ctx.beat?.();                                                // long flights are not hangs
        if (Date.now() > deadline) return false;
        const p = bot.entity.position;
        const vec = dest.minus(p), mag = Math.hypot(vec.x, vec.y, vec.z);
        if (mag <= 0.6) break;
        if (mag < bestLeft - 0.8) { bestLeft = mag; bestAt = Date.now(); }
        else if (Date.now() - bestAt > 4000) { if (process.env.BUILD_TRACE) log("fly", `no progress toward ${tx},${ty},${tz} (rubber-banded or unloaded chunk?)`); return false; }
        const nowT = Date.now(); const dt = Math.min(0.25, (nowT - (ctx._flyT || nowT - 50)) / 1000); ctx._flyT = nowT;   // fixed speed (~11 b/s) however late the timer fires
        const step = vec.scaled(Math.min(Math.max(0.3, 11 * dt), 1.2, mag) / mag);
        const next = p.plus(step);
        const hit = [next, next.offset(0, 1, 0), next.offset(0, 1.7, 0)].find((q) => solidAt(bot, q));
        if (hit) {                                                 // boxed in (often by our own half-built wall): a creative player just breaks out; the builder re-places it later
          if (process.env.BUILD_TRACE) log("fly", `blocked by ${bot.blockAt(hit)?.name}@${hit.floored()} from ${p.floored()} to ${tx},${ty},${tz} direct=${direct}`);
          if (direct || digs++ >= 6) return false;
          try { await bot.dig(bot.blockAt(hit), true); } catch { return false; }
          continue;
        }
        bot.physics.gravity = 0; bot.entity.velocity = new Vec3(0, 0, 0);
        p.add(step);
        await sleep(50, signal);
      }
    }
    return true;
  } finally { ctx._flyT = 0; if (!keep) { try { bot.creative.stopFlying(); } catch { /* not flying */ } } }
}

/** Creative building, one cell: hover just above it (above everything placed so far, which is built bottom-up), then place/dig by hand. */
async function hoverAbove(ctx, cell, { side = false } = {}) {
  const { bot } = ctx;
  const here = bot.entity.position;
  const near = (p) => Math.hypot(here.x - p.x, here.z - p.z) < 2.2 && Math.abs(here.y - p.y) < 1.2;
  const free = (p) => !solidAt(bot, p) && !solidAt(bot, p.offset(0, 1, 0)) && !solidAt(bot, p.offset(0, 1.7, 0));
  // a way in from above: nothing solid in the column over the spot (so the descent does not run into a roof)
  const openAbove = (p) => { for (let dy = 2; dy <= 24; dy++) if (solidAt(bot, p.offset(0, dy, 0))) return false; return true; };
  const cands = side ? [] : [new Vec3(cell.x + 0.5, cell.y + 2.2, cell.z + 0.5)];
  for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2], [3, 0], [-3, 0], [0, 3], [0, -3]]) for (const dy of [0.2, 1.2, 2.2]) cands.push(new Vec3(cell.x + 0.5 + dx, cell.y + dy, cell.z + 0.5 + dz));
  const good = cands.filter((p) => free(p) && openAbove(p));
  const inCell = Math.floor(here.x) === cell.x && Math.floor(here.z) === cell.z && here.y > cell.y - 1.9 && here.y < cell.y + 1;
  const reach = here.offset(0, 1.62, 0).distanceTo(new Vec3(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5));
  if (!inCell && reach <= 4.0 && good.some(near)) return true;          // close enough to really reach it (the server allows ~4.5 from the eyes)
  if (!good.length) return false;
  good.sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
  const t = good[0];
  const simple = Math.abs(here.y - t.y) < 6 && Math.hypot(here.x - t.x, here.z - t.z) < 14;
  return flyTo(ctx, t.x, t.y, t.z, { keep: true, direct: simple && cands[0] === t });
}

module.exports = { hoverAbove, isCreative, giveItems, flyTo, hoverNear, makeRoom, freeSlot };
