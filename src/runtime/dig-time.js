// mineflayer's per-version tool-speed data is wrong for some blocks (obsidian + diamond pickaxe comes out as 375 s
// instead of 9.4 s), so it waits far too long. This is the real Minecraft formula, installed over bot.digTime.
const TOOL_SPEED = { wooden: 2, stone: 4, copper: 5, iron: 6, diamond: 8, netherite: 9, golden: 12 };

function correctDigTimeMs(bot, reg, block) {
  if (bot.game?.gameMode === "creative") return 0;                   // creative: instant, and no drops
  const hardness = block.hardness;
  if (hardness == null || hardness < 0) return null;
  const held = bot.heldItem;
  const category = reg.toolCategoryForBlock(block.name);
  let speed = 1, canHarvest = true;
  const heldCategory = held ? reg.toolCategory(held.name) : null;
  if (block.harvestTools && Object.keys(block.harvestTools).length) canHarvest = !!(held && block.harvestTools[held.type]);
  if (held) {
    if (heldCategory && heldCategory === category) speed = TOOL_SPEED[held.name.split("_")[0]] || 1;
    else if (held.name === "shears" && /(wool|leaves|cobweb|vine)/.test(block.name)) speed = /(cobweb|leaves)/.test(block.name) ? 15 : 5;
    else if (heldCategory === "sword" && /(cobweb|bamboo)/.test(block.name)) speed = 15;
    if (speed > 1) { const eff = (held.enchants || []).find((e) => e.name === "efficiency"); if (eff) speed += eff.lvl * eff.lvl + 1; }
  }
  for (const [id, e] of Object.entries(bot.entity.effects || {})) {
    const n = bot.registry.effects?.[id]?.name;
    if (n === "haste") speed *= 1 + 0.2 * ((e.amplifier ?? 0) + 1);
    else if (n === "mining_fatigue") speed *= Math.pow(0.3, Math.min((e.amplifier ?? 0) + 1, 4));
  }
  const eye = bot.blockAt(bot.entity.position.offset(0, 1.62, 0));
  const helmet = bot.inventory.slots[5];
  const aqua = (helmet?.enchants || []).some((e) => e.name === "aqua_affinity");
  if (eye?.name === "water" && !aqua) speed /= 5;
  if (!bot.entity.onGround) speed /= 5;
  const damage = speed / hardness / (canHarvest ? 30 : 100);
  if (damage >= 1) return 0;
  return Math.ceil(1 / damage) * 50;
}

function installDigTime(bot, reg) {
  const original = bot.digTime;
  bot.digTime = (block) => {
    try { const t = correctDigTimeMs(bot, reg, block); if (t != null) return t; } catch { /* fall back to mineflayer */ }
    return original(block);
  };
}

module.exports = { installDigTime, correctDigTimeMs };
