# Minecraft Agents — architecture

Version 2 of the agent: a layered rewrite of the original single-file bot.
Target: Minecraft Java 26.1.2 (mineflayer reports data version `26.1`), Node 24, mineflayer 4.39 + mineflayer-pathfinder 2.4.5.

## Layers

```
src/core/       PURE. No bot, no I/O, no Date.now() in logic. Unit-testable with plain objects.
  registry.js   minecraft-data wrapper (recipes, drop sources, tool tiers)
  acquire.js    tech-tree planner: (inventory, wants) -> ordered steps (gather/craft/smelt/hunt/place_station)
  planner.js    plan(reg, goal, snapshot, hints) -> {done|blocked|action, remaining, watch?}
  reflex.js     reflex(snapshot, ctx) -> most urgent survival action or null
  progress.js   assess(ledger) -> ok|stalled|looping  (progress = `remaining` must fall)
  memory.js     failure memory (banned cells, strikes)
src/runtime/
  agent.js      the control loop: observe -> reflex -> plan -> act -> VERIFY -> escalate
  observe.js    bot -> plain Snapshot (inv, entities, hostiles, players, items, health, dimension...)
  radar.js      where is player X (live entity, or `/data get entity` across distance/dimension)
  util.js       sleep/waitFor (abort-aware), ok()/fail(), log()
src/skills/     EFFECTFUL. async (ctx, args) => {ok, reason?, data?, progress?}
  move.js       goto(ctx, goal, opts) with stuck watchdog + breakFree; configureMovements
  blocks.js     digBlock, placeAt, collectDrops, scaffoldItem, equipFor, isProtected ...
  gather.js     mine(), explore()      craft.js  craft/smelt/placeStation
  combat.js     fight()                follow.js follow()/hunt()
  vertical.js   pillarUp/digDown/escapeHole    tactics.js approach/tower_to/dig_to/deliver/collect
  survival.js   eat/surface/escape_lava/extinguish
  index.js      skill registry  (name -> fn)
src/brain/      intent.js (chat -> goal, local parser), chat.js (router); LLM only for fuzzy intent + advice
```

## Key ideas (read before changing anything)

1. **Plan = f(real state).** The planner is pure and re-run every cycle. Nothing is "resumed";
   after an interruption the next plan simply starts from reality.
2. **Verification by measurement.** Each planner result carries `remaining` (plan cost, distance,
   missing blocks ...). After an action the agent re-plans and checks `remaining` fell. No progress
   N times => escalation ladder (retry -> avoid source -> relocate -> advisor -> give up with a reason).
3. **Skills never trust themselves.** A skill must verify its own effect in the world (block changed,
   inventory grew, entity reached) and return `fail(reason)` otherwise.
4. **Abort everywhere.** Every await in a skill goes through `sleep/waitFor(..., signal)` or checks
   `throwIfAborted(ctx.signal)`; reflexes and new goals pre-empt by aborting `ctx.signal`.
   Skills must leave the bot in a clean state in `finally` (control states are reset by the agent too).
5. **Reflexes** (eat, drowning, lava, fire, creeper, defend) are pure rules in `core/reflex.js`.

## Skill contract

```js
// ctx = { bot, reg, mem, agent, signal, beat() }   (call ctx.beat() inside long loops: watchdog heartbeat)
async function mySkill(ctx, args) { ...; return ok(data) /* or */ fail("reason_slug", data); }
```
Return `{ ok:true, data, progress:{delivered:2} }` — numeric `progress` entries are summed into `goal.progress`.
Throw nothing for expected failures; let AbortError propagate untouched.

## Test environment

A real vanilla **26.1.2 server** runs at `localhost:25599` (offline mode, started with `~/mc-testserver/run.sh`,
already running; do NOT restart/stop it). Console commands: `echo "<cmd>" >> ~/mc-testserver/cmd.fifo`
(helper: `consoleCmd()` in `test/e2e/harness.js`). Logs: `~/mc-testserver/logs/latest.log`.
Other agents may be testing on the same server at the same time: use your OWN bot username,
teleport to YOUR OWN area (given in your brief), never run server-wide destructive commands
(`kill @e[type=!player]` kills everyone's test mobs — use selectors with `distance=..N` or `tag`).
Existing e2e examples: `test/e2e/have.js`, `combat.js`, `hunt.js`, `dig.js`, `follow.js`.


## v2.1 additions (building, awareness, agentic loop)

- `core/structure.js` (pure): the **structure language** (box/hollow/walls/line/set/stairs/door/clear/till/plant/water) -> validated
  cells; `materialsFor`, `diffStructure`, `orderCells`. Farm sanity rules (every crop within 4 of water) live in the compiler.
- `brain/design.js`: the AI designs ANY structure for the request as a spec; compiler errors + "unobtainable block" and
  "too expensive" checks are fed back for repair (3 attempts). Nothing about the shape is hard-coded.
- `skills/structure.js`: generic builder - site search, bottom-up placement, doors/stairs facing, tilling, water, planting,
  stray-liquid removal, scaffold cleanup, final **diff of the real world against the spec** (success only at 0 missing).
  `skills/farming.js`: harvest + replant. Build goal = `{type:"build", request}`; planner `planStructure` designs once,
  gathers what is missing via the normal acquire planner, then builds + verifies.
- `brain/director.js`: the AI loop for anything without a typed goal: observe -> decide (MEDIUM reasoning) -> typed goal or script
  -> self-repair (3x) -> **critic** check before "done"; working scripts are saved to `skills/learned/` and reused.
- `brain/status.js#describeWorld`: Voyager-style observation (biome, block census, ground/void, light, hunger/health, inventory
  pressure). `core/planner.js#opportunistic`: tool/armor upgrades, food runs when hungry, torches in the dark.
- Safety nets: no-progress watchdog + `Agent.unstick()`, vertical dig-out (`ascend`/`digDown`), NaN-coordinate rejection,
  reflex cooldowns, every running action registered in `agent.active` so any goal can cancel it.
- Speed: mining digs everything in reach before moving, sweeps drops once per cluster, detects pickup from the inventory,
  caches pathfinder `Movements`; the pure planner is memoised.

Tests: `npm test` (unit), `npm run test:quick` (~2 min e2e on the scratch server), `test/e2e/structure.js "<build request>"`.
`test/live-*.js` are non-destructive checks against the real world on the port in MC_PORT.

### Creative mode (v2.2)
`skills/creative.js`: `giveItems` (creative inventory, instant), `flyTo` (abortable, cruises above terrain, stops at walls).
When `bot.game.gameMode === "creative"`: the planner answers every `have` with one `creative_give` action (no gather/craft/
smelt/hunt, no boat prerequisite), reflexes and survival upkeep are off, digging is instant (and drops nothing), `goto`
flies long distances, and the AI prompts state the rules (`api.give`, `api.fly`, `api.gameMode`).
Multi-agent: `MC_AGENT_NAMES`, `tell` goal (`@Name command`), `start-team.sh`.

## v2.3 — spatial awareness, co-op builds, grounded knowledge

- `runtime/spatial.js`: where a player stands/faces/looks (raycast), `waterScan` (nearest water, river vs lake, shortest crossing, water straight ahead),
  `resolveAnchor` ("here" / "facing" = right in front / "looking" = crosshair / explicit coords), `planBridgeRoute` + `bridgeSpec`, `originFromAnchor`.
  `build` goals carry `where`+`anchor` (pinned at chat time from the requester's real view); `bridge` goals find the water themselves.
  The interpreter prompt gets a live SPATIAL paragraph; scripts get `api.view()` / `api.water()`.
- Co-op: `runtime/shared.js` blackboard (`data/shared/builds.json`); the owner publishes spec+origin, a teammate's `assist` goal joins the SAME blueprint
  at the SAME place (helper builds from the far end). Leader order: tell first, then own build.
- Knowledge: `brain/knowledge.js` = structured landmarks with provenance (self/player/teammate), shared via `data/shared/landmarks.json`.
  Prompts list only these; goto/build coordinates the AI returns are rejected unless grounded (player's words, landmark, known position).
  Context (`data/<Name>/context.json`) is versioned, atomically written with a `.bak`, and only counts coordinates a human said.
- Models: fast (`GEMINI_MODEL`) for chat interpretation; strong (`GEMINI_STRONG_MODEL`, default `gemini-pro-latest`) for designs, director decisions,
  critic and script repair, with automatic fallback to the fast model. Scripts are statically checked (syntax, unknown `api.*`) before they run.
- Creative building: hover over each cell and place by hand (`creative.hoverAbove`), support-ordered layers; flights are time-boxed with stuck detection.

## v2.4 — autonomous players, team protocol, unattended operation

- `brain/autonomy.js`: when nothing is asked, an agent chooses its own work: needs (food, full bag) -> teamwork (join a teammate's build) ->
  survival milestones (wood tools -> stone tools -> food -> furnace -> iron tools/armor) -> strong-model curriculum for its ROLE (leader, scout, miner,
  builder, lumberjack, hunter, smith; unknown names get a stable role by hash). Autonomous goals are `auto` (quiet, time-boxed, failures remembered in
  `data/<Name>/journal.json` and not repeated for a while). Any human command pre-empts; `stop` pauses autonomy 5 min.
- `runtime/team.js`: agents never act on each other's chat. Status = one file per agent (`data/shared/agents/`), messages = one file each in
  `data/shared/inbox/<name>/` with a type (`command` is interpreted like a human request and answered with a `report`; `report` is recorded, never answered).
  The `tell` skill still prints a line in chat so humans can follow along.
- Unattended: `start-team.sh` runs each agent under `supervise.sh` (relaunch on crash/OOM, back-off), `stop-team.sh` stops all; heap watchdog restarts cleanly
  at 1.4 GB; pathfinder search radius capped (an unreachable goal once ate 2 GB); stations are only trusted within reach; crafting has deadlines.
- Builder fix: everything in the way (grass/dirt/old blocks) is cleared BEFORE placing our own blocks (previously our walls hid the cells to dig:
  "blocked_by:oak_planks" x750 in a log). A repeated build request resumes the unfinished build instead of redesigning.

## v2.5 — places, worlds, shared skills

- Places: "mark this spot / this is where the village goes / build it here" writes the speaker's exact x y z (asked from the server via radar if the agent is far away)
  into knowledge as `<thing> site`; a project's centre is logged too; "where is the village?" is answered from that record. Prompts only contain recorded places.
- Worlds: `runtime/world.js` fingerprints the world by the login packet's hashed seed. A different (or unknown) world wipes this agent's context/knowledge/journal
  and the shared board (projects, requests, builds, landmarks, inbox); the skill library is kept.
- Skills: `brain/learned.js` = shared library with params (`api.args`), version, track record, history. Only the relevant skills are offered; a skill that fails is
  repaired by the director and the working fix is saved as the next version for everybody; skills that keep failing are hidden until someone repairs them.

## v2.6 — survival: fighting together, night, death spirals

- Reflex (`core/reflex.js`, pure + tested): outnumbered (>=3 hostiles) -> wall in only if they are not already on top of us, else fight; critical at 8 hp; a mob on a
  teammate is fought beside them; starving at low hp eats rotten flesh as a last resort. Creepers are outrun, not meleed; fast mobs (spiders, zombies) are fought, not fled from.
- Team call-outs: a fight sends an `alert` (position, mobs, hp) to every teammate within 90 blocks + one chat line; those with >=10 hp walk over and fight (`respondToAlert`).
- Night (`observe.dayTime` from the overworld clock): with a bed -> sleep; without a bed and without a sword -> `hideout` goal = `burrow` skill (3-deep pit, capped, wait for daylight, climb out).
- Death spiral guard: no gear recovery after 2 deaths in 10 min or at night (retried by daylight); respawn without gear no longer walks into the same mobs.
- Efficiency: animal/tree sightings are shared landmarks (hunt/mine go to a known site first), any wood type counts, food milestone only when hungry,
  shield + bed milestones, wood sword in the first kit.

## v2.7 — protect villages, repair/renovate, one place per job, talking, orders
- Never a quarry: `blocks.looksBuilt` (planks/bricks/cobble/glass/doors/... and logs without leaves around them) are not mining candidates; a build site with >3 blocks of somebody's
  building on it is refused (or slid away from). Project jobs remember the origin they chose (`task.origin` -> `anchor.fixed`): every batch/retry/after a death builds in the SAME place.
- Repair / renovate: `build` goals with `mode: repair|renovate` (where = the building looked at / stood in). `runtime/survey.js` finds the building (cluster of player-made blocks), prints it layer by layer
  with likely-damage cells; the designer returns the intact-plus-fixed spec (validated: size exact, repair keeps >92% of existing blocks and fills the damage); the builder places only what is missing
  (repair never touches what stands). Creative hover picks a spot with open sky above, outside walls.
- Orders: "everyone come/gather/follow/go to x y z" = `quickOrder` (no planner): the elected leader broadcasts an `order`, everybody does it; "come" means stand by (autonomy paused 4 min).
- Night: no job/errand without bed or real gear after dusk (put down, resumed in the morning); no jobs without a weapon.
- Conversation: `brain/banter.js` - every few minutes an agent checks on a teammate, offers help to a hurt one, comments on what it finished, or (the leader) proposes the next team project
  (`TeamProjects.proposeProject`); replies are one or two short lines, never loops. Humans' orders always come first.

## v2.8 — riding (happy ghast, boats, minecarts, horses)
- `skills/ride.js`: `mount` (picks the mount by name / nearest / "the one <player> sits on"; a happy ghast gets its harness first), `dismount` (lands a ghast before getting off, steps off its back),
  `drive` (fly the happy ghast I drive: it is client-authoritative like a boat - we send `vehicle_move` + `player_input`, never with shift held, cruise above terrain, descend onto the target, optional land).
  Goals `mount` / `dismount` / `drive`; the planner fetches a harness when the nearest ghast has none. While riding, on-foot reflexes are off.
- mineflayer only appends to a vehicle's passenger list, so after getting off a ghast that still carried someone `bot.vehicle` stayed set; `index.js` now keeps the server's list authoritative.

## v2.9 — chests, night, village renovation
- Chests: "put your items in the chest here" uses the chest next to the speaker (`where: here|looking`); the bot says exactly what moved (or that it only has its gear / nothing).
- Night: without a bed within 48 blocks nobody stays out - errands are put down and the agent digs in (`hideout`) until daylight, gear or not; with a bed it sleeps.
  At night reflexes fight only what is on top of us; creepers are kept at 8 blocks.
- Village renovation (`brain/village.js`): "renovate/repair the village" -> survey every building (clusters of player-made blocks) for damage, ground gaps (small patches
  below the village's common ground level), and dirt paths from the centre to every door; the jobs go on the project board (repair jobs use the survey/repair designer,
  fill and path jobs carry a ready spec with a fixed origin). New DSL op `path` (grass/dirt + shovel = dirt_path).

## v2.10 — repair / fix-up that actually works
- `brain/fixup.js` (no AI): repair = survey holes in the building SHELL (outer walls/roof/floor; inside only gaps in a floor), fill each with the neighbours' material; junk patches
  (dirt/gravel/cobble in a plank wall) are swapped; a 1x2 gap at floor level in an outer wall gets a door; junk inside, on the roof and piled around above ground level is cleared;
  ground pits (small patches below the common ground level) are filled. One spec with a fixed origin, built in `mode: fix` (wrong cells are replaced).
- Goals: `build` with `mode: repair` -> deterministic repair; `fixup` {repair, clean, fill} for "fill the holes", "clean up the dirt", "tidy up around the house".
  Village renovation uses the same per-building repair specs.
- Builder: `ensureClearShot` walks (door-aware) to a spot that can see a block before digging it; for fix jobs, junk the walls hide from every reachable spot is
  still removed without touching the wall. Creative: air/junk cells are hovered to and broken; never place into the cell we are standing in; doors hang from a spot outside.

## v2.11 — build where told
- Exact coordinates (`anchor.mode === "coords"`): no sliding to a "nicer" spot; plain blocks on the spot (often our own earlier attempt) are built over, only somebody's home
  (doors/beds/chests) stops it - with a clear message; a failed player order makes the agent wait for the player instead of wandering off to its own errands.
- Team requests: coordinates in the message are the project centre (`project.exact`); ONE object (statue, house, tower...) is ONE job at that spot - never split into
  separately placed parts; teammates help through `assist`.

## v2.11 — build where told
- Exact coordinates (`anchor.mode === "coords"`): no sliding to a "nicer" spot; plain blocks on the spot (often our own earlier attempt) are built over, only somebody's home
  (doors/beds/chests) stops it - with a clear message; a failed player order makes the agent wait for the player instead of wandering off to its own errands.
- Team requests: coordinates in the message are the project centre (`project.exact`); ONE object (statue, house, tower...) is ONE job at that spot - never split into
  separately placed parts; teammates help through `assist`.
- "clear task" (to anyone) ends ALL team work: active projects are cancelled, a teammate in the middle of a cancelled project's job drops it at once, nothing older
  than the last reset is revived after a restart, and the leader never re-proposes a cancelled/finished project (and waits 20 min after a reset before proposing anything).

### v2.12 - creative flags, night help calls
- `design_structure` passes `skipCost` in creative: any block (coloured wool...) is allowed, nothing is rejected as "cannot be obtained".
- `originFromAnchor`: a spot the player pointed at ("here", "facing", "in front") is treated like exact coordinates. Leftover plain blocks (e.g. an unfinished earlier flag) are built over; only homes (doors/beds/chests) stop the build.
- Creative hover: never "already there" while standing in the cell, and only within 4.0 blocks of reach. Floating cells get a temporary support that is removed afterwards.
- Autonomy `watch()`: the dusk rule never cancels an `ally:` goal (answering a teammate's call for help). An errand dropped at dusk is blocked for 8 min, so it doesn't loop pick -> drop.

### v2.13 - jobs survive help calls; any agent can lead
- `respondToAlert`: the current goal and queue (player orders, not idle autonomy errands) are put back after the `goto` + `kill` help goals, with the same `sid`, so a build resumes at its place.
- `chat.continueBuild`: "continue your task" / "what about the cooking house" / "Wren, finish it with Vesper" resumes the owner's unfinished build (`shared.buildOf`) at its fixed origin. Other named agents get `assist` on it. It runs before the group/project route.
- `electCoordinator(agent, named, message)`: the agent named FIRST leads. If nobody is named, a hash of the message picks one from the online team (no fixed Vesper preference). If the elected leader makes no plan within about 30-40 s, a waiting agent takes the lead.
- `broadcastOrder` / `runOrder`: an order to follow/come to an agent is not sent to that agent itself.
- Tests: `test/e2e/helpresume.js`. They clean up their forceload areas: piled-up forceloads crashed the scratch server.

### v2.14 - following ends
- `setGoal`: new work from a player or a team order (not auto, not a director sub-step) clears a standing `follow`. After the job the bot doesn't go back to trailing the player.
- `autonomy.free`: a standing `follow` expires after 15 min with no word from any player. The bot says so and goes back to its own work.
- Director: `follow`/`come` steps are refused unless the task text asks for it ("follow", "come with me"...). Its own errands (`quiet`) are capped at 25 steps instead of 80.
- `runOrder` cancels a running director errand.
- Test: `test/e2e/followends.js`.

### v2.15 - any AI provider
- `src/brain/providers.js`: `resolveConfig(env)` + `createProvider(cfg)`, so every provider exposes `generate({model, prompt, timeoutMs, level}) -> text`.
  - Gemini and Anthropic use their official SDKs.
  - Everything OpenAI-compatible (OpenAI, OpenRouter, Groq, DeepSeek, xAI, Mistral, Together, Ollama, LM Studio, custom) uses plain fetch to `/chat/completions`. It falls back to plain JSON when a server rejects `response_format`.
- Config: `AI_PROVIDER` (or auto-detect from the first `*_API_KEY` found), `AI_MODEL`, `AI_STRONG_MODEL` (`none` = fast only), `AI_BASE_URL`, `AI_API_KEY`. `GEMINI_MODEL` / `GEMINI_STRONG_MODEL` still work.
- `Brain` keeps the shared retry, per-model quota breaker and strong-to-fast fallback for every provider. `parseJson` pulls the first JSON object out of prose or code fences.
- Anthropic: no `temperature` (rejected on current models). `effort` comes from `level`. Refusals throw. Server-side refusal fallbacks (`fallbacks: "default"`) are used on models that support them.

### v2.17 - character mode
- `src/brain/persona.js`: `personaLine(name)` is added to the chat and banter prompts. An agent named after a famous character speaks in that character's style (short, funny, family-friendly). Other names stay plain and friendly. `CHARACTER_MODE=off` disables it.
