# AgentOrbit — the AI-agent coin galaxy

The live pump.fun AI-agent sector as an animated galaxy: every agent coin is a glowing orb — size is market cap, glow is momentum against all-time high, pulse is reply activity, and launches under 24 h spawn in with a dashed halo. Hover for a card, click to inspect, share a per-coin page.

Indexed ≠ verified. Nothing here is financial advice. AgentOrbit is independent and not affiliated with pump.fun.

## Run locally

```sh
cd trytek
npm install
npm run build
npm run snapshot            # regenerate data/seed-cache.json from pump.fun (optional)
npx wrangler pages dev . --port 8788   # full stack: galaxy + /api/orbit + emulated R2
```

Open `http://localhost:8788`. Without Functions (`npm run serve` → `http://localhost:4288`), the galaxy loads the bundled seed cache and the freshness chip says so.

## How it works

- **`/`** — the galaxy (2D canvas, no framework, no packages). A nebula wash, twinkling starfield, and orbit rings set the stage inside a soft vignette; every orb **continuously orbits** its ring (active coins orbit faster), with ring radius = rank and size = market cap — rank changes spring inward/outward, size changes breathe. Tapered comet trails follow every orb; coins up ≥5% breathe an acid halo; search matches link into a constellation and stand proud of the dimmed field. New coins spawn in a staggered wave from the core; dropped coins fade out; clicks ripple. **Lenses: Now** (momentum blend + session MC delta), **New** (under 48 h), **Movers** (biggest measured gainers — the Function diffs each refresh against the previous snapshot and ships per-coin `change`), **All-time** (ATH ranking). Every orb has a stable vivid hue from its mint hash (green core = AI-agent coin, white core = pump.fun top coin). A **live ticker tape** under the header shows MCs with ▲/▼ change; the open panel live-refreshes and flashes green/red on moves. Hover scales orbs for inspection; taps on phones open the inspect panel directly. Ranking refreshes by a 30-second client poll (the Function cache refreshes on its own 90-second TTL). Deterministic placement from the mint hash; springs animate every transition; pointer parallax; pauses when the tab is hidden. `prefers-reduced-motion` gets a static card grid with the same data and links. Phones get a full-width lens row and safe-area insets.
- **`/api/orbit`** (Pages Function) — one stable endpoint. R2-cached snapshot, TTL 90 s; a request past the TTL gets the stale payload immediately (`stale: true`) while `waitUntil` refreshes in the background. Cold cache refreshes synchronously; a hard failure serves 503 and the client falls back to `data/seed-cache.json`. The page never renders empty, and the freshness chip never lies.
- **Qualification** — keywords (`ai`, `agent`, `agentic`, `bot`, `gpt`, `llm`; short ones match whole words only, so "bottled water" stays out) over pump.fun's newest/top/most-replied lists, plus a hand-curated always-include list, minus nsfw/banned coins, deduped by name (highest market cap wins — copycat launches don't get two orbs). Source of truth: `data/keywords.json` + `data/curated.json`, edited only by the curation workflow.
- **`/c/{mint}`** (Pages Function) — per-coin share page with escaped og/twitter meta (unfurls in X/Telegram), live rows from the orbit cache, DEX Screener fallback for coins not yet indexed, and an honest 404 page for unknown mints.
- **Coin cards** — 1200×675 PNG drawn client-side (canvas), with the honesty line baked in; per-coin image falls back to an acid lettermark if the CDN image taints or fails.

## Deploy to Cloudflare Pages

```sh
npx wrangler r2 bucket create agentorbit-data
npx wrangler pages deploy . --project-name agentorbit
```

Run `npm run snapshot` before deploying so the seed cache is fresh. No secrets, no vars, no bot check in v1.

## Test

- `sh probe.sh` with the dev server running — 15 assertions, exit code = failure count.
- Phones (390×844 / 360×640): galaxy touch, bottom-sheet inspect panel, lens toggle, search.
- `prefers-reduced-motion`: static grid, no canvas.

## Constraints (permanent)

Static + Pages Functions + R2 only. No wallet, no accounts, no analytics, no token talk in-product. The shares gate applies before any `$` discussion: three distinct outside shares over a month, verified from public posts, decided by the product owner — never this repo.
