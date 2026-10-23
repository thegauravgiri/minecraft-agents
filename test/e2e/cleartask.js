// "clear task" must END the work for good: no re-claiming the same job from the board, no revival, no repeat proposal.
process.env.MC_AGENT_NAMES = "Alpha,Beta"; process.env.MC_GENERIC_TRIGGER = "false"; process.env.MC_AUTONOMY = "on"; process.env.MC_BANTER = "off";
const os = require("os"), path = require("path");
process.env.MC_SHARED_DIR = path.join(os.tmpdir(), "mcbot-clr-" + Date.now());
const mineflayer = require("mineflayer");
const { createAgentBot } = require("../../src/index");
const { consoleCmd, sleep, waitUntil } = require("./harness");
const board = require("../../src/runtime/project");
(async () => {
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-clr-a-" + Date.now()); const A = createAgentBot({ port: 25599, username: "Alpha" }); await A.ready;
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-clr-b-" + Date.now()); const B = createAgentBot({ port: 25599, username: "Beta" }); await B.ready;
  const h = await new Promise((r) => { const b = mineflayer.createBot({ host: "localhost", port: 25599, username: "Boss", auth: "offline", version: "26.1.2" }); b.once("spawn", () => r(b)); });
  consoleCmd("op Boss"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  consoleCmd("tp Alpha 3700 150 3700"); consoleCmd("tp Beta 3703 150 3700"); consoleCmd("tp Boss 3701 150 3702"); await sleep(3000);
  consoleCmd("gamemode creative Alpha"); consoleCmd("gamemode creative Beta"); await sleep(6000);
  h.chat("everyone build a wheat farm and a small cabin at 3740 150 3700");
  await waitUntil(() => [A, B].some((x) => x.agent.goal?.project), 120000, 500);
  console.log("working on:", [A, B].map((x) => x.agent.goal?.autoWhy || x.agent.goal?.type || "idle").join(" | "));
  h.chat("Alpha clear task");
  await sleep(45000);
  const busy = [A, B].map((x) => x.agent.goal?.project ? x.agent.goal.autoWhy : null).filter(Boolean);
  console.log("45s after 'clear task': active projects", board.active().length, "| still on project jobs:", JSON.stringify(busy));
  const pass = board.active().length === 0 && busy.length === 0;
  console.log(pass ? "PASS clear task ends the work" : "FAIL");
  A.agent.stop(); B.agent.stop(); A.bot.quit(); B.bot.quit(); h.quit(); process.exit(pass ? 0 : 1);
})();
