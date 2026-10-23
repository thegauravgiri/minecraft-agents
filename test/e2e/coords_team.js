// A team request with coordinates for ONE object: one job, exactly at the coordinates (not legs here and a head over there).
process.env.MC_AGENT_NAMES = "Alpha,Beta"; process.env.MC_GENERIC_TRIGGER = "false"; process.env.MC_AUTONOMY = "on"; process.env.MC_BANTER = "off";
const os = require("os"), path = require("path");
process.env.MC_SHARED_DIR = path.join(os.tmpdir(), "mcbot-ct-" + Date.now());
const mineflayer = require("mineflayer");
const { createAgentBot } = require("../../src/index");
const { consoleCmd, sleep, waitUntil } = require("./harness");
const board = require("../../src/runtime/project");
(async () => {
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-ct-a-" + Date.now()); const A = createAgentBot({ port: 25599, username: "Alpha" }); await A.ready;
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-ct-b-" + Date.now()); const B = createAgentBot({ port: 25599, username: "Beta" }); await B.ready;
  const h = await new Promise((r) => { const b = mineflayer.createBot({ host: "localhost", port: 25599, username: "Boss", auth: "offline", version: "26.1.2" }); b.once("spawn", () => r(b)); });
  consoleCmd("op Boss"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  consoleCmd("tp Alpha 3700 150 3700"); consoleCmd("tp Beta 3703 150 3700"); consoleCmd("tp Boss 3701 150 3702"); await sleep(3000);
  consoleCmd("gamemode creative Alpha"); consoleCmd("gamemode creative Beta"); await sleep(6000);
  h.chat("everyone build a big stone statue of a creeper at 3730 150 3690, legs body and head properly");
  await waitUntil(() => board.active().some((p) => p.state === "open"), 90000, 500);
  const p = board.active().find((x) => x.state === "open");
  const ts = p ? board.tasks(p.id) : [];
  console.log("jobs:", ts.map((t) => `${t.title} @ ${t.plot.x},${t.plot.z}`).join(" | "), "| exact:", p?.exact);
  const pass = ts.length === 1 && ts[0].plot.x === 3730 && ts[0].plot.z === 3690 && p.exact;
  console.log(pass ? "PASS one object = one job at the coordinates" : "FAIL");
  A.agent.stop(); B.agent.stop(); A.bot.quit(); B.bot.quit(); h.quit(); process.exit(pass ? 0 : 1);
})();
