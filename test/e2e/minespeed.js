// Per-block mining speed: time for N blocks of stone with a decent pickaxe (no walking involved).
const mineflayer = require("mineflayer");
const { connect, consoleCmd, botCmd, sleep, waitUntil, settle } = require("./harness");
const N = parseInt(process.argv[2] || "24", 10);
(async () => {
  const { bot, agent } = await connect("SpeedBot");
  const s = mineflayer.createBot({ host: "localhost", port: 25599, username: "Steve", auth: "offline", version: "26.1.2" });
  await new Promise((r) => s.once("spawn", r)); consoleCmd("op Steve");
  consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamemode survival SpeedBot");
  consoleCmd("tp SpeedBot 150 90 -150"); await settle(bot);
  const f = bot.entity.position.floored();
  await botCmd(bot, "clear @s"); await botCmd(bot, "give @s iron_pickaxe");
  consoleCmd(`fill ${f.x + 2} ${f.y} ${f.z - 2} ${f.x + 7} ${f.y + 3} ${f.z + 2} stone`);
  await sleep(1200); agent.run();
  const t0 = Date.now(); const times = [];
  const orig = bot.dig.bind(bot);
  bot.dig = (...a) => { const t = Date.now(); return orig(...a).then((r) => { times.push(Date.now() - t); if (process.env.DIG_TRACE) console.log("dig ok", Date.now() - t, "ms", a[0].name); return r; }, (e) => { if (process.env.DIG_TRACE) console.log("dig FAIL", Date.now() - t, "ms", e.message); throw e; }); };
  s.chat(`SpeedBot get ${N} cobblestone`);
  const n = () => bot.inventory.items().filter((i) => i.name === "cobblestone").reduce((a, i) => a + i.count, 0);
  const start = Date.now();
  await waitUntil(() => n() >= 1, 60000, 100);
  const first = Date.now();
  const ok = await waitUntil(() => n() >= N, 180000, 200);
  const total = Date.now() - first;
  const digMs = times.reduce((a, b) => a + b, 0);
  console.log(`${ok ? "PASS" : "FAIL"} ${n()} cobblestone | after first block: ${(total / 1000).toFixed(1)}s for ${n() - 1} blocks = ${(total / Math.max(1, n() - 1)).toFixed(0)}ms/block | pure dig time ${(digMs / Math.max(1, times.length)).toFixed(0)}ms/block over ${times.length} digs`);
  agent.stop(); bot.quit(); s.quit(); process.exit(0);
})();
