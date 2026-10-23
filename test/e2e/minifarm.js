// Isolated farm build (no AI): tiny tilled plot with water and fence; prints the result grid.
const { connect, consoleCmd, botCmd, sleep, settle, waitUntil } = require("./harness");
const { Vec3 } = require("vec3");
const { Memory } = require("../../src/core/memory");
const { buildStructure } = require("../../src/skills/structure");
(async () => {
  const { bot, agent, reg } = await connect("MiniFarm");
  consoleCmd("gamemode survival MiniFarm"); consoleCmd("difficulty peaceful");
  await settle(bot);
  const P = bot.entity.position.floored(); const X = P.x, Z = P.z, Y = P.y;           // build the test platform right where the bot stands
  consoleCmd(`fill ${X - 15} ${Y - 30} ${Z - 15} ${X + 15} ${Y - 2} ${Z + 15} stone`); consoleCmd(`fill ${X - 15} ${Y - 1} ${Z - 15} ${X + 15} ${Y - 1} ${Z + 15} grass_block`); consoleCmd(`fill ${X - 15} ${Y} ${Z - 15} ${X + 15} ${Y + 12} ${Z + 15} air`); consoleCmd(`fill ${X + 8} ${Y - 1} ${Z} ${X + 10} ${Y - 1} ${Z + 2} water`);
  await waitUntil(() => bot.blockAt(new Vec3(X + 3, Y - 1, Z))?.name === "grass_block" && bot.blockAt(new Vec3(X + 3, Y + 3, Z))?.name === "air", 20000, 300);
  consoleCmd(`tp MiniFarm ${X} ${Y} ${Z}`); await settle(bot);
  await botCmd(bot, "clear @s"); for (const g of ["diamond_hoe 1", "bucket 1", "wheat_seeds 64", "dirt 20", "oak_fence 40"]) await botCmd(bot, `give @s ${g}`);
  const N = parseInt(process.env.N || "5", 10), m = (N - 1) / 2, e = N - 1;
  const spec = { name: `${N}x${N} farm`, size: { w: N, d: N, h: 3 }, palette: { f: "oak_fence" }, ops: [
    { op: "till", from: [1, 0, 1], to: [e - 1, 0, e - 1] }, { op: "water", at: [m, 0, m] }, { op: "plant", from: [1, 1, 1], to: [e - 1, 1, e - 1], crop: "wheat" }, { op: "clear", from: [m, 1, m], to: [m, 1, m] },
    { op: "line", from: [0, 1, 0], to: [e, 1, 0], block: "f" }, { op: "line", from: [0, 1, e], to: [e, 1, e], block: "f" }, { op: "line", from: [0, 1, 0], to: [0, 1, e], block: "f" }, { op: "line", from: [e, 1, 0], to: [e, 1, e], block: "f" }] };
  const ctx = { bot, reg, mem: new Memory(), agent, signal: new AbortController().signal, beat() {} };
  const r = await buildStructure(ctx, { spec, id: "mini" + Date.now() });
  console.log("RESULT", JSON.stringify(r).slice(0, 300));
  const o = ctx.origin;
  for (let z = 0; z < N; z++) { let row = ""; for (let x = 0; x < N; x++) { const g = bot.blockAt(new Vec3(o.x + x, o.y, o.z + z)).name, u = bot.blockAt(new Vec3(o.x + x, o.y + 1, o.z + z)).name; row += (g === "farmland" ? "F" : g === "water" ? "~" : g[0]) + (u === "wheat" ? "w" : u === "oak_fence" ? "#" : ".") + " "; } console.log("GRID", row); }
  bot.quit(); process.exit(0);
})();
