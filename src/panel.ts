import { formatAge, formatMc, momentum, type OrbitCoin } from './types.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

let openMint: string | null = null;

/** Draw a tiny market-cap sparkline; placeholders when history is still forming. */
export function drawSpark(canvas: HTMLCanvasElement, history: number[] | undefined, falling: boolean): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const data = (history ?? []).filter((v) => Number.isFinite(v) && v >= 0);
  if (data.length < 2) {
    ctx.fillStyle = 'rgba(147, 163, 173, 0.8)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(data.length === 1 ? 'collecting live history…' : 'no history yet', w / 2, h / 2 + 3);
    return;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = Math.max(max - min, Math.max(max * 0.0001, 1));
  const pad = 3;
  const x = (i: number): number => pad + (i / (data.length - 1)) * (w - pad * 2);
  const y = (v: number): number => h - pad - ((v - min) / span) * (h - pad * 2);
  const color = falling ? '255, 157, 138' : '200, 255, 61';
  ctx.strokeStyle = `rgba(${color}, 0.9)`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.stroke();
  // Area tint under the line.
  ctx.lineTo(x(data.length - 1), h - pad);
  ctx.lineTo(x(0), h - pad);
  ctx.closePath();
  ctx.fillStyle = `rgba(${color}, 0.10)`;
  ctx.fill();
  // Last point dot.
  ctx.fillStyle = `rgb(${color})`;
  ctx.beginPath();
  ctx.arc(x(data.length - 1), y(data[data.length - 1]!), 2.5, 0, Math.PI * 2);
  ctx.fill();
}

/** The mint whose panel is open, or null — lets the poll loop live-refresh it. */
export function openPanelMint(): string | null {
  return openMint;
}

/** Shared row/spark rendering for open + live-refresh. */
function renderPanelData(coin: OrbitCoin): void {
  const falling = coin.history !== undefined && coin.history.length >= 2 && (coin.history[coin.history.length - 1] ?? 0) < (coin.history[0] ?? 0);
  drawSpark($('panel-spark') as HTMLCanvasElement, coin.history, falling);
  $('panel-rows').replaceChildren(
    row('Market cap', formatMc(coin.mc)),
    row('From all-time high', `${Math.round(momentum(coin) * 100)}%`),
    row(
      'Last refresh Δ',
      typeof coin.change === 'number' ? `${coin.change >= 0 ? '+' : ''}${(coin.change * 100).toFixed(1)}%` : '—'
    ),
    row('Age', formatAge(coin)),
    row('Replies', String(coin.replies)),
    row('Inclusion', coin.agent ? (coin.curated ? 'Curated AI-agent' : 'AI-agent keyword match') : 'pump.fun live top 20')
  );
}

export function openPanel(coin: OrbitCoin): void {
  openMint = coin.mint;
  $('panel-mint').textContent = coin.mint;
  $('panel-name').textContent = coin.name || 'Unnamed coin';
  $('panel-ticker').textContent = `$${coin.symbol || '?'}`;
  $('panel-desc').textContent = coin.description || 'No description submitted by the creator.';
  renderPanelData(coin);
  ($('panel-pump') as HTMLAnchorElement).href = `https://pump.fun/coin/${encodeURIComponent(coin.mint)}`;
  ($('panel-dex') as HTMLAnchorElement).href = `https://dexscreener.com/solana/${encodeURIComponent(coin.mint)}`;
  ($('panel-share') as HTMLAnchorElement).href = `/c/${encodeURIComponent(coin.mint)}`;
  $('panel-card').onclick = () => {
    void downloadCard(coin);
  };
  $('panel-backdrop').hidden = false;
  $('panel').classList.add('open');
  document.body.classList.add('panel-open');
  // Screen-reader + keyboard users land on the close control, not stranded behind the sheet.
  ($('panel-close') as HTMLButtonElement).focus({ preventScroll: true });
}

export function closePanel(): void {
  openMint = null;
  $('panel').classList.remove('open');
  $('panel-backdrop').hidden = true;
  document.body.classList.remove('panel-open');
}

/**
 * Live-refresh the open panel with fresh data, flashing the MC row green or
 * red when it moved since the panel was opened. No-op when nothing is open.
 */
export function refreshOpenPanel(coin: OrbitCoin): void {
  if (openMint !== coin.mint) return;
  const rows = $('panel-rows');
  const flash = (up: boolean): void => {
    rows.classList.remove('flash-up', 'flash-down');
    void rows.offsetWidth; // restart the CSS animation
    rows.classList.add(up ? 'flash-up' : 'flash-down');
  };
  if (typeof coin.change === 'number' && Math.abs(coin.change) >= 0.0005) flash(coin.change > 0);
  renderPanelData(coin);
}

function row(label: string, value: string): HTMLElement {
  const div = document.createElement('div');
  const left = document.createElement('span');
  left.textContent = label;
  const right = document.createElement('span');
  right.textContent = value;
  div.append(left, right);
  return div;
}

export function toast(message: string): void {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  window.setTimeout(() => el.classList.remove('show'), 2800);
}

/* ---------- share card: 1200 x 675 PNG, drawn client-side ---------- */

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'coin';
}

function loadCoinImage(url: string, timeoutMs = 3500): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = window.setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => {
      window.clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      resolve(null); // tainting or dead CDN -> draw the letter fallback
    };
    img.src = url;
  });
}

export async function drawCoinCard(coin: OrbitCoin): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 675;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');

  const bg = ctx.createLinearGradient(0, 0, 1200, 675);
  bg.addColorStop(0, '#0a0e14');
  bg.addColorStop(0.63, '#121a24');
  bg.addColorStop(1, '#0a0e14');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 1200, 675);
  const glow = ctx.createRadialGradient(960, 220, 0, 960, 220, 700);
  glow.addColorStop(0, 'rgba(200,255,61,0.14)');
  glow.addColorStop(1, 'rgba(200,255,61,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 1200, 675);

  ctx.strokeStyle = 'rgba(200,255,61,0.65)';
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 24, 1152, 627);

  // Coin image (or acid letter fallback).
  const img = await loadCoinImage(coin.image);
  const cx = 910;
  const cy = 300;
  const r = 150;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  if (img) {
    ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = '#c8ff3d';
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.fillStyle = '#0a0d12';
    ctx.font = `700 ${r}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((coin.name[0] ?? '?').toUpperCase(), cx, cy);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(200,255,61,0.8)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#c8ff3d';
  ctx.font = '500 20px ui-monospace, monospace';
  ctx.fillText('AI AGENT / PUMP.FUN', 64, 92);

  let size = 64;
  const name = coin.name.toUpperCase();
  ctx.font = `700 ${size}px system-ui, sans-serif`;
  while (ctx.measureText(name).width > 660 && size > 30) {
    size -= 4;
    ctx.font = `700 ${size}px system-ui, sans-serif`;
  }
  ctx.fillStyle = '#f2f6f3';
  ctx.fillText(name, 64, 210, 660);
  ctx.fillStyle = '#c8ff3d';
  ctx.font = '700 26px ui-monospace, monospace';
  ctx.fillText(`$${coin.symbol.toUpperCase()}`, 64, 258);

  ctx.fillStyle = '#f2f6f3';
  ctx.font = '500 22px ui-monospace, monospace';
  ctx.fillText(`MC ${formatMc(coin.mc)}   ·   ${formatAge(coin).toUpperCase()}   ·   ${coin.replies} REPLIES`, 64, 380);

  const barW = 560;
  ctx.fillStyle = '#26313d';
  ctx.fillRect(64, 420, barW, 10);
  ctx.fillStyle = '#c8ff3d';
  ctx.fillRect(64, 420, barW * Math.max(0.03, momentum(coin)), 10);

  ctx.fillStyle = '#93a3ad';
  ctx.font = '500 17px ui-monospace, monospace';
  ctx.fillText('AGENTORBIT · INDEXED, NOT VERIFIED · NOT FINANCIAL ADVICE', 64, 610);
  ctx.fillText('/c/' + coin.mint, 64, 635);

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Card export failed'))), 'image/png')
  );
}

export async function downloadCard(coin: OrbitCoin): Promise<void> {
  try {
    const blob = await drawCoinCard(coin);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agentorbit-${slug(coin.name)}.png`;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('Coin card downloaded');
  } catch {
    toast('Card export failed in this browser.');
  }
}
