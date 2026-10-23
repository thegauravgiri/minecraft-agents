// "tell everyone to come to me / to x y z": the elected leader broadcasts, every agent goes. (No building plan, no chatter loop.)
process.env.MC_AGENT_NAMES = "Alpha,Beta,Gamma"; process.env.MC_GENERIC_TRIGGER = "false"; process.env.MC_AUTONOMY = "off";
const os = require("os"), path = require("path");
process.env.MC_SHARED_DIR = path.join(os.tmpdir(), "mcbot-gather-" + Date.now());
const mineflayer = require("mineflayer");
const { createAgentBot } = require("../../src/index");
const { consoleCmd, sleep, waitUntil } = require("./harness");
(async () => {
  const names = ["Alpha", "Beta", "Gamma"], bots = [];
  for (const n of names) { process.env.BOT_DATA_DIR = path.join(os.tmpdir(), `mcbot-gather-${n}-${Date.now()}`); bots.push(createAgentBot({ port: 25599, username: n })); await bots[bots.length - 1].ready; }
  const h = await new Promise((r) => { const b = mineflayer.createBot({ host: "localhost", port: 25599, username: "Boss", auth: "offline", version: "26.1.2" }); b.once("spawn", () => r(b)); });
  consoleCmd("op Boss"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  const X = 1300, Z = 1300, Y = 150;
  consoleCmd(`forceload add ${X - 70} ${Z - 30} ${X + 70} ${Z + 30}`); await sleep(2000);
  for (let x = X - 70; x <= X + 70; x += 35) { consoleCmd(`fill ${x} ${Y - 5} ${Z - 30} ${x + 34} ${Y - 2} ${Z + 30} stone`); consoleCmd(`fill ${x} ${Y - 1} ${Z - 30} ${x + 34} ${Y - 1} ${Z + 30} grass_block`); consoleCmd(`fill ${x} ${Y} ${Z - 30} ${x + 34} ${Y + 8} ${Z + 30} air`); }
  await sleep(5000);
  names.forEach((n, i) => { consoleCmd(`tp ${n} ${X - 50 + i * 4} ${Y} ${Z}`); consoleCmd(`gamemode creative ${n}`); }); consoleCmd(`tp Boss ${X + 40} ${Y} ${Z}`); await sleep(3000);
  bots.forEach((b) => b.agent.run()); await sleep(1500);
  const lines = []; h.on("chat", (u, m) => { if (names.includes(u)) lines.push(`<${u}> ${m}`); });
  const near = () => bots.filter((b) => b.bot.entity.position.distanceTo(h.entity.position) < 8).length;
  h.chat("tell everyone to gather around me");
  const ok = await waitUntil(() => near() === 3, 90000, 1000);
  console.log(`agents near the human: ${near()}/3 | chat: ${lines.slice(0, 4).join(" || ")}`);
  console.log(ok && lines.length <= 6 ? "PASS everyone gathers" : "FAIL");
  bots.forEach((b) => { b.agent.stop(); b.bot.quit(); }); h.quit(); process.exit(ok ? 0 : 1);
})();
