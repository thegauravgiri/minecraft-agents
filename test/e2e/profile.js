const { connect, consoleCmd, botCmd, sleep } = require("./harness");
const { observe } = require("../../src/runtime/observe");
(async () => {
  const { bot, agent, reg } = await connect();
  await sleep(1500);
  const time = (label, fn, n = 3) => { const t = Date.now(); for (let i = 0; i < n; i++) fn(); console.log(label, ((Date.now() - t) / n).toFixed(1) + "ms"); };
  time("observe", () => observe(bot));
  agent.invalidateHints(); time("hints(cold)", () => { agent.invalidateHints(); agent.hints(observe(bot)); }, 2);
  time("findBlock crafting_table 24", () => bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 24 }));
  time("findBlock oak_log 48", () => bot.findBlock({ matching: bot.registry.blocksByName.oak_log.id, maxDistance: 48 }));
  time("findBlocks stone 64 x48", () => bot.findBlocks({ matching: [bot.registry.blocksByName.stone.id], maxDistance: 64, count: 48 }));
  const { plan } = require("../../src/core/planner");
  time("plan(iron_pickaxe)", () => plan(reg, { type: "have", items: { iron_pickaxe: 1 } }, observe(bot), agent.hints(observe(bot))), 3);
  // craft timing
  await botCmd(bot, "give @s oak_log 8"); await sleep(500);
  const t = Date.now();
  const item = bot.registry.itemsByName.oak_planks;
  const rec = bot.recipesFor(item.id, null, 1, null);
  console.log("recipesFor", Date.now() - t, "ms", rec.length);
  const t2 = Date.now(); await bot.craft(rec[0], 1); console.log("bot.craft", Date.now() - t2, "ms");
  bot.quit(); process.exit(0);
})();
