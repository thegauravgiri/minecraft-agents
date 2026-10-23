// Turns the live mineflayer bot into a plain-data Snapshot that the pure core can reason about.
const { invMap } = require("./util");

const HOSTILE = new Set([
  "zombie", "zombie_villager", "husk", "drowned", "skeleton", "stray", "bogged", "wither_skeleton", "creeper", "spider",
  "cave_spider", "enderman", "witch", "pillager", "vindicator", "evoker", "ravager", "vex", "phantom", "slime",
  "magma_cube", "silverfish", "blaze", "ghast", "hoglin", "piglin_brute", "zoglin", "guardian", "elder_guardian",
  "shulker", "endermite", "warden", "breeze", "creaking"
]);
const RANGED = new Set(["skeleton", "stray", "bogged", "pillager", "blaze", "ghast", "witch", "breeze"]);
const PASSIVE_FOOD = new Set(["cow", "pig", "sheep", "chicken", "rabbit", "mooshroom", "goat"]);

function normDim(d) {
  const s = String(d || "overworld").toLowerCase().replace(/^minecraft:/, "");
  if (s.includes("nether")) return "the_nether";
  if (s.includes("end")) return "the_end";
  return "overworld";
}

function entityKind(e) {
  if (e.type === "player") return "player";
  const n = e.name || "";
  if (n === "item" || n === "item_stack") return "item";
  if (n === "arrow" || n === "spectral_arrow" || n === "trident" || n === "fireball" || n === "small_fireball") return "projectile";
  if (HOSTILE.has(n) || e.type === "hostile") return "hostile";
  if (PASSIVE_FOOD.has(n)) return "food_animal";
  if (e.type === "animal" || e.type === "passive") return "passive";
  if (n.endsWith("boat") || n.endsWith("raft")) return "boat";
  if (e.type === "mob" || e.type === "living") return "mob";
  return "other";
}

function droppedItemName(e) {
  try { return e.getDroppedItem?.()?.name || null; } catch { return null; }
}

function armorSummary(bot) {
  const slots = { head: 5, chest: 6, legs: 7, feet: 8 };
  const out = {};
  for (const [k, s] of Object.entries(slots)) out[k] = bot.inventory.slots[s]?.name || null;
  return out;
}

function observe(bot, { radius = 32 } = {}) {
  const me = bot.entity;
  const p = me.position;
  const entities = [];
  for (const e of Object.values(bot.entities)) {
    if (e === me || !e.position) continue;
    const d = e.position.distanceTo(p);
    if (d > radius) continue;
    const kind = entityKind(e);
    entities.push({
      id: e.id, kind, name: e.name, username: e.username || null,
      pos: { x: e.position.x, y: e.position.y, z: e.position.z },
      vel: e.velocity ? { x: e.velocity.x, y: e.velocity.y, z: e.velocity.z } : null,
      dist: d, health: e.health ?? e.metadata?.[9] ?? null,
      item: kind === "item" ? droppedItemName(e) : null,
      held: kind === "player" ? e.heldItem?.name || null : null,
      ranged: RANGED.has(e.name),
      harnessed: e.name === "happy_ghast" ? !!(e.equipment || [])[6] : undefined
    });
  }
  entities.sort((a, b) => a.dist - b.dist);

  const feet = bot.blockAt(p);
  const eye = bot.blockAt(p.offset(0, 1.62, 0));
  const below = bot.blockAt(p.offset(0, -0.5, 0));
  const nameOf = (b) => b?.name || "air";

  return {
    t: Date.now(),
    pos: { x: p.x, y: p.y, z: p.z },
    yaw: me.yaw, pitch: me.pitch,
    vel: { x: me.velocity.x, y: me.velocity.y, z: me.velocity.z },
    onGround: me.onGround,
    health: bot.health ?? 20, food: bot.food ?? 20, saturation: bot.foodSaturation ?? 0,
    oxygen: bot.oxygenLevel ?? 20,
    dimension: normDim(bot.game?.dimension),
    inWater: nameOf(feet) === "water" || !!me.isInWater,
    headInWater: nameOf(eye) === "water",
    inLava: nameOf(feet) === "lava",
    onFire: !!(me.metadata && bot.entity.onFire),
    feetBlock: nameOf(feet), groundBlock: nameOf(below),
    light: feet?.light ?? 15, skyLight: feet?.skyLight ?? 15,
    inv: invMap(bot),
    held: bot.heldItem?.name || null,
    armor: armorSummary(bot),
    hasShield: bot.inventory.slots[45]?.name === "shield",
    entities,
    players: entities.filter((e) => e.kind === "player"),
    hostiles: entities.filter((e) => e.kind === "hostile"),
    items: entities.filter((e) => e.kind === "item"),
    gameMode: bot.game?.gameMode,
    vehicle: bot.vehicle?.name || null,
    // world clock in ticks of the day (0 sunrise-ish, 13000-23000 night); 26.x keeps it in clocks.overworld
    dayTime: (() => { const t = bot.time; const v = t?.clocks?.overworld?.totalTicks ?? t?.time ?? t?.age; return v == null ? null : Number(v) % 24000; })()
  };
}

module.exports = { observe, entityKind, normDim, HOSTILE, RANGED, PASSIVE_FOOD, droppedItemName };
