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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });

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
    trackMc(coins);
    galaxy.setData(coins); // boot handoff: the lens already defaults to "now"
    galaxy.setLens(currentLens);
    renderTape();
    updateHud();
    wireKeyboard();
    wireGyro();
    // Live rank churn: poll every 30 s; the server cache refreshes on its
    // own 90 s TTL, so numbers visibly tick and movers rearrange.
    window.setInterval(() => void refreshSoon(state.offline), 30 * 1000);
  }

  const agents = coins.filter((c) => c.agent).length;
  $('status').textContent = `${coins.length} coins live · ${agents} AI-agent · ${coins.length - agents} pump.fun top 20${state.offline ? ' · offline seed' : ''}`;
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
      input.value = '';
      input.dispatchEvent(new Event('input'));
      input.blur();
    }
  });
  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    if (!query || !coins.length) {
      galaxy?.setVisible(null);
      $('search-count').textContent = '';
      if (!galaxy) filterGrid('');
      return;
    }
    const mints = new Set<string>();
    for (const coin of coins) {
      if (coin.name.toLowerCase().includes(query) || coin.symbol.toLowerCase().includes(query)) mints.add(coin.mint);
    }
    galaxy?.setVisible(mints);
    $('search-count').textContent = mints.size ? `${mints.size} match${mints.size === 1 ? '' : 'es'}` : 'no matches';
    if (!galaxy) filterGrid(query);
  });
}

function filterGrid(query: string): void {
  const grid = $('grid');
  for (const card of grid.querySelectorAll<HTMLButtonElement>('.grid-card')) {
    const name = (card.querySelector('strong')?.textContent ?? '').toLowerCase();
    const meta = (card.querySelector('span')?.textContent ?? '').toLowerCase();
    card.hidden = Boolean(query) && !name.includes(query) && !meta.includes(query);
  }
}

function wireChip(fetchedAt: number, offline: boolean, stale: boolean): void {
  const chip = $('chip');
  const update = (): void => {
    const minutes = Math.max(0, Math.round((Date.now() - fetchedAt) / 60000));
    const age = minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min old` : `${Math.round(minutes / 60)} h old`;
    chip.textContent = offline ? `offline data · ${age}` : stale ? `stale · ${age}` : `live · ${age}`;
    chip.classList.toggle('is-stale', offline || stale);
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

function tapeItem(coin: OrbitCoin): HTMLElement {
  const item = document.createElement('span');
  const label = document.createElement('b');
  label.textContent = `$${coin.symbol}`;
  const mc = document.createElement('i');
  mc.textContent = formatMc(coin.mc);
  item.append(label, mc);
  const change = typeof coin.change === 'number' ? coin.change : mcDeltaView.get(coin.mint);
  if (typeof change === 'number' && Math.abs(change) >= 0.0005) {
    const delta = document.createElement('em');
    delta.textContent = `${change >= 0 ? '▲ +' : '▼ '}${(change * 100).toFixed(1)}%`;
    delta.className = change >= 0 ? 'up' : 'down';
    item.append(delta);
  }
  return item;
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
  tape.replaceChildren();
  const track = document.createElement('div');
  track.className = 'tape-track';
  for (const coin of list) track.append(tapeItem(coin));
  // Duplicate the set so the marquee loops seamlessly.
  for (const coin of list) track.append(tapeItem(coin));
  tape.append(track);
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
