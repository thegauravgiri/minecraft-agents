// "build X" end to end: chat -> AI router -> AI designer -> materials -> builder -> independent verification of the real world.
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
const S = require("../../src/core/structure");
const what = process.argv[2] || "build a two storey house";
(async () => {
  const { bot, agent, reg } = await connect("BuildBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve");
  consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamemode survival BuildBot");
  await settle(bot);
  const P = bot.entity.position.floored(); const X = P.x, Z = P.z, Y = process.env.GM ? 150 : P.y;      // clean platform right under the bot, pond to the east
  if (process.env.GM) { consoleCmd(`forceload add ${X - 25} ${Z - 25} ${X + 25} ${Z + 25}`); await sleep(1500); }
  consoleCmd(`fill ${X - 25} ${Y - 30} ${Z - 25} ${X + 25} ${Y - 2} ${Z + 25} stone`); consoleCmd(`fill ${X - 25} ${Y - 1} ${Z - 25} ${X + 25} ${Y - 1} ${Z + 25} grass_block`);
  for (let yy = Y; yy <= Y + 16; yy += 6) consoleCmd(`fill ${X - 25} ${yy} ${Z - 25} ${X + 25} ${Math.min(yy + 5, Y + 16)} ${Z + 25} air`);   // 32768-block limit per /fill consoleCmd(`fill ${X + 18} ${Y - 1} ${Z} ${X + 20} ${Y - 1} ${Z + 2} water`);
  await waitUntil(() => bot.blockAt(new Vec3(X + 3, Y - 1, Z))?.name === "grass_block" && bot.blockAt(new Vec3(X + 3, Y + 4, Z))?.name === "air", 20000, 300);
  consoleCmd(`tp BuildBot ${X} ${Y} ${Z}`); await settle(bot);
  await botCmd(bot, "clear @s");
  if (process.env.GM) { consoleCmd("gamemode " + process.env.GM + " BuildBot"); await sleep(800); }
  const farm = /farm|crop|garden|pen|field/.test(what);
  const kit = farm
    ? [["oak_planks", 64], ["oak_log", 16], ["cobblestone", 64], ["dirt", 64], ["oak_fence", 64], ["oak_fence_gate", 4], ["torch", 16], ["oak_slab", 16], ["diamond_hoe", 1], ["bucket", 1], ["wheat_seeds", 64], ["carrot", 64], ["potato", 64], ["beetroot_seeds", 32], ["melon_seeds", 16], ["pumpkin_seeds", 16], ["stone", 32], ["glass", 8]]
    : [["oak_planks", 192], ["oak_log", 48], ["cobblestone", 192], ["stone_bricks", 128], ["glass", 32], ["glass_pane", 32], ["dirt", 64], ["torch", 24], ["oak_stairs", 48], ["cobblestone_stairs", 48], ["oak_door", 4], ["oak_slab", 32], ["ladder", 16]];
  if (process.env.GM !== "creative") for (const [it, n] of kit) await botCmd(bot, `give @s ${it} ${n}`);
  await sleep(500);
  console.log('start pos', bot.entity.position.toString(), 'below', bot.blockAt(bot.entity.position.offset(0,-1,0))?.name, 'P', P.toString(), 'gm', bot.game.gameMode, 'fly', bot.entity.onGround);
  agent.run();
  const said = []; s.on("chat", (u, m) => { if (u === "BuildBot") said.push(m); });
  s.chat("BuildBot " + what);
  const t0 = Date.now();
  await waitUntil(() => agent.goal?.type === "build", 40000, 300);
  const id = agent.goal?.sid;
  const ok = await waitUntil(() => !agent.goal || agent.goal.type !== "build", 600000, 1000);
  const rec = agent.mem.recall(`structure:${id}`);
  const g = agent.lastBuildGoal;
  console.log("goal finished:", ok, "in", Math.round((Date.now() - t0) / 1000) + "s", "| origin", JSON.stringify(rec?.origin));
  console.log("said:", JSON.stringify(said.filter((m) => !m.startsWith("[") && m.length < 120)));
  // independent check of the real world against the spec the designer produced
  const spec = agent.lastSpec;
  if (spec && rec) {
    const c = S.compileStructure(spec, reg); const cells = c.cells.map((x) => S.abs(x, rec.origin));
    const d = S.diffStructure(cells, (p) => { const b = bot.blockAt(new Vec3(p.x, p.y, p.z)); return b ? { name: b.name, boundingBox: b.boundingBox } : null; });
    const kinds = {}; for (const x of cells) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
    console.log(`SPEC "${spec.name}" ${JSON.stringify(c.size)} | cells ${cells.length} ${JSON.stringify(kinds)} | missing ${d.missing.length} wrong ${d.wrong.length} unknown ${d.unknown.length} | match ${(d.ratio * 100).toFixed(1)}%`);
    console.log(d.missing.length + d.wrong.length === 0 ? "PASS structure complete and verified" : "FAIL " + [...d.missing, ...d.wrong].slice(0, 6).map((x) => `${x.block}@${x.x},${x.y},${x.z}`).join(" "));
  } else console.log("FAIL no spec/site recorded");
  agent.stop(); bot.quit(); s.quit(); process.exit(0);
})();
