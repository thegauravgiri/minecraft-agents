// "Renovate the village": look at the whole settlement like a builder would and turn it into jobs.
//  - every building (a cluster of player-made blocks, at least 3 high) is checked for damage (holes in walls/roof/floor) -> a repair job each
//  - ground gaps between the houses (pits, missing blocks in the surface) -> a fill job
//  - dirt paths from the village centre to every door -> a path job
// The jobs go on the project board, so the whole team works on it in parallel (see team-project.js).
const { Vec3 } = require("vec3");
const { builtName } = require("../skills/blocks");
const { surveyBuilding } = require("../runtime/survey");
const { columnTop } = require("../runtime/spatial");

const key = (x, y, z) => `${x},${y},${z}`;

function builtIds(bot) {
  if (bot._builtIds) return bot._builtIds;
  bot._builtIds = Object.values(bot.registry.blocksByName).filter((b) => builtName(b.name)).map((b) => b.id);
  return bot._builtIds;
}

/** Buildings around a point: clusters of player-made blocks (doors, planks, glass, cobblestone, beds...). */
function findBuildings(bot, center, radius = 56) {
  const found = bot.findBlocks({ point: new Vec3(center.x, center.y, center.z), matching: builtIds(bot), maxDistance: radius, count: 8000 });
  const set = new Map(found.map((p) => [key(p.x, p.y, p.z), p]));
  const seen = new Set(), clusters = [];
  for (const [k0, p0] of set) {
    if (seen.has(k0)) continue;
    const stack = [p0], members = []; seen.add(k0);
    while (stack.length) {
      const p = stack.pop(); members.push(p);
      for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -2; dz <= 2; dz++) {
        const k = key(p.x + dx, p.y + dy, p.z + dz);
        if (!seen.has(k) && set.has(k)) { seen.add(k); stack.push(set.get(k)); }
      }
    }
    clusters.push(members);
  }
  const out = [];
  for (const m of clusters) {
    const min = { x: Math.min(...m.map((p) => p.x)), y: Math.min(...m.map((p) => p.y)), z: Math.min(...m.map((p) => p.z)) };
    const max = { x: Math.max(...m.map((p) => p.x)), y: Math.max(...m.map((p) => p.y)), z: Math.max(...m.map((p) => p.z)) };
    if (m.length < 25 || max.y - min.y < 2) continue;                       // fences, paths, single lamps are not buildings
    const doors = [];
    for (const p of m) {
      const b = bot.blockAt(p);
      if (!b || !/_door$/.test(b.name) || /_door$/.test(bot.blockAt(p.offset(0, -1, 0))?.name || "")) continue;
      // outside = the bounding-box face the door is closest to
      const faces = [[p.x - min.x, -1, 0], [max.x - p.x, 1, 0], [p.z - min.z, 0, -1], [max.z - p.z, 0, 1]].sort((a, b2) => a[0] - b2[0]);
      doors.push({ x: p.x + faces[0][1], y: p.y, z: p.z + faces[0][2] });
    }
    out.push({ min, max, blocks: m.length, center: { x: Math.round((min.x + max.x) / 2), y: min.y, z: Math.round((min.z + max.z) / 2) }, doors });
  }
  return out.sort((a, b) => Math.hypot(a.center.x - center.x, a.center.z - center.z) - Math.hypot(b.center.x - center.x, b.center.z - center.z));
}

const inside = (b, x, z, pad = 0) => x >= b.min.x - pad && x <= b.max.x + pad && z >= b.min.z - pad && z <= b.max.z + pad;

/**
 * Pits and missing surface blocks between the buildings: cells to fill with dirt.
 * The village's ground level is the most common surface height around; small connected patches lower than that (craters, dug holes)
 * are gaps - big ones are real terrain (a valley, a river bank) and are left alone.
 */
function groundGaps(bot, buildings, center, radius = 40, limit = 400) {
  const top = new Map();
  const tops = [];
  for (let x = center.x - radius; x <= center.x + radius; x++) for (let z = center.z - radius; z <= center.z + radius; z++) {
    if (buildings.some((b) => inside(b, x, z, 1))) continue;
    const t = columnTop(bot, x, z, center.y + 4, 14, 24);
    if (t.unloaded || t.kind !== "ground") continue;
    top.set(`${x},${z}`, t.y); tops.push(t.y);
  }
  if (!tops.length) return [];
  const count = {}; for (const y of tops) count[y] = (count[y] || 0) + 1;
  const ref = Number(Object.keys(count).sort((a, b) => count[b] - count[a])[0]);
  const low = new Set([...top].filter(([, y]) => y < ref && ref - y <= 4).map(([k]) => k));
  const cells = [], seen = new Set();
  for (const k of low) {
    if (seen.has(k)) continue;
    const comp = [], stack = [k]; seen.add(k);
    while (stack.length) { const c = stack.pop(); comp.push(c); const [x, z] = c.split(",").map(Number); for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = `${x + dx},${z + dz}`; if (low.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); } } }
    if (comp.length > 40) continue;                                          // a valley, not a hole
    for (const c of comp) { const [x, z] = c.split(",").map(Number); for (let y = top.get(c) + 1; y <= ref && cells.length < limit; y++) cells.push({ x, y, z }); }
  }
  return cells;
}

/** Dirt paths from the hub to every door (straight lines over the surface, around the buildings themselves). */
function pathsTo(bot, buildings, hub, limit = 700) {
  const cells = new Map();
  for (const b of buildings) for (const d of b.doors) {
    const n = Math.max(Math.abs(d.x - hub.x), Math.abs(d.z - hub.z));
    for (let i = 0; i <= n && cells.size < limit; i++) {
      const x = Math.round(hub.x + ((d.x - hub.x) * i) / Math.max(n, 1)), z = Math.round(hub.z + ((d.z - hub.z) * i) / Math.max(n, 1));
      if (buildings.some((o) => inside(o, x, z, 0))) continue;
      const t = columnTop(bot, x, z, hub.y + 4, 14, 24);
      if (t.unloaded || t.kind !== "ground") continue;
      const name = bot.blockAt(new Vec3(x, t.y, z))?.name;
      if (name === "dirt_path" || name === "farmland") continue;
      cells.set(key(x, t.y, z), { x, y: t.y, z });
    }
  }
  return [...cells.values()];
}

/** Absolute cells -> a structure spec with an origin (the builder's language). */
function specFrom(name, cells, kind) {
  const min = { x: Math.min(...cells.map((c) => c.x)), y: Math.min(...cells.map((c) => c.y)), z: Math.min(...cells.map((c) => c.z)) };
  const max = { x: Math.max(...cells.map((c) => c.x)), y: Math.max(...cells.map((c) => c.y)), z: Math.max(...cells.map((c) => c.z)) };
  const ops = cells.map((c) => kind === "path" ? { op: "path", at: [c.x - min.x, c.y - min.y, c.z - min.z] } : { op: "set", at: [c.x - min.x, c.y - min.y, c.z - min.z], block: "dirt" });
  return { origin: min, spec: { name, size: { w: max.x - min.x + 1, d: max.z - min.z + 1, h: max.y - min.y + 1 }, palette: {}, ops } };
}

/** The whole renovation as board jobs. */
function planRenovation(bot, center, { paths = true, gaps = true } = {}) {
  const buildings = findBuildings(bot, center);
  const tasks = [];
  const report = { buildings: buildings.length, damaged: 0, gaps: 0, path: 0 };
  const F = require("./fixup");
  const ref = F.groundRef(bot, center, 30, buildings);
  buildings.slice(0, 12).forEach((b, i) => {
    const sv = surveyBuilding(bot, { x: b.center.x, y: b.min.y + 1, z: b.center.z });
    if (!sv || sv.tooBig) return;
    const r = F.repairCells(bot, sv), junk = F.junkCells(bot, { min: sv.origin, max: { x: sv.origin.x + sv.size.w - 1, y: sv.origin.y + sv.size.h - 1, z: sv.origin.z + sv.size.d - 1 } }, ref);
    const s = F.specOf(`building ${i + 1} repair`, { place: r.place, doors: r.doors, clear: junk });
    if (!s) return;
    report.damaged++;
    tasks.push({ id: `repair_${i + 1}`, title: `repair building ${i + 1}`, request: "repair this building", roleHint: "builder", mode: "fix", spec: s.spec, origin: s.origin, size: { w: b.max.x - b.min.x + 1, d: b.max.z - b.min.z + 1 }, zone: "ring", plot: { x: b.center.x, z: b.center.z } });
  });
  if (gaps) {
    const g = groundGaps(bot, buildings, center);
    report.gaps = g.length;
    if (g.length) { const s = specFrom("ground fill", g, "fill"); tasks.push({ id: "fill_gaps", title: "fill the ground gaps", request: "fill the ground gaps", roleHint: "lumberjack", spec: s.spec, origin: s.origin, size: { w: s.spec.size.w, d: s.spec.size.d }, zone: "outer", plot: { x: center.x, z: center.z } }); }
  }
  if (paths) {
    const p = pathsTo(bot, buildings, center);
    report.path = p.length;
    if (p.length) { const s = specFrom("village paths", p, "path"); tasks.push({ id: "paths", title: "lay the village paths", request: "lay dirt paths to every door", roleHint: "builder", spec: s.spec, origin: s.origin, size: { w: s.spec.size.w, d: s.spec.size.d }, zone: "outer", plot: { x: center.x, z: center.z } }); }
  }
  return { tasks, report, buildings };
}

module.exports = { findBuildings, groundGaps, pathsTo, specFrom, planRenovation };
