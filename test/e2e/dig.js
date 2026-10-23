const { connect, consoleCmd, botCmd, sleep } = require("./harness");
const { digDown } = require("../../src/skills/vertical");
const { Memory } = require("../../src/core/memory");
(async () => {
  const { bot, agent, reg } = await connect();
  consoleCmd("difficulty peaceful"); await botCmd(bot, "gamemode survival"); await botCmd(bot, "clear @s"); await botCmd(bot, "give @s diamond_pickaxe");
  consoleCmd("tp Vesper -30 80 60"); await sleep(1000); while (!bot.entity.onGround || bot.entity.position.y < 70) await sleep(200); await sleep(500);
  const y0 = bot.entity.position.y;
  const ctl = new AbortController();
  const ctx = { bot, reg, mem: new Memory(), signal: ctl.signal, agent };
  const t = Date.now();
  console.log("dbg y", bot.entity.position.y, "target", Math.floor(y0) - 8, "below", bot.blockAt(bot.entity.position.offset(0,-1,0))?.name);
  const r = await digDown(ctx, { targetY: Math.floor(y0) - 8, toward: bot.entity.position.offset(5, 0, 0) });
  console.log("digDown result", JSON.stringify(r), "y", y0, "->", bot.entity.position.y.toFixed(1), Date.now() - t, "ms");
  bot.quit(); process.exit(r.ok ? 0 : 1);
})();
