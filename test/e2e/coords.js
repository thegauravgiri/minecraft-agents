// "build ... at X Y Z": exactly there - even over leftovers of an earlier attempt - and a team request with coordinates is ONE job at that spot.
process.env.MC_AUTONOMY = "off"; process.env.MC_BANTER = "off";
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { connect, consoleCmd, sleep, waitUntil, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("CoordBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve"); consoleCmd("gamemode creative Steve"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  const X = 3700, Z = 3700, Y = 150;
  consoleCmd(`forceload add ${X - 40} ${Z - 40} ${X + 40} ${Z + 40}`); await sleep(2500);
  for (let x = X - 40; x <= X + 40; x += 20) { consoleCmd(`fill ${x} ${Y - 5} ${Z - 40} ${x + 19} ${Y - 2} ${Z + 40} dirt`); consoleCmd(`fill ${x} ${Y - 1} ${Z - 40} ${x + 19} ${Y - 1} ${Z + 40} grass_block`); consoleCmd(`fill ${x} ${Y} ${Z - 40} ${x + 19} ${Y + 20} ${Z + 40} air`); }
  await sleep(4000);
  const TX = X + 20, TZ = Z - 15;
  consoleCmd(`fill ${TX - 1} ${Y} ${TZ - 1} ${TX + 1} ${Y + 2} ${TZ + 1} cobblestone`);            // leftovers of an earlier attempt right on the spot
  consoleCmd(`tp CoordBot ${X - 20} ${Y} ${Z + 20}`); consoleCmd("gamemode creative CoordBot"); consoleCmd(`tp Steve ${X - 18} ${Y} ${Z + 18}`); await sleep(3000); await settle(bot);
  agent.run();
  s.chat(`CoordBot build a small stone statue of a creeper at ${TX} ${Y} ${TZ}. Don't go anywhere else`);
  await waitUntil(() => agent.goal?.type === "build", 40000, 300);
  const sid = agent.goal?.sid;
  await waitUntil(() => !!agent.mem.recall(`structure:${sid}`), 120000, 500);
  const rec = agent.mem.recall(`structure:${sid}`);
  const spec = agent.goal?.spec || agent.lastSpec;
  const cx = rec && spec ? rec.origin.x + (spec.size.w - 1) / 2 : null, cz = rec && spec ? rec.origin.z + (spec.size.d - 1) / 2 : null;
  console.log("origin:", JSON.stringify(rec?.origin), "size", JSON.stringify(spec?.size), "centre", cx, cz, "asked", TX, TZ);
  const pass = rec && Math.abs(cx - TX) <= 1.5 && Math.abs(cz - TZ) <= 1.5;
  console.log(pass ? "PASS builds exactly at the given coordinates" : "FAIL");
  agent.stop(); bot.quit(); s.quit(); process.exit(pass ? 0 : 1);
})();
