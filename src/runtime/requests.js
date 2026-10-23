// Asking for help, the way players do: "need 80 oak planks - anyone?" goes to the whole team, whoever is best placed answers, and
// exactly one of them takes it (O_EXCL claim file, same trick as the project board). Nobody asks the human for things a teammate can do.
const fs = require("fs");
const path = require("path");

const dir = () => path.join(process.env.MC_SHARED_DIR || path.resolve(__dirname, "..", "..", "data", "shared"), "requests");
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
function writeAtomic(f, o) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); }

function post({ from, item, count, why = "" }) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  writeAtomic(path.join(dir(), `${id}.json`), { id, from, item, count, why, t: Date.now(), state: "open" });
  return id;
}
/** Open, recent requests (older than 20 min are stale), not by `me`. */
function open(me) {
  let files = []; try { files = fs.readdirSync(dir()).filter((f) => f.endsWith(".json")); } catch { return []; }
  return files.map((f) => readJson(path.join(dir(), f))).filter((r) => r && r.state === "open" && r.from !== me && Date.now() - r.t < 20 * 60000 && !fs.existsSync(path.join(dir(), `${r.id}.claim`)));
}
function mine(from) {
  let files = []; try { files = fs.readdirSync(dir()).filter((f) => f.endsWith(".json")); } catch { return []; }
  return files.map((f) => readJson(path.join(dir(), f))).filter((r) => r && r.from === from && Date.now() - r.t < 20 * 60000);
}
function claim(id, helper) {
  try { const fd = fs.openSync(path.join(dir(), `${id}.claim`), "wx"); fs.writeSync(fd, JSON.stringify({ helper, t: Date.now() })); fs.closeSync(fd); return true; } catch { return false; }
}
function withdraw(id) { const r = readJson(path.join(dir(), `${id}.json`)); if (r) writeAtomic(path.join(dir(), `${id}.json`), { ...r, state: "withdrawn" }); }
function isClaimed(id) { return fs.existsSync(path.join(dir(), `${id}.claim`)); }
function release(id) { try { fs.unlinkSync(path.join(dir(), `${id}.claim`)); } catch { /* gone */ } }
function fulfil(id, helper) { const r = readJson(path.join(dir(), `${id}.json`)); if (r) writeAtomic(path.join(dir(), `${id}.json`), { ...r, state: "done", helper, doneAt: Date.now() }); }

/** Which roles naturally supply this item? */
function suppliers(item) {
  if (/_planks$|_log$|^stick$|_door$|^chest$|_fence|_sign$|crafting_table|_slab$|_stairs$|ladder|barrel/.test(item)) return ["lumberjack", "builder"];
  if (/cobblestone|^stone|_ore$|^iron|^coal|raw_|furnace|^gravel|^sand|^dirt|andesite|diorite|granite/.test(item)) return ["miner", "smith"];
  if (/^cooked_|^bread|^beef|^porkchop|^chicken|^mutton|^wheat|^carrot|^potato|^apple/.test(item)) return ["hunter"];
  if (/_pickaxe|_axe|_sword|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots|shield|bucket/.test(item)) return ["smith"];
  return [];
}

module.exports = { withdraw, isClaimed, post, open, mine, claim, release, fulfil, suppliers };
