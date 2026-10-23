# Contributing to Minecraft Agents

Thanks for wanting to help! Bug reports, ideas, new skills and pull requests are all welcome.

## Getting started

```bash
git clone https://github.com/thegauravgiri/minecraft-agents.git
cd minecraft-agents && npm install && cp .env.example .env
npm test
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) first. The short version:

- `src/core` is **pure** (no bot, no I/O). Planner and structure changes belong there and get a unit test in `test/`.
- `src/skills` holds effectful actions: `async (ctx, args) => ({ ok, reason?, data? })`. Register new ones in `src/skills/index.js`.
- `src/brain` covers language, the LLM, teamwork and autonomy.

## Testing against a real game

End-to-end scenarios in `test/e2e/` drive agents on a local **test server**, never on your own world:

1. Run a vanilla server in `~/mc-testserver`, or set `MC_TEST_SERVER_DIR`. Set it to offline mode, port 25599 (or `MC_TEST_PORT`), and pipe a `cmd.fifo` into its console.
2. Run `node test/e2e/<scenario>.js`. Each scenario prints `PASS` or `FAIL`.

## Pull requests

- Keep each PR to one change, and say what it fixes and how you tested it.
- Match the surrounding style: small functions, comments that explain *why*.
- Don't commit `.env`, `data/` or logs. They hold API keys, chat and world coordinates.

## Reporting bugs

Open an issue with:
- what you said to the agent;
- what it did, and what you expected;
- the relevant lines of `data-log-<Name>.txt`, with player names and coordinates removed if you prefer.
