// Two agents left alone talk to each other a little (and stop), without any human involvement.
process.env.MC_AGENT_NAMES = "Alpha,Beta"; process.env.MC_GENERIC_TRIGGER = "false"; process.env.MC_AUTONOMY = "off";
const os = require("os"), path = require("path");
process.env.MC_SHARED_DIR = path.join(os.tmpdir(), "mcbot-banter-" + Date.now());
const mineflayer = require("mineflayer");
const { createAgentBot } = require("../../src/index");
const { consoleCmd, sleep } = require("./harness");
(async () => {
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-ban-a-" + Date.now()); const A = createAgentBot({ port: 25599, username: "Alpha" }); await A.ready;
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-ban-b-" + Date.now()); const B = createAgentBot({ port: 25599, username: "Beta" }); await B.ready;
  const w = await new Promise((r) => { const b = mineflayer.createBot({ host: "localhost", port: 25599, username: "Watcher", auth: "offline", version: "26.1.2" }); b.once("spawn", () => r(b)); });
  consoleCmd("difficulty peaceful"); consoleCmd("tp Alpha 160 80 -160"); consoleCmd("tp Beta 163 80 -160"); consoleCmd("tp Watcher 170 80 -160"); await sleep(3000);
  const lines = []; w.on("chat", (u, m) => { if (u === "Alpha" || u === "Beta") lines.push(`<${u}> ${m}`); });
  await sleep(6000);                                  // statuses published
  A.agent.banter.next = Date.now(); B.agent.banter.next = Date.now() + 999999;
  await sleep(45000);
  console.log("conversation:\n  " + lines.join("\n  "));
  const alpha = lines.filter((l) => l.startsWith("<Alpha>")).length, beta = lines.filter((l) => l.startsWith("<Beta>")).length;
  const pass = alpha >= 1 && beta >= 1 && lines.length <= 6;
  console.log(pass ? "PASS they talk, briefly" : "FAIL");
  A.agent.stop(); B.agent.stop(); A.bot.quit(); B.bot.quit(); w.quit(); process.exit(pass ? 0 : 1);
})();
