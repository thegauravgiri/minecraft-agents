// Pure reflex rules: snapshot (+ light context) -> the single most urgent thing to do, or null.
// Cheap enough to run every few ticks. Higher `priority` wins. These pre-empt any running goal action.
const FOOD_PRIORITY = ["enchanted_golden_apple", "golden_apple", "cooked_beef", "cooked_porkchop", "cooked_mutton", "cooked_salmon", "cooked_chicken",
  "cooked_rabbit", "cooked_cod", "baked_potato", "bread", "golden_carrot", "apple", "carrot", "melon_slice", "sweet_berries", "dried_kelp", "beef", "porkchop", "mutton", "chicken", "potato"];
const BAD_FOOD = new Set(["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chorus_fruit"]);

function bestFood(inv, { allowRaw = true } = {}) {
  for (const f of FOOD_PRIORITY) {
    if (!inv[f]) continue;
    if (!allowRaw && ["beef", "porkchop", "mutton", "chicken", "potato"].includes(f)) continue;
    return f;
  }
  return null;
}

const near = (list, d) => list.filter((e) => e.dist <= d);

/**
 * ctx: { lastHurt:{t, by}, master:{pos}, mode:'follow'|'idle'|'task'|'kill', now }
 */
function reflex(snap, ctx = {}) {
  const now = ctx.now ?? snap.t;
  if (snap.gameMode === "creative") return null;   // invulnerable, no hunger, no drowning: survival reflexes would only waste time

  if (snap.inLava) return { kind: "escape_lava", priority: 100 };
  if (snap.onFire && !snap.inWater) return { kind: "extinguish", priority: 90 };
  if (snap.headInWater && snap.oxygen <= (ctx.swimming ? 3 : 12)) return { kind: "surface", priority: 95 };

  const creeper = near(snap.hostiles, ctx.night ? 8 : 5).find((h) => h.name === "creeper");          // a creeper is never fought: keep well away from it (further at night)
  if (creeper && snap.health > 0) return { kind: "evade_creeper", priority: 80, target: creeper };

  const hurtRecently = ctx.lastHurt && now - ctx.lastHurt.t < 4000;
  const critical = snap.health <= 8;
  const threats = near(snap.hostiles, 7);
  if (critical && threats.length) {
    const food = bestFood(snap.inv, { allowRaw: false });
    if (snap.food < 20 && (snap.inv.golden_apple || snap.inv.enchanted_golden_apple)) return { kind: "eat", priority: 85, item: snap.inv.enchanted_golden_apple ? "enchanted_golden_apple" : "golden_apple" };
    const foodNow = bestFood(snap.inv, { allowRaw: false });
    if (foodNow && snap.food < 20 && threats.every((t) => t.dist > 2.5)) return { kind: "eat", priority: 84, item: foodNow };
    return { kind: "flee_or_block", priority: 82, threats };
  }

  // Outnumbered: three or more hostiles close = a fight nobody should take in the open. Wall in (or, with no blocks, back to a fight).
  if (near(snap.hostiles, 9).length >= 3) return { kind: "outnumbered", priority: 83, threats: near(snap.hostiles, 12), target: near(snap.hostiles, 12)[0] };

  const food = bestFood(snap.inv, { allowRaw: snap.food <= 6 });
  if (food && (snap.food <= 14 || (snap.health <= 14 && snap.food < 20)) && !threats.some((t) => t.dist < 3)) {
    return { kind: "eat", priority: 40, item: food };
  }

  // A teammate is being jumped: fight next to them (the team that kills together survives together).
  for (const ally of ctx.allies || []) {
    const hit = snap.hostiles.find((h) => h.dist < 16 && Math.hypot(h.pos.x - ally.pos.x, h.pos.z - ally.pos.z) < 5 && !(h.name === "enderman") && !(h.name === "creeper" && h.dist < 4));
    if (hit && snap.health > 9) return { kind: "defend", priority: 48, target: hit, ally: ally.username };
  }

  // Starving at low health with nothing decent to eat: rotten flesh beats not healing at all (natural regeneration needs a full-ish food bar)
  if (!food && snap.health <= 10 && snap.food <= 17 && snap.inv.rotten_flesh && !threats.some((t) => t.dist < 5)) return { kind: "eat", priority: 36, item: "rotten_flesh" };

  // Combat engagement depends on what we were asked to do.
  const mode = ctx.mode || "idle";
  if (snap.hostiles.length) {
    let engage = null;
    const close = near(snap.hostiles, mode === "idle" || mode === "guard" ? 10 : 4);
    if (mode === "follow") {
      // only when something is actually on us, or the master is fighting
      const onUs = near(snap.hostiles, 3.2)[0];
      const masterFight = ctx.master && snap.hostiles.find((h) => Math.hypot(h.pos.x - ctx.master.pos.x, h.pos.z - ctx.master.pos.z) < 6 && h.dist < 14);
      // being shot/hurt by something farther away (skeletons, spiders) must also provoke a response
      const hurtBy = hurtRecently ? near(snap.hostiles, 18)[0] : null;
      engage = onUs || hurtBy || masterFight || null;
    } else if (mode === "kill") {
      engage = null; // the kill goal owns combat
    } else if (ctx.night) {
      // at night we do not go looking for fights: only what is actually on us (or just hit us); the rest is avoided by hiding / sleeping
      engage = near(snap.hostiles, 2.8).find((h) => h.name !== "creeper") || (hurtRecently ? near(snap.hostiles, 6).find((h) => h.name !== "creeper") : null) || null;
    } else {
      engage = close[0] || (hurtRecently ? near(snap.hostiles, 18)[0] : null) || null;
    }
    if (engage && !(engage.name === "enderman" && !hurtRecently)) return { kind: "defend", priority: 50, target: engage };
  }

  return null;
}

module.exports = { reflex, bestFood, FOOD_PRIORITY, BAD_FOOD };
