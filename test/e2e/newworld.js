// A different world must start with a clean mind; the same world must keep its memory. (Skills survive both.)
const os = require("os"), path = require("path"), fs = require("fs");
const tmp = path.join(os.tmpdir(), "mcbot-newworld-" + Date.now());
process.env.BOT_DATA_DIR = path.join(tmp, "own"); process.env.MC_SHARED_DIR = path.join(tmp, "shared");
const { createAgentBot } = require("../../src/index");
const { sleep } = require("./harness");
const ctxFile = path.join(process.env.BOT_DATA_DIR, "context.json"), worldFile = path.join(process.env.BOT_DATA_DIR, "world.json");
const join = async () => { const i = createAgentBot({ port: 25599, username: "WorldBot", auto: false, chat: false }); await i.ready; await sleep(500); i.bot.quit(); await sleep(500); return i; };
(async () => {
  fs.mkdirSync(process.env.BOT_DATA_DIR, { recursive: true });
  fs.writeFileSync(ctxFile, JSON.stringify({ chat: [{ speaker: "x", text: "old world base at 1 2 3", t: 1 }], places: [{ x: 1, y: 2, z: 3, label: "base", speaker: "x", text: "base at 1 2 3" }], facts: {}, goals: [] }));
  await join();                                                     // 1st contact: no record of this world -> wiped, fingerprint stored
  const wiped1 = !fs.existsSync(ctxFile);
  const fp = JSON.parse(fs.readFileSync(worldFile, "utf8")).fingerprint;
  fs.writeFileSync(ctxFile, JSON.stringify({ chat: [], places: [{ x: 9, y: 9, z: 9, label: "farm", speaker: "x", text: "farm at 9 9 9" }], facts: {}, goals: [] }));
  await join();                                                     // same world again -> memory kept
  const kept = fs.existsSync(ctxFile);
  fs.writeFileSync(worldFile, JSON.stringify({ fingerprint: "another:world" }));
  await join();                                                     // "different" world -> wiped
  const wiped2 = !fs.existsSync(ctxFile);
  const ok = wiped1 && kept && wiped2 && !!fp;
  console.log(`fingerprint ${fp} | unknown world wiped: ${wiped1} | same world kept: ${kept} | different world wiped: ${wiped2}`);
  console.log(ok ? "PASS new world => clean memory" : "FAIL");
  process.exit(ok ? 0 : 1);
})();
