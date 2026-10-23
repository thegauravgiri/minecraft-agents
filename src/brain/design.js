// The AI designs what the player asked for (any house, tower, farm, pen, bridge ...) as a structure spec; the pure
// compiler validates it and its errors are fed back for repair. Nothing about the shape is hard-coded.
const S = require("../core/structure");
const { planAcquire } = require("../core/acquire");
const { log } = require("../runtime/util");

const DSL = `Structure spec JSON:
{"name":"...","size":{"w":<x extent>,"d":<z extent>,"h":<y extent>},"palette":{"key":"real_block_name",...},"ops":[...]}
Coordinates are [x,y,z] relative to the build origin; x east, z south, y up. y=0 is the SURFACE layer (the existing ground block, which gets replaced); y>=1 is above ground. Max size 40x40x32, <= 6000 blocks. Later ops paint over earlier ones.
Ops (block = palette key or real block name; from/to inclusive):
 {"op":"box","from":[..],"to":[..],"block":"k"}      solid fill (floors, roofs, pillars)
 {"op":"hollow","from":[..],"to":[..],"block":"k"}   outer shell only
 {"op":"walls","from":[..],"to":[..],"block":"k"}    4 vertical faces only (no floor/ceiling)
 {"op":"line","from":[..],"to":[..],"block":"k"}
 {"op":"set","at":[..],"block":"k","facing":"north|south|east|west","half":"bottom|top"}  one block (slab, trapdoor, fence_gate, torch, ladder, bed...)
 {"op":"stairs","at":[..],"block":"oak_stairs","facing":"east"}   facing = direction the stair ASCENDS toward
 {"op":"door","at":[x,y,z],"block":"oak_door","facing":"south"}    at = lower half, facing = the OUTSIDE side; needs solid floor under it
 {"op":"clear","from":[..],"to":[..]}                 air (windows, doorways, stairwell holes)
 {"op":"till","from":[x,0,z],"to":[x,0,z]}            ground becomes farmland (needs hoe), y must be 0
 {"op":"plant","from":[..],"to":[..],"crop":"wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|sweet_berry_bush|nether_wart"}   crops go at y=1 on tilled y=0
 {"op":"water","at":[x,0,z]}                          water source in the ground (needs a water bucket); hydrates farmland within 4 blocks
Design rules: honour EVERY detail the player asked for (number of storeys, size, material, purpose). A multi-storey building needs real floors, a staircase (stairs ops + a "clear" hole in the upper floor), and walls for every storey. Always include a door (and windows) on buildings, a roof, and use the materials listed as AVAILABLE when reasonable. Farms: every crop must be within 4 blocks of a water cell, fence the farm and add a gate, leave the water cell free of crops. Animal pens: fence + gate, big enough (>= 6x6). Keep interiors walkable (>=2 high).
BE ECONOMICAL (survival only - in CREATIVE mode any block is free, use the right colours/materials): the bot gathers every block by hand. Use at most 3-4 block types, only cheap common blocks (planks, logs, cobblestone, stone, dirt, glass, fences, stairs/slabs of those), NO iron-based or rare decoration (lanterns, chains, cauldrons, hoppers, hay bales, dirt_path, carved pumpkins, banners). Default sizes: house 7x7 (two storeys -> height ~9-10), farm 9x9, pen 8x8; stay under ~350 blocks unless the player asks for big. Prefer the AVAILABLE materials.`;

const EXAMPLE = `Example (tiny two-storey house 7x7, 9 high):
{"name":"two storey house","size":{"w":7,"d":7,"h":9},"palette":{"floor":"spruce_planks","wall":"oak_planks","roof":"oak_planks","glass":"glass_pane","stair":"oak_stairs","door":"oak_door"},
"ops":[{"op":"box","from":[0,0,0],"to":[6,0,6],"block":"floor"},{"op":"walls","from":[0,1,0],"to":[6,7,6],"block":"wall"},
{"op":"box","from":[0,4,0],"to":[6,4,6],"block":"floor"},{"op":"stairs","at":[1,1,5],"block":"stair","facing":"east"},{"op":"stairs","at":[2,2,5],"block":"stair","facing":"east"},{"op":"stairs","at":[3,3,5],"block":"stair","facing":"east"},{"op":"stairs","at":[4,4,5],"block":"stair","facing":"east"},{"op":"clear","from":[1,4,5],"to":[4,4,5]},
{"op":"box","from":[0,8,0],"to":[6,8,6],"block":"roof"},{"op":"door","at":[3,1,0],"block":"door","facing":"north"},{"op":"set","at":[1,2,0],"block":"glass"},{"op":"set","at":[5,2,0],"block":"glass"},{"op":"set","at":[1,6,0],"block":"glass"},{"op":"set","at":[5,6,0],"block":"glass"}]}`;

function prompt({ request, world, inventory, errors, previous }) {
  return `You are an expert Minecraft builder. Design a structure for this request from the player: "${request}"
World/context: ${world}
AVAILABLE in the bot's inventory right now: ${inventory}
${DSL}
${EXAMPLE}
${errors ? `Your previous design was rejected by the validator:\n${errors.map((e) => "- " + e).join("\n")}\nPrevious design:\n${JSON.stringify(previous).slice(0, 3500)}\nFix every error and return the full corrected spec.` : ""}
Reply ONLY with the JSON spec.`;
}

async function designStructure({ brain, reg, request, world, inventory, extra = null, validate = null, skipCost = false }) {
  let errors = null, previous = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let spec;
    try { spec = await brain.json(prompt({ request, world: world + (extra ? "\n" + extra : ""), inventory, errors, previous }), { timeoutMs: 70000, level: "LOW", strong: true }); }
    catch (e) { log("design", `llm error (attempt ${attempt}): ${e.message}`); errors = [String(e.message)]; continue; }
    const r = S.compileStructure(spec, reg);
    if (r.ok && !skipCost) {
      // can every block actually be obtained, and is it affordable?
      const need = S.materialsFor(r.cells, {}).short;
      const impossible = [], pricey = [];
      let total = 0;
      for (const [item, n] of Object.entries(need)) {
        const p = planAcquire(reg, {}, { [item]: Math.min(n, 64) }, { allowHunt: true });
        if (!p.ok) impossible.push(item); else { total += p.cost * Math.max(1, n / 64); if (p.cost > 120) pricey.push(item); }
      }
      if (impossible.length) { r.ok = false; r.errors = [`these blocks cannot be obtained by the bot, remove or replace them: ${impossible.join(", ")}`]; }
      else if (total > 2500 && attempt < 3) { r.ok = false; r.errors = [`too expensive to gather (${Math.round(total)} effort). Make it smaller and use fewer block types; expensive: ${pricey.join(", ") || "many blocks"}`]; }
    }
    if (r.ok && validate) { const bad = validate(spec, r); if (bad?.length) { r.ok = false; r.errors = bad; } }
    if (r.ok) { log("design", `"${spec.name}" ${r.size.w}x${r.size.d}x${r.size.h}, ${r.cells.length} cells (attempt ${attempt})`); return { ok: true, spec, cells: r.cells.length }; }
    log("design", `attempt ${attempt} rejected: ${r.errors.slice(0, 3).join(" | ")}`);
    errors = r.errors.slice(0, 8); previous = spec;
  }
  return { ok: false, errors };
}

module.exports = { designStructure };
