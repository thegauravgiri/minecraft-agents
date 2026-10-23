// AI providers: one tiny interface, generate({ model, prompt, timeoutMs, level }) -> text, so the rest of the code never cares who answers.
//   gemini      Google Gemini (official @google/genai SDK)
//   anthropic   Anthropic Claude (official @anthropic-ai/sdk)
//   openai, openrouter, groq, deepseek, xai, mistral, together, ollama, lmstudio, custom
//               everything that speaks the OpenAI chat-completions API (plain fetch, no extra dependency)
// Pick one with AI_PROVIDER, or just put a provider's API key in .env and it is detected.
const { log } = require("../runtime/util");

// fast = chat, quick decisions (many calls); strong = designs, scripts, critique (few calls, needs to be good)
const PROVIDERS = {
  gemini:     { kind: "gemini",    keyEnv: "GEMINI_API_KEY",     fast: "gemini-flash-latest", strong: "gemini-pro-latest" },
  anthropic:  { kind: "anthropic", keyEnv: "ANTHROPIC_API_KEY",  fast: "claude-haiku-5-5",    strong: "claude-opus-5-5" },
  openai:     { kind: "openai", keyEnv: "OPENAI_API_KEY",     baseURL: "https://api.openai.com/v1",        fast: "gpt-6-luna",          strong: "gpt-6-astra" },
  openrouter: { kind: "openai", keyEnv: "OPENROUTER_API_KEY", baseURL: "https://openrouter.ai/api/v1",     fast: "openrouter/auto",     strong: "openrouter/auto" },
  groq:       { kind: "openai", keyEnv: "GROQ_API_KEY",       baseURL: "https://api.groq.com/openai/v1",   fast: "openai/gpt-oss-20b",  strong: "openai/gpt-oss-120b" },
  deepseek:   { kind: "openai", keyEnv: "DEEPSEEK_API_KEY",   baseURL: "https://api.deepseek.com/v1",      fast: "deepseek-chat",       strong: "deepseek-reasoner" },
  xai:        { kind: "openai", keyEnv: "XAI_API_KEY",        baseURL: "https://api.x.ai/v1",              fast: "grok-4.3",            strong: "grok-4.7" },
  mistral:    { kind: "openai", keyEnv: "MISTRAL_API_KEY",    baseURL: "https://api.mistral.ai/v1",        fast: "mistral-small-latest", strong: "mistral-large-latest" },
  together:   { kind: "openai", keyEnv: "TOGETHER_API_KEY",   baseURL: "https://api.together.xyz/v1",      fast: "openai/gpt-oss-20b",  strong: "openai/gpt-oss-120b" },
  ollama:     { kind: "openai", keyEnv: null, local: true,    baseURL: "http://localhost:11434/v1" },
  lmstudio:   { kind: "openai", keyEnv: null, local: true,    baseURL: "http://localhost:1234/v1" },
  custom:     { kind: "openai", keyEnv: null, local: true }
};

/** Which provider, key, models and URL - from .env. Returns { name, kind, apiKey, model, strongModel, baseURL } or { error }. */
function resolveConfig(env = process.env) {
  let name = (env.AI_PROVIDER || "").trim().toLowerCase();
  if (!name) name = Object.keys(PROVIDERS).find((n) => PROVIDERS[n].keyEnv && env[PROVIDERS[n].keyEnv]) || (env.AI_BASE_URL ? "custom" : "");
  if (!name) return { error: "no AI provider configured (set AI_PROVIDER, or put a provider API key such as GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY in .env)" };
  const p = PROVIDERS[name];
  if (!p) return { error: `unknown AI_PROVIDER "${name}" - use one of: ${Object.keys(PROVIDERS).join(", ")}` };
  const apiKey = env.AI_API_KEY || (p.keyEnv && env[p.keyEnv]) || "";
  const legacy = name === "gemini" ? { model: env.GEMINI_MODEL, strong: env.GEMINI_STRONG_MODEL } : {};       // older .env files
  const model = env.AI_MODEL || legacy.model || p.fast;
  const strongRaw = env.AI_STRONG_MODEL ?? legacy.strong;
  const strongModel = strongRaw === "" || strongRaw === "none" ? null : (strongRaw || p.strong || null);
  const baseURL = (env.AI_BASE_URL || p.baseURL || "").replace(/\/+$/, "");
  if (!p.local && !apiKey) return { error: `AI_PROVIDER=${name} needs an API key (AI_API_KEY or ${p.keyEnv})` };
  if (p.kind === "openai" && !baseURL) return { error: `AI_PROVIDER=${name} needs AI_BASE_URL (the OpenAI-compatible endpoint, e.g. http://localhost:8000/v1)` };
  if (!model) return { error: `AI_PROVIDER=${name} needs AI_MODEL (the model name your server serves, e.g. AI_MODEL=qwen3)` };
  return { name, kind: p.kind, apiKey, model, strongModel: strongModel === model ? null : strongModel, baseURL };
}

const withTimeout = (p, ms, ctl) => Promise.race([p, new Promise((_, rej) => setTimeout(() => { ctl?.abort(); rej(new Error("llm_timeout")); }, ms))]);

function geminiProvider(cfg) {
  const { GoogleGenAI } = require("@google/genai");
  const client = new GoogleGenAI({ apiKey: cfg.apiKey });
  const thinkingOk = {};
  const call = (model, prompt, level, thinking, ms) => withTimeout(client.models.generateContent({ model, contents: prompt, config: { responseMimeType: "application/json", temperature: 0.1, ...(thinking ? { thinkingConfig: { thinkingLevel: level } } : {}) } }), ms);
  return {
    async generate({ model, prompt, timeoutMs, level }) {
      let res;
      try { res = await call(model, prompt, level, thinkingOk[model] !== false, timeoutMs); thinkingOk[model] ??= true; }
      catch (e) {
        if (/timeout/.test(e.message) || thinkingOk[model] === false) throw e;
        thinkingOk[model] = false; res = await call(model, prompt, level, false, timeoutMs);     // model rejects thinkingConfig: remember and retry plain
      }
      return res.text || "";
    }
  };
}

function anthropicProvider(cfg) {
  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: cfg.apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}), maxRetries: 0 });     // retries are done by the Brain (shared by every provider)
  const FALLBACKS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;                    // models that support server-side refusal fallbacks
  const EFFORT = { LOW: "low", MEDIUM: "medium", HIGH: "high" };
  return {
    async generate({ model, prompt, timeoutMs, level }) {
      const params = {
        model, max_tokens: 16000,
        system: "You are the decision-making brain of a Minecraft agent. Reply with exactly one JSON object and nothing else - no prose, no code fences.",
        output_config: { effort: EFFORT[level] || "low" },
        messages: [{ role: "user", content: prompt }]
      };
      const useFallback = FALLBACKS.test(model) && !cfg.baseURL;
      const res = useFallback
        ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, { timeout: timeoutMs })
        : await client.messages.create(params, { timeout: timeoutMs });
      if (res.stop_reason === "refusal") throw new Error(`refusal${res.stop_details?.category ? " (" + res.stop_details.category + ")" : ""}`);
      return res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    }
  };
}

function openaiProvider(cfg) {
  const noJsonMode = new Set();                       // servers/models that reject response_format: asked again without it
  return {
    async generate({ model, prompt, timeoutMs }) {
      const send = async (jsonMode) => {
        const ctl = new AbortController();
        const body = { model, messages: [{ role: "system", content: "Reply with exactly one JSON object and nothing else." }, { role: "user", content: prompt }], ...(jsonMode ? { response_format: { type: "json_object" } } : {}) };
        const res = await withTimeout(fetch(`${cfg.baseURL}/chat/completions`, {
          method: "POST", signal: ctl.signal,
          headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}), ...(cfg.name === "openrouter" ? { "x-title": "Minecraft Agents" } : {}) },
          body: JSON.stringify(body)
        }), timeoutMs, ctl);
        const text = await res.text();
        if (!res.ok) { const e = new Error(`${res.status} ${text.slice(0, 300)}`); e.status = res.status; throw e; }
        const j = JSON.parse(text);
        return j.choices?.[0]?.message?.content || "";
      };
      if (noJsonMode.has(model)) return send(false);
      try { return await send(true); }
      catch (e) {
        if (e.status === 400 && /response_format|json_object|json mode/i.test(e.message)) { noJsonMode.add(model); log("llm", `${model}: no JSON mode on this server - asking for plain JSON`); return send(false); }
        throw e;
      }
    }
  };
}

function createProvider(cfg) {
  if (cfg.kind === "gemini") return geminiProvider(cfg);
  if (cfg.kind === "anthropic") return anthropicProvider(cfg);
  return openaiProvider(cfg);
}

/** The first JSON object in a model's answer (models sometimes wrap it in prose or code fences). */
function parseJson(text) {
  const t = String(text || "").trim().replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(t); } catch { /* look for the object inside */ }
  const start = t.indexOf("{");
  if (start < 0) throw new Error("no JSON in the answer");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false; continue; }
    if (c === "\"") inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(t.slice(start, i + 1));
  }
  throw new Error("unterminated JSON in the answer");
}

module.exports = { PROVIDERS, resolveConfig, createProvider, parseJson };
