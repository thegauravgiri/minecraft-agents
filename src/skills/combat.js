// Melee combat with proper attack cooldowns, jump-crits, strafing and hit-and-run.
const { Vec3 } = require("vec3");
const { goals, configureMovements, dash, corridorClear } = require("./move");
const { sleep, throwIfAborted, ok, fail, dist3, log } = require("../runtime/util");

const WEAPON_RANK = [
  ["netherite_sword", 8], ["diamond_sword", 7], ["iron_sword", 6], ["stone_sword", 5], ["golden_sword", 4], ["wooden_sword", 4],
  ["netherite_axe", 7.5], ["diamond_axe", 7], ["iron_axe", 6], ["stone_axe", 5], ["wooden_axe", 3.5], ["golden_axe", 3],
  ["mace", 6]
];
// seconds for the attack meter to refill
const COOLDOWN_MS = (name) => {
  if (!name) return 260;
  if (name.endsWith("_sword")) return 640;
  if (name.endsWith("_axe")) return name.startsWith("wooden") || name.startsWith("stone") ? 1250 : name.startsWith("iron") ? 1100 : 1000;
  if (name === "mace") return 1700;
  if (name.endsWith("_pickaxe")) return 850;
  if (name.endsWith("_shovel")) return 1000;
  return 400;
};

function bestWeapon(bot) {
  let best = null, bestV = -1;
  for (const it of bot.inventory.items()) {
    const r = WEAPON_RANK.find(([n]) => n === it.name);
    if (r && r[1] > bestV) { best = it; bestV = r[1]; }
  }
  return best;
}

async function equipCombatGear(bot) {
  const w = bestWeapon(bot);
  try {
    if (w && bot.heldItem?.type !== w.type) await bot.equip(w, "hand");
    const shield = bot.inventory.items().find((i) => i.name === "shield");
    if (shield && bot.inventory.slots[45]?.name !== "shield") await bot.equip(shield, "off-hand");
    for (const slot of ["head", "torso", "legs", "feet"]) {
      const suffix = { head: "_helmet", torso: "_chestplate", legs: "_leggings", feet: "_boots" }[slot];
      const cur = bot.inventory.slots[{ head: 5, torso: 6, legs: 7, feet: 8 }[slot]];
      const order = ["netherite", "diamond", "iron", "chainmail", "golden", "leather"];
      const rank = (n) => (n ? order.length - order.findIndex((o) => n.startsWith(o)) : 0);
      const cand = bot.inventory.items().filter((i) => i.name.endsWith(suffix)).sort((a, b) => rank(b.name) - rank(a.name))[0];
      if (cand && rank(cand.name) > rank(cur?.name)) await bot.equip(cand, slot);
    }
  } catch { /* equipment is best effort */ }
  return w;
}

function resolveTarget(bot, spec) {
  if (spec.id != null) return bot.entities[spec.id] || null;
  if (spec.username) {
    const n = spec.username.toLowerCase();
    const key = Object.keys(bot.players).find((k) => k.toLowerCase() === n);
    const e = key ? bot.players[key]?.entity : null;
    return e && bot.entities[e.id] ? e : null;
  }
  if (spec.names) {
    let best = null, bd = Infinity;
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !e.position || !spec.names.includes(e.name)) continue;
      const d = e.position.distanceTo(bot.entity.position);
      if (d < bd && d <= (spec.radius || 24)) { best = e; bd = d; }
    }
    return best;
  }
  return null;
}

/**
 * spec: { id | username | names[], radius }
 * opts: { hitAndRun, timeoutMs, giveUpHealth, onTick }
 * Returns ok({killed}) | fail('lost_target'|'timeout'|'low_health')
 */
async function fight(ctx, spec, opts = {}) {
  const { bot, signal } = ctx;
  const { hitAndRun = false, timeoutMs = 90000, giveUpHealth = 0 } = opts;
  await equipCombatGear(bot);
  const t0 = Date.now();
  let lastAttack = 0, strafeDir = 1, strafeT = 0, jumpedForCrit = false, lastSeen = Date.now();
  let target = resolveTarget(bot, spec);
  const targetId = target?.id;
  bot.pathfinder.setMovements(configureMovements(bot, { dig: false }));
  let following = false;
  let killedByEvent = false;
  const onDead = (e) => { if (e.id === targetId) killedByEvent = true; };
  bot.on("entityDead", onDead);

  try {
    for (;;) {
      throwIfAborted(signal);
      ctx.beat?.();
      if (killedByEvent) return ok({ killed: true });
      if (Date.now() - t0 > timeoutMs) return fail("timeout");
      if (bot.health <= giveUpHealth) return fail("low_health");
      target = spec.id != null || spec.username ? resolveTarget(bot, spec) : resolveTarget(bot, targetId != null ? { id: targetId } : spec);
      if (!target) {
        if (Date.now() - lastSeen > 1500) return targetId != null || spec.username ? ok({ killed: spec.username ? false : true, lost: !!spec.username }) : fail("lost_target");
        await sleep(60, signal); continue;
      }
      lastSeen = Date.now();
      if (target.health != null && target.health <= 0) return ok({ killed: true });

      const me = bot.entity.position;
      const tp = target.position;
      const d = me.distanceTo(tp.offset(0, 0, 0));
      const eyeD = me.offset(0, 1.62, 0).distanceTo(tp.offset(0, (target.height || 1.8) * 0.5, 0));
      const now = Date.now();
      const held = bot.heldItem?.name;

      const shielded = bot.inventory.slots[45]?.name === "shield";
      if (shielded) {
        // block arrows while closing on ranged enemies, drop the guard to swing
        const wantGuard = !!(target.name && /(skeleton|stray|bogged|pillager|blaze|ghast|witch|breeze)/.test(target.name)) && d > 3.6;
        if (wantGuard && !bot.usingHeldItem) { try { bot.activateItem(true); } catch { /* busy */ } }
        else if (!wantGuard && bot.usingHeldItem) { try { bot.deactivateItem(); } catch { /* idle */ } }
      }
      // far away and clear ground between us: sprint-jump the gap ourselves, like a player running someone down
      if (d > 14 && bot.entity.onGround && corridorClear(bot, Math.atan2(-(tp.x - me.x), -(tp.z - me.z)), 5)) {
        if (following) { bot.pathfinder.stop(); following = false; }
        const moved = await dash(ctx, tp.x, tp.z, { stopDist: 7, maxMs: 2500 });
        if (moved > 2) continue;
      }
      if (d > 3.4) {
        if (!following) { bot.pathfinder.setGoal(new goals.GoalFollow(target, 1.8), true); following = true; }
        bot.setControlState("sprint", true);
        await sleep(50, signal);
        continue;
      }
      if (following) { bot.pathfinder.stop(); following = false; }

      // close range: manual footwork
      await bot.lookAt(tp.offset(0, (target.height || 1.8) * 0.85, 0), true);
      if (now - strafeT > 700) { strafeDir = -strafeDir; strafeT = now; }
      bot.setControlState("left", strafeDir > 0 && d < 2.6);
      bot.setControlState("right", strafeDir < 0 && d < 2.6);
      bot.setControlState("forward", d > 2.3);
      bot.setControlState("back", d < 1.2 || (hitAndRun && now - lastAttack < 450));
      bot.setControlState("sprint", d > 2.3);

      const ready = now - lastAttack >= COOLDOWN_MS(held);
      const critWindow = !bot.entity.onGround && bot.entity.velocity.y < -0.05;
      if (ready && eyeD <= 3.1) {
        if (bot.entity.onGround && !jumpedForCrit && now - lastAttack > COOLDOWN_MS(held) + 150 && !hitAndRun) {
          bot.setControlState("jump", true); jumpedForCrit = true; await sleep(40, signal); bot.setControlState("jump", false);
        } else if (critWindow || jumpedForCrit === false || now - lastAttack > COOLDOWN_MS(held) + 500) {
          bot.attack(target);
          lastAttack = Date.now(); jumpedForCrit = false;
        }
      } else if (ready && eyeD > 3.1 && eyeD < 3.6) {
        bot.setControlState("forward", true);
      }
      if (jumpedForCrit && bot.entity.onGround && now - lastAttack > 900) jumpedForCrit = false;
      await sleep(40, signal);
    }
  } finally {
    bot.removeListener("entityDead", onDead);
    for (const c of ["forward", "back", "left", "right", "sprint", "jump"]) bot.setControlState(c, false);
    try { bot.pathfinder.stop(); } catch { /* idle */ }
  }
}

module.exports = { fight, equipCombatGear, bestWeapon, resolveTarget, COOLDOWN_MS };
