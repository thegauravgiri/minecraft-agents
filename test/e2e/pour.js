const { connect, consoleCmd, botCmd, sleep, settle } = require("./harness");
const { Vec3 } = require("vec3");
(async () => {
  const { bot } = await connect("PourDbg");
  consoleCmd("gamemode survival PourDbg"); consoleCmd("tp PourDbg 700 91 700"); await settle(bot);
  consoleCmd("fill 690 60 690 710 89 710 stone"); consoleCmd("fill 690 90 690 710 90 710 grass_block"); consoleCmd("fill 690 91 690 710 98 710 air");
  await sleep(600); consoleCmd("tp PourDbg 701 91 700"); await settle(bot);
  await botCmd(bot, "clear @s"); await botCmd(bot, "give @s water_bucket");
  const cell = new Vec3(699, 90, 700);
  consoleCmd(`setblock ${cell.x} ${cell.y} ${cell.z} air`); await sleep(500);
  console.log("pos", bot.entity.position.floored().toString(), "hole:", bot.blockAt(cell).name, "floor:", bot.blockAt(cell.offset(0, -1, 0)).name);
  const wb = bot.inventory.items().find((i) => i.name === "water_bucket"); await bot.equip(wb, "hand");
  const tries = [
    ["look(pitch -1.25) + activateItem", async () => { await bot.look(Math.atan2(-(cell.x + 0.5 - bot.entity.position.x), -(cell.z + 0.5 - bot.entity.position.z)), -1.25, true); await sleep(150); bot.activateItem(); }],
    ["lookAt floor + activateItem", async () => { await bot.lookAt(cell.offset(0.5, 0.0, 0.5), true); await sleep(150); bot.activateItem(); }],
    ["placeBlock on floor top", async () => { const floor = bot.blockAt(cell.offset(0, -1, 0)); await bot.lookAt(cell.offset(0.5, 0, 0.5), true); await bot.placeBlock(floor, new Vec3(0, 1, 0)); }]
  ];
  for (const [label, fn] of tries) {
    try { await fn(); } catch (e) { console.log(label, "error:", e.message); }
    await sleep(600);
    console.log(label, "->", bot.blockAt(cell).name, "| held", bot.heldItem?.name, "| buckets", bot.inventory.items().filter((i) => /bucket/.test(i.name)).map((i) => i.name).join(","));
    if (bot.blockAt(cell).name === "water") break;
  }
  process.exit(0);
})();
