import type { OrbitPayload } from './types.js';

export interface OrbitState {
  payload: OrbitPayload;
  offline: boolean;
}

/**
 * Try the live API first; fall back to the bundled seed cache (labeled stale,
 * offline) when the Function is absent or failing. The galaxy never renders
 * empty, and the freshness chip always tells the truth about which path ran.
 */
export async function loadOrbit(): Promise<OrbitState> {
  try {
    const res = await fetch('/api/orbit', { signal: AbortSignal.timeout(12000) });
    if (res.ok) {
      const data = (await res.json()) as OrbitPayload;
      if (Array.isArray(data.coins) && data.coins.length > 0) return { payload: data, offline: false };
    }
  } catch {
    /* fall through to the seed */
  }
  const res = await fetch('data/seed-cache.json', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Orbit data is unavailable.');
  const data = (await res.json()) as OrbitPayload;
  if (!Array.isArray(data.coins)) throw new Error('Orbit data is malformed.');
  return { payload: { ...data, stale: true }, offline: true };
}
