/**
 * AgentOrbit shared server helpers. No DOM, no framework.
 * The agent-coin qualification source of truth is data/keywords.json + data/curated.json
 * (imported here so the curation workflow edits JSON, not code).
 */
import KEYWORDS from '../data/keywords.json';
import CURATED_RAW from '../data/curated.json';

interface CuratedEntry {
  name: string;
  symbol: string;
  mint: string;
}

interface CuratedFile {
  include: CuratedEntry[];
  deny: CuratedEntry[];
}

const CURATED: CuratedFile = CURATED_RAW;

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(key: string, value: string | ArrayBuffer | Uint8Array): Promise<void>;
}

interface R2ObjectLike {
  text(): Promise<string>;
}

export interface OrbitEnv {
  ORBIT_R2?: R2BucketLike;
}

export interface OrbitCoin {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  image: string;
  mc: number;
  ath: number;
  replies: number;
  createdAt: number;
  curated: boolean;
  /** true = matched the AI-agent heuristic/curated list; false = pump.fun live top-20 anchor. */
  agent: boolean;
  /** Relative MC change since the previous refresh cycle (movers); undefined on the first cycle. */
  change?: number;
  /** Recent market-cap history (oldest→newest, capped) — feeds the sparklines. */
  history?: number[];
}

export interface OrbitSnapshot {
  fetchedAt: number;
  coins: OrbitCoin[];
}

const PUMP_V3 = 'https://frontend-api-v3.pump.fun/coins';

/** Everything coin-derived that lands in HTML/attribute context goes through this. */
export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&#38;')
    .replace(/</g, '&#60;')
    .replace(/>/g, '&#62;')
    .replace(/"/g, '&#34;')
    .replace(/'/g, '&#39;');
}

export function jsonResponse(data: unknown, status = 200, cacheControl = 'no-store'): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cacheControl },
  });
}

export async function fetchJson<T>(url: string, timeoutMs = 12000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'AgentOrbit/0.1 (+local probe)' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/* ---------- qualification: keyword heuristic + curated list ---------- */

function tokenized(...values: (string | undefined)[]): string {
  return values.filter(Boolean).join(' ').toLowerCase();
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesKeywords(text: string): boolean {
  for (const keyword of KEYWORDS.keywords) {
    // Short keywords (ai, bot, gpt, llm) match whole words only — "bot" must not
    // hit "bottled water". Longer ones (agent, agentic) may match as prefixes.
    // Keywords are data (edited by humans), so escape them before compiling.
    const safe = escapeRegExp(keyword);
    const pattern =
      keyword.length <= 4
        ? new RegExp(`(^|[^a-z0-9])${safe}([^a-z0-9]|$)`, 'i')
        : new RegExp(`(^|[^a-z0-9])${safe}`, 'i');
    if (pattern.test(text)) return true;
  }
  return false;
}

function matchesCurated(mint: string, name: string, symbol: string): boolean {
  if (CURATED.include.some((entry) => entry.mint === mint)) return true;
  const lowerName = name.toLowerCase();
  const lowerSymbol = symbol.toLowerCase();
  return CURATED.include.some((entry) => {
    const entryName = entry.name.toLowerCase();
    return (entryName && lowerName === entryName) || (entry.symbol && lowerSymbol === entry.symbol.toLowerCase());
  });
}

function isDenied(mint: string, name: string, symbol: string): boolean {
  if (CURATED.deny.some((entry) => entry.mint === mint)) return true;
  const lowerName = name.toLowerCase();
  return CURATED.deny.some((entry) => entry.name && entry.name.toLowerCase() === lowerName);
}

/* ---------- pump.fun v3 coin shape (verified live 2026-09-25) ---------- */

interface PumpCoin {
  mint?: unknown;
  name?: unknown;
  symbol?: unknown;
  description?: unknown;
  image_uri?: unknown;
  usd_market_cap?: unknown;
  market_cap?: unknown;
  ath_market_cap?: unknown;
  reply_count?: unknown;
  created_timestamp?: unknown;
  nsfw?: unknown;
  is_banned?: unknown;
}

function toMillis(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
  return raw < 1e12 ? raw * 1000 : raw; // seconds vs ms
}

function toOrbitCoin(raw: PumpCoin, curated: boolean, agent: boolean): OrbitCoin | null {
  const mint = typeof raw.mint === 'string' ? raw.mint : '';
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 64) : '';
  const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().slice(0, 16) : '';
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || !name) return null;
  const mc = typeof raw.usd_market_cap === 'number' ? raw.usd_market_cap : typeof raw.market_cap === 'number' ? raw.market_cap : 0;
  const ath = typeof raw.ath_market_cap === 'number' && raw.ath_market_cap > 0 ? raw.ath_market_cap : mc;
  return {
    mint,
    name,
    symbol,
    description: typeof raw.description === 'string' ? raw.description.slice(0, 240) : '',
    image: typeof raw.image_uri === 'string' ? raw.image_uri : '',
    mc,
    ath,
    replies: typeof raw.reply_count === 'number' ? raw.reply_count : 0,
    createdAt: toMillis(raw.created_timestamp),
    curated,
    agent,
  };
}

function coinFields(raw: PumpCoin): { mint: string; name: string; symbol: string } {
  return {
    mint: typeof raw.mint === 'string' ? raw.mint : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    symbol: typeof raw.symbol === 'string' ? raw.symbol : '',
  };
}

/**
 * Discover the live sector: pump.fun's top-20 coins by market cap (visual
 * anchors, agent: false) plus every AI-agent coin the heuristic/curated list
 * can match from the newest, top, and most-replied lists (agent: true).
 * Per-request failures are skipped (rate-limit resilience); returns null when
 * nothing could be fetched at all.
 */
export async function discoverAgentCoins(): Promise<OrbitCoin[] | null> {
  const byMint = new Map<string, OrbitCoin>();
  let fetchedAny = false;

  // 1) Global live top 20 — the market's biggest coins, included regardless of theme.
  const top = await fetchJson<PumpCoin[]>(`${PUMP_V3}?offset=0&limit=20&sort=market_cap&includeNsfw=false`);
  if (Array.isArray(top) && top.length > 0) {
    fetchedAny = true;
    for (const raw of top) {
      if (raw.nsfw === true || raw.is_banned === true) continue;
      const { mint, name, symbol } = coinFields(raw);
      const curated = matchesCurated(mint, name, symbol);
      const text = tokenized(name, symbol, typeof raw.description === 'string' ? raw.description : '');
      const isAgent = curated || (matchesKeywords(text) && !isDenied(mint, name, symbol));
      const coin = toOrbitCoin(raw, curated, isAgent);
      if (coin && !byMint.has(coin.mint)) byMint.set(coin.mint, coin);
    }
  }

  // 2) Agent-sector discovery across newest, deeper top, and most-replied lists.
  const pages: Array<{ sort: string; offset: number }> = [
    { sort: 'market_cap', offset: 20 },
    { sort: 'market_cap', offset: 50 },
    { sort: 'created_timestamp', offset: 0 },
    { sort: 'created_timestamp', offset: 30 },
    { sort: 'created_timestamp', offset: 60 },
    { sort: 'reply_count', offset: 0 },
  ];
  for (const page of pages) {
    const url = `${PUMP_V3}?offset=${page.offset}&limit=30&sort=${page.sort}&includeNsfw=false`;
    const coins = await fetchJson<PumpCoin[]>(url);
    if (!Array.isArray(coins)) continue;
    fetchedAny = true;
    for (const raw of coins) {
      if (raw.nsfw === true || raw.is_banned === true) continue;
      const { mint, name, symbol } = coinFields(raw);
      const curated = matchesCurated(mint, name, symbol);
      const text = tokenized(name, symbol, typeof raw.description === 'string' ? raw.description : '');
      if (!curated && !(matchesKeywords(text) && !isDenied(mint, name, symbol))) continue;
      if (isDenied(mint, name, symbol)) continue;
      const coin = toOrbitCoin(raw, curated, true);
      if (coin && !byMint.has(coin.mint)) byMint.set(coin.mint, coin);
    }
  }
  if (!fetchedAny || byMint.size === 0) return null;
  // One orb per project name: copycats launch the same name repeatedly —
  // keep the highest-market-cap instance.
  const byName = new Map<string, OrbitCoin>();
  for (const coin of byMint.values()) {
    const key = coin.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing || coin.mc > existing.mc) byName.set(key, coin);
  }
  return [...byName.values()];
}
