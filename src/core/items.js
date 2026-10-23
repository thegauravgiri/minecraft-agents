// Natural-language item phrase -> registry item name. Pure.
const ALIASES = {
  wood: "oak_log", logs: "oak_log", log: "oak_log", tree: "oak_log", planks: "oak_planks", plank: "oak_planks", stone: "cobblestone",
  cobble: "cobblestone", table: "crafting_table", "crafting table": "crafting_table", workbench: "crafting_table",
  steak: "cooked_beef", beef: "beef", pork: "porkchop", meat: "cooked_beef", "cooked meat": "cooked_beef", food: "cooked_beef",
  iron: "iron_ingot", gold: "gold_ingot", diamonds: "diamond", diamond: "diamond", coal: "coal", sticks: "stick", bed: "white_bed", boat: "oak_boat",
  "water bucket": "water_bucket", bucket: "bucket", torch: "torch", torches: "torch", wool: "white_wool", bread: "bread", arrows: "arrow", bow: "bow", shield: "shield", chest: "chest", furnace: "furnace"
};

function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

function singular(w) {
  if (w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.endsWith("ves")) return w.slice(0, -3) + "f";
  if (w.endsWith("ses") || w.endsWith("xes")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function resolveItem(reg, phrase) {
  if (!phrase) return null;
  let p = phrase.toLowerCase().trim().replace(/\b(a|an|the|some|of|my|me)\b/g, " ").replace(/\s+/g, " ").trim();
  if (!p) return null;
  if (ALIASES[p]) return ALIASES[p];
  const us = p.replace(/ /g, "_");
  if (reg.hasItem(us)) return us;
  const sing = us.split("_").map((w, i, a) => (i === a.length - 1 ? singular(w) : w)).join("_");
  if (reg.hasItem(sing)) return sing;
  if (ALIASES[sing.replace(/_/g, " ")]) return ALIASES[sing.replace(/_/g, " ")];
  // fuzzy: smallest edit distance, ties -> shorter name
  let best = null, bd = Infinity;
  for (const it of reg.mc.itemsArray) {
    const d = lev(sing, it.name);
    if (d < bd || (d === bd && best && it.name.length < best.length)) { best = it.name; bd = d; }
  }
  return bd <= Math.max(2, Math.floor(sing.length * 0.25)) ? best : null;
}

module.exports = { resolveItem, ALIASES, lev };
