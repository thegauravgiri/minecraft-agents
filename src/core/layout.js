// Pure town planning: where each building of a project goes, so a village is a village (centre, rings, spacing) and not seven
// buildings dropped on top of each other. No bot, no I/O.
const GAP = 7;                                                    // free ground between two footprints (paths, fences, room to build)

const footprint = (t) => Math.max(t.size?.w || 10, t.size?.d || 10);

/**
 * tasks: [{id, zone:'center'|'ring'|'outer', size:{w,d}}]; returns Map id -> {x,z} (centre of the plot).
 * Centre buildings share the middle (first one exactly on it), ring buildings sit on concentric circles around it,
 * outer buildings (farms, pens) on a wider circle. Every plot is at least (size_a+size_b)/2 + GAP from every other one.
 */
function layoutPlots(center, tasks) {
  const out = new Map();
  const placed = [];
  const ok = (x, z, f) => placed.every((p) => Math.hypot(p.x - x, p.z - z) >= (p.f + f) / 2 + GAP);
  const put = (t, x, z) => { x = Math.round(x); z = Math.round(z); placed.push({ x, z, f: footprint(t) }); out.set(t.id, { x, z }); };

  const byZone = (z) => tasks.filter((t) => (t.zone || "ring") === z);
  const spiral = (t, minR, startAngle = 0) => {                    // walk outward along circles until a free spot is found
    const f = footprint(t);
    for (let r = Math.max(minR, 0); r < 400; r += Math.max(4, f / 2)) {
      const circumference = Math.max(1, 2 * Math.PI * r);
      const steps = Math.max(1, Math.floor(circumference / (f + GAP)));
      for (let i = 0; i < steps; i++) {
        const a = startAngle + (i / steps) * Math.PI * 2;
        const x = center.x + Math.cos(a) * r, z = center.z + Math.sin(a) * r;
        if (ok(x, z, f)) return [x, z];
      }
    }
    return [center.x + 200, center.z];
  };

  const centre = byZone("center");
  centre.forEach((t, i) => { if (i === 0) put(t, center.x, center.z); else { const [x, z] = spiral(t, footprint(t) + GAP); put(t, x, z); } });
  const maxF = Math.max(10, ...tasks.map(footprint));
  const ringStart = centre.length ? (footprint(centre[0]) / 2 + maxF / 2 + GAP) : 0;
  byZone("ring").forEach((t, i) => { const [x, z] = spiral(t, ringStart, i * 0.7); put(t, x, z); });
  const ringEnd = Math.max(ringStart, ...placed.map((p) => Math.hypot(p.x - center.x, p.z - center.z) + p.f / 2));
  byZone("outer").forEach((t, i) => { const [x, z] = spiral(t, ringEnd + footprint(t) / 2 + GAP, 0.4 + i * 1.3); put(t, x, z); });
  return out;
}

/** How well does a task suit an agent role? Higher is better. */
function roleFit(task, role) {
  const hint = String(task.roleHint || "").toLowerCase();
  if (hint === role) return 10;
  const kin = { builder: ["leader", "lumberjack"], leader: ["builder"], lumberjack: ["builder"], hunter: ["builder", "smith"], smith: ["miner", "builder"], miner: ["smith", "builder"], scout: ["builder", "hunter"] };
  if ((kin[hint] || []).includes(role)) return 4;
  return role === "builder" ? 3 : 1;
}

module.exports = { layoutPlots, roleFit, footprint, GAP };
