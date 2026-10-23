// Leader/teammate: the human tells Alpha to give Beta a job. Beta must get it ("@Beta ..."), do it, report back
// ("@Alpha ..."), and the two must NOT keep chatting afterwards.
process.env.MC_AGENT_NAMES = "Alpha,Beta"; process.env.MC_AUTONOMY = "off"; process.env.MC_SHARED_DIR = require("os").tmpdir() + "/mcbot-team-" + Date.now(); process.env.MC_GENERIC_TRIGGER = "false";
const os = require("os"), path = require("path");
const mineflayer = require("mineflayer");
const { createAgentBot } = require("../../src/index");
const { consoleCmd, sleep, waitUntil } = require("./harness");
(async () => {
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-team-alpha-" + Date.now()); const A = createAgentBot({ port: 25599, username: "Alpha" }); await A.ready;
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-team-beta-" + Date.now());  const B = createAgentBot({ port: 25599, username: "Beta" }); await B.ready;
  const human = await new Promise((r) => { const b = mineflayer.createBot({ host: "localhost", port: 25599, username: "Gems", auth: "offline", version: "26.1.2" }); b.once("spawn", () => r(b)); });
  consoleCmd("op Gems"); consoleCmd("difficulty peaceful"); consoleCmd("gamemode survival Alpha"); consoleCmd("gamemode survival Beta");
  consoleCmd("tp Alpha 150 90 -150"); consoleCmd("tp Beta 154 90 -150"); consoleCmd("tp Gems 152 90 -150"); await sleep(3500);
  consoleCmd("clear Alpha"); consoleCmd("clear Beta"); await sleep(300); consoleCmd("give Beta oak_log 6");
  const log = []; human.on("chat", (u, m) => { if (u === "Alpha" || u === "Beta") log.push(`<${u}> ${m}`); });
  const planks = () => B.bot.inventory.items().filter((i) => /_planks$/.test(i.name)).reduce((a, i) => a + i.count, 0);
  human.chat("Alpha, you are the leader: tell Beta to craft 4 oak planks");
  const got = await waitUntil(() => planks() >= 4, 70000, 400);
  await sleep(12000);                                     // watch for runaway chatter after the job is done
  console.log("conversation:\n  " + log.join("\n  "));
  const told = log.some((l) => /^<Alpha> @Beta .*plank/i.test(l));
  const reported = A.agent.teamReports.some((r) => r.from === "Beta");
  const chatter = log.length;
  console.log(`Beta crafted planks: ${got} | Alpha told Beta: ${told} | Beta reported to Alpha: ${reported} | public agent messages: ${chatter}`);
  const pass = got && told && reported && chatter <= 8;
  console.log(pass ? "PASS team delegation works, no chat loop" : "FAIL");
  A.agent.stop(); B.agent.stop(); A.bot.quit(); B.bot.quit(); human.quit(); process.exit(pass ? 0 : 1);
})();
