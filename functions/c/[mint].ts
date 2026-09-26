import { fetchJson, htmlEscape, jsonResponse, type OrbitCoin, type OrbitEnv, type OrbitSnapshot } from '../_lib';

interface PagesContext {
  env: OrbitEnv;
  params: Record<string, string | string[]>;
}

const PUMP_V3 = 'https://frontend-api-v3.pump.fun/coins';
const DEX_PAIRS = 'https://api.dexscreener.com/token-pairs/v1/solana';
const COIN_TTL_MS = 5 * 60 * 1000;

const baseStyle = `:root{--bg:#0a0e14;--panel:#121a24;--line:#26313d;--text:#f2f6f3;--muted:#93a3ad;--acid:#c8ff3d}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;color-scheme:dark}
a,button{-webkit-tap-highlight-color:transparent;touch-action:manipulation}
.wrap{max-width:560px;margin:0 auto;padding:calc(16px + env(safe-area-inset-top,0px)) 16px calc(32px + env(safe-area-inset-bottom,0px))}
.brand{font-weight:800;letter-spacing:-.02em;text-decoration:none;color:var(--text)}
.brand em{color:var(--acid);font-style:normal}
h1{font-size:clamp(26px,7vw,34px);letter-spacing:-.02em;margin:10px 0 2px}
.tick{color:var(--acid);font-family:ui-monospace,monospace;font-size:14px}
.desc{font-size:15px;line-height:1.55;color:#c9d4d0;margin:12px 0}
.rows{display:grid;gap:6px;margin:14px 0;font-family:ui-monospace,monospace;font-size:13px}
.rows div{display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid var(--line);padding:6px 0}
.rows span:last-child{color:var(--acid)}
.note{background:#22352e;border:1px solid #7ba64b;border-radius:8px;padding:10px 12px;font-size:12px;line-height:1.5;margin:14px 0}
.btns{display:flex;flex-direction:column;gap:8px}
a.btn{background:var(--acid);color:#0b1411;font-weight:800;text-decoration:none;padding:13px 14px;min-height:48px;border-radius:8px;font-size:15px;text-align:center}
a.btn.ghost{background:transparent;color:var(--acid);border:1px solid var(--acid)}
.muted{color:var(--muted);font-size:12px;line-height:1.5}
button.btn{font:inherit;background:#1a2530;color:var(--text);border:1px solid var(--line);border-radius:8px;min-height:48px;font-size:15px;cursor:pointer}
.coin-img{width:96px;height:96px;border-radius:50%;object-fit:cover;border:2px solid var(--acid);margin:12px 0 0}`;

function pageHtml(body: string, title: string, og: string, extraHead = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0e14">
<title>${htmlEscape(title)}</title>
${og}${extraHead}<style>${baseStyle}</style>
</head>
<body><div class="wrap">
<p style="margin:0"><a class="brand" href="/">Agent<em>Orbit</em></a></p>
${body}
<p class="muted">Agent coins are matched by keyword heuristics + a curated list. Indexed &#8800; verified. Nothing here is financial advice.</p>
</div></body>
</html>`;
}

function ogBlock(coin: { name: string; symbol: string; image: string; description: string }): string {
  const desc = coin.description
    ? htmlEscape(coin.description.slice(0, 120))
    : `${htmlEscape(coin.name)} — an AI-agent coin indexed by AgentOrbit.`;
  return `<meta property="og:title" content="${htmlEscape(coin.name)} · AgentOrbit">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
${coin.image ? `<meta property="og:image" content="${htmlEscape(coin.image)}">\n` : ''}<meta name="twitter:card" content="${coin.image ? 'summary_large_image' : 'summary'}">
`;
}

function coinPage(coin: OrbitCoin, indexed: boolean): string {
  const ageHours = coin.createdAt ? Math.max(0, (Date.now() - coin.createdAt) / 36e5) : 0;
  const age = ageHours < 1 ? 'under an hour' : ageHours < 24 ? `${Math.round(ageHours)} h` : `${Math.round(ageHours / 24)} d`;
  const mc = coin.mc >= 1e6 ? `$${(coin.mc / 1e6).toFixed(1)}M` : coin.mc >= 1e3 ? `$${Math.round(coin.mc / 1e3)}K` : '$—';
  const change =
    typeof coin.change === 'number' && Number.isFinite(coin.change)
      ? `${coin.change >= 0 ? '+' : ''}${(coin.change * 100).toFixed(1)}%`
      : '—';
  const kind = coin.agent ? (coin.curated ? 'AI-agent · curated' : 'AI-agent · keyword match') : 'pump.fun live top coin';
  const rows = indexed
    ? `<div class="rows">
<div><span>Market cap</span><span>${htmlEscape(mc)}</span></div>
<div><span>Last refresh Δ</span><span>${htmlEscape(change)}</span></div>
<div><span>Age</span><span>${htmlEscape(age)}</span></div>
<div><span>Replies</span><span>${htmlEscape(String(coin.replies))}</span></div>
<div><span>Type</span><span>${htmlEscape(kind)}</span></div>
</div>`
    : '';
  const indexedNote = indexed
    ? ''
    : '<p class="note">This coin is not currently indexed by AgentOrbit. The details below come from DEX Screener; check the official pump.fun page before trusting anything.</p>';
  const art = coin.image
    ? `<img class="coin-img" src="${htmlEscape(coin.image)}" alt="${htmlEscape(coin.name)} artwork" loading="lazy" onerror="this.remove()">`
    : '';
  return pageHtml(
    `${art}
<h1>${htmlEscape(coin.name)}</h1>
<p class="tick">$${htmlEscape(coin.symbol)}</p>
${indexedNote}
${coin.description ? `<p class="desc">${htmlEscape(coin.description)}</p>` : ''}
${rows}
<div class="btns">
<a class="btn" href="https://pump.fun/coin/${htmlEscape(coin.mint)}" rel="noopener noreferrer">View on Pump ↗</a>
<a class="btn ghost" href="https://dexscreener.com/solana/${htmlEscape(coin.mint)}" rel="noopener noreferrer">View on DEX Screener ↗</a>
<a class="btn ghost" href="/#${htmlEscape(coin.mint)}">Open in the galaxy ↗</a>
</div>`,
    `${coin.name} · AgentOrbit`,
    ogBlock(coin),
    indexed ? '' : ''
  );
}

function notFoundHtml(mint: string): string {
  const safeMint = htmlEscape(mint.slice(0, 44));
  return pageHtml(
    `<h1>Coin not found.</h1>
<p class="desc">AgentOrbit has no record of <span class="tick">${safeMint}</span>. The mint may be malformed, or the coin is too new for every index.</p>
<div class="btns"><a class="btn ghost" href="/">Open the galaxy ↗</a></div>`,
    'Coin not found · AgentOrbit',
    `<meta property="og:title" content="Coin not found · AgentOrbit">
<meta name="twitter:card" content="summary">
`
  );
}

async function coinFromDex(env: OrbitEnv, mint: string): Promise<OrbitCoin | null> {
  const bucket = env.ORBIT_R2;
  const cacheKey = `orbit/coin/${mint}.json`;
  try {
    const cachedObj = await bucket?.get(cacheKey);
    if (cachedObj) {
      const cached = JSON.parse(await cachedObj.text()) as { at: number; coin: OrbitCoin | null };
      if (Date.now() - cached.at < COIN_TTL_MS) return cached.coin;
    }
  } catch {
    /* fall through to a fresh lookup */
  }
  const pairs = await fetchJson<Array<{ chainId?: string; baseToken?: { name?: string; symbol?: string; address?: string } }>>(`${DEX_PAIRS}/${mint}`);
  let coin: OrbitCoin | null = null;
  if (Array.isArray(pairs)) {
    const pair = pairs.find((p) => p.chainId === 'solana' && p.baseToken?.address === mint);
    if (pair?.baseToken?.name) {
      coin = {
        mint,
        name: String(pair.baseToken.name).slice(0, 64),
        symbol: String(pair.baseToken.symbol ?? '').slice(0, 16),
        description: '',
        image: '',
        mc: 0,
        ath: 0,
        replies: 0,
        createdAt: 0,
        curated: false,
        agent: false,
      };
    }
  }
  try {
    await bucket?.put(cacheKey, JSON.stringify({ at: Date.now(), coin }));
  } catch {
    /* cache write failure is non-fatal */
  }
  return coin;
}

async function coinFromOrbitCache(env: OrbitEnv, mint: string): Promise<OrbitCoin | null> {
  try {
    const obj = await env.ORBIT_R2?.get('orbit/cache.json');
    if (!obj) return null;
    const snapshot = JSON.parse(await obj.text()) as OrbitSnapshot;
    if (!Array.isArray(snapshot.coins)) return null;
    return snapshot.coins.find((c) => c.mint === mint) ?? null;
  } catch {
    return null;
  }
}

/** GET /c/{mint} — the shareable per-coin page with escaped og meta. */
export async function onRequestGet(context: PagesContext): Promise<Response> {
  const raw = context.params['mint'];
  const mint = Array.isArray(raw) ? raw[0] : raw;
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' };
  if (typeof mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return new Response(notFoundHtml(typeof mint === 'string' ? mint : ''), { status: 404, headers });
  }
  const indexed = await coinFromOrbitCache(context.env, mint);
  if (indexed) return new Response(coinPage(indexed, true), { status: 200, headers });
  const dexCoin = await coinFromDex(context.env, mint);
  if (dexCoin) return new Response(coinPage(dexCoin, false), { status: 200, headers });
  return new Response(notFoundHtml(mint), { status: 404, headers });
}

/** Non-GET verbs get the honest JSON nudge, not a silent 405 from the platform. */
export function onRequest(context: PagesContext): Response {
  void context;
  return jsonResponse({ error: 'Use GET /c/{mint}.' }, 405);
}
