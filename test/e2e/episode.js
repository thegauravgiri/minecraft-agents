// "day 1: <goal>" -> title + boss bar + team project + event log; a fight in between; "end of day" -> recap, highlights.md, captions.srt.
process.env.MC_AGENT_NAMES = "Alpha,Beta"; process.env.MC_GENERIC_TRIGGER = "false"; process.env.MC_AUTONOMY = "off"; process.env.MC_BANTER = "off"; process.env.EPISODE_RECORD = "off";
const os = require("os"), path = require("path"), fs = require("fs");
process.env.MC_SHARED_DIR = path.join(os.tmpdir(), "mcbot-episode-" + Date.now());
process.env.EPISODES_DIR = path.join(os.tmpdir(), "mcbot-episodes-" + Date.now());
const mineflayer = require("mineflayer");
const { createAgentBot } = require("../../src/index");
const { consoleCmd, sleep, waitUntil } = require("./harness");
(async () => {
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-ep-a-" + Date.now()); const A = createAgentBot({ port: 25599, username: "Alpha" }); await A.ready;
  process.env.BOT_DATA_DIR = path.join(os.tmpdir(), "mcbot-ep-b-" + Date.now()); const B = createAgentBot({ port: 25599, username: "Beta" }); await B.ready;
  const w = await new Promise((r) => { const b = mineflayer.createBot({ host: "localhost", port: 25599, username: "Watcher", auth: "offline", version: "26.1.2" }); b.once("spawn", () => r(b)); });
  for (const n of ["Watcher", "Alpha", "Beta"]) consoleCmd(`op ${n}`);
  consoleCmd("difficulty normal"); consoleCmd("gamerule doMobSpawning false"); consoleCmd("time set noon");
  const X = 1500, Z = 900, Y = 150;
  consoleCmd(`forceload add ${X - 30} ${Z - 30} ${X + 30} ${Z + 30}`); await sleep(2000);
  for (let x = X - 30; x <= X + 30; x += 15) { consoleCmd(`fill ${x} ${Y - 3} ${Z - 30} ${x + 14} ${Y - 1} ${Z + 30} grass_block`); consoleCmd(`fill ${x} ${Y} ${Z - 30} ${x + 14} ${Y + 10} ${Z + 30} air`); }
  await sleep(3000);
  consoleCmd(`tp Alpha ${X} ${Y} ${Z}`); consoleCmd(`tp Beta ${X + 10} ${Y} ${Z}`); consoleCmd(`tp Watcher ${X + 3} ${Y} ${Z + 3}`); await sleep(2500);
  for (const n of ["Alpha", "Beta"]) { consoleCmd(`gamemode survival ${n}`); consoleCmd(`give ${n} stone_sword 1`); consoleCmd(`item replace entity ${n} armor.chest with iron_chestplate`); }
  const titles = [], bars = [];
  w._client.on("set_title_text", (p) => titles.push(JSON.stringify(p.text)));
  w._client.on("boss_bar", (p) => bars.push(p.action + ":" + JSON.stringify(p.title || p.health || "")));
  A.agent.run(); B.agent.run(); await sleep(2000);
  w.chat("day 1: build a small cobblestone hut");
  const { current, dirOf } = require("../../src/brain/episode");
  const started = await waitUntil(() => current()?.day === 1, 15000, 300);
  await sleep(5000);
  for (let i = 0; i < 2; i++) consoleCmd(`summon zombie ${X + 2 + i} ${Y} ${Z + i}`);
  await waitUntil(() => { try { return /"help"/.test(fs.readFileSync(path.join(dirOf(1), "events.jsonl"), "utf8")); } catch { return false; } }, 40000, 500);
  await sleep(15000);
  w.chat("end of day");
  const ended = await waitUntil(() => fs.existsSync(path.join(dirOf(1), "captions.srt")), 40000, 500);
  const dir = dirOf(1);
  const md = ended ? fs.readFileSync(path.join(dir, "highlights.md"), "utf8") : "";
  const srt = ended ? fs.readFileSync(path.join(dir, "captions.srt"), "utf8") : "";
  console.log(`started: ${started} | titles: ${titles.slice(0, 4).join(" , ")} | bossbar packets: ${bars.length}`);
  console.log("---- highlights.md\n" + md.split("\n").slice(0, 22).join("\n"));
  console.log("---- captions.srt (first 3)\n" + srt.split("\n\n").slice(0, 3).join("\n\n"));
  const pass = started && ended && titles.some((t) => /DAY 1/.test(t)) && bars.length > 0 && /help/.test(md) && srt.includes("-->");
  console.log(pass ? "PASS episode: title, boss bar, highlights, captions" : "FAIL");
  consoleCmd("forceload remove all"); A.agent.stop(); B.agent.stop(); A.bot.quit(); B.bot.quit(); w.quit(); process.exit(pass ? 0 : 1);
})();
