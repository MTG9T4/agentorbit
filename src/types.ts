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
  /** true = AI-agent match; false = pump.fun live top-20 anchor. */
  agent: boolean;
  /** Relative MC change since the previous server refresh cycle (movers). */
  change?: number;
  /** Recent MC history (oldest→newest, capped) for the sparklines. */
  history?: number[];
}

export interface OrbitSnapshot {
  fetchedAt: number;
  coins: OrbitCoin[];
}

export interface OrbitPayload extends OrbitSnapshot {
  stale: boolean;
}

export type Lens = 'now' | 'new' | 'movers' | 'alltime';

export const LENS_LABELS: Record<Lens, string> = { now: 'Now', new: 'New', movers: 'Movers', alltime: 'All-time' };

export function ageHours(coin: OrbitCoin): number {
  if (!coin.createdAt) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - coin.createdAt) / 36e5);
}

/** 0..1 — how close a coin is to its all-time-high market cap. */
export function momentum(coin: OrbitCoin): number {
  if (!coin.ath || !coin.mc) return 0;
  return Math.min(1, coin.mc / coin.ath);
}

/** The "Now" blend: ATH proximity, reply activity, recency, and session momentum (live MC change). */
export function nowScore(coin: OrbitCoin, mcDelta?: number): number {
  const m = momentum(coin);
  const activity = Math.min(1, Math.log10(coin.replies + 1) / 3);
  const hours = ageHours(coin);
  const recency = Number.isFinite(hours) ? 1 / (1 + hours / 6) : 0.1;
  const rise = mcDelta !== undefined ? 0.3 * Math.min(0.5, Math.max(-0.4, mcDelta)) : 0;
  return 0.45 * m + 0.25 * activity + 0.2 * recency + 0.1 + rise;
}

/** Movers ranking: measured refresh-cycle change first, then young+hot coins, then the rest. */
function moverScore(coin: OrbitCoin): number {
  if (typeof coin.change === 'number' && Number.isFinite(coin.change)) return coin.change;
  const hours = ageHours(coin);
  const recency = Number.isFinite(hours) && hours < 24 ? 1 - hours / 24 : 0;
  return -1 + 0.5 * recency + 0.25 * momentum(coin);
}

/**
 * Sorted, capped coin list for one lens. The cap is the live top 25 — coins
 * outside it fade out of the galaxy, climbers glide inward, droppers sink.
 */
export function lensCoins(coins: OrbitCoin[], lens: Lens, cap = 25, mcDelta?: Map<string, number>): OrbitCoin[] {
  const list = [...coins];
  if (lens === 'new') {
    const fresh = list.filter((c) => ageHours(c) < 48).sort((a, b) => b.createdAt - a.createdAt);
    return fresh.length ? fresh.slice(0, cap) : list.sort((a, b) => b.createdAt - a.createdAt).slice(0, cap);
  }
  if (lens === 'movers') {
    return list.sort((a, b) => moverScore(b) - moverScore(a)).slice(0, cap);
  }
  if (lens === 'alltime') return list.sort((a, b) => b.ath - a.ath).slice(0, cap);
  return list
    .sort((a, b) => nowScore(b, mcDelta?.get(b.mint)) - nowScore(a, mcDelta?.get(a.mint)))
    .slice(0, cap);
}

export function formatMc(mc: number): string {
  if (!mc) return '—';
  if (mc >= 1e9) return `$${(mc / 1e9).toFixed(1)}B`;
  if (mc >= 1e6) return `$${(mc / 1e6).toFixed(1)}M`;
  if (mc >= 1e3) return `$${Math.round(mc / 1e3)}K`;
  return `$${Math.round(mc)}`;
}

export function formatAge(coin: OrbitCoin): string {
  const hours = ageHours(coin);
  if (!Number.isFinite(hours)) return 'unknown age';
  if (hours < 1) return 'under an hour old';
  if (hours < 24) return `${Math.round(hours)} h old`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day old' : `${days} d old`;
}
