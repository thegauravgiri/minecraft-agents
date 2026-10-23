// Skill registry: name -> async (ctx, args) => {ok, reason?, data?}
const { log } = require("../runtime/util");
const { mine, explore } = require("./gather");
const { craft, smelt, placeStation } = require("./craft");
const { follow, hunt } = require("./follow");
const { fight } = require("./combat");
const survival = require("./survival");
const tactics = require("./tactics");
const vertical = require("./vertical");
const bed = require("./bed");
const portal = require("./portal");
const boat = require("./boat");
const extras = require("./extras");
const chest = require("./chest");
const structure = require("./structure");
const farming = require("./farming");
const creative = require("./creative");
const { buildHouse } = require("./build");

// Repair without guesswork: survey the building, fill every hole with the material around it, swap junk patches, put doors in doorways,
// clear junk from inside/roof/around - one spec, built and verified by the normal builder.
async function deterministicRepair(ctx, near) {
  const a = ctx.agent, g = a.goal, bot = ctx.bot;
  const F = require("../brain/fixup");
  const { surveyBuilding } = require("../runtime/survey");
  const sv = surveyBuilding(bot, near);
  if (!sv || sv.tooBig) { a.say(sv?.tooBig ? "That building is too big for me to survey in one go." : "I can't find a building there - stand next to it or look at it and tell me again.", { force: true }); a.abandon(); return { ok: false, reason: "no_building" }; }
  const b = { min: sv.origin, max: { x: sv.origin.x + sv.size.w - 1, y: sv.origin.y + sv.size.h - 1, z: sv.origin.z + sv.size.d - 1 } };
  const ref = F.groundRef(bot, { x: b.min.x, y: b.min.y, z: b.min.z }, 12, [b]);
  const r = F.repairCells(bot, sv);
  const junk = F.junkCells(bot, b, ref);
  log("repair", `survey ${sv.size.w}x${sv.size.d}x${sv.size.h} at ${sv.origin.x},${sv.origin.y},${sv.origin.z}: holes ${JSON.stringify(sv.holes.map((h) => [h.x, h.y, h.z]))} place ${r.place.length} doors ${r.doors.length} junk ${junk.length}`);
  const s = F.specOf("repaired building", { place: r.place, doors: r.doors, clear: junk });
  if (!s) { a.say("I checked that building - no holes, no junk. It's in good shape.", { force: true }); a.abandon(); return { ok: true, data: { nothing: true } }; }
  g.spec = s.spec; g._compiled = null; g.mode = "fix";
  a.mem.remember(`structure:${g.sid}`, { origin: s.origin, name: "repaired building" });
  a.say(`Repairing: ${r.place.length} hole${r.place.length === 1 ? "" : "s"} to fill${r.doors.length ? `, ${r.doors.length} door${r.doors.length > 1 ? "s" : ""} to hang` : ""}${junk.length ? `, ${junk.length} junk block${junk.length > 1 ? "s" : ""} to clear` : ""}.`, { force: true });
  return { ok: true, data: { name: "repaired building", holes: r.place.length, junk: junk.length } };
}

/** "clean up the dirt / fill the holes in the ground (around here)": the same measurable fix-up, around a point. */
async function planFixupSkill(ctx, { repair = true, clean = true, fill = true }) {
  if (repair) clean = true;                                                  // a repaired house with dirt left inside is not repaired
  const a = ctx.agent, g = a.goal, bot = ctx.bot;
  const an = g.anchor;
  const center = an ? { x: an.x, y: an.y ?? Math.floor(bot.entity.position.y), z: an.z } : { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y) - 1, z: Math.floor(bot.entity.position.z) };
  if (Math.hypot(center.x - bot.entity.position.x, center.z - bot.entity.position.z) > 30) await module.exports.approach(ctx, { pos: { x: center.x, y: center.y, z: center.z }, range: 8 }).catch(() => null);
  try { await bot.waitForChunksToLoad(); } catch { /* best effort */ }
  const plan = require("../brain/fixup").planFixup(bot, center, { repair, clean, fill });
  log("repair", `fix-up plan: ${JSON.stringify(plan.report)}`);
  const rp = plan.report || {};
  if (plan.nothing || !plan.spec) { a.say(`I looked around: ${rp.buildings || 0} building(s), no holes, no junk, no gaps in the ground - nothing to fix.`, { force: true }); a.abandon(); return { ok: true, data: { nothing: true } }; }
  g.spec = plan.spec; g._compiled = null; g.mode = "fix";
  a.mem.remember(`structure:${g.sid}`, { origin: plan.origin, name: "fix-up" });
  const parts = [rp.holes ? `${rp.holes} holes in buildings` : "", rp.doors ? `${rp.doors} missing doors` : "", rp.junk ? `${rp.junk} junk blocks to clear` : "", rp.gaps ? `${rp.gaps} ground gaps to fill` : ""].filter(Boolean);
  a.say(`On it: ${parts.join(", ")}.`, { force: true });
  return { ok: true, data: { report: rp } };
}

// Repair / renovate an EXISTING building: look at it, describe it to the AI layer by layer, get back the intact-plus-fixed structure, build only the difference.
async function repairDesign(ctx, request, mode) {
  const { designStructure } = require("../brain/design");
  const { surveyBuilding } = require("../runtime/survey");
  const { describeWorld, invSummary } = require("../brain/status");
  const { observe } = require("../runtime/observe");
  const a = ctx.agent, g = a.goal, bot = ctx.bot;
  const an = g.anchor;
  const near = an ? { x: an.x, y: (an.y ?? bot.entity.position.y) + 1, z: an.z } : bot.entity.position;
  // chunks of a far-away building may not be loaded: go there first
  if (an && Math.hypot(an.x - bot.entity.position.x, an.z - bot.entity.position.z) > 30) { a.think("going to the building first"); await module.exports.approach(ctx, { pos: { x: an.x, y: an.y ?? bot.entity.position.y, z: an.z }, range: 10 }).catch(() => null); }
  if (mode === "repair") return deterministicRepair(ctx, near);                      // repairs need no AI: holes, junk patches, doorways are measurable
  const sv = surveyBuilding(bot, near);
  if (!sv || sv.tooBig) { a.say(sv?.tooBig ? "That building is too big for me to survey in one go." : "I can't find a building there - stand next to it or look at it and tell me again.", { force: true }); a.abandon(); return { ok: false, reason: "no_building" }; }
  a.think(`found a building ${sv.size.w}x${sv.size.d}x${sv.size.h} (${sv.blocks} blocks) at ${sv.origin.x} ${sv.origin.y} ${sv.origin.z}`);
  const legend = Object.entries(sv.palette).map(([n, l]) => `${l}=${n}`).join(", ");
  const extra = `THIS IS ${mode === "repair" ? "A REPAIR" : "A RENOVATION"} OF AN EXISTING BUILDING, NOT A NEW ONE. Existing building scan (x east, z south, layers bottom to top; "." = no block of the building; legend: ${legend}):\n${sv.ascii}\n${sv.holes.length ? `LIKELY DAMAGE (empty cells enclosed by the building on most sides - fill each with the block named, unless it is clearly a window/door pattern): ${sv.holes.slice(0, 30).map((h) => `[${h.x},${h.y},${h.z}]=${h.block}`).join(" ")}.` : ""}\nThe spec origin [0,0,0] is the scan's minimum corner and size MUST be exactly {"w":${sv.size.w},"d":${sv.size.d},"h":${sv.size.h}}.\n${mode === "repair" ? "Reproduce EVERY intact block exactly (same block type, same place) and add only what is missing or broken: holes in walls/roof/floor, missing corners, door, windows, steps. Change nothing else." : "Keep the footprint and apply the requested change; keep everything the request does not touch exactly as it is."}`;
  const validate = (spec, r) => {
    const errs = [];
    if (r.size.w !== sv.size.w || r.size.d !== sv.size.d || r.size.h !== sv.size.h) errs.push(`size must be exactly ${sv.size.w}x${sv.size.d}x${sv.size.h}, you gave ${r.size.w}x${r.size.d}x${r.size.h}`);
    if (mode === "repair" && !errs.length) {
      const have = new Map(r.cells.filter((c) => c.kind !== "air").map((c) => [`${c.x},${c.y},${c.z}`, c.block]));
      let changed = 0; for (const [k, name] of sv.grid) { const want = have.get(k); if (!want || (want !== name && !(/_planks$/.test(want) && /_planks$/.test(name)))) changed++; }
      const unfilled = sv.holes.filter((h) => !have.has(`${h.x},${h.y},${h.z}`));
      if (unfilled.length > Math.max(1, sv.holes.length * 0.15)) errs.push(`these likely-damage cells are still empty in your spec, fill them: ${unfilled.slice(0, 12).map((h) => `[${h.x},${h.y},${h.z}]=${h.block}`).join(" ")}`);
      if (changed > Math.max(6, sv.blocks * 0.08)) errs.push(`you changed or dropped ${changed} of the ${sv.blocks} existing blocks - a repair must keep every intact block exactly as scanned`);
    }
    return errs;
  };
  const snap = observe(bot);
  const r = await designStructure({ brain: a.brain, reg: ctx.reg, request: `${mode} the existing building: ${request}`, world: describeWorld(a, snap), inventory: invSummary(snap.inv, 30), extra, validate, skipCost: true });
  if (!r.ok) return { ok: false, reason: "design_failed", data: { errors: r.errors } };
  // a renovation also REMOVES: every block of the old building that the new design no longer has is cleared
  // (without this "turn the face around" / "remove the extra blocks" changed nothing - the builder only ever adds)
  {
    const S = require("../core/structure");
    const c = S.compileStructure(r.spec, ctx.reg);
    const keep = new Set((c.ok ? c.cells : []).filter((x) => x.kind !== "air").map((x) => `${x.x},${x.y},${x.z}`));
    const remove = [...sv.grid.keys()].filter((k) => !keep.has(k));
    if (remove.length) {
      r.spec.ops = [...(r.spec.ops || []), ...remove.map((k) => ({ op: "set", at: k.split(",").map(Number), block: "air" }))];
      a.think(`renovation also removes ${remove.length} old block${remove.length > 1 ? "s" : ""}`);
    }
  }
  g.spec = r.spec; g._compiled = null; g.mode = "fix";          // fix mode: blocks that differ from the new design are replaced
  a.mem.remember(`structure:${g.sid}`, { origin: sv.origin, name: r.spec.name });
  try { a.know.add({ kind: "build", label: r.spec.name || "building", pos: sv.origin, size: sv.size }); } catch { /* best effort */ }
  a.think(`${mode}: ${r.cells} blocks planned against ${sv.blocks} existing`);
  return { ok: true, data: { name: r.spec.name, mode } };
}

module.exports = {
  wander: (ctx, args) => explore(ctx, { distance: args.distance || 25, why: 'wander' }),
  mine, craft, smelt, placeStation, hunt, follow,
  fight: (ctx, args) => fight(ctx, args, args.opts || {}),
  approach: tactics.approach, tower_to: tactics.towerTo, dig_to: tactics.digTo, deliver: tactics.deliver, collect: tactics.collect,
  build_house: async (ctx, args) => { const r = await buildHouse(ctx, args); if (r.ok && r.data?.verified) r.progress = { ...(r.progress || {}), verified: 1 }; return r; },
  swim_across: boat.swimAcross, boat_to: boat.boatTo, dismount_boat: boat.dismount,
  tell: async (ctx, { agent, command }) => {
    if (!ctx.agent.isAgent(agent)) return { ok: false, reason: "unknown_agent:" + agent };
    const sent = require("../runtime/team").send(ctx.bot.username, agent, { type: "command", text: command });
    if (!sent) return { ok: false, reason: "inbox_unavailable" };
    ctx.agent.say(`@${agent} ${command}`, { noName: true, force: true });                      // the humans see it too; the receiver acts on the inbox copy only
    return { ok: true, data: { told: agent }, progress: { told: 1 } };
  },
  creative_give: creative.giveItems,
  fly_to: async (ctx, { x, y, z }) => ((await creative.flyTo(ctx, x, y, z)) ? { ok: true } : { ok: false, reason: "fly_blocked" }),
  harvest: farming.harvest,
  build_structure: structure.buildStructure,
  design_structure: async (ctx, { request }) => {
    const { designStructure } = require("../brain/design");
    const { describeWorld, invSummary } = require("../brain/status");
    const { observe } = require("../runtime/observe");
    const snap = observe(ctx.bot);
    // the same job again (or "finish/continue it"): pick the unfinished build up where it stands instead of designing and starting over
    {
      const shared = require("../runtime/shared"), prev = shared.buildOf(ctx.bot.username);
      const words = (t) => new Set(String(t || "").toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !/^(the|and|build|make|small|big|for|with|please|finish|continue|resume)$/.test(w)));
      const a = words(request), b = words(prev?.request);
      const overlap = a.size && b.size ? [...a].filter((w) => b.has(w)).length / Math.min(a.size, b.size) : 0;
      const an = ctx.agent.goal?.anchor;
      const spot = an && prev?.origin ? Math.hypot(an.x - (prev.origin.x + (prev.spec?.size?.w || 0) / 2), an.z - (prev.origin.z + (prev.spec?.size?.d || 0) / 2)) : 0;
      const sameSpot = !an || an.fixed || spot < 14;                       // a new place was named: that is a NEW build there, not the old one somewhere else
      if (prev && !prev.done && prev.origin && sameSpot && (overlap >= 0.5 || /\b(finish|continue|resume|complete)\b/i.test(request))) {
        const g = ctx.agent.goal;
        g.spec = prev.spec; g._compiled = null;
        ctx.agent.mem.remember(`structure:${g.sid}`, { origin: prev.origin, name: prev.name });
        ctx.agent.think(`continuing my earlier ${prev.name} at x${prev.origin.x} z${prev.origin.z} instead of starting over`);
        return { ok: true, data: { name: prev.name, resumed: true } };
      }
    }
    const gm = ctx.agent.goal?.mode;
    if (gm === "repair" || gm === "renovate") return repairDesign(ctx, request, gm);
    ctx.agent.think(`designing: ${request}`);
    const g = ctx.agent.goal, a = g?.anchor;
    const placement = a ? `PLACEMENT: the player chose the spot - ${a.mode === "here" ? "the build is centred on where the player stands" : a.mode === "front" ? `the build goes directly in front of the player (they face ${a.facing})` : a.mode === "facing" ? `the build goes where the player is looking/facing (${a.facing || "?"})` : "the build goes at the given coordinates"}${a.facing ? `; the player faces ${a.facing}, so put the MAIN DOOR on the side that faces the player (door facing = ${require("../runtime/spatial").OPPOSITE[a.facing]})` : ""}.` : "";
    const r = await designStructure({ brain: ctx.agent.brain, reg: ctx.reg, request, world: describeWorld(ctx.agent, snap) + (placement ? "\n" + placement : ""), inventory: invSummary(snap.inv, 30), skipCost: ctx.bot.game?.gameMode === "creative" });      // creative: any block is available, no cost limits
    if (!r.ok) return { ok: false, reason: "design_failed", data: { errors: r.errors } };
    ctx.agent.goal.spec = r.spec;
    require("../runtime/shared").publishBuild(ctx.bot.username, { sid: ctx.agent.goal.sid, name: r.spec.name, spec: r.spec, origin: null, request, done: false });
    if (!ctx.agent.goal?.auto) ctx.agent.say(`Design ready: ${r.spec.name} (${r.cells} blocks).`, { force: true });
    return { ok: true, data: { name: r.spec.name } };
  },
  design_bridge: async (ctx, { where, width, material, pos, requester }) => {
    const sp = require("../runtime/spatial");
    const who = requester || ctx.agent.master;
    if (who && !ctx.bot.players[who]?.entity) { const rot = await ctx.agent.radar.askRotation(who); void rot; }   // far away: ask the server which way they face
    const route = sp.planBridgeRoute(ctx.agent, who, { where, width: Math.max(1, Math.min(7, width || 3)), pos });
    if (route.error) { ctx.agent.say(`${route.error}.`, { force: true }); setTimeout(() => ctx.agent.clearGoal(), 0); return { ok: false, reason: "no_route", data: { message: route.error } }; }
    const inv = ctx.bot.inventory.items();
    const planks = inv.filter((i) => /_planks$/.test(i.name)).sort((a, b) => b.count - a.count)[0]?.name;
    const mat = material && ctx.reg.hasItem(material) ? material : planks || "oak_planks";
    const fence = mat.replace(/_planks$/, "_fence");
    const spec = sp.bridgeSpec(route, { material: mat, rail: /_planks$/.test(mat) && ctx.reg.hasItem(fence) ? fence : null });
    const g = ctx.agent.goal;
    g.spec = spec; g.route = route;
    ctx.agent.mem.remember(`structure:${g.sid}`, { origin: route.origin, name: "bridge" });
    ctx.agent.know.add({ kind: "build", label: "bridge", pos: route.origin, size: { w: route.max.x - route.min.x + 1, d: route.max.z - route.min.z + 1, h: 2 } });
    require("../runtime/shared").publishBuild(ctx.bot.username, { sid: g.sid, name: "bridge", spec, origin: route.origin, request: "bridge", done: false });
    ctx.agent.think(`bridge: ${route.why}; ${route.waterWidth} blocks of water, ${route.axis}-axis from x${route.entry.x} z${route.entry.z} to x${route.exit.x} z${route.exit.z}, deck y${route.deckY}`);
    ctx.agent.say(`Bridging ${route.waterWidth} blocks of water at x${route.min.x}..${route.max.x}, z${route.min.z}..${route.max.z}.`, { force: true });
    return { ok: true, data: { name: "bridge", length: route.length } };
  },
  // join a teammate's build: same blueprint, same place (waits for them to finish designing and choosing the spot)
  join_build: async (ctx, { owner }) => {
    const shared = require("../runtime/shared");
    const t0 = Date.now();
    for (;;) {
      const b = shared.buildOf(owner);
      if (b) {
        const g = ctx.agent.goal;
        g.spec = b.spec; g._compiled = null; g.sharedSid = b.sid;
        ctx.agent.mem.remember(`structure:${g.sid}`, { origin: b.origin, name: b.name });
        ctx.agent.think(`joining ${owner}'s ${b.name} at x${b.origin.x} y${b.origin.y} z${b.origin.z}`);
        return { ok: true, data: { joined: owner } };
      }
      if (Date.now() - t0 > 120000) { ctx.agent.say(`${owner} hasn't started a build I can join.`, { force: true }); ctx.agent.abandon(); return { ok: false, reason: "no_shared_build" }; }
      ctx.beat?.();
      await require("../runtime/util").sleep(1500, ctx.signal);
    }
  },
  chest: chest.chestTransfer, place_item: extras.placeItem, tidy: extras.tidy, flee: extras.flee, shelter: extras.emergencyShelter, raise_shield: extras.raiseShield,
  set_spawn: bed.setSpawn,
  travel_dimension: portal.travelDimension, chase_across_dimensions: portal.chaseAcrossDimensions,
  ascend_surface: (ctx) => vertical.ascend(ctx, { targetY: 64 }),
  plan_fixup: planFixupSkill,
  mount_ride: require("./ride").mount, dismount_ride: require("./ride").dismount, drive_ghast: require("./ride").drive,
  burrow: vertical.burrow, pillar: vertical.pillarUp, escape_hole: vertical.escapeHole,
  equip_gear: async (ctx) => { await require('./combat').equipCombatGear(ctx.bot); return { ok: true }; },
  eat: survival.eat,
  surface: survival.surface,
  escape_lava: survival.escapeLava,
  extinguish: survival.extinguish
};
