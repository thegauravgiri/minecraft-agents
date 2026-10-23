// Low health with a hostile next to us: the bot must survive sensibly and never busy-loop.
const { connect, consoleCmd, botCmd, sleep, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("LowBot");
  consoleCmd("difficulty normal"); consoleCmd("time set day"); consoleCmd("gamemode survival LowBot");
  consoleCmd("tp LowBot 150 90 -150"); await settle(bot);
  await botCmd(bot, "clear @s"); await botCmd(bot, "give @s dirt 32");
  agent.run();
  let reflexLines = 0;
  const origLog = console.log; console.log = (...a) => { if (String(a[0]).includes("[reflex]")) reflexLines++; origLog(...a); };
  consoleCmd("execute at LowBot run summon zombie ~2 ~ ~ {PersistenceRequired:1b}"); consoleCmd("execute at LowBot run summon zombie ~-2 ~ ~ {PersistenceRequired:1b}");
  await sleep(500); consoleCmd("damage LowBot 15");
  const t0 = Date.now(); let minHp = 20, cpu0 = process.cpuUsage();
  while (Date.now() - t0 < 15000) { minHp = Math.min(minHp, bot.health); await sleep(250); }
  const cpu = process.cpuUsage(cpu0); const cpuPct = ((cpu.user + cpu.system) / 1000) / 15000 * 100;
  console.log = origLog;
  const ok = reflexLines < 80 && cpuPct < 110;
  console.log("cycles(replans):", agent.stats.replans, "reflexes:", agent.stats.reflexes, "actions:", agent.stats.actions, "dead:", agent.dead);
  console.log(ok ? "PASS" : "FAIL", "reflex log lines in 15s:", reflexLines, "cpu%:", cpuPct.toFixed(0), "alive:", bot.health > 0, "minHp", minHp.toFixed(1), "hp now", bot.health.toFixed(1));
  agent.stop(); bot.quit(); process.exit(ok ? 0 : 1);
})();
