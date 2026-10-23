// Non-destructive, REAL world (MC_PORT, default 44444): the unstick routine picks a sensible recovery and finishes without errors.
const { createAgentBot } = require("../src/index");
(async () => {
  const o = createAgentBot({ port: Number(process.env.MC_PORT || 44444), username: "SbxBot", auto: false, chat: false }); await o.ready;
  const { bot, agent } = o;
  agent.alive = true;
  const logs = []; const t0 = Date.now();
  console.log("start", bot.entity.position.floored().toString());
  await agent.unstick();
  console.log("after unstick #1:", bot.entity.position.floored().toString(), `${Date.now() - t0}ms`, "level", agent.unstickLevel);
  // simulate the watchdog: a no-progress interrupt must set the flag and abort the running action
  const invSig = bot.inventory.items().map((i) => i.name + i.count).sort().join(",");
  agent.prog = { pos: bot.entity.position.clone(), inv: invSig, t: Date.now() - 61000 };
  const ctl = new AbortController(); agent.current = { name: "approach", ctl, reflex: false }; agent.active.add(ctl);
  agent.monitor();
  console.log("watchdog fired:", agent.needUnstick === true && ctl.signal.aborted ? "PASS" : "FAIL", "needUnstick", agent.needUnstick, "aborted", ctl.signal.aborted);
  bot.quit(); process.exit(0);
})();
