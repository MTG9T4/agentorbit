#!/usr/bin/env node
/**
 * Generate data/seed-cache.json from pump.fun's live v3 API.
 * Run before deploy (`npm run snapshot`) so the first visit is never an empty
 * galaxy and the zero-config static fallback has real data. Self-contained on
 * purpose — no TS imports, no dependencies.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const keywords = JSON.parse(readFileSync(join(root, 'data', 'keywords.json'), 'utf8')).keywords;
const curated = JSON.parse(readFileSync(join(root, 'data', 'curated.json'), 'utf8'));
const PUMP = 'https://frontend-api-v3.pump.fun/coins';

const pages = [
  { sort: 'market_cap', offset: 0 },
  { sort: 'market_cap', offset: 30 },
  { sort: 'created_timestamp', offset: 0 },
  { sort: 'created_timestamp', offset: 30 },
  { sort: 'created_timestamp', offset: 60 },
  { sort: 'reply_count', offset: 0 },
];

function keywordMatch(text) {
  return keywords.some((k) =>
    k.length <= 4
      ? new RegExp(`(^|[^a-z0-9])${k}([^a-z0-9]|$)`, 'i').test(text)
      : new RegExp(`(^|[^a-z0-9])${k}`, 'i').test(text)
  );
}

function curatedMatch(name, symbol) {
  const n = name.toLowerCase();
  const s = symbol.toLowerCase();
  return curated.include.some((e) => e.name.toLowerCase() === n || (e.symbol && e.symbol.toLowerCase() === s));
}

function denied(name) {
  return curated.deny.some((e) => e.name && e.name.toLowerCase() === name.toLowerCase());
}

const byMint = new Map();
for (const page of pages) {
  const url = `${PUMP}?offset=${page.offset}&limit=30&sort=${page.sort}&includeNsfw=false`;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'AgentOrbit snapshot/0.1' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(String(res.status));
    const coins = await res.json();
    for (const raw of coins) {
      if (raw.nsfw === true || raw.is_banned === true) continue;
      const name = String(raw.name ?? '').trim().slice(0, 64);
      const symbol = String(raw.symbol ?? '').trim().slice(0, 16);
      if (!name || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(raw.mint ?? ''))) continue;
      const curatedHit = curatedMatch(name, symbol);
      const text = [name, symbol, String(raw.description ?? '')].join(' ').toLowerCase();
      const deniedHit = denied(name);
      if (deniedHit) continue;
      if (!curatedHit && !keywordMatch(text)) continue;
      const mc = typeof raw.usd_market_cap === 'number' ? raw.usd_market_cap : typeof raw.market_cap === 'number' ? raw.market_cap : 0;
      const created = typeof raw.created_timestamp === 'number' ? (raw.created_timestamp < 1e12 ? raw.created_timestamp * 1000 : raw.created_timestamp) : 0;
      const coin = {
        mint: raw.mint,
        name,
        symbol,
        description: String(raw.description ?? '').slice(0, 240),
        image: String(raw.image_uri ?? ''),
        mc,
        ath: typeof raw.ath_market_cap === 'number' && raw.ath_market_cap > 0 ? raw.ath_market_cap : mc,
        replies: typeof raw.reply_count === 'number' ? raw.reply_count : 0,
        createdAt: created,
        curated: curatedHit,
        agent: true,
      };
      if (!byMint.has(coin.mint)) byMint.set(coin.mint, coin);
    }
  } catch (err) {
    console.error(`page ${page.sort}/${page.offset} failed: ${err.message}`);
  }
}

// Global live top 20 — visual anchors included regardless of theme (agent: false).
try {
  const res = await fetch(`${PUMP}?offset=0&limit=20&sort=market_cap&includeNsfw=false`, { headers: { accept: 'application/json', 'user-agent': 'AgentOrbit snapshot/0.1' }, signal: AbortSignal.timeout(15000) });
  if (res.ok) {
    const top = await res.json();
    for (const raw of top) {
      if (raw.nsfw === true || raw.is_banned === true) continue;
      const name = String(raw.name ?? '').trim().slice(0, 64);
      const symbol = String(raw.symbol ?? '').trim().slice(0, 16);
      if (!name || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(raw.mint ?? ''))) continue;
      if (byMint.has(raw.mint)) continue;
      const text = [name, symbol, String(raw.description ?? '')].join(' ').toLowerCase();
      const agentHit = curatedMatch(name, symbol) || keywordMatch(text);
      const mc = typeof raw.usd_market_cap === 'number' ? raw.usd_market_cap : typeof raw.market_cap === 'number' ? raw.market_cap : 0;
      byMint.set(raw.mint, {
        mint: raw.mint,
        name,
        symbol,
        description: String(raw.description ?? '').slice(0, 240),
        image: String(raw.image_uri ?? ''),
        mc,
        ath: typeof raw.ath_market_cap === 'number' && raw.ath_market_cap > 0 ? raw.ath_market_cap : mc,
        replies: typeof raw.reply_count === 'number' ? raw.reply_count : 0,
        createdAt: typeof raw.created_timestamp === 'number' ? (raw.created_timestamp < 1e12 ? raw.created_timestamp * 1000 : raw.created_timestamp) : 0,
        curated: curatedMatch(name, symbol),
        agent: agentHit,
      });
    }
  }
} catch (err) {
  console.error(`top-20 page failed: ${err.message}`);
}

if (byMint.size === 0) {
  console.error('No coins qualified — refusing to write an empty seed.');
  process.exit(1);
}

// One orb per project name: copycats repeat names — keep the highest-MC instance.
const byName = new Map();
for (const coin of byMint.values()) {
  const key = coin.name.toLowerCase();
  const existing = byName.get(key);
  if (!existing || coin.mc > existing.mc) byName.set(key, coin);
}

const snapshot = { fetchedAt: Date.now(), coins: [...byName.values()] };
writeFileSync(join(root, 'data', 'seed-cache.json'), JSON.stringify(snapshot, null, 2));
console.log(`seed-cache.json: ${snapshot.coins.length} agent coins, fetchedAt ${new Date(snapshot.fetchedAt).toISOString()}`);
