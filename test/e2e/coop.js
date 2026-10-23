// Two agents build ONE structure together: the leader designs and builds, the helper joins the same blueprint at the same spot.
process.env.MC_AGENT_NAMES = "Alpha,Beta"; process.env.MC_GENERIC_TRIGGER = "false";
const os = require("os"), path = require("path");
process.env.MC_SHARED_DIR = path.join(os.tmpdir(), "mcbot-shared-" + Date.now());
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");
const { createAgentBot } = require("../../src/index");
const { consoleCmd, sleep, waitUntil } = require("./harness");
const S = require("../../src/core/structure");
(async () => {
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-coop-a-" + Date.now()); const A = createAgentBot({ port: 25599, username: "Alpha", gamemode: "creative" }); await A.ready;
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-coop-b-" + Date.now()); const B = createAgentBot({ port: 25599, username: "Beta", gamemode: "creative" }); await B.ready;
  const human = await new Promise((r) => { const b = mineflayer.createBot({ host: "localhost", port: 25599, username: "Gems", auth: "offline", version: "26.1.2" }); b.once("spawn", () => r(b)); });
  consoleCmd("op Gems"); consoleCmd("difficulty peaceful"); consoleCmd("time set day");
  const X = 420, Z = 420, Y = 150;
  consoleCmd(`forceload add ${X - 25} ${Z - 25} ${X + 25} ${Z + 25}`); await sleep(1500);
  consoleCmd(`fill ${X - 25} ${Y - 10} ${Z - 25} ${X + 25} ${Y - 2} ${Z + 25} stone`); consoleCmd(`fill ${X - 25} ${Y - 1} ${Z - 25} ${X + 25} ${Y - 1} ${Z + 25} grass_block`);
  for (let y = Y; y <= Y + 16; y += 6) consoleCmd(`fill ${X - 25} ${y} ${Z - 25} ${X + 25} ${Math.min(y + 5, Y + 16)} ${Z + 25} air`);
  await waitUntil(() => A.bot.blockAt(new Vec3(X, Y - 1, Z))?.name === "grass_block" && A.bot.blockAt(new Vec3(X, Y + 5, Z))?.name === "air", 25000, 400);
  consoleCmd(`tp Alpha ${X} ${Y} ${Z}`); consoleCmd(`tp Beta ${X + 3} ${Y} ${Z}`); consoleCmd(`tp Gems ${X + 1} ${Y} ${Z + 6}`); await sleep(2500);
  consoleCmd("gamemode creative Alpha"); consoleCmd("gamemode creative Beta"); await sleep(800);
  const goalsB = []; const iv = setInterval(() => { const t = B.agent.goal?.type; if (t && goalsB[goalsB.length - 1] !== t) goalsB.push(t); }, 500);
  const log = []; human.on("chat", (u, m) => { if (u === "Alpha" || u === "Beta") log.push(`<${u}> ${m}`); });
  human.chat("Alpha, build a small wooden cabin and have Beta help you build it");
  const t0 = Date.now();
  await waitUntil(() => A.agent.goal?.type === "build", 60000, 300);
  const sid = A.agent.goal?.sid;
  await waitUntil(() => !A.agent.goal && !B.agent.goal, 540000, 1000);
  clearInterval(iv);
  const rec = A.agent.mem.recall(`structure:${sid}`);
  const spec = A.agent.lastSpec;
  let match = 0;
  if (spec && rec) {
    const c = S.compileStructure(spec, A.reg); const cells = c.cells.map((x) => S.abs(x, rec.origin));
    const d = S.diffStructure(cells, (p) => { const b = A.bot.blockAt(new Vec3(p.x, p.y, p.z)); return b ? { name: b.name, boundingBox: b.boundingBox } : null; });
    match = d.ratio;
  }
  console.log("finished in", Math.round((Date.now() - t0) / 1000) + "s | Beta goals:", goalsB.join(" > "), "| match", (match * 100).toFixed(1) + "%");
  console.log("conversation:\n  " + log.slice(0, 14).join("\n  "));
  const pass = goalsB.includes("assist") && match >= 0.99;
  console.log(pass ? "PASS co-op build" : "FAIL co-op build");
  A.agent.stop(); B.agent.stop(); A.bot.quit(); B.bot.quit(); human.quit(); process.exit(pass ? 0 : 1);
})();
