// Pure house blueprint: geometry, world diff, material needs, placement order and an independent verifier.
// No bot access. The "world" is a function blockAtFn({x,y,z}) -> {name, boundingBox?} | "name" | null (unloaded).
//
// Coordinates: origin = min corner of the footprint at FLOOR level. Floor layer y0 = origin.y (natural ground
// counts as floor), walls y0+1..y0+h, roof y0+h+1. Interior = footprint minus the wall ring, y0+1..y0+h.
//
// planBuildHouse(goal, snapshot, hints) -> planner handler result
//   goal     { type:'build', what:'house', size?:{w,d,h}, material?:'oak_planks', origin?, door?, windows? }
//   snapshot { inv:{item:count}, ... }
//   hints    { houseVerified?:bool, house?:{origin,size,material,door,windows} (mem.recall('house')),
//              houseBlockAt?: blockAtFn (enables exact missing-cell count), houseBlocked?: string }
//   returns  { done:true, remaining:0 }
//          | { blocked:string, remaining:1e6 }
//          | { done:false, remaining:N, needs:{oak_planks:N, oak_door:1, glass:2}, action:null, label }   (materials short)
//          | { done:false, remaining:N, action:{skill:'build_house', args, label} }
// `remaining` = number of cells still missing/wrong (falls as the house is built).

const DIRS = { south: { x: 0, z: 1 }, north: { x: 0, z: -1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 } };

const nameOf = (i) => (i == null ? null : typeof i === "string" ? i : i.name);
const AIR = /^(cave_|void_)?air$/;
const FLUID = /^(water|lava|flowing_water|flowing_lava|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;
const NONSOLID = /(^|_)(grass|tall_grass|fern|large_fern|dandelion|poppy|orchid|allium|bluet|tulip|daisy|cornflower|lily_of_the_valley|rose|peony|lilac|sunflower|torch|sign|button|pressure_plate|carpet|rail|vine|vines|dead_bush|sapling|mushroom|banner|lever|redstone_wire|cobweb|tripwire|leaf_litter|ladder|flower|snow|fire|bush)$/;
const BAD_WALL = /(leaves|(^|_)ice$|sand$|gravel$|tnt|cactus|magma|slime|honey|cobweb|powder_snow)/;

const isDoorName = (n) => !!n && /_door$/.test(n);
const isAir = (i) => !!nameOf(i) && AIR.test(nameOf(i));
const isFluid = (i) => { const n = nameOf(i); return !!n && FLUID.test(n); };
const isDoor = (i) => isDoorName(nameOf(i));
function isSolid(i) {
  const n = nameOf(i);
  if (!n || AIR.test(n) || FLUID.test(n) || isDoorName(n)) return false;
  if (typeof i === "object" && i.boundingBox) return i.boundingBox === "block";
  return !NONSOLID.test(n);
}
const isSolidGood = (i) => isSolid(i) && !BAD_WALL.test(nameOf(i));
const isPassable = (i) => !!nameOf(i) && !isSolid(i) && !isDoor(i);
const isTorch = (i) => /torch$/.test(nameOf(i) || "");

const key = (p) => `${p.x},${p.y},${p.z}`;
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(v)));

function houseBlueprint({ origin, size = {}, material = "oak_planks", door = "south", windows = "glass", torch = true, doorItem = "oak_door" } = {}) {
  const w = clampInt(size.w ?? 5, 5, 15), d = clampInt(size.d ?? 5, 5, 15), h = clampInt(size.h ?? 3, 2, 6);
  const o = { x: Math.floor(origin?.x ?? 0), y: Math.floor(origin?.y ?? 0), z: Math.floor(origin?.z ?? 0) };
  if (!DIRS[door]) door = "south";
  if (h < 3 && windows !== "none") windows = "none";
  const y0 = o.y, top = y0 + h + 1;
  const cells = [];
  const add = (x, y, z, role, extra) => cells.push({ x: o.x + x, y, z: o.z + z, role, ...extra });

  const dir = DIRS[door];
  const alongX = dir.z !== 0;
  const doorIdx = alongX ? Math.floor(w / 2) : Math.floor(d / 2);
  const dx = dir.z === 1 ? doorIdx : dir.z === -1 ? doorIdx : dir.x === 1 ? w - 1 : 0;
  const dz = dir.z === 1 ? d - 1 : dir.z === -1 ? 0 : doorIdx;
  const winSpots = [];
  if (windows !== "none") {
    if (alongX) { winSpots.push([0, Math.floor(d / 2)], [w - 1, Math.floor(d / 2)]); }
    else { winSpots.push([Math.floor(w / 2), 0], [Math.floor(w / 2), d - 1]); }
  }
  const isWin = (x, z) => winSpots.some((s) => s[0] === x && s[1] === z);

  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) add(x, y0, z, "floor");
  for (let y = y0 + 1; y <= y0 + h; y++) {
    for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) {
      if (x !== 0 && x !== w - 1 && z !== 0 && z !== d - 1) continue;
      if (x === dx && z === dz && y === y0 + 1) { add(x, y, z, "door_lower"); continue; }
      if (x === dx && z === dz && y === y0 + 2) { add(x, y, z, "door_upper"); continue; }
      if (y === y0 + 2 && isWin(x, z)) { add(x, y, z, "window"); continue; }
      add(x, y, z, "wall");
    }
  }
  for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) add(x, top, z, "roof");

  const interior = [], stand = [];
  for (let x = 1; x < w - 1; x++) for (let z = 1; z < d - 1; z++) {
    for (let y = y0 + 1; y <= y0 + h; y++) interior.push({ x: o.x + x, y, z: o.z + z });
    stand.push({ x: o.x + x, y: y0 + 1, z: o.z + z });
  }
  const cx = o.x + (w - 1) / 2, cz = o.z + (d - 1) / 2;
  stand.sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz));

  const doorCell = { x: o.x + dx, y: y0 + 1, z: o.z + dz };
  const doorUpper = { x: doorCell.x, y: y0 + 2, z: doorCell.z };
  const front = { x: doorCell.x + dir.x, y: y0 + 1, z: doorCell.z + dir.z };
  const behind = { x: doorCell.x - dir.x, y: y0 + 1, z: doorCell.z - dir.z };
  const apron = [
    { ...{ x: front.x, y: y0, z: front.z }, role: "apron_floor" },
    { ...front, role: "apron_air" },
    { x: front.x, y: y0 + 2, z: front.z, role: "apron_air" }
  ];
  if (torch) {
    const far = stand.reduce((best, s) => (!best || Math.hypot(s.x - behind.x, s.z - behind.z) > Math.hypot(best.x - behind.x, best.z - behind.z) ? s : best), null);
    if (far) cells.push({ x: far.x, y: y0 + 1, z: far.z, role: "torch", optional: true });
  }
  return {
    origin: o, size: { w, d, h }, material, door, windows, doorItem, dir,
    box: { min: { x: o.x, y: y0, z: o.z }, max: { x: o.x + w - 1, y: top, z: o.z + d - 1 } },
    cells, interior, stand, doorCell, doorUpper, front, behind, apron
  };
}

const DOOR_ROLES = new Set(["door_lower", "door_upper"]);
const SOLID_ROLES = new Set(["floor", "wall", "roof"]);

// 'ok' | 'missing' | 'wrong' | 'unknown'
function cellState(cell, info, bp) {
  if (info == null) return "unknown";
  const r = cell.role;
  if (SOLID_ROLES.has(r) || (r === "window" && bp.windows === "glass")) {
    if (isSolidGood(info)) return "ok";
    return isSolid(info) ? "wrong" : "missing";
  }
  if (r === "window") return isSolid(info) ? "wrong" : "ok";
  if (DOOR_ROLES.has(r)) {
    const n = nameOf(info);
    if (isDoorName(n)) return n === "iron_door" ? "wrong" : "ok";
    if (isSolid(info)) return "wrong";
    return "missing";
  }
  if (r === "torch") return isTorch(info) ? "ok" : "missing";
  if (r === "interior" || r === "apron_air") return isPassable(info) ? "ok" : "wrong";
  if (r === "apron_floor") return isSolidGood(info) ? "ok" : "missing";
  return "ok";
}

function diffBlueprint(bp, at) {
  const missing = [], wrong = [], unknown = [];
  let req = 0, okN = 0;
  for (const c of bp.cells) {
    const s = cellState(c, at(c), bp);
    if (!c.optional) { req++; if (s === "ok") okN++; }
    if (s === "ok") continue;
    if (c.optional) continue;
    (s === "missing" ? missing : s === "wrong" ? wrong : unknown).push(c);
  }
  for (const c of bp.interior) {
    const s = cellState({ ...c, role: "interior" }, at(c), bp);
    if (s === "wrong") wrong.push({ ...c, role: "interior" });
  }
  return { missing, wrong, unknown, doneRatio: req ? okN / req : 1 };
}

// Blocks that must be removed before the structure can stand: plants/leaves/bumps in the build volume.
function obstructions(bp, at) {
  const out = [];
  const consider = (c, role) => {
    const info = at(c);
    const n = nameOf(info);
    if (!n || AIR.test(n) || FLUID.test(n)) return;
    if (cellState({ ...c, role }, info, bp) === "ok") return;
    out.push({ x: c.x, y: c.y, z: c.z, name: n, role });
  };
  for (const c of bp.cells) {
    if (c.role === "floor") continue;
    if (c.optional) continue;
    const st = cellState(c, at(c), bp);
    if (st === "ok") continue;
    const n = nameOf(at(c));
    if (!n || AIR.test(n) || FLUID.test(n)) continue;
    out.push({ x: c.x, y: c.y, z: c.z, name: n, role: c.role });
  }
  for (const c of bp.interior) consider(c, "interior");
  for (const c of bp.apron) if (c.role === "apron_air") consider(c, "apron_air");
  return out.sort((a, b) => b.y - a.y);
}

// Cells to fill (bottom-up) so every floor / apron-floor column is solid down to real ground.
function fillPlan(bp, at, maxDepth = 5) {
  const fills = [], unsupported = [];
  const cols = bp.cells.filter((c) => c.role === "floor").concat(bp.apron.filter((c) => c.role === "apron_floor"));
  for (const c of cols) {
    if (isSolidGood(at(c))) continue;
    let y = c.y - 1, found = null;
    for (let i = 0; i < maxDepth; i++, y--) {
      const info = at({ x: c.x, y, z: c.z });
      if (info == null) break;
      if (isSolidGood(info)) { found = y; break; }
    }
    if (found == null) { unsupported.push(c); continue; }
    for (let yy = found + 1; yy <= c.y; yy++) fills.push({ x: c.x, y: yy, z: c.z });
  }
  return { fills: fills.sort((a, b) => a.y - b.y), unsupported };
}

const isPlanksName = (n) => /_planks$/.test(n || "");
const REQUIRED_ITEM = (bp, role) => (role === "window" ? (bp.windows === "glass" ? "glass" : null) : DOOR_ROLES.has(role) ? bp.doorItem : role === "torch" ? null : bp.material);

// Shortfall per item: {item: count}. With `at`, only unsatisfied cells are counted.
function materialsNeeded(bp, have = {}, at = null, { ignoreFloor = false } = {}) {
  const need = {};
  let doorMissing = false;
  for (const c of bp.cells) {
    if (c.optional) continue;
    if (ignoreFloor && c.role === "floor") continue;
    if (at && cellState(c, at(c), bp) === "ok") continue;
    if (DOOR_ROLES.has(c.role)) { doorMissing = true; continue; }
    const item = REQUIRED_ITEM(bp, c.role);
    if (item) need[item] = (need[item] || 0) + 1;
  }
  if (doorMissing) need[bp.doorItem] = 1;
  const out = {};
  for (const [item, n] of Object.entries(need)) {
    let got = have[item] || 0;
    if (isPlanksName(item)) for (const [k, v] of Object.entries(have)) if (k !== item && isPlanksName(k)) got += v;
    if (isDoorName(item)) for (const [k, v] of Object.entries(have)) if (k !== item && isDoorName(k) && k !== "iron_door") got += v;
    if (n > got) out[item] = n - got;
  }
  return out;
}

// Stands (feet cells) from which `cell` can be placed (eye within reach), nearest first.
function standsFor(cell, stands, reach = 4.3) {
  const cx = cell.x + 0.5, cy = cell.y + 0.5, cz = cell.z + 0.5;
  return stands
    .filter((s) => !(s.x === cell.x && s.z === cell.z && (cell.y === s.y || cell.y === s.y + 1)))
    .map((s) => ({ s, d: Math.hypot(s.x + 0.5 - cx, s.y + 1.62 - cy, s.z + 0.5 - cz) }))
    .filter((e) => e.d <= reach)
    .sort((a, b) => a.d - b.d)
    .map((e) => e.s);
}

const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// Bottom-up order where every cell touches a solid (existing world via solidFn, or an earlier cell)
// and is reachable from some stand. Returns {order:[{cell,stand}], stuck:[cells]}.
function orderCells(cells, stands, { solid = () => false, reach = 4.3 } = {}) {
  const placed = new Set();
  let pending = cells.filter((c) => !DOOR_ROLES.has(c.role) && c.role !== "torch");
  const order = [];
  let last = null;
  const supported = (c) => N6.some(([a, b, e]) => { const p = { x: c.x + a, y: c.y + b, z: c.z + e }; return placed.has(key(p)) || solid(p); });
  while (pending.length) {
    const elig = [];
    for (const c of pending) {
      if (!supported(c)) continue;
      const st = standsFor(c, stands, reach);
      if (st.length) elig.push({ c, st });
    }
    if (!elig.length) break;
    const minY = Math.min(...elig.map((e) => e.c.y));
    const layer = elig.filter((e) => e.c.y === minY);
    const pick = (last && layer.find((e) => e.st.some((s) => key(s) === key(last)))) || layer[0];
    const stand = last && pick.st.some((s) => key(s) === key(last)) ? last : pick.st[0];
    order.push({ cell: pick.c, stand });
    placed.add(key(pick.c));
    last = stand;
    pending = pending.filter((c) => c !== pick.c);
  }
  return { order, stuck: pending };
}

// Independent structural check on the real world.
function verifyHouse(bp, at) {
  const problems = [];
  const P = (code, c) => problems.push(c ? `${code}@${c.x},${c.y},${c.z}` : code);
  const { box } = bp, y0 = bp.origin.y;

  for (const c of bp.cells) {
    if (c.optional) continue;
    const info = at(c);
    const s = cellState(c, info, bp);
    if (s === "ok") continue;
    if (s === "unknown") { P("unloaded", c); continue; }
    const code = { floor: "floor_gap", wall: "wall_gap", roof: "roof_gap", window: "window_gap", door_lower: "door_missing", door_upper: "door_missing" }[c.role] || "bad_cell";
    P(s === "wrong" && DOOR_ROLES.has(c.role) && nameOf(info) === "iron_door" ? "door_not_openable" : code, c);
  }
  for (const c of bp.interior) {
    const info = at(c);
    if (info == null) { P("unloaded", c); continue; }
    if (!isPassable(info)) P(isFluid(info) ? "interior_flooded" : "interior_blocked", c);
  }
  const dl = at(bp.doorCell), du = at(bp.doorUpper);
  if (dl && du && !(isDoor(dl) && isDoor(du)) && !(isPassable(dl) && isPassable(du))) P("door_cell_not_passable", bp.doorCell);

  // walkable standing cell on the flat floor level
  const stands = (x, z) => isSolidGood(at({ x, y: y0, z })) && isPassable(at({ x, y: y0 + 1, z })) && isPassable(at({ x, y: y0 + 2, z }));
  const f = bp.front, b = bp.behind;
  const frontOk = stands(f.x, f.z);
  if (!frontOk) P("front_blocked", f);
  const behindOk = stands(b.x, b.z);
  if (!behindOk) P("behind_door_blocked", b);
  // all interior columns reachable from behind the door
  if (behindOk) {
    const inside = new Set(bp.stand.map((s) => `${s.x},${s.z}`));
    const seen = new Set([`${b.x},${b.z}`]), q = [[b.x, b.z]];
    while (q.length) {
      const [x, z] = q.pop();
      for (const [a, c] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${x + a},${z + c}`;
        if (!inside.has(k) || seen.has(k)) continue;
        if (!stands(x + a, z + c)) continue;
        seen.add(k); q.push([x + a, z + c]);
      }
    }
    if (seen.size < inside.size) problems.push(`interior_unreachable:${seen.size}/${inside.size}`);
  }

  // leak test: with the door treated as solid nothing outside may reach the interior (3D flood fill)
  const m = 2;
  const inBox = (p) => p.x >= box.min.x && p.x <= box.max.x && p.y >= box.min.y && p.y <= box.max.y && p.z >= box.min.z && p.z <= box.max.z;
  const doorKeys = new Set([key(bp.doorCell), key(bp.doorUpper)]);
  const windowOpen = (p) => bp.windows === "open" && bp.cells.some((c) => c.role === "window" && key(c) === key(p));
  const passableLeak = (p) => {
    if (doorKeys.has(key(p)) || windowOpen(p)) return false;
    const info = at(p);
    return info != null && !isSolid(info) && !isDoor(info);
  };
  const lo = { x: box.min.x - m, y: box.min.y - 1, z: box.min.z - m }, hi = { x: box.max.x + m, y: box.max.y + m, z: box.max.z + m };
  const seen = new Set(), q = [];
  for (let x = lo.x; x <= hi.x; x++) for (let y = lo.y; y <= hi.y; y++) for (let z = lo.z; z <= hi.z; z++) {
    const p = { x, y, z };
    if (inBox(p) || !passableLeak(p)) continue;
    seen.add(key(p)); q.push(p);
  }
  let leak = null;
  while (q.length && !leak) {
    const p = q.pop();
    for (const [a, c, e] of N6) {
      const n = { x: p.x + a, y: p.y + c, z: p.z + e };
      if (n.x < lo.x || n.x > hi.x || n.y < lo.y || n.y > hi.y || n.z < lo.z || n.z > hi.z) continue;
      const k = key(n);
      if (seen.has(k) || !passableLeak(n)) continue;
      if (inBox(n) && bp.interior.some((i) => key(i) === k)) { leak = n; break; }
      seen.add(k); q.push(n);
    }
  }
  if (leak) P("leak", leak);
  return { ok: problems.length === 0, problems };
}

function planBuildHouse(goal = {}, snap = {}, hints = {}) {
  if (hints.houseVerified) return { done: true, remaining: 0 };
  if (hints.houseBlocked) return { blocked: hints.houseBlocked, remaining: 1e6 };
  const rec = hints.house || {};
  const inv = snap.inv || {};
  const material = rec.material || goal.material || "oak_planks";
  const bp = houseBlueprint({
    origin: rec.origin || goal.origin || { x: 0, y: 0, z: 0 },
    size: rec.size || goal.size, material, door: rec.door || goal.door, windows: rec.windows || goal.windows
  });
  let remaining, needs;
  if (hints.houseBlockAt && rec.origin) {
    const d = diffBlueprint(bp, hints.houseBlockAt);
    remaining = d.missing.length + d.wrong.length;
    needs = materialsNeeded(bp, inv, hints.houseBlockAt, { ignoreFloor: true });
    if (remaining === 0) remaining = 1;
  } else {
    remaining = bp.cells.filter((c) => !c.optional).length;
    needs = materialsNeeded(bp, inv, null, { ignoreFloor: true });
  }
  if (Object.keys(needs).length) {
    return { done: false, remaining, needs, action: null, label: `gather materials for house: ${Object.entries(needs).map(([k, v]) => `${v} ${k}`).join(", ")}` };
  }
  const args = { size: bp.size, material, door: bp.door, windows: bp.windows };
  if (rec.origin) args.origin = rec.origin;
  return { done: false, remaining, action: { skill: "build_house", args, label: `build house (${remaining} blocks to go)` } };
}

module.exports = {
  houseBlueprint, diffBlueprint, materialsNeeded, orderCells, standsFor, verifyHouse, obstructions, fillPlan, cellState, planBuildHouse,
  isSolid, isSolidGood, isPassable, isDoor, isFluid, isAir, isTorch, nameOf, DIRS
};
