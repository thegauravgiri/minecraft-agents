// Questions about the bot itself are answered locally and instantly from real state, never from the LLM.
const { observe } = require("../runtime/observe");

function describeActivity(agent) {
  const g = agent.goal;
  if (g) {
    switch (g.type) {
      case "have": return `getting ${Object.entries(g.items).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ")}${agent.running ? ` (${agent.running.action.label})` : ""}`;
      case "kill": return `hunting ${g.targets.join(", ")}`;
      case "give": return `fetching ${g.item.replace(/_/g, " ")} for ${g.player}`;
      case "come": return `coming to ${g.player}`;
      default: return g.type.replace(/_/g, " ");
    }
  }
  if (agent.baseGoal.type === "follow") return `following ${agent.baseGoal.player}`;
  return "idle";
}

function invSummary(inv, max = 10) {
  const e = Object.entries(inv).sort((a, b) => b[1] - a[1]).slice(0, max);
  return e.length ? e.map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`).join(", ") : "nothing";
}

function answerStatus(agent, text) {
  const l = text.toLowerCase();
  // only genuine questions about me; any command verb means this is a task, not a status query
  if (/\b(open|take|get|grab|give|put|store|drop|collect|craft|make|build|mine|kill|go|come|place|bring|fetch|cook|smelt|dig|find|pick|use|equip|eat|sleep|follow|stop|stay)\b/.test(l)) return null;
  if (!/(\?|^(what|how|where|show|tell|list|do you|are you|did you|have you|which)\b)/.test(l)) return null;
  const snap = observe(agent.bot);
  const p = snap.pos;
  if (/(what are you doing|what'?s up|status|what.*(doing|task|goal)|busy)/.test(l)) return `${describeActivity(agent)}. hp ${Math.round(snap.health)}, food ${Math.round(snap.food)}`;
  if (/(health|hp|hearts)/.test(l)) return `hp ${Math.round(snap.health)}/20, food ${Math.round(snap.food)}/20`;
  if (/(inventory|what do you have|items|carrying)/.test(l)) return `I have: ${invSummary(snap.inv)}`;
  if (/(where are you|coords|coordinates|position|location)/.test(l)) return `x${Math.round(p.x)} y${Math.round(p.y)} z${Math.round(p.z)} (${snap.dimension.replace("the_", "")})`;
  return null;
}

// Voyager-style observation: what is around me, what is below me, what the sky/light/biome are.
function surroundings(bot, radius = 9) {
  const p = bot.entity.position.floored();
  const counts = {};
  let solidBelow = false, voidBelow = true;
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -4; dy <= 5; dy++) {
    const b = bot.blockAt(p.offset(dx, dy, dz));
    if (!b || b.name === "air" || b.name === "cave_air") continue;
    counts[b.name] = (counts[b.name] || 0) + 1;
  }
  for (let y = 1; y <= 60; y++) { const b = bot.blockAt(p.offset(0, -y, 0)); if (b && b.boundingBox === "block") { voidBelow = false; solidBelow = y; break; } }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k.replace(/_/g, " ")} x${v}`).join(", ");
  const here = bot.blockAt(bot.entity.position);
  let skyOpen = true;
  for (let dy = 2; dy <= 40; dy++) { const b = bot.blockAt(p.offset(0, dy, 0)); if (b && b.boundingBox === "block" && !/leaves/.test(b.name)) { skyOpen = false; break; } }
  return { top, voidBelow, groundDepth: solidBelow, biome: here?.biome?.name || "?", light: here?.light ?? "?", skyLight: here?.skyLight ?? "?", skyOpen };
}

const describeSpaceSafe = (agent, m) => require("../runtime/spatial").describeSpace(agent, m);

function describeWorld(agent, snap) {
  const p = snap.pos;
  const near = (list, n = 6) => list.slice(0, n).map((e) => `${e.username || e.name}(${Math.round(e.dist)}m, dy ${Math.round(e.pos.y - p.y)})`).join(", ") || "none";
  const ground = snap.groundBlock, feet = snap.feetBlock;
  const bed = agent.mem.recall("bed");
  return [
    snap.gameMode === "creative" ? "GAME MODE: CREATIVE - you can fly, cannot be hurt, never get hungry, break blocks instantly (they drop NOTHING) and can take ANY item instantly from the creative inventory. Never gather, craft, smelt, hunt or cook for items - just use the typed goal have (or api.give). Walking/boats are unnecessary: you fly. For LARGE terrain work (flatten a mountain, clear/level an area, big builds) use ONE script with api.fill(x1,y1,z1,x2,y2,z2,'block') / api.setblock - never dig block by block. For LARGE terrain work (flatten a mountain, clear/level an area, big builds) use ONE script with api.fill(x1,y1,z1,x2,y2,z2,'block') / api.setblock - never dig block by block." : `game mode: ${snap.gameMode || "survival"}`,
    `pos x${Math.round(p.x)} y${Math.round(p.y)} z${Math.round(p.z)} in ${snap.dimension}; hp ${Math.round(snap.health)}/20 food ${Math.round(snap.food)}/20; standing on ${ground}${snap.inWater ? " (in water)" : ""}; holding ${snap.held || "nothing"}`,
    `inventory (${Object.keys(snap.inv).length}/36 slots used${Object.keys(snap.inv).length >= 33 ? " - NEARLY FULL: drop junk or use a chest" : ""}): ${invSummary(snap.inv, 24)}`,
    `armor: ${Object.entries(snap.armor).map(([k, v]) => `${k}=${v || "-"}`).join(" ")}`,
    (() => { const e = surroundings(agent.bot); return `environment: biome ${e.biome}, light ${e.light} (sky ${e.skyLight}), ${e.skyOpen ? "open sky" : "roofed/underground"}, ${e.voidBelow ? "NO ground below me (void/island edge)" : `ground ${e.groundDepth} below`}; blocks within 9: ${e.top || "none"}`; })(),
    `status: hunger ${snap.food <= 6 ? "STARVING" : snap.food <= 14 ? "hungry" : "fine"}, health ${snap.health <= 8 ? "LOW" : snap.health <= 14 ? "hurt" : "fine"}${snap.oxygen < 20 ? `, oxygen ${snap.oxygen}` : ""}${snap.inLava ? ", IN LAVA" : ""}${snap.hostiles.length ? `, ${snap.hostiles.length} hostiles near` : ""}`,
    `players nearby: ${near(snap.players)}; hostiles: ${near(snap.hostiles)}; dropped items nearby: ${snap.items.length}`,
    `chests within 24 blocks: ${(() => { try { const ids = ["chest", "trapped_chest", "barrel"].map((n) => agent.bot.registry.blocksByName[n]?.id).filter((x) => x != null); return agent.bot.findBlocks({ matching: ids, maxDistance: 24, count: 6 }).length; } catch { return 0; } })()}; dropped items nearby: ${snap.items.map((i) => i.item).filter(Boolean).slice(0, 8).join(", ") || "none"}`,
    (() => { try { const m = agent.master; return m && !agent.isAgent(m) ? `requester ${describeSpaceSafe(agent, m)}` : null; } catch { return null; } })(),
    (() => { try { const t = require("../runtime/team").readTeam(agent.bot.username); return `you are ${agent.bot.username}, role: ${agent.role || "player"}; teammates online: ${t.length ? t.map((m) => `${m.name} [${m.role}] ${m.activity || "idle"}`).join("; ") : "none"}`; } catch { return null; } })(),
    (() => { try { const { isRideable } = require("../skills/ride"); const me = agent.bot.entity.position; const near = Object.values(agent.bot.entities).filter((e) => e !== agent.bot.entity && isRideable(e) && e.position.distanceTo(me) < 40).slice(0, 4).map((e) => `${e.name}${e.name === "happy_ghast" ? ((e.equipment || [])[6] ? " (harnessed)" : " (no harness)") : ""} ${Math.round(e.position.distanceTo(me))}m`); return agent.bot.vehicle ? `riding a ${agent.bot.vehicle.name}${(agent.bot.vehicle.passengers || [])[0] === agent.bot.entity ? " as the driver" : " as a passenger"}` : near.length ? `rideable nearby: ${near.join(", ")}` : null; } catch { return null; } })(),
    `known landmarks (verified): ${agent.know?.summary(8) || "none"}`,
    `known bed: ${bed ? `x${bed.x} y${bed.y} z${bed.z}` : "none"}; current activity: ${describeActivity(agent)}`
  ].filter(Boolean).join("\n");
}

module.exports = { surroundings, describeWorld, answerStatus, describeActivity, invSummary };
