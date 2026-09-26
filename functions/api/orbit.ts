import { discoverAgentCoins, jsonResponse, type OrbitEnv, type OrbitSnapshot } from '../_lib';

interface PagesContext {
  env: OrbitEnv;
  waitUntil?: (promise: Promise<unknown>) => void;
}

const CACHE_KEY = 'orbit/cache.json';
// 90 s: one shared cache serves every visitor, so this is ~7 pump.fun requests
// per 90 s globally — gentle on their rate limits while keeping numbers visibly live.
const TTL_MS = 90 * 1000;

async function readCache(env: OrbitEnv): Promise<OrbitSnapshot | null> {
  const bucket = env.ORBIT_R2;
  if (!bucket) return null;
  try {
    const obj = await bucket.get(CACHE_KEY);
    if (!obj) return null;
    const parsed = JSON.parse(await obj.text()) as OrbitSnapshot;
    if (!parsed || !Array.isArray(parsed.coins) || typeof parsed.fetchedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function refresh(env: OrbitEnv): Promise<OrbitSnapshot | null> {
  // Measure movers and extend history against the previous snapshot before it is replaced.
  const prevMc = new Map<string, number>();
  const prevHistory = new Map<string, number[]>();
  try {
    const old = await readCache(env);
    for (const coin of old?.coins ?? []) {
      prevMc.set(coin.mint, coin.mc);
      if (Array.isArray(coin.history)) prevHistory.set(coin.mint, coin.history);
    }
  } catch {
    /* first cycle has nothing to compare against */
  }
  const coins = await discoverAgentCoins();
  if (!coins) return null; // keep whatever cache exists; never overwrite with emptiness
  for (const coin of coins) {
    const prev = prevMc.get(coin.mint);
    if (prev !== undefined && prev > 0) coin.change = coin.mc / prev - 1;
    const history = prevHistory.get(coin.mint) ?? [];
    coin.history = [...history, coin.mc].slice(-24); // ~36 minutes of 90s cycles
  }
  const snapshot: OrbitSnapshot = { fetchedAt: Date.now(), coins };
  try {
    await env.ORBIT_R2?.put(CACHE_KEY, JSON.stringify(snapshot));
  } catch {
    /* cache write failure is non-fatal; this response still carries fresh data */
  }
  return snapshot;
}

function snapshotResponse(snapshot: OrbitSnapshot, stale: boolean): Response {
  return jsonResponse({ ...snapshot, stale });
}

/**
 * GET /api/orbit — the galaxy's one stable endpoint.
 * Fresh cache -> serve it. Stale -> serve stale immediately (stale: true) and
 * refresh in the background. Cold cache -> refresh synchronously. If discovery
 * fails cold, 503: the client falls back to the bundled seed cache.
 */
export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { env } = context;
  const bucket = env.ORBIT_R2;
  if (!bucket) return jsonResponse({ error: 'Orbit storage is not configured.' }, 503);

  const cached = await readCache(env);
  const age = cached ? Date.now() - cached.fetchedAt : Infinity;

  if (cached && age < TTL_MS) return snapshotResponse(cached, false);

  if (cached) {
    const background = refresh(env).catch(() => null);
    if (context.waitUntil) context.waitUntil(background);
    return snapshotResponse(cached, true);
  }

  const fresh = await refresh(env);
  if (fresh) return snapshotResponse(fresh, false);
  return jsonResponse({ error: 'Orbit data is temporarily unavailable.' }, 503);
}
