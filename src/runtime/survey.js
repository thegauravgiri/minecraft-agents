// Look at an existing building (a village house, something the team built long ago) and describe it so the AI can repair or renovate it:
// find the cluster of player-made blocks nearest to a point, measure it, and print it layer by layer.
const { Vec3 } = require("vec3");
const { builtName, looksBuilt } = require("../skills/blocks");

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function surveyBuilding(bot, near, { radius = 26, maxBlocks = 7000 } = {}) {
  const structural = (b) => b && b.boundingBox !== "empty" && (builtName(b.name) || (/_(log|wood)$/.test(b.name) && looksBuilt(bot, b)));
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
  const cx = Math.floor(near.x), cy = Math.floor(near.y), cz = Math.floor(near.z);
  // seeds: structural blocks around the point, nearest first
  const seeds = [];
  for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) for (let dy = -4; dy <= 8; dy++) { const b = at(cx + dx, cy + dy, cz + dz); if (structural(b)) seeds.push({ b, d: Math.hypot(dx, dz) + Math.abs(dy) * 0.5 }); }
  if (!seeds.length) return null;
  seeds.sort((a, b) => a.d - b.d);
  const seen = new Set(), key = (x, y, z) => `${x},${y},${z}`;
  const blocks = [];
  const queue = [seeds[0].b.position];
  seen.add(key(queue[0].x, queue[0].y, queue[0].z));
  while (queue.length && blocks.length < maxBlocks) {
    const p = queue.pop();
    const b = at(p.x, p.y, p.z);
    if (!structural(b)) continue;
    if (Math.abs(p.x - cx) > radius || Math.abs(p.z - cz) > radius) continue;
    blocks.push({ x: p.x, y: p.y, z: p.z, name: b.name });
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dy && !dz) continue;
      const k = key(p.x + dx, p.y + dy, p.z + dz);
      if (!seen.has(k)) { seen.add(k); queue.push(new Vec3(p.x + dx, p.y + dy, p.z + dz)); }
    }
  }
  if (blocks.length < 12) return null;
  const min = { x: Math.min(...blocks.map((b) => b.x)), y: Math.min(...blocks.map((b) => b.y)), z: Math.min(...blocks.map((b) => b.z)) };
  const max = { x: Math.max(...blocks.map((b) => b.x)), y: Math.max(...blocks.map((b) => b.y)), z: Math.max(...blocks.map((b) => b.z)) };
  const size = { w: max.x - min.x + 1, d: max.z - min.z + 1, h: max.y - min.y + 1 };
  if (size.w > 40 || size.d > 40 || size.h > 32) return { tooBig: true, size };
  // palette: most common blocks get letters
  const count = {};
  for (const b of blocks) count[b.name] = (count[b.name] || 0) + 1;
  const names = Object.keys(count).sort((a, b) => count[b] - count[a]).slice(0, 24);
  const letter = Object.fromEntries(names.map((n, i) => [n, LETTERS[i]]));
  const grid = new Map(blocks.map((b) => [key(b.x - min.x, b.y - min.y, b.z - min.z), b.name]));
  const layers = [];
  for (let y = 0; y < size.h; y++) {
    const rows = [];
    for (let z = 0; z < size.d; z++) { let row = ""; for (let x = 0; x < size.w; x++) { const n = grid.get(key(x, y, z)); row += n ? (letter[n] || "?") : "."; } rows.push(row); }
    layers.push(`y=${y}:\n${rows.join("\n")}`);
  }
  // Likely damage: an empty cell with built blocks on 4+ sides (or on two opposite sides + more) inside the building's own shell, e.g. a missing wall/roof block.
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const holes = [];
  for (let y = 0; y < size.h; y++) for (let z = 0; z < size.d; z++) for (let x = 0; x < size.w; x++) {
    if (grid.has(key(x, y, z))) continue;
    const nb = dirs.map(([dx, dy, dz]) => grid.get(key(x + dx, y + dy, z + dz))).filter(Boolean);
    const opposite = [[0, 1], [2, 3], [4, 5]].some(([a, b]) => grid.has(key(x + dirs[a][0], y + dirs[a][1], z + dirs[a][2])) && grid.has(key(x + dirs[b][0], y + dirs[b][1], z + dirs[b][2])));
    const shell = x === 0 || z === 0 || x === size.w - 1 || z === size.d - 1 || y === 0 || y === size.h - 1;
    // inside the house only a gap in a FLOOR/CEILING counts (all four horizontal neighbours built); the rest of the interior is living space, not damage
    const floorGap = !shell && [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => grid.has(key(x + dx, y, z + dz)));
    if ((shell && (nb.length >= 4 || (nb.length >= 3 && opposite))) || floorGap) {
      const tally = {}; for (const n of nb) tally[n] = (tally[n] || 0) + 1;
      holes.push({ x, y, z, block: Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0] });
    }
  }
  return { origin: min, size, blocks: blocks.length, grid, palette: letter, ascii: layers.join("\n"), key, holes: holes.slice(0, 60) };
}

module.exports = { surveyBuilding };
