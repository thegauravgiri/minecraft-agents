process.env.MC_AUTONOMY = "off";
const { Vec3 } = require("vec3");
const { connect, consoleCmd, sleep, settle } = require("./harness");
(async () => {
  const { bot, agent } = await connect("ChestBot");
  const X = 2700, Z = 2700, Y = 150;
  consoleCmd(`forceload add ${X - 10} ${Z - 10} ${X + 10} ${Z + 10}`); await sleep(1200);
  consoleCmd(`fill ${X - 8} ${Y - 3} ${Z - 8} ${X + 8} ${Y - 1} ${Z + 8} stone`); consoleCmd(`fill ${X - 8} ${Y} ${Z - 8} ${X + 8} ${Y + 4} ${Z + 8} air`);
  consoleCmd(`setblock ${X + 2} ${Y} ${Z} chest`); await sleep(1500);
  consoleCmd(`tp ChestBot ${X} ${Y} ${Z}`); consoleCmd("gamemode survival ChestBot"); consoleCmd("clear ChestBot");
  for (const [i, n] of [["cobblestone", 20], ["oak_log", 5], ["stone_pickaxe", 1], ["rotten_flesh", 3]]) consoleCmd(`give ChestBot ${i} ${n}`);
  await sleep(1500); await settle(bot);
  console.log("inv before:", bot.inventory.items().map((i) => i.name + "x" + i.count).join(","));
  const r = await agent.exec({ skill: "chest", args: { action: "put", items: "all" } }, false);
  console.log("result:", JSON.stringify(r).slice(0, 300));
  await sleep(500);
  console.log("inv after:", bot.inventory.items().map((i) => i.name + "x" + i.count).join(","));
  process.exit(0);
})();
