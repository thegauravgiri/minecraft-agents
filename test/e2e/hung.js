// A skill that never returns and ignores abort (what froze AIBot and Scout) must not freeze the agent.
const { connect } = require("./harness");
const skills = require("../../src/skills");
(async () => {
  const { agent, bot } = await connect("HungBot");
  skills.hung_test = () => new Promise(() => {});            // never settles, never looks at ctx.signal
  const t0 = Date.now();
  const p = agent.exec({ skill: "hung_test" }, false);
  setTimeout(() => agent.abortCurrent("test"), 500);
  const r = await Promise.race([p, new Promise((res) => setTimeout(() => res("STILL STUCK"), 9000))]);
  const dt = Date.now() - t0;
  const ok = r !== "STILL STUCK" && r.aborted && dt < 8000 && agent.current === null;
  console.log(ok ? `PASS hung skill released after ${dt} ms` : `FAIL ${JSON.stringify(r)} after ${dt} ms`);
  agent.stop(); bot.quit(); process.exit(ok ? 0 : 1);
})();
