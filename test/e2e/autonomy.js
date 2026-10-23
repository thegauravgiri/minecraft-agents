// Nobody gives orders: do the agents find useful work by themselves, stay quiet, and keep going?   node test/e2e/autonomy.js [seconds]
process.env.MC_AGENT_NAMES = "Alpha,Beta"; process.env.MC_GENERIC_TRIGGER = "false";
const os = require("os"), path = require("path");
process.env.MC_SHARED_DIR = path.join(os.tmpdir(), "mcbot-auto-shared-" + Date.now());
const mineflayer = require("mineflayer");
const { createAgentBot } = require("../../src/index");
const { consoleCmd, sleep } = require("./harness");
const secs = parseInt(process.argv[2] || "240", 10);
(async () => {
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-auto-a-" + Date.now()); const A = createAgentBot({ port: 25599, username: "Alpha" }); await A.ready;
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-auto-b-" + Date.now()); const B = createAgentBot({ port: 25599, username: "Beta" }); await B.ready;
  const human = await new Promise((r) => { const b = mineflayer.createBot({ host: "localhost", port: 25599, username: "Watcher", auth: "offline", version: "26.1.2" }); b.once("spawn", () => r(b)); });
  consoleCmd("op Watcher"); consoleCmd("difficulty peaceful"); consoleCmd("time set day"); consoleCmd("gamemode survival Alpha"); consoleCmd("gamemode survival Beta");
  consoleCmd("tp Alpha 160 80 -160"); consoleCmd("tp Beta 164 80 -160"); consoleCmd("tp Watcher 162 80 -158"); await sleep(3000);
  consoleCmd("clear Alpha"); consoleCmd("clear Beta");
  const said = []; human.on("chat", (u, m) => { if (u === "Alpha" || u === "Beta") said.push(`<${u}> ${m}`); });
  const goals = { Alpha: [], Beta: [] };
  for (const [n, X] of [["Alpha", A], ["Beta", B]]) setInterval(() => { const g = X.agent.goal; const k = g ? `${g.type}${g.auto ? "*" : ""}` : X.agent.director.ctl ? "director" : "idle"; if (goals[n][goals[n].length - 1] !== k) goals[n].push(k); }, 1000);
  console.log(`watching ${secs}s with no orders...`);
  await sleep(secs * 1000);
  for (const [n, X] of [["Alpha", A], ["Beta", B]]) {
    console.log(`${n}: role ${X.agent.role} | goals: ${goals[n].join(" > ")} | journal: ${X.agent.autonomy.journal.map((j) => `${j.outcome === "done" ? "+" : "-"}${j.goal}`).join("; ").slice(0, 300)}`);
    console.log(`   inv: ${JSON.stringify(X.agent.lastInv || {}).slice(0, 200)}`);
  }
  console.log("public chat lines:", said.length, said.slice(0, 6).join(" || ").slice(0, 400));
  const pass = goals.Alpha.some((g) => g.endsWith("*") || g === "director") && goals.Beta.some((g) => g.endsWith("*") || g === "director") && said.length <= 6;
  console.log(pass ? "PASS agents work autonomously and quietly" : "FAIL");
  A.agent.stop(); B.agent.stop(); A.bot.quit(); B.bot.quit(); human.quit(); process.exit(pass ? 0 : 1);
})();
