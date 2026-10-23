// Server commands as a creative builder's toolkit (needs cheats/op, which the world grants): /fill and /setblock turn
// "flatten this mountain" or "clear this area" from thousands of single digs into a handful of commands.
// Safeguards: capped volume, and never touching anything near a remembered house / structure / bed.
const { sleep, ok, fail, log } = require("../runtime/util");

const MAX_FILL = 30000;                       // vanilla limit is 32768 blocks per /fill
const MAX_VOLUME = 400000;                    // sanity cap per call

async function runCommand(ctx, cmd, { timeout = 6000 } = {}) {
  const { bot, signal } = ctx;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); bot.removeListener("messagestr", on); resolve(r); };
    const on = (m) => {
      const s = String(m);
      if (/successfully filled|changed the block|filled \d+ block/i.test(s)) finish(ok({ message: s }));
      else if (/no blocks were filled|could not set the block|that position is not loaded|outside the world|too many blocks/i.test(s)) finish(fail("command_rejected", { message: s }));
      else if (/unknown or incomplete command|do not have permission/i.test(s)) finish(fail("no_permission", { message: s }));
    };
    const t = setTimeout(() => finish(fail("no_reply", {})), timeout);
    signal?.addEventListener("abort", () => finish(fail("aborted")), { once: true });
    bot.on("messagestr", on);
    bot.chat(cmd);
  });
}

const blk = (b) => String(b || "air").replace(/^minecraft:/, "").replace(/[^a-z0-9_:\[\]=,.]/gi, "");

// boxes we must not touch: remembered houses, built structures, our bed (with a margin)
function protectedBoxes(ctx) {
  const boxes = [];
  const f = ctx.mem?.facts || {};
  const m = 6;
  if (f.house?.origin && f.house?.size) boxes.push({ x0: f.house.origin.x - m, x1: f.house.origin.x + f.house.size.w + m, y0: f.house.origin.y - m, y1: f.house.origin.y + f.house.size.h + m + 4, z0: f.house.origin.z - m, z1: f.house.origin.z + f.house.size.d + m, what: "your house" });
  for (const [k, v] of Object.entries(f)) if (k.startsWith("structure:") && v?.origin) boxes.push({ x0: v.origin.x - m, x1: v.origin.x + 40, y0: v.origin.y - m, y1: v.origin.y + 36, z0: v.origin.z - m, z1: v.origin.z + 40, what: `the ${v.name || "structure"} I built` });
  if (f.bed) boxes.push({ x0: f.bed.x - m, x1: f.bed.x + m, y0: f.bed.y - m, y1: f.bed.y + m, z0: f.bed.z - m, z1: f.bed.z + m, what: "the bed" });
  return boxes;
}

/** Fill a box. Splits big volumes into several commands. Returns ok({commands}) or the first failure. */
async function fillBox(ctx, x1, y1, z1, x2, y2, z2, block = "air") {
  const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)], [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)], [az, bz] = [Math.min(z1, z2), Math.max(z1, z2)];
  if ([ax, bx, ay, by, az, bz].some((n) => !Number.isFinite(n))) return fail("invalid_coordinates");
  if ((bx - ax + 1) * (by - ay + 1) * (bz - az + 1) > MAX_VOLUME) return fail("area_too_large");
  for (const b of protectedBoxes(ctx)) if (ax <= b.x1 && bx >= b.x0 && ay <= b.y1 && by >= b.y0 && az <= b.z1 && bz >= b.z0) return fail("protected_area", { message: `that area overlaps ${b.what}` });
  const cmds = [];
  const layer = Math.max(1, Math.floor(MAX_FILL / ((bx - ax + 1) * (bz - az + 1))));   // slice by height so each command stays under the limit
  for (let y = ay; y <= by; y += layer) cmds.push(`/fill ${ax} ${y} ${az} ${bx} ${Math.min(by, y + layer - 1)} ${bz} ${blk(block)}`);
  let last = null;
  for (const c of cmds) { last = await runCommand(ctx, c); if (!last.ok && last.reason !== "command_rejected") return last; await sleep(150, ctx.signal); }
  // verify: what the bot can actually see must match what was asked for (the AI's idea of "ground level" is often off by one)
  await sleep(900, ctx.signal);
  const { bot } = ctx;
  const { Vec3 } = require("vec3");
  const want = blk(block);
  let bad = 0, example = null, checked = 0;
  const stride = Math.max(1, Math.ceil(((bx - ax + 1) * (by - ay + 1) * (bz - az + 1)) / 8000));
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) for (let z = az; z <= bz; z += stride) {
    const b = bot.blockAt(new Vec3(x, y, z));
    if (!b) continue;                                              // not loaded: cannot judge
    checked++;
    const okCell = want === "air" ? b.boundingBox !== "block" : b.name === want.replace(/\[.*$/, "");
    if (!okCell) { bad++; if (!example) example = `${b.name} at ${x},${y},${z}`; }
  }
  if (bad) return fail("fill_incomplete", { left: bad, checked, example, message: `after /fill ${want}, ${bad} of ${checked} checked cells still differ (e.g. ${example}) - widen the range or check the y levels` });
  return ok({ commands: cmds.length, verifiedCells: checked, last: last?.data?.message });
}

const setBlock = (ctx, x, y, z, block) => (![x, y, z].every(Number.isFinite) ? fail("invalid_coordinates") : runCommand(ctx, `/setblock ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)} ${blk(block)}`));

module.exports = { runCommand, fillBox, setBlock, protectedBoxes };
