// A flag (a pole + cloth hanging in the air) in creative, at the place asked - even after an unfinished earlier flag somewhere else.
process.env.MC_AUTONOMY = "off"; process.env.MC_BANTER = "off";
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const S = require("../../src/core/structure");
const { connect, consoleCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent, reg } = await connect("FlagBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve"); consoleCmd("gamemode creative Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  const X = 3900, Z = 3900, Y = 150;
  consoleCmd(`forceload add ${X - 50} ${Z - 30} ${X + 60} ${Z + 30}`); await sleep(2500);
  for (let x = X - 50; x <= X + 60; x += 20) { consoleCmd(`fill ${x} ${Y - 5} ${Z - 30} ${x + 19} ${Y - 2} ${Z + 30} dirt`); consoleCmd(`fill ${x} ${Y - 1} ${Z - 30} ${x + 19} ${Y - 1} ${Z + 30} grass_block`); consoleCmd(`fill ${x} ${Y} ${Z - 30} ${x + 19} ${Y + 30} ${Z + 30} air`); }
  for (let x = X - 50; x <= X + 60; x += 10) consoleCmd(`fill ${x} ${Y} ${Z - 30} ${x + 9} ${Y + 40} ${Z + 30} air`);   // leftovers of earlier runs
  await sleep(5000);
  consoleCmd(`tp FlagBot ${X - 30} ${Y} ${Z}`); consoleCmd("gamemode creative FlagBot"); consoleCmd(`tp Steve ${X - 30} ${Y} ${Z + 3}`); await sleep(3000); await settle(bot);
  agent.run();
  s.chat("FlagBot make a huge flag of Nepal here");
  await waitUntil(() => agent.goal?.spec, 60000, 500);
  await sleep(8000);
  s.chat("FlagBot cancel all tasks"); await sleep(3000);
  consoleCmd(`tp Steve ${X + 30} ${Y} ${Z}`); await sleep(2000);
  s.chat("FlagBot make a huge flag of Nepal here");
  await waitUntil(() => agent.goal?.type === "build", 30000, 300);
  const sid = agent.goal?.sid;
  const done = await waitUntil(() => !agent.goal, 300000, 2000);
  const rec = agent.mem.recall(`structure:${sid}`), spec = agent.lastSpec;
  let match = 0;
  if (rec && spec) { const c = S.compileStructure(spec, reg); const cells = c.cells.map((x) => S.abs(x, rec.origin)); match = S.diffStructure(cells, (p) => { const b = bot.blockAt(new Vec3(p.x, p.y, p.z)); return b ? { name: b.name, boundingBox: b.boundingBox } : null; }).ratio; }
  const dist = rec ? Math.hypot(rec.origin.x + spec.size.w / 2 - (X + 30), rec.origin.z + spec.size.d / 2 - Z) : 999;
  console.log(`second flag: origin ${JSON.stringify(rec?.origin)} size ${JSON.stringify(spec?.size)} | distance from where asked ${dist.toFixed(1)} | built ${(match * 100).toFixed(0)}% | finished ${done}`);
  const pass = done && dist < 12 && match >= 0.95;
  console.log(pass ? "PASS flag built where asked" : "FAIL");
  agent.stop(); bot.quit(); s.quit(); process.exit(pass ? 0 : 1);
})();
