// Team defence: three zombies jump Alpha; Alpha shouts, Beta (40 blocks away) comes and they clear them together.
process.env.MC_AGENT_NAMES = "Alpha,Beta"; process.env.MC_GENERIC_TRIGGER = "false"; process.env.MC_AUTONOMY = "on"; process.env.MC_BANTER = "off";   // autonomy ON: the night rule must not call Beta back
const os = require("os"), path = require("path");
process.env.MC_SHARED_DIR = path.join(os.tmpdir(), "mcbot-ally-" + Date.now());
const mineflayer = require("mineflayer");
const { createAgentBot } = require("../../src/index");
const { consoleCmd, sleep, waitUntil } = require("./harness");
(async () => {
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-ally-a-" + Date.now()); const A = createAgentBot({ port: 25599, username: "Alpha" }); await A.ready;
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-ally-b-" + Date.now()); const B = createAgentBot({ port: 25599, username: "Beta" }); await B.ready;
  const w = await new Promise((r) => { const b = mineflayer.createBot({ host: "localhost", port: 25599, username: "Watcher", auth: "offline", version: "26.1.2" }); b.once("spawn", () => r(b)); });
  consoleCmd("op Watcher"); consoleCmd("difficulty normal"); consoleCmd("gamerule doMobSpawning false"); consoleCmd("time set midnight"); consoleCmd("gamerule doDaylightCycle false");
  const X = 900, Z = 900, Y = 150;
  consoleCmd(`forceload add ${X - 60} ${Z - 30} ${X + 60} ${Z + 30}`); await sleep(2000);
  for (let x = X - 60; x <= X + 60; x += 30) { consoleCmd(`fill ${x} ${Y - 6} ${Z - 30} ${x + 29} ${Y - 2} ${Z + 30} stone`); consoleCmd(`fill ${x} ${Y - 1} ${Z - 30} ${x + 29} ${Y - 1} ${Z + 30} grass_block`); consoleCmd(`fill ${x} ${Y} ${Z - 30} ${x + 29} ${Y + 8} ${Z + 30} air`); }
  await sleep(4000);
  consoleCmd(`tp Alpha ${X} ${Y} ${Z}`); consoleCmd(`tp Beta ${X + 40} ${Y} ${Z}`); consoleCmd(`tp Watcher ${X + 20} ${Y} ${Z + 20}`); await sleep(3000);
  for (const n of ["Alpha", "Beta"]) { consoleCmd(`gamemode survival ${n}`); consoleCmd(`clear ${n}`); consoleCmd(`give ${n} stone_sword 1`); consoleCmd(`give ${n} cooked_beef 8`); consoleCmd(`item replace entity ${n} armor.chest with iron_chestplate`); consoleCmd(`item replace entity ${n} armor.head with iron_helmet`); }
  await sleep(1500);
  const lines = []; w.on("chat", (u, m) => { if (u === "Alpha" || u === "Beta") lines.push(`<${u}> ${m}`); });
  A.agent.run(); B.agent.run(); await sleep(2000);
  for (let i = 0; i < 3; i++) consoleCmd(`summon zombie ${X + 3 + i} ${Y} ${Z + i}`);
  const t0 = Date.now();
  const zombies = () => Object.values(A.bot.entities).filter((e) => e.name === "zombie" && e.position.distanceTo(A.bot.entity.position) < 40).length;
  await waitUntil(() => B.agent.goal?.type === "goto" || B.agent.goal?.type === "kill" || B.agent.current?.name === "fight", 30000, 300);
  const helped = !!(B.agent.goal || B.agent.current);
  const cleared = await waitUntil(() => zombies() === 0, 90000, 500);
  console.log(`Beta responded: ${helped} | zombies cleared: ${cleared} in ${Math.round((Date.now() - t0) / 1000)}s | hp Alpha ${Math.round(A.bot.health)} Beta ${Math.round(B.bot.health)}`);
  console.log("chat:", lines.slice(0, 5).join(" || "));
  const pass = helped && cleared && A.bot.health > 0 && B.bot.health > 0;
  console.log(pass ? "PASS team fights together" : "FAIL");
  A.agent.stop(); B.agent.stop(); A.bot.quit(); B.bot.quit(); w.quit(); process.exit(pass ? 0 : 1);
})();
