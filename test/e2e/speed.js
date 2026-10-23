// How fast does the bot travel 70 flat blocks? (walk 4.3 b/s, sprint 5.6, sprint-jump ~7+)
const { connect, consoleCmd, botCmd, sleep, settle, waitUntil } = require("./harness");
const { Vec3 } = require("vec3");
const { Memory } = require("../../src/core/memory");
const { goto, goals } = require("../../src/skills/move");
(async () => {
  const { bot, agent, reg } = await connect("SprintBot");
  consoleCmd("gamemode survival SprintBot"); consoleCmd("difficulty peaceful");
  await settle(bot);
  const P = bot.entity.position.floored(); const X = P.x, Z = P.z, Y = P.y;
  consoleCmd(`fill ${X - 5} ${Y - 30} ${Z - 5} ${X + 90} ${Y - 2} ${Z + 5} stone`); consoleCmd(`fill ${X - 5} ${Y - 1} ${Z - 5} ${X + 90} ${Y - 1} ${Z + 5} grass_block`); consoleCmd(`fill ${X - 5} ${Y} ${Z - 5} ${X + 90} ${Y + 6} ${Z + 5} air`);
  await waitUntil(() => bot.blockAt(new Vec3(X + 80, Y - 1, Z))?.name === "grass_block", 20000, 300);
  consoleCmd(`tp SprintBot ${X} ${Y} ${Z}`); await settle(bot); await botCmd(bot, "clear @s");
  await botCmd(bot, "effect give @s saturation 30 10 true"); await sleep(500);
  const ctx = { bot, reg, mem: new Memory(), agent, signal: new AbortController().signal, beat() {} };
  const T = 70, t0 = Date.now();
  if (process.env.HOP_DEBUG) { let n = 0; bot.on('physicsTick', () => { if (++n % 10) return; const c = bot.controlState, v = bot.entity.velocity; console.log('dbg moving', bot.pathfinder.isMoving(), 'fwd', c.forward, 'spr', c.sprint, 'jump', c.jump, 'ground', bot.entity.onGround, 'speed', Math.hypot(v.x, v.z).toFixed(2), 'hopflag', !!bot.__sprintHop, 'noHop', !!bot.__noHop); }); }
  const r = await goto(ctx, new goals.GoalNear(X + T, Y, Z, 1.5), { timeout: 60000, towardPos: new Vec3(X + T, Y, Z) });
  const sec = (Date.now() - t0) / 1000;
  console.log(`travel ${T} blocks: ${r.ok ? "ok" : r.reason} in ${sec.toFixed(1)}s = ${(T / sec).toFixed(2)} blocks/s (sprint-jump target >= 6.5)`);
  bot.quit(); process.exit(0);
})();
