// Chat -> Goal. Fast local parser first (instant, deterministic); the LLM only handles what this cannot.
const { resolveItem } = require("../core/items");

const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, dozen: 12 };
const parseCount = (s) => {
  if (s == null) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : NUM[String(s).toLowerCase()] ?? null;
};

const ACQUIRE = /^(?:please\s+)?(?:go\s+)?(?:get|gather|collect|mine|chop|bring|fetch|craft|make|build|create|assemble|put together|smelt|find|grab|obtain|farm|i need|i want|give me)\s+(?:me\s+)?(?:(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|dozen)\s+)?(.+?)(?:\s+(?:for me|please|now))?$/i;

function parseIntent(text, opts = {}) {
  const { reg, speaker, botName } = opts;
  let t = String(text || "").trim().replace(/[!.?]+$/g, "");
  if (botName) t = t.replace(new RegExp(`^(?:hey\\s+|yo\\s+)?@?${botName}[,:]?\\s*`, "i"), "");
  t = t.replace(/^(?:hey\s+|hi\s+|yo\s+)?(?:ai|bot)[,:]?\s+/i, "").trim();
  const l = t.toLowerCase();
  if (!l) return null;

  const num = "(-?\\d+(?:\\.\\d+)?)";
  const cm = l.match(new RegExp(`^(?:come|go|walk|run|head|move|travel|goto|tp)(?:\\s+(?:to|towards?|over to))?\\s*(?:coords?|coordinates|at)?[:\\s]*\\(?${num}[,\\s]+${num}(?:[,\\s]+${num})?\\)?`));
  if (cm) {
    const a = [cm[1], cm[2], cm[3]].filter((x) => x != null).map(Number);
    return a.length === 3 ? { type: "goto", pos: { x: a[0], y: a[1], z: a[2] } } : { type: "goto", pos: { x: a[0], y: null, z: a[1] } };
  }
  // "come to the location I gave earlier" / "go back there" / "go to base" -> remembered place
  const homeOf = (ctx) => {
    if (!ctx) return null;
    const p = ctx.lastPlace("home") || ctx.lastPlace("base") || ctx.lastPlace("house");
    if (p) return { x: p.x, y: p.y, z: p.z };
    const h = ctx.recall("house");
    if (h?.origin && h?.size) return { x: h.origin.x + Math.floor(h.size.w / 2), y: h.origin.y + 1, z: h.origin.z + Math.floor(h.size.d / 2) };
    const b = ctx.recall("bed");
    return b ? { x: b.x, y: b.y, z: b.z } : null;
  };
  const homeMatch = l.match(/^(?:come|go|walk|run|head|move|travel|return|get)\s+(?:back\s+)?(?:over\s+)?(?:to\s+|towards?\s+|into\s+|inside\s+)?(?:the\s+|our\s+|my\s+)?(?:home|house|base|camp|bed)\b/);
  if (homeMatch && opts.ctx) { const h = homeOf(opts.ctx); if (h) return { type: "goto", pos: h }; }
  const ref = l.match(/^(?:come|go|walk|run|head|move|travel|return|get)\s+(?:back\s+)?(?:over\s+)?(?:to\s+|towards?\s+)?(?:the\s+|that\s+|my\s+|our\s+|your\s+)?(.*)$/);
  if (ref && opts.ctx) {
    const rest = ref[1].trim();
    const isRef = /^(?:(?:earlier|previous|last|same|given|provided|first|original|old)\b.*(?:location|place|coords?|coordinates|spot|position|one)|(?:location|place|coords?|coordinates|spot|position)\b.*(?:gave|given|said|sent|provided|told|earlier)|there|that (?:place|spot|location)|back there|where i said)/.test(rest) || /^(?:location|place|coords?|coordinates)$/.test(rest);
    const named = opts.ctx.lastPlace(rest.split(/\s+/)[0]);
    const place = isRef ? opts.ctx.lastPlace() : (named && /^(base|home|house|camp|farm|mine|portal|village|spawn|cave|tower|castle|shop)\b/.test(rest) ? named : null);
    if (place) return { type: "goto", pos: { x: place.x, y: place.y, z: place.z } };
  }
  if (/^(stop|stay|wait|halt|hold|freeze|cancel|abort|stand still|never ?mind|nvm)\b/.test(l)) return { type: "stop" };
  if (/^(follow|come with|stick with|tag along)\b/.test(l)) return { type: "follow", player: speaker };
  if (/^(come|come here|come to me|get over here|over here|here|c'?mere)\b/.test(l)) return { type: "come", player: speaker };
  // containers: "open the chest", "take everything from the chest", "put the dirt in the chest", "what's in the chest"
  const chestWord = /\b(chest|chests|barrel|box|storage)\b/;
  if (chestWord.test(l)) {
    const put = l.match(/^(?:please\s+)?(?:put|store|deposit|dump|place|drop)\s+(?:all\s+|everything\s+|my\s+)?(.*?)\s*(?:in|into|inside)\s+(?:the\s+|a\s+|that\s+)?(?:nearest\s+)?(?:chest|barrel|box|storage)/);
    if (put) { const what = put[1].replace(/\b(my|the|all|items?|stuff)\b/g, "").trim(); const item = what && reg ? resolveItem(reg, what) : null; return { type: "chest", action: "put", items: item ? { [item]: 10000 } : "all" }; }
    if (/^(?:what'?s|what is|what do you see|look|check|see|peek|show)\b.*(chest|barrel|box|storage)/.test(l) || /(what'?s in|contents of)/.test(l)) return { type: "chest", action: "list", items: [] };
    const take = l.match(/^(?:please\s+)?(?:take|get|grab|collect|loot|withdraw|fetch|pick up|empty)\s+(?:out\s+)?(?:all\s+(?:the\s+)?|everything\s+|(?:some\s+)?)?(.*?)\s*(?:from|out of|in|inside)\s+(?:the\s+|a\s+|that\s+)?(?:nearest\s+)?(?:chest|barrel|box|storage)/);
    if (take) { const what = take[1].replace(/\b(the|all|items?|stuff|everything|out)\b/g, "").trim(); const item = what && reg ? resolveItem(reg, what) : null; return { type: "chest", action: "take", items: item ? { [item]: 10000 } : "all" }; }
    if (/^(?:please\s+)?(?:open|loot|empty|raid|rummage|search)\b/.test(l)) return { type: "chest", action: "take", items: "all" };
  }
  if (/^(?:sleep|go to sleep|go to bed|rest|nap|use\s+(?:a\s+|the\s+)?bed)\b/.test(l)) return { type: "set_spawn", sleep: true };
  if (/^(?:set\s+(?:a\s+|my\s+|your\s+|the\s+)?(?:spawn|respawn)|make\s+(?:the\s+|a\s+)?bed\s+(?:your\s+)?spawn)/.test(l)) return { type: "set_spawn" };
  if (/^(?:please\s+)?(?:build|make|construct|create|set up)\s+(?:me\s+|us\s+)?(?:a\s+|an\s+|the\s+)?(?:[\w-]+\s+){0,4}?(?:house|home|hut|shelter|base|cabin|farm|tower|castle|barn|pen|stable|wall|pool|cottage|mansion|fortress)/.test(l)) return { type: "build", request: t };

  let m = l.match(/^(?:please\s+)?(?:kill|hunt|attack|fight|slay|eliminate|destroy|murder)\s+(?:down\s+)?(.+)$/);
  if (m) {
    const who = m[1].trim();
    if (/^(me|myself)$/.test(who)) return { type: "kill", targets: [speaker], manhunt: false };
    if (/^(both|everyone|all|them|all players|everybody)$/.test(who)) return { type: "kill", targets: ["*players"], manhunt: true };
    if (/^(hostiles?|mobs?|monsters?|zombies|everything)$/.test(who)) return { type: "kill", targets: ["*hostiles"], radius: 24 };
    return { type: "kill", targets: [m[1].trim().replace(/\s+and\s+/g, ",").split(",").map((s) => s.trim())].flat() };
  }

  m = l.match(/^(?:please\s+)?(?:give|drop|bring|toss|send)\s+(?:me|us)\s+(?:(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|dozen)\s+)?(.+)$/);
  if (m && reg) {
    const item = resolveItem(reg, m[2]);
    if (item) return { type: "give", player: speaker, item, count: parseCount(m[1]) || 1 };
  }

  m = l.match(/^(?:please\s+)?(?:pick ?up|collect|grab)\s+(?:the\s+)?(?:dropped\s+|all\s+)?(?:items?|drops?|stuff)\b/);
  if (m) return { type: "collect", accept: null };

  m = l.match(/^(?:please\s+)?(?:cook|bake|feed)\b.*?(?:(\d+)\s+)?(?:meat|food|steak|beef|pork|porkchop|chicken|mutton|meals?|us|me)?/);
  if (m && /(cook|feed|bake)/.test(l) && /(meat|food|steak|beef|pork|chicken|mutton|meal|feed|us|me)\b/.test(l)) {
    const n = (l.match(/(\d+)/) || [])[1];
    return { type: "cook", count: n ? parseInt(n, 10) : 8, deliverTo: /(for (me|us)|feed|give|bring)/.test(l) ? speaker : null };
  }

  m = l.match(/^(?:please\s+)?(?:place|put down|set down|make and place|craft and place|build me|make me)\s+(?:me\s+)?(?:an?\s+|the\s+|a\s+)?(chest|crafting table|workbench|furnace|torch|bed|barrel|anvil|enchanting table|crafting_table)\b/);
  if (m) return { type: "place", item: m[1].replace(/ /g, "_").replace("workbench", "crafting_table"), near: speaker };
  if (/^(shelter|hide|take cover|wall (?:yourself )?in|protect yourself|bunker)/.test(l)) return { type: "shelter" };

  m = l.match(ACQUIRE);
  if (m && reg) {
    const item = resolveItem(reg, m[2]);
    if (item) return { type: "have", items: { [item]: parseCount(m[1]) || 1 } };
  }
  return null;
}

// "come to X and set a spawn point" -> ordered list of goals (null if any part is not understood)
function parseSequence(text, opts) {
  let t = String(text || "").trim();
  if (opts.botName) t = t.replace(new RegExp(`^(?:hey\\s+|yo\\s+)?@?${opts.botName}[,:]?\\s*`, "i"), "");
  t = t.replace(/^(?:hey\s+|hi\s+|yo\s+)?(?:ai|bot)[,:]?\s+/i, "");
  const ACTION = "(?:sleep|go to sleep|rest|build|craft|make|get|mine|cook|collect|kill|hunt|give|place|open|set|eat|smelt)";
  const parts = t.split(new RegExp(`\\s*(?:,?\\s+and then\\s+|,?\\s+after that\\s+|,?\\s+then\\s+|,?\\s+and\\s+|\\s+(?:in order to|so (?:that )?(?:you )?can|so you could|to)\\s+(?=${ACTION}\\b))`, "i")).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const goals = parts.map((p) => parseIntent(p, opts));
  return goals.every(Boolean) ? goals : { partial: goals, parts };
}

module.exports = { parseIntent, parseSequence, parseCount };
