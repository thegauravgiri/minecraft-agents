const mineflayer = require("mineflayer");
const { connect, consoleCmd, botCmd, sleep, waitUntil } = require("./harness");
const { Memory } = require("../../src/core/memory");
const { Radar } = require("../../src/runtime/radar");
const { normDim } = require("../../src/runtime/observe");
const { travelDimension, chaseAcrossDimensions } = require("../../src/skills/portal");

const results = [];
const check = (name, pass, extra = "") => { results.push(pass); console.log(`${pass ? "PASS" : "FAIL"} ${name} ${extra}`); };
const nether = (c) => consoleCmd(`execute in minecraft:the_nether run ${c}`);
const over = (c) => consoleCmd(`execute in minecraft:overworld run ${c}`);

async function fixtures() {
  over("forceload add 495 495 550 550"); nether("forceload add 50 50 85 85");
  await sleep(3000);
  over("fill 495 70 495 550 79 550 stone"); over("fill 495 80 495 550 100 550 air");
  nether("fill 50 85 50 85 89 85 netherrack"); nether("fill 50 90 50 85 105 85 air");
  nether("fill 66 89 65 69 93 65 obsidian hollow"); nether("fill 67 90 65 68 92 65 nether_portal[axis=x]");
  await sleep(1500);
}
const placeOverworldPortal = () => { over("fill 520 79 520 523 83 520 obsidian hollow"); over("fill 521 80 520 522 82 520 nether_portal[axis=x]"); };
const removeOverworldPortal = () => { over("fill 519 80 519 524 84 521 air"); over("fill 519 79 519 524 79 521 stone"); };

(async () => {
  const { bot, agent, reg } = await connect("PortalBot");
  consoleCmd("difficulty peaceful");
  await botCmd(bot, "gamemode survival"); await botCmd(bot, "clear @s");
  await fixtures();
  const ctl = new AbortController();
  const mem = new Memory();
  const ctx = { bot, reg, mem, signal: ctl.signal, agent };
  const tpOver = async (x, y, z) => { consoleCmd(`execute in minecraft:overworld run tp PortalBot ${x} ${y} ${z}`); await sleep(1500); await waitUntil(() => bot.entity.onGround && normDim(bot.game.dimension) === "overworld", 8000, 200); await sleep(500); };

  await tpOver(514, 80, 526); placeOverworldPortal();
  check("0 fixture portal visible", await waitUntil(() => bot.findBlock({ matching: bot.registry.blocksByName.nether_portal.id, maxDistance: 32 }), 8000, 300));
  let r = await travelDimension(ctx, { dimension: "the_nether" });
  console.log(JSON.stringify(r));
  check("1 overworld->nether", r.ok && normDim(bot.game.dimension) === "the_nether" && r.data.arrived);
  check("1 arrival portal remembered", (mem.recall("portals")?.the_nether || []).length >= 1, JSON.stringify(mem.recall("portals")));

  r = await travelDimension(ctx, { dimension: "overworld" });
  console.log(JSON.stringify(r));
  check("2 nether->overworld", r.ok && normDim(bot.game.dimension) === "overworld");

  removeOverworldPortal();
  await tpOver(530, 80, 532); await botCmd(bot, "clear @s");
  mem.facts = {};
  r = await travelDimension(ctx, { dimension: "the_nether" });
  console.log(JSON.stringify(r));
  check("4 no materials -> need hint", !r.ok && r.reason === "no_portal_and_no_materials" && r.data?.need?.obsidian === 10);

  await botCmd(bot, "give @s obsidian 10"); await botCmd(bot, "give @s flint_and_steel"); await botCmd(bot, "give @s dirt 8");
  await sleep(500);
  r = await travelDimension(ctx, { dimension: "the_nether" });
  console.log(JSON.stringify(r));
  check("3 build + light + enter", r.ok && normDim(bot.game.dimension) === "the_nether");

  r = await travelDimension(ctx, { dimension: "overworld" });
  check("3b back to overworld", r.ok && normDim(bot.game.dimension) === "overworld", JSON.stringify(r.data || r.reason));

  // 5: chase across dimensions
  const t = mineflayer.createBot({ host: "localhost", port: 25599, username: "PortalTarget", auth: "offline", version: "26.1.2" });
  await new Promise((res) => t.once("spawn", res));
  consoleCmd("op PortalTarget"); await sleep(800);
  consoleCmd("gamemode survival PortalTarget");
  consoleCmd("execute in minecraft:the_nether run tp PortalTarget 60 90 70");
  await sleep(2500);
  const radar = new Radar(bot);
  ctx.agent = { radar, mem };
  radar.track("PortalTarget");
  const w0 = await waitUntil(() => radar.where("PortalTarget")?.dimension === "the_nether", 8000, 300);
  check("5 radar sees target in nether", w0, JSON.stringify(radar.where("PortalTarget")));
  let arrived = false;
  for (let i = 0; i < 6 && !arrived; i++) {
    r = await chaseAcrossDimensions(ctx, "PortalTarget");
    console.log("chase", i, JSON.stringify(r), bot.game.dimension);
    arrived = r.ok && r.data.arrived;
    if (!r.ok) break;
  }
  check("5a chase overworld->nether", arrived && normDim(bot.game.dimension) === "the_nether");

  consoleCmd("execute in minecraft:overworld run tp PortalTarget 514 80 524");
  await sleep(2500);
  arrived = false;
  for (let i = 0; i < 6 && !arrived; i++) {
    r = await chaseAcrossDimensions(ctx, "PortalTarget");
    console.log("chase back", i, JSON.stringify(r), bot.game.dimension);
    arrived = r.ok && r.data.arrived;
    if (!r.ok) break;
  }
  check("5b chase nether->overworld", arrived && normDim(bot.game.dimension) === "overworld");

  radar.stop(); t.quit(); bot.quit();
  const all = results.every(Boolean);
  console.log(all ? "ALL PASS" : "SOME FAILED");
  process.exit(all ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
