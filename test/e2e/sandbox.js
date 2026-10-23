// Scripts that do real synchronous work before their first await must run, and infinite loops must still be stopped.
const { connect, consoleCmd, sleep, settle } = require("./harness");
const { runScript } = require("../../src/brain/sandbox");
const { Memory } = require("../../src/core/memory");
(async () => {
  const { bot, agent, reg } = await connect("SbxBot");
  consoleCmd("gamemode survival SbxBot"); consoleCmd("tp SbxBot 150 90 -150"); await settle(bot);
  const mk = () => ({ bot, reg, mem: new Memory(), agent, signal: new AbortController().signal });
  const heavy = `let n = 0; for (let i = 0; i < 40; i++) { n += api.findBlocks("stone", 64, 300).length; n += api.entities({ maxDist: 64 }).length; }
    api.log("scanned", n); return n;`;
  let t = Date.now(); let r = await runScript(mk(), heavy);
  console.log("heavy sync scan:", r.ok ? "PASS" : "FAIL " + r.error, `${Date.now() - t}ms`, JSON.stringify(r.value));
  t = Date.now(); r = await runScript(mk(), `while (true) {}`, { timeoutMs: 20000 });
  console.log("infinite loop stopped:", !r.ok && /timed out/.test(r.error) ? "PASS" : "FAIL " + JSON.stringify(r), `${Date.now() - t}ms`);
  t = Date.now(); r = await runScript(mk(), `await api.sleep(300); api.say("hello from a script"); return api.count("dirt");`);
  console.log("normal async script:", r.ok ? "PASS" : "FAIL " + r.error, `${Date.now() - t}ms`);
  bot.quit(); process.exit(0);
})();
