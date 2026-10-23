// Fixing up what exists - deterministic, no AI guesswork, no 20-second design call:
//   repair  : every hole in a building's shell (walls, roof, floor) is filled with the material around it; a dirt/cobble patch stuck in a
//             plank wall is replaced by planks; a 1x2 opening at floor level in a wall gets a door
//   clean   : junk blocks (dirt, gravel, scaffold cobblestone...) inside the building, on its roof, and piled up around it above the ground are removed
//   fill    : pits and holes in the ground around it are filled up to the normal ground level
// The result is one structure spec with a fixed origin, so the normal builder does the work (and verifies it).
const { Vec3 } = require("vec3");
const { surveyBuilding } = require("../runtime/survey");
const { columnTop } = require("../runtime/spatial");
const { findBuildings, groundGaps } = require("./village");

const JUNK = /^(dirt|coarse_dirt|rooted_dirt|gravel|sand|red_sand|netherrack|cobbled_deepslate|cobblestone|mossy_cobblestone|andesite|diorite|granite|tuff)$/;
const key = (x, y, z) => `${x},${y},${z}`;

/** Most common surface height around (the "ground level" of the place). */
function groundRef(bot, center, radius, buildings) {
  const count = {};
  for (let x = center.x - radius; x <= center.x + radius; x += 2) for (let z = center.z - radius; z <= center.z + radius; z += 2) {
    if (buildings.some((b) => x >= b.min.x - 1 && x <= b.max.x + 1 && z >= b.min.z - 1 && z <= b.max.z + 1)) continue;
    const t = columnTop(bot, x, z, center.y + 6, 16, 24);
    if (!t.unloaded && t.kind === "ground" && !JUNK.test(t.name || "") ) count[t.y] = (count[t.y] || 0) + 1;
  }
  const ys = Object.keys(count);
  return ys.length ? Number(ys.sort((a, b) => count[b] - count[a])[0]) : Math.floor(center.y);
}

/** Repair cells of one building: holes / junk patches -> material, doorways -> a door. */
function repairCells(bot, sv) {
  const place = [], doors = [];
  const usesCobble = [...sv.grid.values()].filter((n) => /cobble/.test(n)).length > sv.blocks * 0.1;
  const holeSet = new Set(sv.holes.map((h) => key(h.x, h.y, h.z)));
  const onShell = (h) => h.x === 0 || h.z === 0 || h.x === sv.size.w - 1 || h.z === sv.size.d - 1;
  const used = new Set();
  for (const h of sv.holes) {
    if (used.has(key(h.x, h.y, h.z))) continue;
    const abs = { x: sv.origin.x + h.x, y: sv.origin.y + h.y, z: sv.origin.z + h.z };
    // a 1-wide, 2-high gap in an outer wall right above the floor is a doorway: it gets a door, not a wall block
    if (onShell(h) && holeSet.has(key(h.x, h.y + 1, h.z)) && (sv.grid.has(key(h.x, h.y - 1, h.z)) || h.y <= 1)) {
      const facing = h.x === 0 ? "west" : h.x === sv.size.w - 1 ? "east" : h.z === 0 ? "north" : "south";
      const existing = bot.blockAt(new Vec3(abs.x, abs.y, abs.z));
      if (!existing || !/_door$/.test(existing.name)) doors.push({ ...abs, facing });
      used.add(key(h.x, h.y + 1, h.z));
      continue;
    }
    const cur = bot.blockAt(new Vec3(abs.x, abs.y, abs.z));
    if (cur && cur.boundingBox === "block" && !JUNK.test(cur.name)) continue;     // something solid and proper is there already: not ours to judge
    if (/cobble/.test(h.block) && !usesCobble) continue;
    place.push({ ...abs, block: h.block });
  }
  return { place, doors };
}

/** Junk to remove: inside the building, on its roof, and piled up around it above the ground. */
function junkCells(bot, b, ref, ring = 6) {
  const out = [];
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
  const shellMaterials = new Set();
  for (let x = b.min.x; x <= b.max.x; x++) for (let z = b.min.z; z <= b.max.z; z += Math.max(1, b.max.z - b.min.z)) { const n = at(x, b.min.y + 1, z)?.name; if (n) shellMaterials.add(n); }
  const isJunk = (blk) => blk && blk.boundingBox === "block" && JUNK.test(blk.name) && !shellMaterials.has(blk.name);
  // inside (between the walls, above the floor, below the roof)
  for (let x = b.min.x + 1; x < b.max.x; x++) for (let z = b.min.z + 1; z < b.max.z; z++) for (let y = b.min.y + 1; y < b.max.y; y++) { const blk = at(x, y, z); if (isJunk(blk)) out.push({ x, y, z }); }
  // on the roof
  for (let x = b.min.x - 1; x <= b.max.x + 1; x++) for (let z = b.min.z - 1; z <= b.max.z + 1; z++) for (let y = b.max.y + 1; y <= b.max.y + 6; y++) { const blk = at(x, y, z); if (isJunk(blk)) out.push({ x, y, z }); }
  // around it, above the ground level (scaffold pillars, dropped dirt piles)
  for (let x = b.min.x - ring; x <= b.max.x + ring; x++) for (let z = b.min.z - ring; z <= b.max.z + ring; z++) {
    if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) continue;
    for (let y = ref + 1; y <= ref + 10; y++) { const blk = at(x, y, z); if (isJunk(blk)) out.push({ x, y, z }); }
  }
  return out;
}

/** cells -> structure spec with a fixed origin. place:[{x,y,z,block}] clear:[{x,y,z}] doors:[{x,y,z,facing}] */
function specOf(name, { place = [], clear = [], doors = [] }) {
  const all = [...place, ...clear, ...doors, ...doors.map((d) => ({ ...d, y: d.y + 1 }))];
  if (!all.length) return null;
  const min = { x: Math.min(...all.map((c) => c.x)), y: Math.min(...all.map((c) => c.y)), z: Math.min(...all.map((c) => c.z)) };
  const max = { x: Math.max(...all.map((c) => c.x)), y: Math.max(...all.map((c) => c.y)), z: Math.max(...all.map((c) => c.z)) };
  const rel = (c) => [c.x - min.x, c.y - min.y, c.z - min.z];
  const ops = [
    ...clear.map((c) => ({ op: "set", at: rel(c), block: "air" })),
    ...place.map((c) => ({ op: "set", at: rel(c), block: c.block })),
    ...doors.map((d) => ({ op: "door", at: rel(d), block: "oak_door", facing: d.facing }))
  ];
  return { origin: min, spec: { name, size: { w: max.x - min.x + 1, d: max.z - min.z + 1, h: max.y - min.y + 1 }, palette: {}, ops } };
}

/**
 * Plan a fix-up around a point. opts: { repair, clean, fill, radius }
 * Returns { spec, origin, report } or { error }.
 */
function planFixup(bot, center, { repair = true, clean = true, fill = true, radius = 14 } = {}) {
  const buildings = findBuildings(bot, center, radius + 24).filter((b) => Math.hypot(b.center.x - center.x, b.center.z - center.z) <= radius + Math.max(b.max.x - b.min.x, b.max.z - b.min.z));
  const ref = groundRef(bot, center, radius + 6, buildings);
  const place = [], clear = [], doors = [];
  const report = { buildings: buildings.length, holes: 0, doors: 0, junk: 0, gaps: 0, groundLevel: ref };
  for (const b of buildings.slice(0, 6)) {
    if (repair) {
      const sv = surveyBuilding(bot, { x: b.center.x, y: b.min.y + 1, z: b.center.z });
      if (sv && !sv.tooBig) { const r = repairCells(bot, sv); require("../runtime/util").log("repair", `building at ${sv.origin.x},${sv.origin.y},${sv.origin.z} ${sv.size.w}x${sv.size.d}x${sv.size.h}: holes ${JSON.stringify(sv.holes.map((h) => [h.x, h.y, h.z]))} -> place ${JSON.stringify(r.place.map((c) => [c.x - sv.origin.x, c.y - sv.origin.y, c.z - sv.origin.z, c.block]))}`); place.push(...r.place); doors.push(...r.doors); report.holes += r.place.length; report.doors += r.doors.length; }
    }
    if (clean) { const j = junkCells(bot, b, ref); clear.push(...j); report.junk += j.length; }
  }
  if (clean && !buildings.length) {                                          // no building: just the junk piles above the ground around the point
    const pseudo = { min: { x: center.x, y: ref, z: center.z }, max: { x: center.x, y: ref, z: center.z } };
    const j = junkCells(bot, pseudo, ref, radius).filter((c) => c.y > ref); clear.push(...j); report.junk += j.length;
  }
  if (fill) {
    const g = groundGaps(bot, buildings, { x: center.x, y: ref, z: center.z }, radius, 300).map((c) => ({ ...c, block: "dirt" }));
    place.push(...g); report.gaps = g.length;
  }
  const seen = new Set();
  const dedupe = (list) => list.filter((c) => { const k = key(c.x, c.y, c.z); if (seen.has(k)) return false; seen.add(k); return true; });
  const s = specOf("fix-up", { doors: dedupe(doors), place: dedupe(place), clear: dedupe(clear) });
  if (!s) return { report, nothing: true };
  return { ...s, report };
}

module.exports = { planFixup, repairCells, junkCells, groundRef, specOf, JUNK };
