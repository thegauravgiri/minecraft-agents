// Spatial awareness: where a player stands, which way they face, what they look at, where the nearest water is and how
// to cross it. Everything the AI needs to put a build/bridge/action at the place the player MEANT.
// Pure geometry helpers up top; world sampling below (needs a bot).
const { Vec3 } = require("vec3");
const { log } = require("./util");

const COMPASS = [["south", 0, 1], ["west", -1, 0], ["north", 0, -1], ["east", 1, 0]];
const OPPOSITE = { north: "south", south: "north", east: "west", west: "east" };
const DIR = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 } };

/** mineflayer yaw (0 = north/-z, counter-clockwise) -> unit look vector and compass word */
function lookVector(yaw, pitch = 0) {
  return { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
}
function compassOf(dx, dz) {
  if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? "east" : "west";
  return dz >= 0 ? "south" : "north";
}
/** minecraft /data Rotation yaw degrees (0 = south, 90 = west) -> mineflayer yaw radians */
const mcYawToBot = (deg) => ((180 - deg) * Math.PI) / 180;

const solidAt = (bot, x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox === "block"; };
const nameAt = (bot, x, y, z) => bot.blockAt(new Vec3(x, y, z))?.name || null;
const isLiquid = (n) => n === "water" || n === "lava" || n === "bubble_column" || n === "kelp" || n === "kelp_plant" || n === "seagrass" || n === "tall_seagrass";

/** Top of the column: the highest block that is solid or liquid (leaves/logs count as "tree", not ground). */
function columnTop(bot, x, z, aroundY, up = 14, down = 40) {
  for (let y = Math.floor(aroundY) + up; y >= Math.floor(aroundY) - down; y--) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b) return { unloaded: true, y };
    if (b.name === "water" || b.name === "lava") return { y, kind: b.name, name: b.name };
    if (b.boundingBox === "block") {
      if (/leaves$/.test(b.name)) continue;
      if (/_log$|_wood$/.test(b.name)) return { y, kind: "tree", name: b.name };
      return { y, kind: "ground", name: b.name };
    }
  }
  return { y: Math.floor(aroundY) - down, kind: "void" };
}

/** What the player stands on / faces / looks at. Works for players in render range; `pos`-only for far ones (rot via radar). */
function viewOf(agent, name) {
  const bot = agent.bot;
  const key = Object.keys(bot.players).find((k) => k.toLowerCase() === String(name).toLowerCase());
  const ent = key ? bot.players[key]?.entity : null;
  let pos = ent?.position, yaw = ent?.yaw, pitch = ent?.pitch ?? 0, live = !!ent;
  if (!pos) {
    const r = agent.radar?.where(name);
    if (!r?.pos) return null;
    pos = r.pos; live = false;
    const rot = agent.radar?.cache?.get(String(name).toLowerCase())?.rot;
    if (rot) { yaw = mcYawToBot(rot.yaw); pitch = (-rot.pitch * Math.PI) / 180; }
  }
  const out = { name: key || name, live, pos: { x: pos.x, y: pos.y, z: pos.z }, block: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } };
  const below = bot.blockAt(new Vec3(out.block.x, out.block.y - 1, out.block.z));
  out.standingOn = below?.name || null;
  if (yaw == null || Number.isNaN(yaw)) return out;
  const v = lookVector(yaw, pitch);
  out.yaw = yaw; out.pitch = pitch; out.dir = { x: v.x, z: v.z };
  out.facing = compassOf(v.x, v.z);
  // what the crosshair rests on
  try {
    const eye = new Vec3(pos.x, pos.y + 1.62, pos.z);
    const hit = bot.world.raycast(eye, new Vec3(v.x, v.y, v.z), 80);
    if (hit) out.lookingAt = { x: hit.position.x, y: hit.position.y, z: hit.position.z, name: hit.name, dist: Math.round(eye.distanceTo(hit.position.offset(0.5, 0.5, 0.5))), face: hit.face };
  } catch { /* chunk not loaded: no look target */ }
  // ground point ahead: the surface column at 1..40 blocks in the facing direction (what "in front of me" means)
  const hd = Math.hypot(v.x, v.z) || 1;
  out.ahead = (d) => { const x = Math.floor(pos.x + (v.x / hd) * d), z = Math.floor(pos.z + (v.z / hd) * d); const t = columnTop(bot, x, z, pos.y); return { x, z, y: t.y, kind: t.kind }; };
  return out;
}

/**
 * Water around a point. Samples columns on a grid and answers:
 *  - nearest water column, the water body's extent along x and z, and the narrowest crossing,
 *  - for an optional heading, where that line first meets water and where it comes out on the other side.
 * A crossing is {axis:'x'|'z', sign:+1|-1, entry:{x,z,y} (last land column), exit:{x,z,y} (first land after the water), width, landY}.
 */
function waterScan(bot, center, { radius = 40, heading = null } = {}) {
  const cx = Math.floor(center.x), cz = Math.floor(center.z), cy = Math.floor(center.y);
  const cache = new Map();
  const top = (x, z) => { const k = x + "," + z; if (!cache.has(k)) cache.set(k, columnTop(bot, x, z, cy)); return cache.get(k); };
  const wet = (x, z) => { const t = top(x, z); return t.kind === "water"; };
  const out = { found: false };

  const crossAlong = (sx, sz, dx, dz, maxLen) => {
    // march from (sx,sz) along (dx,dz) (unit axis step): find first water, then first land after it
    let x = sx, z = sz, lastLand = null, inWater = false, entry = null, wetRun = 0;
    for (let i = 0; i <= maxLen; i++, x += dx, z += dz) {
      const t = top(x, z);
      if (t.unloaded) return null;
      if (t.kind === "water") { if (!inWater) { inWater = true; entry = lastLand; wetRun = 0; } wetRun++; }
      else {
        if (inWater) {
          if (!entry) return null;
          return { entry, exit: { x, z, y: t.y }, width: wetRun, landY: entry.y, exitY: t.y, axis: dx ? "x" : "z", sign: dx ? dx : dz };
        }
        lastLand = { x, z, y: t.y };
      }
    }
    return null;
  };

  // 1. the player's own heading: is there water straight ahead?
  if (heading && (heading.x || heading.z)) {
    const ax = Math.abs(heading.x) >= Math.abs(heading.z);
    const dx = ax ? Math.sign(heading.x) : 0, dz = ax ? 0 : Math.sign(heading.z);
    const c = crossAlong(cx, cz, dx, dz, radius);
    if (c) { out.found = true; out.ahead = c; }
  }
  // 2. nearest water column (ring search) and the narrowest crossing of that water body
  let best = null;
  for (let r = 1; r <= radius && !best; r += 1) {
    for (let a = -r; a <= r && !best; a++) for (const [x, z] of [[cx + a, cz - r], [cx + a, cz + r], [cx - r, cz + a], [cx + r, cz + a]]) { if (wet(x, z)) { best = { x, z, d: Math.hypot(x - cx, z - cz) }; break; } }
  }
  if (best) {
    out.found = true; out.nearest = { x: best.x, z: best.z, dist: Math.round(best.d) };
    // extent of the body along each axis through that column (run length of water)
    const run = (dx, dz) => { let n = 1; for (let s = 1; s < 80; s++) { if (wet(best.x + dx * s, best.z + dz * s)) n++; else break; } for (let s = 1; s < 80; s++) { if (wet(best.x - dx * s, best.z - dz * s)) n++; else break; } return n; };
    const runX = run(1, 0), runZ = run(0, 1);
    out.extent = { alongX: runX, alongZ: runZ };
    const narrowAxis = runX <= runZ ? "x" : "z";               // shortest way across = along the shorter run
    out.shape = Math.max(runX, runZ) >= 3 * Math.min(runX, runZ) && Math.min(runX, runZ) <= 12 ? "river/stream" : (Math.min(runX, runZ) > 12 ? "lake/ocean" : "pond");
    out.riverRunsAlong = out.shape === "river/stream" ? (narrowAxis === "x" ? "z" : "x") : null;
    const dirSign = narrowAxis === "x" ? Math.sign(best.x - cx) || 1 : Math.sign(best.z - cz) || 1;
    // start on land on the near side of that column, walk the narrow axis across; try the three neighbouring lanes, keep the shortest
    const dx = narrowAxis === "x" ? dirSign : 0, dz = narrowAxis === "z" ? dirSign : 0;
    let bestC = null;
    for (const lane of [0, 1, -1, 2, -2]) {
      const px = best.x - dx * (Math.min(runX, runZ) + 4) + (narrowAxis === "z" ? lane : 0);
      const pz = best.z - dz * (Math.min(runX, runZ) + 4) + (narrowAxis === "x" ? lane : 0);
      const c = crossAlong(px, pz, dx, dz, Math.min(runX, runZ) + 40);
      if (c && (!bestC || c.width < bestC.width)) bestC = c;
    }
    if (bestC) out.narrowest = bestC;
  }
  return out;
}

/** One-paragraph description of a player's surroundings for the AI. */
function describeSpace(agent, name) {
  const v = viewOf(agent, name);
  if (!v) return `${name}: position unknown (not in range, radar has no fix).`;
  const bot = agent.bot;
  const parts = [`${v.name} stands at x${v.block.x} y${v.block.y} z${v.block.z}${v.standingOn ? ` on ${v.standingOn}` : ""}`];
  if (v.facing) parts.push(`facing ${v.facing}${v.lookingAt ? `, looking at ${v.lookingAt.name} at x${v.lookingAt.x} y${v.lookingAt.y} z${v.lookingAt.z} (${v.lookingAt.dist} blocks away)` : ""}`);
  else parts.push("facing direction unknown");
  if (v.ahead) { const a = v.ahead(8); parts.push(`8 blocks ahead the surface is ${a.kind} at y${a.y}`); }
  try {
    const w = waterScan(bot, new Vec3(v.pos.x, v.pos.y, v.pos.z), { radius: 40, heading: v.dir });
    if (!w.found) parts.push("no water within 40 blocks");
    else {
      if (w.ahead) parts.push(`straight ahead (${v.facing}) there is water: land ends at x${w.ahead.entry.x} z${w.ahead.entry.z}, water is ${w.ahead.width} wide, far shore starts at x${w.ahead.exit.x} z${w.ahead.exit.z}`);
      if (w.nearest) parts.push(`nearest water at x${w.nearest.x} z${w.nearest.z} (${w.nearest.dist} blocks), looks like a ${w.shape}${w.riverRunsAlong ? ` running along ${w.riverRunsAlong}` : ""}`);
      if (w.narrowest) parts.push(`shortest crossing: ${w.narrowest.width} blocks along ${w.narrowest.axis} from x${w.narrowest.entry.x} z${w.narrowest.entry.z} to x${w.narrowest.exit.x} z${w.narrowest.exit.z}`);
    }
  } catch (e) { log("spatial", "water scan failed: " + e.message); }
  return parts.join("; ") + ".";
}

/** Resolve "here" / "facing" / "water" (/ explicit pos) into an anchor the builder can use. */
function resolveAnchor(agent, speaker, where, pos = null) {
  const bot = agent.bot;
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.z)) {
    const t = columnTop(bot, Math.floor(pos.x), Math.floor(pos.z), pos.y ?? bot.entity.position.y);
    return { mode: "coords", x: Math.floor(pos.x), z: Math.floor(pos.z), y: Number.isFinite(pos.y) ? Math.floor(pos.y) : t.y, kind: t.kind, facing: null, playerPos: null };
  }
  const v = viewOf(agent, speaker);
  if (!v) return null;
  const base = { playerPos: v.block, facing: v.facing || null, player: v.name };
  if (where === "here" || where === "at_player") {
    const t = columnTop(bot, v.block.x, v.block.z, v.pos.y);
    return { ...base, mode: "here", x: v.block.x, z: v.block.z, y: Number.isFinite(v.pos.y) ? Math.floor(v.pos.y) - 1 : t.y, kind: "ground" };
  }
  if (where === "facing") {                                          // "in front of me": right next to the player, along their facing direction
    if (!v.dir) return { ...base, mode: "here", x: v.block.x, z: v.block.z, y: v.block.y - 1, kind: "ground", note: "facing unknown - using the player's own spot" };
    const a = v.ahead(3);
    return { ...base, mode: "front", x: a.x, z: a.z, y: a.y, kind: a.kind };
  }
  if (where === "looking" || where === "ahead" || where === "there") {
    if (!v.dir) return { ...base, mode: "here", x: v.block.x, z: v.block.z, y: v.block.y - 1, kind: "ground", note: "facing unknown - using the player's own spot" };
    // prefer the block the crosshair is on (if it is the ground), else the surface a few blocks ahead
    const L = v.lookingAt;
    if (L && L.dist <= 60 && !isLiquid(L.name)) {
      let y = L.y, x = L.x, z = L.z;
      if (L.face === 0 || L.face === 1 || L.face === undefined) { /* top/bottom face: ground point */ }
      const t = columnTop(bot, x, z, y + 3);
      return { ...base, mode: "facing", x, z, y: t.kind === "ground" ? t.y : y, kind: t.kind, looked: L.name, lookDist: L.dist };
    }
    const a = v.ahead(6);
    return { ...base, mode: "facing", x: a.x, z: a.z, y: a.y, kind: a.kind };
  }
  return null;
}

/** For a bridge: find where it has to go. Returns {origin,min,max,axis,sign,length,deckY,entry,exit,why} or {error}. */
function planBridgeRoute(agent, speaker, { where = "facing", width = 3, pos = null } = {}) {
  const bot = agent.bot;
  const v = viewOf(agent, speaker);
  const from = v ? new Vec3(v.pos.x, v.pos.y, v.pos.z) : bot.entity.position;
  const scan = waterScan(bot, from, { radius: 48, heading: where === "facing" ? v?.dir : null });
  let c = null, why = "";
  if (where !== "nearest" && scan.ahead) { c = scan.ahead; why = `the water straight ahead of ${speaker} (${v.facing})`; }
  else if (scan.narrowest) { c = scan.narrowest; why = `the narrowest crossing of the nearest ${scan.shape || "water"}`; }
  else if (scan.ahead) { c = scan.ahead; why = "the water ahead"; }
  if (!c) return { error: scan.found ? "I can see water but could not find land on the far side within range" : "I can't find any water near you to bridge" };
  if (c.width > 36) return { error: `that water is ${c.width} blocks wide - too big for a bridge I can plan in one go, point me at a narrower spot` };
  const half = Math.floor(width / 2);
  // deck level = top ground block at the entry bank (flush with the bank); the far bank may differ by a step or two
  const deckY = c.landY;
  const along = c.axis;                                            // the bridge runs along this axis
  const a0 = along === "x" ? c.entry.x : c.entry.z;                // the bank block we start from
  const a1 = along === "x" ? c.exit.x : c.exit.z;                  // first block of the far bank
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const lateral = along === "x" ? c.entry.z : c.entry.x;
  const min = along === "x" ? { x: lo, z: lateral - half } : { x: lateral - half, z: lo };
  const max = along === "x" ? { x: hi, z: lateral - half + width - 1 } : { x: lateral - half + width - 1, z: hi };
  return {
    origin: { x: min.x, y: deckY, z: min.z }, min, max, axis: along, sign: c.sign, deckY, width,
    length: hi - lo + 1, waterWidth: c.width, entry: c.entry, exit: c.exit, exitY: c.exitY, why
  };
}

/** Structure spec (the builder's DSL) for a bridge over a route: deck, rails, torches, ramps are left to the terrain. */
function bridgeSpec(route, { material = "oak_planks", rail = "oak_fence", light = true } = {}) {
  const w = route.max.x - route.min.x + 1, d = route.max.z - route.min.z + 1;
  const alongX = route.axis === "x";
  const ops = [{ op: "box", from: [0, 0, 0], to: [w - 1, 0, d - 1], block: "deck" }];
  if (rail && route.width >= 2) {
    if (alongX) { ops.push({ op: "line", from: [0, 1, 0], to: [w - 1, 1, 0], block: "rail" }, { op: "line", from: [0, 1, d - 1], to: [w - 1, 1, d - 1], block: "rail" }); }
    else { ops.push({ op: "line", from: [0, 1, 0], to: [0, 1, d - 1], block: "rail" }, { op: "line", from: [w - 1, 1, 0], to: [w - 1, 1, d - 1], block: "rail" }); }
  }
  const palette = { deck: material, rail: rail || material };
  if (light && rail && route.length >= 8) {
    palette.torch = "torch";
    const step = 6;
    for (let i = 3; i < route.length - 2; i += step) ops.push(alongX ? { op: "set", at: [i, 2, 0], block: "torch" } : { op: "set", at: [0, 2, i], block: "torch" });
  }
  return { name: "bridge", size: { w, d, h: 3 }, palette, ops };
}

/** How many blocks of other people's buildings stand on this footprint (and one block around it) from the ground up to 4 blocks? */
function builtInside(bot, ox, oz, w, d, y0, { homesOnly = false } = {}) {
  const { builtName, PROTECTED } = require("../skills/blocks");
  let n = 0;
  for (let x = ox - 1; x <= ox + w; x++) for (let z = oz - 1; z <= oz + d; z++) for (let y = y0; y <= y0 + 4; y++) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && (homesOnly ? PROTECTED.test(b.name) : b.boundingBox === "block" && builtName(b.name))) n++; }
  return n;
}

/** Where the footprint's min corner goes for an anchor (what the player pointed at / stands on). {origin} or {error}. */
function originFromAnchor(bot, anchor, size) {
  if (anchor.fixed) return { origin: anchor.fixed };                         // this job already has its place: every batch, every retry, after every death: the SAME place
  const { w, d } = size;
  let ox = anchor.x - Math.floor(w / 2), oz = anchor.z - Math.floor(d / 2);
  const pp = anchor.playerPos;
  const inside = () => pp && pp.x >= ox - 1 && pp.x <= ox + w && pp.z >= oz - 1 && pp.z <= oz + d;
  if (anchor.mode === "front" && pp && anchor.facing) {                       // near edge two blocks ahead of the player, centred sideways
    const dir = DIR[anchor.facing];
    const half = (dir.x ? w : d) / 2;
    ox = Math.round(pp.x + dir.x * (2 + half) - w / 2 + 0.5 * (dir.x ? 0 : 0)); oz = Math.round(pp.z + dir.z * (2 + half) - d / 2);
    if (dir.x) oz = pp.z - Math.floor(d / 2); else ox = pp.x - Math.floor(w / 2);
  }
  if ((anchor.mode === "facing" || anchor.mode === "front") && pp && anchor.facing && inside()) {          // "in front of me": never on top of the player
    const dir = DIR[anchor.facing];
    for (let i = 0; i < 40 && inside(); i++) { ox += dir.x; oz += dir.z; }
  }
  const ys = []; let wet = 0, cols = 0;
  for (let x = ox; x < ox + w; x++) for (let z = oz; z < oz + d; z++) {
    const t = columnTop(bot, x, z, anchor.y ?? bot.entity.position.y);
    if (t.unloaded) continue;
    cols++;
    if (t.kind === "water" || t.kind === "lava") wet++;
    else ys.push(t.y);
  }
  if (cols && wet / cols > 0.4) return { error: `that spot is mostly ${wet} water/lava columns out of ${cols} - tell me a drier place` };
  if (!ys.length) return { error: "I can't see solid ground there yet (chunks not loaded)" };
  ys.sort((a, b) => a - b);
  const y0 = ys[Math.floor(ys.length / 2)];
  // exact coordinates from the player: build THERE. Plain blocks (often our own earlier attempt) get built over; only somebody's home (doors, beds, chests) stops us
  // the same for "here" / "there" / "in front of me": the player chose the spot, plain blocks (an earlier unfinished build) are built over
  const exact = anchor.mode === "coords" || (anchor.player && ["here", "facing", "front", "looking"].includes(anchor.mode));
  const clash = exact ? builtInside(bot, ox, oz, w, d, y0, { homesOnly: true }) : builtInside(bot, ox, oz, w, d, y0);
  if (exact && clash > 1) return { error: `there is somebody's house at ${anchor.mode === "coords" ? anchor.x + " " + anchor.z : "that spot"} (doors/beds/chests) - I won't build over it, give me another spot` };
  if (!exact && clash > 3) return { error: `something is already built there (${clash} blocks of a building) - I won't build through it` };
  return { origin: { x: ox, y: y0, z: oz } };
}

module.exports = { builtInside, originFromAnchor, viewOf, waterScan, describeSpace, resolveAnchor, planBridgeRoute, bridgeSpec, columnTop, lookVector, compassOf, mcYawToBot, OPPOSITE, DIR };
