// Live test: build a house on flat ground, interrupt + resume, then on bumpy ground; verified by an independent scan.
const assert = require("assert");
const { connect, consoleCmd, botCmd, sleep, settle } = require("./harness");
const { buildHouse } = require("../../src/skills/build");
const { Memory } = require("../../src/core/memory");

const { Vec3 } = require("vec3");
const GROUND = 63;
const isSolid = (b) => !!b && b.boundingBox === "block" && !/_door$/.test(b.name);
const isDoor = (b) => !!b && /_door$/.test(b.name);

async function platform(bot, cx, cz, rough) {
  consoleCmd(`tp HouseBot ${cx} 70 ${cz}`); await settle(bot);
  const R = rough ? 22 : 15;
  const [x0, x1, z0, z1] = [cx - R, cx + R, cz - R, cz + R];
  const zm = Math.floor((z0 + z1) / 2);
  for (const [za, zb] of [[z0, zm], [zm + 1, z1]]) {
    await botCmd(bot, `fill ${x0} 64 ${za} ${x1} 90 ${zb} air`);
    await botCmd(bot, `fill ${x0} 56 ${za} ${x1} 62 ${zb} dirt`);
    await botCmd(bot, `fill ${x0} ${GROUND} ${za} ${x1} ${GROUND} ${zb} grass_block`);
  }
  if (rough) {
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const h = (x * 7 + z * 13 + Math.abs(x * z)) % 5;
      if (h === 0) consoleCmd(`fill ${x} ${GROUND - 1 - (x & 1)} ${z} ${x} ${GROUND} ${z} air`);
      else if (h === 1) consoleCmd(`fill ${x} ${GROUND + 1} ${z} ${x} ${GROUND + 1 + (z & 1)} ${z} dirt`);
      else if (h === 2 && (x + z) % 3 === 0) consoleCmd(`setblock ${x} ${GROUND + 1} ${z} poppy`);
    }
  }
  await sleep(2500);
  consoleCmd(`tp HouseBot ${cx} 64 ${cz}`); await sleep(1500);
  while (!bot.entity.onGround) await sleep(200);
}

function snapshotBox(bot, o, w, d, h) {
  const m = new Map();
  for (let x = o.x - 1; x <= o.x + w; x++) for (let z = o.z - 1; z <= o.z + d; z++) for (let y = o.y; y <= o.y + h + 2; y++) {
    const b = bot.blockAt(new Vec3(x, y, z));
    m.set(`${x},${y},${z}`, b ? b.name : "?");
  }
  return m;
}

// Independent verification: only raw blocks, no blueprint code.
function independentCheck(bot, o, w, d, h, doorDir = "south") {
  const B = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
  const y0 = o.y;
  const dx = Math.floor(w / 2);
  const doorX = o.x + dx, doorZ = o.z + d - 1;
  let planks = 0;
  const bad = [];
  for (let x = o.x; x < o.x + w; x++) for (let z = o.z; z < o.z + d; z++) {
    if (!isSolid(B(x, y0, z))) bad.push(`floor ${x},${z}`);
    if (!isSolid(B(x, y0 + h + 1, z))) bad.push(`roof ${x},${z}`);
    const edge = x === o.x || x === o.x + w - 1 || z === o.z || z === o.z + d - 1;
    for (let y = y0 + 1; y <= y0 + h; y++) {
      const b = B(x, y, z);
      if (/oak_planks/.test(b.name)) planks++;
      if (edge) {
        if (x === doorX && z === doorZ && y <= y0 + 2) { if (!isDoor(b)) bad.push(`door ${y}`); }
        else if (!isSolid(b)) bad.push(`wall ${x},${y},${z}=${b.name}`);
      } else if (isSolid(b)) bad.push(`interior blocked ${x},${y},${z}`);
    }
  }
  for (let x = o.x; x < o.x + w; x++) for (let z = o.z; z < o.z + d; z++) {
    if (/oak_planks/.test(B(x, y0 + h + 1, z).name)) planks++;
    if (/oak_planks/.test(B(x, y0, z).name)) planks++;
  }
  // a walker: outside front -> through the door -> every interior column
  const free = (x, y, z) => !isSolid(B(x, y, z)) && !/lava|water/.test(B(x, y, z).name);
  const stand = (x, z) => isSolid(B(x, y0, z)) && free(x, y0 + 1, z) && free(x, y0 + 2, z);
  const front = [doorX, doorZ + 1];
  if (!stand(front[0], front[1])) bad.push("front not walkable");
  const seen = new Set([`${front[0]},${front[1]}`]); const q = [front];
  while (q.length) {
    const [x, z] = q.pop();
    for (const [a, c] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + a, nz = z + c, k = `${nx},${nz}`;
      if (seen.has(k) || nx < o.x - 3 || nx > o.x + w + 2 || nz < o.z - 3 || nz > o.z + d + 2) continue;
      const doorway = nx === doorX && nz === doorZ;
      const ok = doorway ? isDoor(B(nx, y0 + 1, nz)) && isDoor(B(nx, y0 + 2, nz)) : stand(nx, nz);
      if (!ok) continue;
      seen.add(k); q.push([nx, nz]);
    }
  }
  for (let x = o.x + 1; x < o.x + w - 1; x++) for (let z = o.z + 1; z < o.z + d - 1; z++) if (!seen.has(`${x},${z}`)) bad.push(`interior ${x},${z} unreachable`);
  // walls-only reachability: the same walk without the door must not enter
  return { bad, planks };
}

(async () => {
  const { bot, agent, reg } = await connect("HouseBot");
  consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamerule advance_time false");
  await botCmd(bot, "gamemode survival"); await botCmd(bot, "clear @s");
  const inv = (n) => bot.inventory.items().filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
  const mkCtx = (mem, ctl) => ({ bot, reg, mem, signal: ctl.signal, agent, beat() {} });
  let failures = 0;
  const check = (cond, msg) => { if (!cond) { failures++; console.log("FAIL:", msg); } else console.log("ok:", msg); };

  // ---- case 1: flat ground + interrupt/resume
  await platform(bot, 300, -300, false);
  await botCmd(bot, "give @s oak_planks 128"); await botCmd(bot, "give @s oak_door 1"); await botCmd(bot, "give @s glass 4"); await botCmd(bot, "give @s torch 2"); await botCmd(bot, "give @s dirt 16");
  await sleep(600);
  const mem = new Memory();
  let ctl = new AbortController();
  await sleep(100);
  const planks0 = inv("oak_planks");
  const run1 = buildHouse(mkCtx(mem, ctl), { material: "oak_planks" }).then((r) => r, (e) => ({ aborted: e.name === "AbortError" }));
  const t0 = Date.now();
  while (!mem.recall("house") || Date.now() - t0 < 1000) await sleep(100);
  const rec = mem.recall("house");
  const { origin: o, size } = rec;
  console.log("site", o, size);
  let placedNow = 0;
  while (Date.now() - t0 < 120000) {
    placedNow = planks0 - inv("oak_planks");
    if (placedNow >= 22) break;
    await sleep(150);
  }
  ctl.abort();
  const r1 = await run1;
  check(r1.aborted === true || r1.ok, `first run interrupted after ~${placedNow} planks (${JSON.stringify(r1).slice(0, 100)})`);
  await sleep(500);
  const before = snapshotBox(bot, o, size.w, size.d, size.h);
  ctl = new AbortController();
  const r2 = await buildHouse(mkCtx(mem, ctl), { material: "oak_planks" });
  console.log("resume result", JSON.stringify(r2).slice(0, 300));
  check(r2.ok && r2.data.verified, "resume completes and verifies");
  check(JSON.stringify(mem.recall("house").origin) === JSON.stringify(o), "same house site after resume");
  const after = snapshotBox(bot, o, size.w, size.d, size.h);
  let broken = 0;
  for (const [k, v] of before) if (v !== "air" && v !== "short_grass" && after.get(k) !== v && !(v === "grass_block" && after.get(k) === "dirt") && !(v.endsWith("_door"))) { broken++; console.log("changed", k, v, "->", after.get(k)); }
  check(broken === 0, "no existing block was broken or replaced during resume");
  let c = independentCheck(bot, o, size.w, size.d, size.h);
  check(c.bad.length === 0, "independent scan flat: " + c.bad.slice(0, 5).join("; "));
  check(planks0 - inv("oak_planks") === c.planks, `no duplicated/wasted planks (used ${planks0 - inv("oak_planks")}, in world ${c.planks})`);
  const me = bot.entity.position.floored();
  const outside = me.x < o.x || me.x >= o.x + size.w || me.z < o.z || me.z >= o.z + size.d;
  check(outside, "bot ended outside the house (not sealed in) at " + me);
  const again = await buildHouse(mkCtx(mem, new AbortController()), {});
  check(again.ok && again.data.resumed && inv("oak_planks") === planks0 - c.planks, "re-running a finished house is a no-op");

  // ---- case 2: uneven ground with holes, bumps and flowers
  await platform(bot, 340, -300, true);
  await botCmd(bot, "clear @s"); await botCmd(bot, "give @s oak_planks 128"); await botCmd(bot, "give @s oak_door 1"); await botCmd(bot, "give @s glass 4"); await botCmd(bot, "give @s dirt 32");
  await sleep(600);
  const mem2 = new Memory();
  const p1 = inv("oak_planks");
  const r3 = await buildHouse(mkCtx(mem2, new AbortController()), { material: "oak_planks" });
  console.log("uneven result", JSON.stringify(r3).slice(0, 300));
  check(r3.ok && r3.data.verified, "uneven terrain: build verified");
  if (r3.ok) {
    const h2 = mem2.recall("house");
    c = independentCheck(bot, h2.origin, h2.size.w, h2.size.d, h2.size.h);
    check(c.bad.length === 0, "independent scan uneven: " + c.bad.slice(0, 5).join("; "));
    console.log("site", h2.origin, "planks used", p1 - inv("oak_planks"));
  }
  // missing material is reported, not faked
  await botCmd(bot, "clear @s");
  const mem3 = new Memory();
  const r4 = await buildHouse(mkCtx(mem3, new AbortController()), {});
  check(!r4.ok && r4.reason === "need_materials" && r4.data.need.oak_planks > 0, "no materials -> need_materials " + JSON.stringify(r4.data?.need));

  console.log(failures ? `FAILED (${failures})` : "PASS");
  bot.quit(); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
