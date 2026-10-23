// Pure, read-only view over minecraft-data: recipes, drop sources, tool tiers.
// Nothing in here touches the bot or the world.
const minecraftData = require("minecraft-data");

const TIERS = { wooden: 1, golden: 1, stone: 2, copper: 2, iron: 3, diamond: 4, netherite: 5 };
const TOOL_CATEGORIES = ["pickaxe", "axe", "shovel", "hoe", "sword"];

// Furnace recipes are not part of minecraft-data.
const SMELTING = {
  raw_iron: "iron_ingot", raw_copper: "copper_ingot", raw_gold: "gold_ingot",
  beef: "cooked_beef", porkchop: "cooked_porkchop", chicken: "cooked_chicken",
  mutton: "cooked_mutton", rabbit: "cooked_rabbit", cod: "cooked_cod", salmon: "cooked_salmon", potato: "baked_potato", cobblestone: "stone", sand: "glass",
  clay_ball: "brick", oak_log: "charcoal", birch_log: "charcoal", spruce_log: "charcoal",
  stone: "smooth_stone", iron_ore: "iron_ingot", gold_ore: "gold_ingot", kelp: "dried_kelp"
};
const FUEL_ITEMS = ["coal", "charcoal"]; // preferred, any *_planks / *_log also burns

const BEDS = (names) => names.filter((n) => n.endsWith("_bed"));

function makeRegistry(version) {
  const mc = minecraftData(version);
  const itemName = (id) => mc.items[id]?.name;

  // ---- recipes, normalised to {result, ingredients:{name:count}, needsTable} ----
  const recipes = {};
  for (const [resultId, list] of Object.entries(mc.recipes)) {
    const name = itemName(+resultId);
    if (!name) continue;
    recipes[name] = list.map((r) => {
      const ingredients = {};
      const add = (id) => {
        if (id == null || id < 0) return;
        const n = itemName(id);
        if (n) ingredients[n] = (ingredients[n] || 0) + 1;
      };
      let w = 0, h = 0;
      if (r.inShape) {
        h = r.inShape.length;
        w = Math.max(...r.inShape.map((row) => row.length));
        r.inShape.flat().forEach(add);
      } else if (r.ingredients) {
        r.ingredients.forEach(add);
        w = h = r.ingredients.length > 4 ? 3 : 2;
      }
      return { result: { name, count: r.result.count || 1 }, ingredients, needsTable: w > 2 || h > 2, raw: r };
    });
  }

  // ---- drop sources: item -> [{block, perBlock}] ----
  const blockSources = {};
  const weak = {}; // low-probability drops kept only as a last resort (e.g. sticks from leaves)
  for (const loot of mc.blockLootArray || []) {
    const blk = mc.blocksByName[loot.block];
    if (!blk || blk.diggable === false || /^(tripwire|cobweb|spawner|trial_spawner|vault|bedrock|barrier|light|structure|ender_chest|chest|trapped_chest|barrel|shulker_box|.*_shulker_box|bookshelf|crafting_table|furnace|blast_furnace|smoker|beacon|enchanting_table|anvil|respawn_anchor)$/.test(loot.block)) continue;
    for (const d of loot.drops) {
      if (d.silkTouch) continue;
      // ore tables list a silk-touch twin; the non-silk-touch branch is deterministic
      const chance = d.noSilkTouch && loot.drops.some((x) => x.silkTouch) ? 1 : (d.dropChance ?? 1);
      const per = (d.stackSizeRange ? d.stackSizeRange[0] : 1) * chance;
      // Player-made blocks that drop themselves are crafted, never "gathered".
      if (d.item === loot.block && recipes[d.item]?.length && !/_log$|_stem$|ore$/.test(d.item)) continue;
      (chance >= 0.25 ? blockSources : weak)[d.item] ||= [];
      (chance >= 0.25 ? blockSources : weak)[d.item].push({ block: loot.block, perBlock: Math.max(per, 0.01) });
    }
  }
  for (const k of Object.keys(weak)) if (!blockSources[k] && !recipes[k]?.length) blockSources[k] = weak[k];
  for (const k of Object.keys(blockSources)) blockSources[k].sort((a, b) => b.perBlock - a.perBlock);

  const mobSources = {};
  const HUNTABLE = new Set(["cow", "pig", "sheep", "chicken", "rabbit", "cod", "salmon", "squid", "spider", "skeleton",
    "zombie", "creeper", "enderman", "blaze", "slime", "ghast", "witch", "mooshroom", "goat", "llama"]);
  for (const loot of mc.entityLootArray || []) {
    if (!HUNTABLE.has(loot.entity)) continue;
    for (const d of loot.drops || []) {
      const per = d.stackSizeRange ? Math.max(d.stackSizeRange[0], 1) : 1;
      (mobSources[d.item] ||= []).push({ mob: loot.entity, perKill: per * (d.dropChance ?? 1) });
    }
  }

  // not in the loot tables as plain drops
  (mobSources.white_wool ||= []).unshift({ mob: "sheep", perKill: 1 });

  const harvestToolsOf = (blockName) => {
    const b = mc.blocksByName[blockName];
    if (!b || !b.harvestTools) return null; // null = no requirement
    return Object.keys(b.harvestTools).map((id) => itemName(+id)).filter(Boolean);
  };

  const tierOf = (name) => {
    const p = String(name).split("_")[0];
    return TIERS[p] || 0;
  };
  const toolCategory = (name) => TOOL_CATEGORIES.find((c) => String(name).endsWith("_" + c)) || null;

  // Best tool category for speed on a given block (derived from block material).
  const toolCategoryForBlock = (blockName) => {
    const b = mc.blocksByName[blockName];
    if (!b) return null;
    const m = String(b.material || "");
    if (m.includes("pickaxe")) return "pickaxe";
    if (m.includes("axe")) return "axe";
    if (m.includes("shovel")) return "shovel";
    if (m.includes("hoe")) return "hoe";
    const n = blockName;
    if (/(log|wood|planks|stem|hyphae|chest|crafting_table|bookshelf|door|fence|sign)/.test(n)) return "axe";
    if (/(dirt|sand|gravel|clay|grass_block|soul|snow|mud|podzol|mycelium|farmland)/.test(n)) return "shovel";
    if (/(stone|ore|deepslate|cobble|brick|furnace|obsidian|netherrack|basalt|concrete|terracotta)/.test(n)) return "pickaxe";
    return null;
  };

  // Higher = rarer / more expensive to reach; used to break ties between equivalent sources.
  const rarity = (block) => {
    let r = 0;
    if (/deepslate/.test(block)) r += 3;
    if (/^(cherry|mangrove|pale_oak|crimson|warped|azalea|flowering)/.test(block)) r += 4;
    if (/_leaves$/.test(block)) r += 8;
    if (/^(nether|soul|end_|crimson|warped|basalt|blackstone)/.test(block)) r += 5;
    if (/^(gilded|infested|suspicious|budding|waxed|exposed|weathered|oxidized)/.test(block)) r += 9;
    return r;
  };
  const WOODS = ["oak", "birch", "spruce", "jungle", "acacia", "dark_oak"];
  const woodRank = (name) => { const i = WOODS.findIndex((w) => String(name).startsWith(w + "_")); return i < 0 ? 9 : i; };
  for (const list of Object.values(recipes)) {
    list.sort((a, b) => Math.min(...Object.keys(a.ingredients).map(woodRank), 9) - Math.min(...Object.keys(b.ingredients).map(woodRank), 9));
  }
  const isFood = (name) => !!mc.foodsByName[name];
  const food = (name) => mc.foodsByName[name];

  const names = {
    logs: mc.itemsArray.filter((i) => /_log$/.test(i.name) && !/stripped/.test(i.name)).map((i) => i.name),
    planks: mc.itemsArray.filter((i) => /_planks$/.test(i.name)).map((i) => i.name),
    beds: BEDS(mc.itemsArray.map((i) => i.name)),
    boats: mc.itemsArray.filter((i) => /_boat$|_raft$/.test(i.name)).map((i) => i.name)
  };

  return {
    mc, version, recipes, blockSources, mobSources, harvestToolsOf, tierOf, toolCategory,
    toolCategoryForBlock, rarity, woodRank, isFood, food, names, SMELTING, FUEL_ITEMS,
    hasItem: (n) => !!mc.itemsByName[n],
    hasBlock: (n) => !!mc.blocksByName[n]
  };
}

module.exports = { makeRegistry, TIERS, TOOL_CATEGORIES, SMELTING };
