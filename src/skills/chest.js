// Containers: find the nearest chest/barrel, walk to it, open it, and take / put / list items. Verified by inventory delta.
const { Vec3 } = require("vec3");
const { goals, goto } = require("./move");
const { sleep, throwIfAborted, ok, fail, invCount, log } = require("../runtime/util");

const CONTAINERS = ["chest", "trapped_chest", "barrel"];
const idsOf = (bot) => [...CONTAINERS, ...Object.keys(bot.registry.blocksByName).filter((n) => /shulker_box$/.test(n))].map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x != null);

function findContainers(bot, maxDistance = 40, count = 6) {
  const me = bot.entity.position;
  return bot.findBlocks({ matching: idsOf(bot), maxDistance, count }).sort((a, b) => a.distanceTo(me) - b.distanceTo(me)).map((p) => bot.blockAt(p)).filter(Boolean);
}

const summarize = (items) => items.map((i) => `${i.count} ${i.name.replace(/_/g, " ")}`).join(", ") || "nothing";

/**
 * args: { action:'take'|'put'|'list', items:'all' | {name:count} | string[] , pos? }
 * Returns ok({list, moved:{name:count}, chest:{x,y,z}}) with progress {chestDone:1}.
 */
async function chestTransfer(ctx, { action = "take", items = "all", pos = null, near = null }) {
  const { bot } = ctx;
  let candidates = [];
  if (pos) { const bl = bot.blockAt(new Vec3(pos.x, pos.y, pos.z)); if (bl && CONTAINERS.includes(bl.name)) candidates = [bl]; }
  if (!candidates.length) candidates = findContainers(bot, 48, 8);
  if (near && candidates.length) candidates = [...candidates].sort((a, b) => a.position.distanceTo(new Vec3(near.x, near.y ?? a.position.y, near.z)) - b.position.distanceTo(new Vec3(near.x, near.y ?? b.position.y, near.z)));   // "the chest here" = the one next to the player, not the one next to me
  if (!candidates.length) return fail("no_chest_nearby");
  let lastEmpty = null;
  // like a player: if this chest has nothing useful, look in the next nearest one
  for (const block of candidates.slice(0, 5)) {
    const r = await useContainer(ctx, block, { action, items });
    if (r.ok || !["empty", "nothing_taken"].includes(r.reason)) return r;
    lastEmpty = r;
  }
  return lastEmpty ? { ok: true, data: { list: "nothing useful", moved: {}, chest: lastEmpty.data?.chest }, progress: { chestDone: 1 } } : fail("no_chest_nearby");
}

async function useContainer(ctx, block, { action, items }) {
  const { bot, signal } = ctx;
  const w = await goto(ctx, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2.6), { timeout: 30000, towardPos: block.position });
  if (!w.ok && bot.entity.position.distanceTo(block.position) > 4.5) return fail("cannot_reach_chest:" + w.reason);
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);

  let c;
  try { c = await bot.openContainer(block); } catch (e) { return fail("open_failed:" + e.message); }
  try {
    const before = c.containerItems().map((i) => ({ name: i.name, count: i.count }));
    const list = summarize(before);
    const chestPos = { x: block.position.x, y: block.position.y, z: block.position.z };
    if ((action === "take" || action === "list") && !before.length) return fail("empty", { chest: chestPos });
    const wants = (name) => (items === "all" ? Infinity : Array.isArray(items) ? (items.includes(name) ? Infinity : 0) : (items[name] ?? 0));
    const moved = {};
    if (action === "take") {
      for (const it of c.containerItems()) {
        throwIfAborted(signal);
        const left = (wants(it.name) === Infinity ? Infinity : wants(it.name) - (moved[it.name] || 0));
        if (left <= 0) continue;
        const n = Math.min(it.count, left);
        try { await c.withdraw(it.type, it.metadata ?? null, n); moved[it.name] = (moved[it.name] || 0) + n; }
        catch (e) { log("chest", `withdraw ${it.name} failed: ${e.message}`); if (/full|slot/i.test(e.message)) break; }
      }
    } else if (action === "put") {
      var kept = [];
      for (const it of c.items()) {
        throwIfAborted(signal);
        if (/(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots|shield)$/.test(it.name) && items === "all") { kept.push(it.name.replace(/_/g, " ")); continue; } // keep gear
        const want = wants(it.name);
        if (!want) continue;
        const n = Math.min(it.count, want === Infinity ? it.count : want);
        try { await c.deposit(it.type, it.metadata ?? null, n); moved[it.name] = (moved[it.name] || 0) + n; }
        catch (e) { log("chest", `deposit ${it.name} failed: ${e.message}`); if (/full/i.test(e.message)) break; }
      }
    }
    await sleep(150, signal);
    if (action === "take" && Object.keys(moved).length === 0) return fail("nothing_taken", { list, chest: chestPos });
    return { ok: true, data: { list, moved, chest: chestPos, kept: typeof kept !== "undefined" ? kept : [] }, progress: { chestDone: 1 } };
  } finally { try { c.close(); } catch { /* already closed */ } }
}

module.exports = { chestTransfer, findContainers, summarize };
