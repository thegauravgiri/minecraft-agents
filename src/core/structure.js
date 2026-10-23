// Pure structure language: an AI-designed spec -> exact world cells, with validation, material needs, diff and order.
// No bot access. "world" is a function blockAt({x,y,z}) -> {name, boundingBox?} | "name" | null (unloaded).
//
// Spec (all coordinates relative to the origin; y=0 is the SURFACE layer, i.e. the existing ground block; y>=1 is above it):
// {
//   "name": "two storey house",
//   "size": { "w": 9, "d": 9, "h": 10 },                 // x, z, y extent of the bounding box (max 40 x 40 x 32)
//   "palette": { "wall": "oak_planks", "roof": "oak_stairs", "glass": "glass_pane", ... },   // key -> real block name
//   "ops": [ ...ordered, later ops paint over earlier ones... ]
// }
// Ops ("block" may be a palette key or a real block name; from/to are inclusive [x,y,z]):
//   box    {from,to,block}              solid fill
//   hollow {from,to,block}              only the outer shell (6 faces)
//   walls  {from,to,block}              only the 4 vertical faces (no floor/ceiling)
//   line   {from,to,block}
//   set    {at,block,facing?,half?}     one block (stairs, slab, trapdoor, fence_gate, torch, ladder, ...)
//   stairs {at,block,facing,half?}      same as set, facing = direction the stair ascends toward (north/south/east/west)
//   door   {at,block,facing}            two-high door; `at` is the lower half, facing = the OUTSIDE side
//   clear  {from,to}                    make air (windows, doorways, stairwell holes)
//   till   {from,to}                    y must be 0: ground becomes farmland (needs a hoe)
//   plant  {from,to,crop}               crop = wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|sweet_berry_bush|nether_wart ...
//   water  {at}                         y=0: dig the ground cell and fill it with water (needs a water bucket)
const LIMITS = { w: 40, d: 40, h: 32, cells: 6000 };
const DIRS = { north: { x: 0, z: -1 }, south: { x: 0, z: 1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 } };

// crop block -> the item that is planted
const CROP_ITEM = {
  wheat: "wheat_seeds", carrots: "carrot", potatoes: "potato", beetroots: "beetroot_seeds", melon_stem: "melon_seeds",
  pumpkin_stem: "pumpkin_seeds", sweet_berry_bush: "sweet_berries", nether_wart: "nether_wart", torchflower: "torchflower_seeds"
};
const BLOCK_ITEM = { wall_torch: "torch", soul_wall_torch: "soul_torch", redstone_wire: "redstone", water: "water_bucket", lava: "lava_bucket", farmland: null };

const DECOR = /(torch|lantern|campfire|flower|_sign|banner|carpet|flower_pot|candle|_button|lever|pressure_plate|painting|item_frame|tulip|poppy|dandelion|rail)$/;
const nameOf = (i) => (i == null ? null : typeof i === "string" ? i : i.name);
const isAirName = (n) => !!n && /^(cave_|void_)?air$/.test(n);
const key = (p) => `${p.x},${p.y},${p.z}`;
const arr3 = (a) => Array.isArray(a) && a.length === 3 && a.every((v) => Number.isInteger(v));

function normalizeBlock(spec, b) {
  if (b == null) return null;
  const mapped = spec.palette?.[b] ?? b;
  return String(mapped).replace(/^minecraft:/, "");
}

/** Validate and compile. Returns {ok, cells, errors, warnings, bounds}. cells: [{x,y,z,block,kind,item,facing,half,...}] (relative). */
function compileStructure(spec, reg) {
  const errors = [], warnings = [];
  if (!spec || typeof spec !== "object") return { ok: false, errors: ["spec must be an object"], cells: [] };
  const size = spec.size || {};
  const W = size.w, D = size.d, H = size.h;
  if (![W, D, H].every((v) => Number.isInteger(v) && v >= 1)) errors.push("size.w, size.d, size.h must be positive integers");
  if (W > LIMITS.w || D > LIMITS.d || H > LIMITS.h) errors.push(`size too large (max ${LIMITS.w}x${LIMITS.d}x${LIMITS.h})`);
  if (!Array.isArray(spec.ops) || !spec.ops.length) errors.push("ops must be a non-empty array");
  if (errors.length) return { ok: false, errors, cells: [] };

  const cells = new Map();
  const inBounds = (p) => p.x >= 0 && p.x < W && p.y >= 0 && p.y < H && p.z >= 0 && p.z < D;
  const checkBlock = (name, where) => {
    if (name === "air") return true;
    if (!reg.hasBlock(name)) { errors.push(`${where}: unknown block "${name}"`); return false; }
    return true;
  };
  const put = (x, y, z, cell) => { cells.set(key({ x, y, z }), { x, y, z, ...cell }); };
  const range = (op, where) => {
    if (!arr3(op.from) || !arr3(op.to)) { errors.push(`${where}: from/to must be [x,y,z] integers`); return null; }
    const [x0, x1] = [Math.min(op.from[0], op.to[0]), Math.max(op.from[0], op.to[0])];
    const [y0, y1] = [Math.min(op.from[1], op.to[1]), Math.max(op.from[1], op.to[1])];
    const [z0, z1] = [Math.min(op.from[2], op.to[2]), Math.max(op.from[2], op.to[2])];
    if (!inBounds({ x: x0, y: y0, z: z0 }) || !inBounds({ x: x1, y: y1, z: z1 })) { errors.push(`${where}: range ${JSON.stringify(op.from)}..${JSON.stringify(op.to)} is outside the size ${W}x${H}x${D} (x,y,z)`); return null; }
    return { x0, x1, y0, y1, z0, z1 };
  };

  spec.ops.forEach((op, i) => {
    const where = `ops[${i}] (${op?.op})`;
    if (!op || typeof op !== "object") { errors.push(`${where}: not an object`); return; }
    const block = op.block != null ? normalizeBlock(spec, op.block) : null;
    switch (op.op) {
      case "box": case "hollow": case "walls": {
        const r = range(op, where); if (!r || !checkBlock(block, where)) return;
        for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) for (let z = r.z0; z <= r.z1; z++) {
          const edgeX = x === r.x0 || x === r.x1, edgeY = y === r.y0 || y === r.y1, edgeZ = z === r.z0 || z === r.z1;
          const on = op.op === "box" || (op.op === "hollow" && (edgeX || edgeY || edgeZ)) || (op.op === "walls" && (edgeX || edgeZ));
          if (on) put(x, y, z, { block, kind: block === "air" ? "air" : "block" });
        }
        break;
      }
      case "line": {
        const r = range(op, where); if (!r || !checkBlock(block, where)) return;
        const n = Math.max(r.x1 - r.x0, r.y1 - r.y0, r.z1 - r.z0, 0);
        for (let t = 0; t <= n; t++) {
          const f = n ? t / n : 0;
          put(Math.round(op.from[0] + (op.to[0] - op.from[0]) * f), Math.round(op.from[1] + (op.to[1] - op.from[1]) * f), Math.round(op.from[2] + (op.to[2] - op.from[2]) * f), { block, kind: "block" });
        }
        break;
      }
      case "set": case "stairs": {
        if (!arr3(op.at)) { errors.push(`${where}: at must be [x,y,z]`); return; }
        const [x, y, z] = op.at;
        if (!inBounds({ x, y, z })) { errors.push(`${where}: at ${JSON.stringify(op.at)} outside bounds`); return; }
        if (!checkBlock(block, where)) return;
        if (op.facing && !DIRS[op.facing]) { errors.push(`${where}: facing must be north|south|east|west`); return; }
        put(x, y, z, { block, kind: block === "air" ? "air" : "block", facing: op.facing, half: op.half });
        break;
      }
      case "door": {
        if (!arr3(op.at)) { errors.push(`${where}: at must be [x,y,z]`); return; }
        const [x, y, z] = op.at;
        if (!inBounds({ x, y: y + 1, z }) || !inBounds({ x, y, z })) { errors.push(`${where}: door (2 high) outside bounds`); return; }
        if (!checkBlock(block, where) || !/_door$/.test(block)) { errors.push(`${where}: block must be a *_door`); return; }
        if (!DIRS[op.facing]) { errors.push(`${where}: facing must be north|south|east|west (the outside side)`); return; }
        put(x, y, z, { block, kind: "door", half: "lower", facing: op.facing });
        put(x, y + 1, z, { block, kind: "door_upper", half: "upper", facing: op.facing });
        break;
      }
      case "clear": {
        const r = range(op, where); if (!r) return;
        for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) for (let z = r.z0; z <= r.z1; z++) put(x, y, z, { block: "air", kind: "air" });
        break;
      }
      case "path": {                                                       // one surface block becomes a dirt path (shovel on grass/dirt)
        if (!arr3(op.at)) { errors.push(`${where}: at must be [x,y,z]`); return; }
        const [x, y, z] = op.at;
        if (!inBounds({ x, y, z })) { errors.push(`${where}: at ${JSON.stringify(op.at)} outside bounds`); return; }
        put(x, y, z, { block: "dirt_path", kind: "path" });
        break;
      }
      case "till": {
        const r = range(op, where); if (!r) return;
        if (r.y0 !== 0 || r.y1 !== 0) { errors.push(`${where}: till must be at y=0`); return; }
        for (let x = r.x0; x <= r.x1; x++) for (let z = r.z0; z <= r.z1; z++) put(x, 0, z, { block: "farmland", kind: "till" });
        break;
      }
      case "plant": {
        const r = range(op, where); if (!r) return;
        const crop = String(op.crop || "wheat").replace(/^minecraft:/, "");
        const item = CROP_ITEM[crop] || (reg.hasItem(crop) ? crop : null);
        if (!item || !reg.hasBlock(crop === "wheat_seeds" ? "wheat" : crop)) { errors.push(`${where}: unknown crop "${crop}"`); return; }
        const blockName = Object.keys(CROP_ITEM).find((k) => CROP_ITEM[k] === item) || crop;
        for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) for (let z = r.z0; z <= r.z1; z++) put(x, y, z, { block: blockName, kind: "plant", item });
        break;
      }
      case "water": {
        if (!arr3(op.at)) { errors.push(`${where}: at must be [x,y,z]`); return; }
        const [x, y, z] = op.at;
        if (!inBounds({ x, y, z })) { errors.push(`${where}: at outside bounds`); return; }
        put(x, y, z, { block: "water", kind: "water" });
        break;
      }
      default: errors.push(`${where}: unknown op "${op.op}"`);
    }
  });

  // item per cell
  const out = [];
  for (const c of cells.values()) {
    if (c.kind === "air" || c.kind === "till" || c.kind === "path") { out.push({ ...c, item: null }); continue; }
    if (c.kind === "plant") { out.push(c); continue; }
    const item = BLOCK_ITEM[c.block] !== undefined ? BLOCK_ITEM[c.block] : (reg.hasItem(c.block) ? c.block : null);
    if (item === undefined || (item === null && c.kind !== "water")) { warnings.push(`no item for block ${c.block}`); }
    out.push({ ...c, item });
  }
  for (const c of out) if (c.kind === "block" && DECOR.test(c.block)) c.optional = true;
  // farm sanity: crops need hydrated farmland and every crop must be within 4 blocks of a water cell
  const waters = out.filter((c) => c.kind === "water");
  const farmland = out.filter((c) => c.kind === "till"), plants = out.filter((c) => c.kind === "plant" && c.block !== "nether_wart");
  if ((farmland.length || plants.length) && !waters.length) errors.push('a farm needs a water cell: add {"op":"water","at":[x,0,z]} in the middle of the tilled area (it hydrates farmland within 4 blocks) and leave the cell above it empty');
  else if (waters.length) {
    const far = farmland.filter((f) => !waters.some((w) => Math.abs(w.x - f.x) <= 4 && Math.abs(w.z - f.z) <= 4));
    if (far.length) errors.push(`${far.length} tilled cells are more than 4 blocks from a water cell (e.g. at [${far[0].x},0,${far[0].z}]): add more water cells so every tilled cell is within 4 blocks`);
  }
  if (out.length > LIMITS.cells)
  if (!out.some((c) => c.kind !== "air")) errors.push("the spec places nothing");
  return { ok: errors.length === 0, errors, warnings, cells: out, size: { w: W, d: D, h: H } };
}

const abs = (c, origin) => ({ ...c, x: c.x + origin.x, y: c.y + origin.y, z: c.z + origin.z });

/** Materials: consumed items {name:n}, tools needed (hoe, bucket), from the cells still missing. */
function materialsFor(cells, have = {}, { missing = null } = {}) {
  const need = {};
  const tools = new Set();
  const list = missing || cells;
  for (const c of list) {
    if (c.kind === "air") continue;
    if (c.kind === "till") { tools.add("hoe"); continue; }
    if (c.kind === "path") { tools.add("shovel"); continue; }
    if (c.kind === "water") { tools.add("water_bucket"); continue; }
    if (c.kind === "door_upper") continue;           // the door item places both halves
    if (c.item) need[c.item] = (need[c.item] || 0) + 1;
  }
  // any planks type may stand in for another, same for logs / stone-ish blocks the player holds plenty of
  const short = {};
  const group = (n) => (/_planks$/.test(n) ? "planks" : /_log$/.test(n) ? "log" : /_door$/.test(n) ? "door" : null);
  const pool = {};
  for (const [k, v] of Object.entries(have)) { const g = group(k); if (g) pool[g] = (pool[g] || 0) + v; }
  const demand = {};
  for (const [item, n] of Object.entries(need)) {
    const g = group(item);
    if (g) demand[g] = (demand[g] || 0) + n; else if ((have[item] || 0) < n) short[item] = n - (have[item] || 0);
  }
  for (const [g, n] of Object.entries(demand)) {
    const gotN = pool[g] || 0;
    if (gotN < n) {
      const sample = Object.keys(need).find((k) => group(k) === g);
      short[sample] = n - gotN;
    }
  }
  return { need, short, tools: [...tools] };
}

/** Compare the world with the (absolute) cells. Returns { missing, wrong, unknown, ratio }. */
function diffStructure(cells, blockAt) {
  const missing = [], wrong = [], unknown = [], optionalMissing = [];
  for (const c of cells) {
    const w = blockAt({ x: c.x, y: c.y, z: c.z });
    const name = nameOf(w);
    if (name == null) { unknown.push(c); continue; }
    let ok;
    if (c.kind === "air") ok = isAirName(name) || (typeof w === "object" && w.boundingBox === "empty" && !/(water|lava)/.test(name));
    else if (c.kind === "door" || c.kind === "door_upper") ok = name === c.block || /_door$/.test(name);
    else if (c.kind === "water") ok = name === "water";
    else if (c.kind === "till") ok = name === "farmland";
    else if (c.kind === "path") ok = name === "dirt_path";
    else if (c.kind === "plant") ok = name === c.block;
    else ok = name === c.block || (/_planks$/.test(c.block) && /_planks$/.test(name)) || (/stairs$/.test(c.block) && /stairs$/.test(name) && c.block.split("_")[0] === name.split("_")[0]);
    if (ok) continue;
    if (c.optional) { optionalMissing.push(c); continue; }
    (isAirName(name) || name === "water" && c.kind !== "water" ? missing : wrong).push(c);
  }
  const total = cells.length;
  return { missing, wrong, unknown, optionalMissing, ratio: total ? 1 - (missing.length + wrong.length) / total : 1 };
}

/**
 * Progressive building: walk the missing cells in build order (bottom-up) against what is in the bag.
 *  buildable - how many cells can be placed RIGHT NOW with the current inventory
 *  wants     - what the NEXT batch of cells (the first `batch` that the bag cannot cover) needs, so gathering is done in small steps
 *              instead of collecting the whole building's materials before the first block is placed
 */
function progressivePlan(missing, have = {}, { batch = 40 } = {}) {
  const group = (n) => (/_planks$/.test(n) ? "planks" : /_log$/.test(n) ? "log" : /_door$/.test(n) ? "door" : null);
  const pool = { ...have }, gpool = {};
  for (const [k, v] of Object.entries(have)) { const g = group(k); if (g) gpool[g] = (gpool[g] || 0) + v; }
  const take = (item) => {
    const g = group(item);
    if (g) { if ((gpool[g] || 0) > 0) { gpool[g]--; return true; } return false; }
    if ((pool[item] || 0) > 0) { pool[item]--; return true; }
    return false;
  };
  const ordered = orderCells(missing.filter((c) => c.kind !== "air" && c.kind !== "door_upper"), { x: 0, z: 0 });
  let buildable = 0; const wants = {}, kinds = new Set(); let queued = 0;
  for (const c of ordered) {
    if (c.kind === "till" || c.kind === "water" || c.kind === "path") { if (queued < batch) { kinds.add(c.kind); queued++; } continue; }
    if (!c.item) { buildable++; continue; }
    if (take(c.item)) buildable++;
    else if (queued < batch) { wants[c.item] = (wants[c.item] || 0) + 1; queued++; }
  }
  return { buildable, wants, kinds: [...kinds], total: ordered.length };
}

/** Placement order: bottom-up by layer; inside a layer walls before fillers; clears first; plants after tills/water. */
const KIND_RANK = { air: 0, water: 1, till: 2, path: 2, block: 3, door: 4, door_upper: 5, plant: 6 };   // water first: dry farmland turns back into dirt
function orderCells(cells, from = { x: 0, z: 0 }) {
  return [...cells].sort((a, b) => a.y - b.y || (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z));
}

module.exports = { compileStructure, materialsFor, progressivePlan, diffStructure, orderCells, abs, DIRS, CROP_ITEM, LIMITS, key };
