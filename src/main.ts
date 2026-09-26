import { Galaxy } from './galaxy.js';
import { loadOrbit } from './state.js';
import { formatMc, lensCoins, LENS_LABELS, type Lens, type OrbitCoin } from './types.js';
import { closePanel, drawSpark, openPanel, openPanelMint, refreshOpenPanel, toast } from './panel.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let coins: OrbitCoin[] = [];
let galaxy: Galaxy | null = null;
let currentLens: Lens = 'now';
let focusMint: string | null = null;
const lastMc = new Map<string, number>();
let mcDeltaView: Map<string, number> = new Map();

function trackMc(list: OrbitCoin[]): void {
  for (const coin of list) lastMc.set(coin.mint, coin.mc);
}

/** Relative market-cap change since the previous poll, per mint. */
function computeDeltas(list: OrbitCoin[]): Map<string, number> {
  const deltas = new Map<string, number>();
  for (const coin of list) {
    const prev = lastMc.get(coin.mint);
    if (prev !== undefined && prev > 0) deltas.set(coin.mint, coin.mc / prev - 1);
  }
  return deltas;
}

async function boot(): Promise<void> {
  const state = await loadOrbit();
  coins = state.payload.coins;

  wireLens();
  wireSearch();
  wireChip(state.payload.fetchedAt, state.offline, state.payload.stale);
  $('panel-backdrop').addEventListener('click', closePanel);
  $('panel-close').addEventListener('click', closePanel);
  wireCopyLink();
  wireSheetSwipe();
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // Check the event's origin, not activeElement: the search input blurs
    // itself on Escape before this bubbles up.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    closePanel();
  });

  // Every mode gets the live furniture: tape, HUD, keyboard, polling.
  // (Reduced motion previously got none of it and froze at boot data.)
  trackMc(coins);
  renderTape();
  updateHud();
  wireKeyboard();

  if (reducedMotion) renderGrid();
  else {
    galaxy = new Galaxy($('galaxy') as HTMLCanvasElement, {
      onHover: showHover,
      onSelect: (coin) => {
        openPanel(coin);
        focusMint = coin.mint; // keep arrow-key walks starting from the tapped orb
        galaxy?.setFocus(coin.mint);
      },
      onError: (message) => {
        $('status').textContent = `render error: ${message}`;
      },
    });
    galaxy.setData(coins); // boot handoff: the lens already defaults to "now"
    galaxy.setLens(currentLens);
    wireGyro();
  }

  const agents = coins.filter((c) => c.agent).length;
  $('status').textContent = `${coins.length} coins live · ${agents} AI-agent · ${coins.length - agents} pump.fun top 20${state.offline ? ' · offline seed' : ''}`;
  // Live churn: poll every 30 s; the server cache refreshes on its own 90 s
  // TTL, so numbers visibly tick and movers rearrange — canvas and grid alike.
  window.setInterval(() => void refreshSoon(state.offline), 30 * 1000);
  if (galaxy) {
    window.setInterval(() => {
      const s = galaxy?.stats();
      if (s) {
        const line = `render ${s.frames}f · ${s.orbs} orbs · alpha ${Math.round(s.avgAlpha * 100)}%`;
        $('render-stats').textContent = line;
      }
    }, 2000);
  }

  const hash = location.hash.replace(/^#/, '');
  if (hash && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash)) {
    const coin = coins.find((c) => c.mint === hash);
    if (coin) {
      openPanel(coin);
      focusMint = coin.mint;
      galaxy?.setFocus(coin.mint);
    }
  }
}

/* ---------- panel chrome: copy link + mobile swipe-down close ---------- */

function wireCopyLink(): void {
  $('panel-copy').addEventListener('click', () => {
    const mint = openPanelMint();
    if (!mint) return;
    const url = `${location.origin}/c/${mint}`;
    const done = (): void => toast('Share link copied');
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, () => toast(url));
    else toast(url); // clipboard blocked — surface the URL instead of failing silently
  });
}

/** Spec: the mobile bottom sheet closes on a swipe down (not just the ✕). */
function wireSheetSwipe(): void {
  const panel = $('panel');
  let startY = 0;
  let dragging = false;
  panel.addEventListener('pointerdown', (e) => {
    if (window.innerWidth > 700) return; // side-panel layout has nothing to swipe
    if (panel.scrollTop > 0) return; // let the sheet scroll first
    if ((e.target as HTMLElement).closest('button, a, input')) return;
    startY = e.clientY;
    dragging = true;
    panel.style.transition = 'none';
  });
  panel.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (dy > 0) panel.style.transform = `translateY(${dy}px)`;
  });
  const settle = (dy: number): void => {
    dragging = false;
    panel.style.transition = '';
    panel.style.transform = '';
    if (dy > 70) closePanel();
  };
  panel.addEventListener('pointerup', (e) => settle(dragging ? e.clientY - startY : -1));
  panel.addEventListener('pointercancel', () => settle(-1));
}

function showHover(coin: OrbitCoin | null, x: number, y: number): void {
  const card = $('hover-card');
  if (!coin) {
    card.hidden = true;
    return;
  }
  $('hover-name').textContent = coin.name;
  $('hover-ticker').textContent = `$${coin.symbol} · ${formatMc(coin.mc)}`;
  const delta = mcDeltaView.get(coin.mint);
  const deltaEl = $('hover-delta');
  if (delta === undefined) {
    deltaEl.textContent = '';
  } else if (delta >= 0.005) {
    deltaEl.textContent = `↑ +${Math.round(delta * 100)}% this session`;
    deltaEl.className = 'rising';
  } else if (delta <= -0.005) {
    deltaEl.textContent = `↓ ${Math.round(delta * 100)}% this session`;
    deltaEl.className = 'falling';
  } else {
    deltaEl.textContent = 'flat this session';
    deltaEl.className = '';
  }
  const stage = ($('stage') as HTMLElement).getBoundingClientRect();
  card.hidden = false;
  drawSpark($('hover-spark') as HTMLCanvasElement, coin.history, (coin.change ?? 0) < 0);
  const cardRect = card.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - stage.left + 16), stage.width - cardRect.width - 8);
  const top = Math.min(Math.max(8, y - stage.top - cardRect.height - 8), stage.height - cardRect.height - 8);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function wireLens(): void {
  document.querySelectorAll<HTMLButtonElement>('#lens button').forEach((button) => {
    button.addEventListener('click', () => {
      const lens = (button.dataset.lens ?? 'now') as Lens;
      if (lens === currentLens || !LENS_LABELS[lens]) return;
      currentLens = lens;
      document.querySelectorAll('#lens button').forEach((b) => {
        const active = b === button;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      if (galaxy) galaxy.setLens(lens);
      else renderGrid();
      updateHud();
    });
  });
}

function wireSearch(): void {
  const input = $('search') as HTMLInputElement;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // search Escape clears the query — full stop
      input.value = '';
      input.dispatchEvent(new Event('input'));
      input.blur();
    }
    if (e.key === 'ArrowDown') {
      const first = $('search-results').querySelector<HTMLElement>('button');
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    const results = $('search-results');
    if (!query || !coins.length) {
      galaxy?.setVisible(null);
      $('search-count').textContent = '';
      results.replaceChildren();
      results.hidden = true;
      if (!galaxy) filterGrid('');
      return;
    }
    // Count what the visitor can actually see: matches inside the current
    // lens cap — the constellation only lights orbs that exist on stage.
    const inLens = new Set(lensCoins(coins, currentLens).map((c) => c.mint));
    const mints = new Set<string>();
    const matches: OrbitCoin[] = [];
    for (const coin of coins) {
      if (coin.name.toLowerCase().includes(query) || coin.symbol.toLowerCase().includes(query)) {
        mints.add(coin.mint);
        if (inLens.has(coin.mint)) matches.push(coin);
      }
    }
    galaxy?.setVisible(mints);
    $('search-count').textContent = matches.length
      ? `${matches.length} match${matches.length === 1 ? '' : 'es'}`
      : 'no matches';
    renderSearchResults(matches.slice(0, 8));
    if (!galaxy) filterGrid(query);
  });

  // Arrow keys walk the result list itself (and never leak into the galaxy).
  const results = $('search-results');
  results.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Escape') return;
    e.stopPropagation();
    e.preventDefault();
    const buttons = Array.from(results.querySelectorAll<HTMLElement>('button'));
    const idx = buttons.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      input.value = '';
      input.dispatchEvent(new Event('input'));
      input.focus();
    } else if (e.key === 'ArrowDown') {
      buttons[Math.min(buttons.length - 1, idx + 1)]?.focus();
    } else if (idx <= 0) {
      input.focus();
    } else {
      buttons[idx - 1]?.focus();
    }
  });
}

/** Spec: a result list under the search box — click a hit to inspect it. */
function renderSearchResults(matches: OrbitCoin[]): void {
  const results = $('search-results');
  results.replaceChildren();
  if (!matches.length) {
    results.hidden = true;
    return;
  }
  for (const coin of matches) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'search-hit';
    const name = document.createElement('span');
    name.textContent = coin.name;
    const meta = document.createElement('span');
    meta.textContent = `$${coin.symbol} · ${formatMc(coin.mc)}`;
    btn.append(name, meta);
    btn.addEventListener('click', () => {
      openPanel(coin);
      focusMint = coin.mint;
      galaxy?.setFocus(coin.mint);
      galaxy?.pulse(coin.mint);
    });
    results.append(btn);
  }
  results.hidden = false;
}

function filterGrid(query: string): void {
  const grid = $('grid');
  for (const card of grid.querySelectorAll<HTMLButtonElement>('.grid-card')) {
    const name = (card.querySelector('strong')?.textContent ?? '').toLowerCase();
    const meta = (card.querySelector('span')?.textContent ?? '').toLowerCase();
    card.hidden = Boolean(query) && !name.includes(query) && !meta.includes(query);
  }
}

/** The freshness chip reads this on every tick; polls keep it current. */
let chipData = { fetchedAt: 0, offline: false, stale: false };

function wireChip(fetchedAt: number, offline: boolean, stale: boolean): void {
  chipData = { fetchedAt, offline, stale };
  const chip = $('chip');
  const update = (): void => {
    const ageMs = chipData.fetchedAt ? Date.now() - chipData.fetchedAt : Infinity;
    const minutes = Math.max(0, Math.round(ageMs / 60000));
    const age = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min old` : `${Math.round(minutes / 60)} h old`;
    // The payload's stale flag describes its fetch moment. If later polls fail
    // silently, the age outgrows the 90 s TTL — say stale instead of lying.
    const aged = ageMs > 5 * 60 * 1000;
    const isStale = chipData.offline || chipData.stale || aged;
    chip.textContent = chipData.offline ? `offline data · ${age}` : isStale ? `stale · ${age}` : `live · ${age}`;
    chip.classList.toggle('is-stale', isStale);
  };
  update();
  window.setInterval(update, 30000);
}

async function refreshSoon(wasOffline: boolean): Promise<void> {
  if (wasOffline) return; // no Function here; the chip already says offline
  try {
    const state = await loadOrbit();
    const deltas = computeDeltas(state.payload.coins);
    coins = state.payload.coins;
    mcDeltaView = deltas;
    trackMc(coins);
    chipData = { fetchedAt: state.payload.fetchedAt, offline: false, stale: state.payload.stale };
    galaxy?.setData(coins, deltas);
    if (!galaxy) renderGrid();
    renderTape();
    updateHud();
    const mint = openPanelMint();
    if (mint) {
      const fresh = coins.find((c) => c.mint === mint);
      if (fresh) refreshOpenPanel(fresh);
    }
    const agents = coins.filter((c) => c.agent).length;
    $('status').textContent = `${coins.length} coins live · ${agents} AI-agent · ${coins.length - agents} pump.fun top 20`;
  } catch {
    /* chip keeps telling the truth; nothing to do */
  }
}

/* ---------- sector HUD: one-glance totals, updated on boot/poll/lens ---------- */

function updateHud(): void {
  const visibleList = lensCoins(coins, currentLens);
  const total = visibleList.reduce((sum, c) => sum + (c.mc > 0 ? c.mc : 0), 0);
  $('hud-mc').textContent = `Sector MC ${total >= 1e9 ? `$${(total / 1e9).toFixed(2)}B` : `$${Math.round(total / 1e6)}M`}`;
  const movers = visibleList.filter((c) => typeof c.change === 'number' && c.change > 0);
  const top = movers.sort((a, b) => (b.change ?? 0) - (a.change ?? 0))[0];
  $('hud-mover').textContent = top ? `Top mover ${top.symbol.slice(0, 10)} +${((top.change ?? 0) * 100).toFixed(1)}%` : 'no positive movers this window';
  $('hud-count').textContent = `${visibleList.length} tracked`;
}

/* ---------- keyboard: arrows walk orbs, Enter inspects ---------- */

function wireKeyboard(): void {
  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Enter') return;
    const list = lensCoins(coins, currentLens);
    if (!list.length) return;
    e.preventDefault();
    let index = list.findIndex((c) => c.mint === focusMint);
    if (e.key === 'Enter') {
      const coin = index >= 0 ? list[index] : list[0]!;
      if (coin) {
        openPanel(coin);
        focusMint = coin.mint; // Enter opens the walked-to coin, like a click
        galaxy?.setFocus(coin.mint);
      }
      return;
    }
    index = e.key === 'ArrowRight' ? (index + 1 + list.length) % list.length : (index - 1 + list.length) % list.length;
    const coin = list[index]!;
    focusMint = coin.mint;
    galaxy?.setFocus(coin.mint);
    galaxy?.pulse(coin.mint);
  });
}

/* ---------- phone gyroscope parallax (Android direct; iOS needs one tap) ---------- */

function wireGyro(): void {
  if (!('DeviceOrientationEvent' in window) || !galaxy) return;
  const attach = (): void => {
    window.addEventListener('deviceorientation', (e) => {
      const gamma = typeof e.gamma === 'number' ? e.gamma : 0; // left/right tilt
      const beta = typeof e.beta === 'number' ? e.beta : 0; // front/back tilt
      galaxy?.setTilt(gamma * 0.8, (beta - 40) * 0.6);
    });
  };
  const needsPermission =
    typeof (DeviceOrientationEvent as unknown as { requestPermission?: unknown }).requestPermission === 'function';
  if (!needsPermission) {
    attach(); // Android + others: works immediately
    return;
  }
  const button = $('tilt');
  button.hidden = false;
  button.addEventListener('click', () => {
    void (async () => {
      try {
        const result = await (DeviceOrientationEvent as unknown as { requestPermission(): Promise<string> }).requestPermission();
        if (result === 'granted') {
          attach();
          button.hidden = true;
          toast('Tilt on — move your phone');
        }
      } catch {
        toast('Tilt unavailable in this browser.');
      }
    })();
  });
}

/* ---------- the live ticker tape: numbers you can watch move ---------- */

function tapeChange(coin: OrbitCoin): number | undefined {
  const change = typeof coin.change === 'number' ? coin.change : mcDeltaView.get(coin.mint);
  return typeof change === 'number' && Math.abs(change) >= 0.0005 ? change : undefined;
}

function tapeItem(coin: OrbitCoin): HTMLElement {
  const item = document.createElement('span');
  const label = document.createElement('b');
  label.textContent = `$${coin.symbol}`;
  const mc = document.createElement('i');
  mc.textContent = formatMc(coin.mc);
  item.append(label, mc);
  const change = tapeChange(coin);
  if (change !== undefined) {
    const delta = document.createElement('em');
    delta.textContent = `${change >= 0 ? '▲ +' : '▼ '}${(change * 100).toFixed(1)}%`;
    delta.className = change >= 0 ? 'up' : 'down';
    item.append(delta);
  }
  return item;
}

let tapeTrack: HTMLDivElement | null = null;
let tapeSig = '';

/** Refresh the numbers on existing items — no DOM churn, no marquee restart. */
function fillTapeTrack(track: HTMLDivElement, list: OrbitCoin[]): void {
  const items = Array.from(track.children) as HTMLElement[];
  for (let half = 0; half < 2; half++) {
    list.forEach((coin, i) => {
      const item = items[half * list.length + i];
      if (!item) return;
      const b = item.querySelector('b');
      const mi = item.querySelector('i');
      if (b) b.textContent = `$${coin.symbol}`;
      if (mi) mi.textContent = formatMc(coin.mc);
      const change = tapeChange(coin);
      const em = item.querySelector('em');
      if (change !== undefined) {
        const text = `${change >= 0 ? '▲ +' : '▼ '}${(change * 100).toFixed(1)}%`;
        if (em) {
          em.textContent = text;
          em.className = change >= 0 ? 'up' : 'down';
        } else {
          const el = document.createElement('em');
          el.textContent = text;
          el.className = change >= 0 ? 'up' : 'down';
          item.append(el);
        }
      } else if (em) {
        em.remove();
      }
    });
  }
}

function renderTape(): void {
  const tape = $('tape');
  if (!coins.length) return;
  const list = [...coins]
    .sort((a, b) => {
      const ca = typeof a.change === 'number' ? a.change : -Infinity;
      const cb = typeof b.change === 'number' ? b.change : -Infinity;
      if (ca !== cb) return cb - ca;
      return b.mc - a.mc;
    })
    .slice(0, 14);
  if (!tapeTrack || !tapeTrack.isConnected) {
    tapeTrack = document.createElement('div');
    tapeTrack.className = 'tape-track';
    tape.replaceChildren(tapeTrack);
    tapeSig = '';
  }
  const sig = list.map((c) => c.mint).join(',');
  if (sig === tapeSig) {
    fillTapeTrack(tapeTrack, list); // same coins, same order: numbers only
    return;
  }
  tapeSig = sig;
  tapeTrack.replaceChildren();
  for (const coin of list) tapeTrack.append(tapeItem(coin));
  // Duplicate the set so the marquee loops seamlessly.
  for (const coin of list) tapeTrack.append(tapeItem(coin));
}

function renderGrid(): void {
  const grid = $('grid');
  grid.hidden = false;
  // No galaxy running: hide the canvas but keep the stage overlays (lens, search, chip).
  ($('galaxy') as HTMLCanvasElement).hidden = true;
  ($('stage') as HTMLElement).style.minHeight = 'auto';
  const list = lensCoins(coins, currentLens);
  grid.replaceChildren();
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No coins match this lens.';
    grid.append(p);
    return;
  }
  for (const coin of list) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'grid-card';
    card.addEventListener('click', () => openPanel(coin));
    const img = document.createElement('img');
    img.src = coin.image;
    img.alt = coin.name;
    img.loading = 'lazy';
    const name = document.createElement('strong');
    name.textContent = coin.name;
    const meta = document.createElement('span');
    meta.textContent = `$${coin.symbol} · ${formatMc(coin.mc)}`;
    card.append(img, name, meta);
    // Same live signals the galaxy shows: session delta + agent marker.
    const change = typeof coin.change === 'number' ? coin.change : mcDeltaView.get(coin.mint);
    const pills = document.createElement('span');
    pills.className = 'pills';
    if (typeof change === 'number' && Math.abs(change) >= 0.005) {
      const delta = document.createElement('b');
      delta.textContent = `${change >= 0 ? '▲ +' : '▼ '}${(change * 100).toFixed(1)}%`;
      delta.className = change >= 0 ? 'pill-up' : 'pill-down';
      pills.append(delta);
    }
    if (coin.agent) {
      const badge = document.createElement('b');
      badge.textContent = coin.curated ? 'AI · curated' : 'AI';
      badge.className = 'pill-agent';
      pills.append(badge);
    }
    if (pills.childElementCount) card.append(pills);
    grid.append(card);
  }
}

boot().catch((err) => {
  console.error(err);
  const grid = $('grid');
  grid.hidden = false;
  grid.replaceChildren();
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = `Orbit data could not be loaded: ${err instanceof Error ? err.message : String(err)}`;
  grid.append(p);
  $('status').textContent = 'data error — see below';
  toast('Data unavailable.');
});

// Surface any client error visibly instead of dying silently.
window.addEventListener('error', (e) => {
  $('status').textContent = `script error: ${e.message}`;
});
