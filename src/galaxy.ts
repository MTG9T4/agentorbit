import { ageHours, lensCoins, momentum, type Lens, type OrbitCoin } from './types.js';

export interface GalaxyHooks {
  onHover(coin: OrbitCoin | null, screenX: number, screenY: number): void;
  onSelect(coin: OrbitCoin): void;
  /** Called once if the render loop throws — surfaces the bug instead of dying silently. */
  onError?(message: string): void;
}

interface Orb {
  coin: OrbitCoin;
  hue: number; // stable, derived from the mint
  sat: number;
  angle: number;
  speed: number; // rad/s orbital drift
  ring: number; // current orbit radius (springs toward targetRing)
  targetRing: number;
  size: number; // current size (springs toward targetSize)
  targetSize: number;
  alpha: number;
  targetAlpha: number;
  spawn: number; // 0..1 spawn-in progress (starts after spawnAt)
  spawnAt: number;
  hoverT: number; // 0..1 hover emphasis spring
  dead: boolean;
  px: number; // last drawn position (hit-testing, labels, ripples)
  py: number;
  trail: number[]; // recent positions [x0,y0,x1,y1,…] — the comet trail
}

interface Star {
  x: number;
  y: number;
  tw: number; // twinkle rate
  ph: number; // phase
  amp: number;
}

interface Ripple {
  x: number;
  y: number;
  start: number;
}

/** A rare shooting star crossing the field — pure ambience, no interaction. */
interface Streak {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  start: number;
  dur: number;
}

function hashFloat(mint: string): { angle: number; hue: number; speed: number } {
  let h = 0x811c9dc5;
  for (let i = 0; i < mint.length; i++) {
    h ^= mint.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const a = (h % 10000) / 10000;
  const hue = Math.floor(((h % 1000003) / 1000003) * 360);
  const speed = 0.012 + ((h % 7919) / 7919) * 0.028;
  return { angle: a * Math.PI * 2, hue, speed };
}

/**
 * Size target from live market cap. Bubbles scale by sqrt(mc) normalized to
 * the currently visible set — the visual area roughly tracks actual market
 * cap. Session deltas (movers) swell an orb above its base size; droppers
 * shrink below.
 */
function orbTargetSize(mc: number, mcDelta: number | undefined, minMc: number, maxMc: number): number {
  if (!mc) return 9;
  const range = Math.sqrt(Math.max(0, maxMc)) - Math.sqrt(Math.max(0, minMc));
  const t = range > 0 ? Math.max(0, (Math.sqrt(mc) - Math.sqrt(Math.max(0, minMc))) / range) : 0.5;
  const growth = mcDelta === undefined ? 0 : 0.4 * Math.min(1, Math.max(-0.5, mcDelta));
  return Math.max(9, (10 + t * 70) * (1 + growth));
}

const TRAIL_POINTS = 34;

export class Galaxy {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private orbs = new Map<string, Orb>();
  private coins: OrbitCoin[] = [];
  private mcDelta: Map<string, number> | null = null;
  private lens: Lens = 'now';
  private hooks: GalaxyHooks;
  private width = 0;
  private height = 0;
  private dpr = 1;
  private time = 0;
  private lastFrame = 0;
  private rafId = 0;
  private running = false;
  private parallaxX = 0;
  private parallaxY = 0;
  private parallaxTX = 0;
  private parallaxTY = 0;
  private zoom = 1; // cinematic breathing (idle mode)
  private zoomT = 1;
  private hovered: Orb | null = null;
  private focused: string | null = null; // keyboard focus mint
  private visible: Set<string> | null = null;
  private stars: Star[] = [];
  private ripples: Ripple[] = [];
  private streaks: Streak[] = [];
  private nextStreak = 7; // first streak ~7 s after boot
  private lastInteraction = 0;
  private cineT = 0; // 0..1 cinematic blend
  private resizeObserver: ResizeObserver | null = null;
  private reportedError = false;

  constructor(canvas: HTMLCanvasElement, hooks: GalaxyHooks) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    this.ctx = ctx;
    this.hooks = hooks;
    this.lastInteraction = 0;
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('click', this.onClick);
    this.running = true;
    this.lastFrame = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  /**
   * Replace the dataset. Rank changes retarget the ring radius (orbs glide
   * inward/outward), new coins spawn in a staggered wave from the core, and
   * dropped coins fade out.
   */
  setData(coins: OrbitCoin[], mcDelta?: Map<string, number>): void {
    this.coins = coins;
    this.mcDelta = mcDelta ?? null;
    const ranked = lensCoins(coins, this.lens, 25, this.mcDelta ?? undefined);
    const seen = new Set<string>();
    const n = ranked.length;
    const R = this.radius();
    const mcs = ranked.map((c) => c.mc).filter((v) => v > 0);
    const minMc = mcs.length ? Math.min(...mcs) : 1;
    const maxMc = mcs.length ? Math.max(...mcs) : 1;
    ranked.forEach((coin, i) => {
      seen.add(coin.mint);
      const t = n === 1 ? 0 : i / (n - 1);
      const targetRing = R * (0.24 + 0.7 * t);
      const { hue, angle, speed } = hashFloat(coin.mint);
      const targetSize = orbTargetSize(coin.mc, this.mcDelta?.get(coin.mint), minMc, maxMc);
      const orb = this.orbs.get(coin.mint);
      if (orb) {
        orb.coin = coin;
        orb.hue = hue;
        orb.sat = coin.mc ? 88 : 25; // keep grey→vivid in sync when an MC fills in or drains
        orb.targetRing = targetRing;
        orb.targetSize = targetSize;
        orb.dead = false;
        orb.targetAlpha = 1;
      } else {
        this.orbs.set(coin.mint, {
          coin,
          hue,
          sat: coin.mc ? 88 : 25,
          angle,
          speed,
          ring: 0, // spawns from the core, then rises to its ring
          targetRing,
          size: 6,
          targetSize,
          alpha: 0,
          targetAlpha: 1,
          spawn: 0,
          spawnAt: this.time + (i % 25) * 0.045, // staggered entrance wave
          hoverT: 0,
          dead: false,
          px: -999,
          py: -999,
          trail: [],
        });
      }
    });
    for (const orb of this.orbs.values()) {
      if (!seen.has(orb.coin.mint)) {
        orb.dead = true;
        orb.targetAlpha = 0;
      }
    }
    if (this.focused !== null && !seen.has(this.focused)) this.focused = null;
  }

  setLens(lens: Lens): void {
    this.lens = lens;
    this.setData(this.coins, this.mcDelta ?? undefined);
  }

  /** null = show all; otherwise only these mints stay lit (search). */
  setVisible(mints: Set<string> | null): void {
    this.visible = mints;
  }

  /** Keyboard focus ring. */
  setFocus(mint: string | null): void {
    this.focused = mint;
    this.interact();
  }

  findOrb(mint: string): OrbitCoin | null {
    return this.orbs.get(mint)?.coin ?? null;
  }

  /** Phone gyroscope: map tilt to parallax. */
  setTilt(x: number, y: number): void {
    this.parallaxTX = Math.min(24, Math.max(-24, x));
    this.parallaxTY = Math.min(18, Math.max(-18, y));
    this.interact();
  }

  /** Any interaction exits the idle cinematic. */
  interact(): void {
    this.lastInteraction = this.time;
  }

  /** Expanding ring at a coin's orb — selection feedback. */
  pulse(mint: string): void {
    const orb = this.orbs.get(mint);
    if (orb && orb.px > -100) this.ripples.push({ x: orb.px, y: orb.py, start: this.time });
  }

  /** Render health for the status line: frames drawn, orb count, average alpha. */
  stats(): { frames: number; orbs: number; avgAlpha: number } {
    let sum = 0;
    for (const orb of this.orbs.values()) sum += orb.alpha;
    return {
      frames: Math.round(this.time * 60),
      orbs: this.orbs.size,
      avgAlpha: this.orbs.size ? sum / this.orbs.size : 0,
    };
  }

  private radius(): number {
    return Math.max(80, Math.min(this.width, this.height) / 2 - 60);
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    const w = parent?.clientWidth ?? this.canvas.clientWidth;
    const h = parent?.clientHeight ?? this.canvas.clientHeight;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.makeStars();
    // Preserve session deltas across resizes — a window/orientation change
    // must not silently drain the movers' swell.
    this.setData(this.coins, this.mcDelta ?? undefined);
  }

  private makeStars(): void {
    // Keep the existing field across resizes (no full-sky reshuffle on every
    // rotation); clamp drifters back in-bounds and top up to a full 120.
    const kept = this.stars.filter((s) => s.x <= this.width && s.y <= this.height);
    for (const s of kept) {
      s.x = Math.min(s.x, this.width);
      s.y = Math.min(s.y, this.height);
    }
    for (let i = kept.length; i < 120; i++) {
      kept.push({
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        tw: 0.4 + Math.random() * 1.4,
        ph: Math.random() * Math.PI * 2,
        amp: 0.35 + Math.random() * 0.45,
      });
    }
    this.stars = kept;
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      this.running = false;
      cancelAnimationFrame(this.rafId);
    } else if (!this.running) {
      this.running = true;
      this.lastFrame = performance.now();
      this.rafId = requestAnimationFrame(this.frame);
    }
  };

  private canvasPoint(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private hitTest(x: number, y: number): Orb | null {
    let best: Orb | null = null;
    let bestDist = Infinity;
    for (const orb of this.orbs.values()) {
      if (orb.dead || orb.alpha < 0.2) continue;
      const d = Math.hypot(orb.px - x, orb.py - y);
      if (d < orb.size / 2 + 14 && d < bestDist) {
        best = orb;
        bestDist = d;
      }
    }
    return best;
  }

  private onPointerMove = (e: PointerEvent): void => {
    const { x, y } = this.canvasPoint(e);
    this.interact();
    if (e.pointerType !== 'touch') {
      this.parallaxTX = ((x / this.width) * 2 - 1) * -12;
      this.parallaxTY = ((y / this.height) * 2 - 1) * -8;
    } else {
      return; // taps go straight to the inspect panel — no hover-card flash on phones
    }
    const hit = this.hitTest(x, y);
    this.hovered = hit;
    this.canvas.style.cursor = hit ? 'pointer' : 'default';
    const rect = this.canvas.getBoundingClientRect();
    this.hooks.onHover(
      hit?.coin ?? null,
      hit ? rect.left + hit.px : e.clientX,
      rect.top + (hit ? hit.py - hit.size / 2 : e.clientY)
    );
  };

  private onPointerLeave = (): void => {
    this.hovered = null;
    this.parallaxTX = 0;
    this.parallaxTY = 0;
    this.hooks.onHover(null, 0, 0);
  };

  private onClick = (e: MouseEvent): void => {
    const { x, y } = this.canvasPoint(e);
    this.interact();
    const hit = this.hitTest(x, y);
    if (hit) {
      this.pulse(hit.coin.mint);
      this.hooks.onSelect(hit.coin);
    }
  };

  private frame = (now: number): void => {
    if (!this.running) return;
    const dt = Math.min(0.05, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.time += dt;
    try {
      this.step(dt);
      this.draw();
    } catch (err) {
      if (!this.reportedError) {
        this.reportedError = true;
        this.hooks.onError?.(err instanceof Error ? err.message : String(err));
      }
    }
    this.rafId = requestAnimationFrame(this.frame);
  };

  private step(dt: number): void {
    const glide = 1 - Math.exp(-dt * 5);
    const glideSoft = 1 - Math.exp(-dt * 3);
    const sizeGlide = 1 - Math.exp(-dt * 2.2);

    // Idle cinematic: after 30 s untouched, drift the camera and breathe the zoom.
    const idle = this.time - this.lastInteraction;
    const cineTarget = idle > 30 ? 1 : 0;
    this.cineT += (cineTarget - this.cineT) * (1 - Math.exp(-dt * 0.5));
    if (this.cineT > 0.01) {
      const driftX = Math.sin(this.time * 0.11) * 22;
      const driftY = Math.cos(this.time * 0.07) * 14;
      this.parallaxTX = this.parallaxTX * (1 - this.cineT) + driftX * this.cineT;
      this.parallaxTY = this.parallaxTY * (1 - this.cineT) + driftY * this.cineT;
    }
    this.zoomT = 1 + 0.05 * this.cineT * (0.5 + 0.5 * Math.sin(this.time * 0.18));
    this.zoom += (this.zoomT - this.zoom) * glideSoft;

    this.parallaxX += (this.parallaxTX - this.parallaxX) * glideSoft;
    this.parallaxY += (this.parallaxTY - this.parallaxY) * glideSoft;
    for (const orb of this.orbs.values()) {
      if (this.time >= orb.spawnAt) {
        orb.spawn = Math.min(1, orb.spawn + dt * 1.6);
      }
      // Continuous orbital drift; active coins orbit a little faster.
      const heat = 1 + Math.min(1, Math.log10(orb.coin.replies + 1) / 2);
      orb.angle += orb.speed * heat * dt * (orb.dead ? 0 : 1);
      orb.ring += (orb.targetRing - orb.ring) * glideSoft;
      orb.size += (orb.targetSize - orb.size) * sizeGlide;
      orb.alpha += (orb.targetAlpha - orb.alpha) * (1 - Math.exp(-dt * 4));
      orb.hoverT += ((this.hovered === orb ? 1 : 0) - orb.hoverT) * glide;
    }
    for (const [mint, orb] of this.orbs) {
      if (orb.dead && orb.alpha < 0.02) this.orbs.delete(mint);
    }
    this.ripples = this.ripples.filter((r) => this.time - r.start < 0.7);

    // Ambient shooting stars: one every 9–18 s, ~1.2 s crossing.
    if (this.time > this.nextStreak) {
      this.nextStreak = this.time + 9 + Math.random() * 9;
      const fromLeft = Math.random() < 0.5;
      const x0 = fromLeft ? -30 : this.width + 30;
      const dir = fromLeft ? 1 : -1;
      const y0 = Math.random() * this.height * 0.55;
      this.streaks.push({
        x0,
        y0,
        x1: x0 + dir * (this.width * 0.45 + Math.random() * this.width * 0.35),
        y1: y0 + 40 + Math.random() * 110,
        start: this.time,
        dur: 1.2,
      });
    }
    this.streaks = this.streaks.filter((s) => this.time - s.start < s.dur);
  }

  private draw(): void {
    const { ctx, width, height, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const cx = width / 2 + this.parallaxX;
    const cy = height / 2 + this.parallaxY;
    const R = this.radius();

    // Cinematic zoom around the field center.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-cx, -cy);

    // Nebula wash: two large, faint color fields so the black never feels flat.
    const neb1 = ctx.createRadialGradient(cx - R * 0.7, cy - R * 0.5, 0, cx - R * 0.7, cy - R * 0.5, R * 1.1);
    neb1.addColorStop(0, 'rgba(64, 120, 140, 0.07)');
    neb1.addColorStop(1, 'rgba(64, 120, 140, 0)');
    ctx.fillStyle = neb1;
    ctx.fillRect(0, 0, width, height);
    const neb2 = ctx.createRadialGradient(cx + R * 0.8, cy + R * 0.6, 0, cx + R * 0.8, cy + R * 0.6, R * 1.0);
    neb2.addColorStop(0, 'rgba(120, 90, 180, 0.06)');
    neb2.addColorStop(1, 'rgba(120, 90, 180, 0)');
    ctx.fillStyle = neb2;
    ctx.fillRect(0, 0, width, height);

    // Twinkling starfield — depth behind everything.
    for (const star of this.stars) {
      const twinkle = star.amp * (0.5 + 0.5 * Math.sin(this.time * star.tw + star.ph));
      ctx.fillStyle = `rgba(190, 210, 220, ${(0.12 + 0.2 * twinkle).toFixed(3)})`;
      ctx.fillRect(star.x, star.y, 1, 1);
    }

    // Shooting stars — a bright head with a fading acid tail.
    for (const s of this.streaks) {
      const t = (this.time - s.start) / s.dur;
      const head = easeOut(t);
      const tail = Math.max(0, head - 0.28);
      const px = (u: number): number => s.x0 + (s.x1 - s.x0) * u;
      const py = (u: number): number => s.y0 + (s.y1 - s.y0) * u;
      const alpha = t < 0.15 ? t / 0.15 : Math.max(0, 1 - (t - 0.15) / 0.85);
      const grad = ctx.createLinearGradient(px(tail), py(tail), px(head), py(head));
      grad.addColorStop(0, 'rgba(200, 255, 61, 0)');
      grad.addColorStop(1, `rgba(235, 255, 210, ${(0.75 * alpha).toFixed(3)})`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(px(tail), py(tail));
      ctx.lineTo(px(head), py(head));
      ctx.stroke();
      if (alpha > 0.05) {
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(px(head), py(head), 1.7, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Orbit rings + a soft core glow that breathes slowly.
    ctx.strokeStyle = 'rgba(38, 49, 61, 0.55)';
    ctx.lineWidth = 1;
    for (const r of [0.24, 0.4, 0.6, 0.8, 0.94]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * r, 0, Math.PI * 2);
      ctx.stroke();
    }
    const coreBreathe = Math.sin(this.time * 0.7);
    const coreR = R * 0.35 * (1 + 0.06 * coreBreathe);
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    core.addColorStop(0, `rgba(200, 255, 61, ${(0.09 + 0.035 * coreBreathe).toFixed(3)})`);
    core.addColorStop(1, 'rgba(200, 255, 61, 0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();

    // Selection ripples.
    for (const ripple of this.ripples) {
      const t = (this.time - ripple.start) / 0.7;
      const ease = 1 - Math.pow(1 - t, 3);
      ctx.strokeStyle = `rgba(200, 255, 61, ${0.5 * (1 - ease)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ripple.x, ripple.y, 10 + ease * 90, 0, Math.PI * 2);
      ctx.stroke();
    }

    const orbs = [...this.orbs.values()].sort((a, b) => b.size - a.size);
    let labeled = 0;
    const constellation: Array<{ orb: Orb; a: number }> = [];
    for (const orb of orbs) {
      if (orb.alpha < 0.02) continue;
      const visibleNow = !this.visible || this.visible.has(orb.coin.mint);
      const dimmed = !visibleNow ? 0.12 : 1;
      // Spotlight: hovering dims every other orb to keep the one in focus.
      const spotlit = this.hovered ? (this.hovered === orb ? 1 : 0.28) : 1;
      const a = orb.alpha * dimmed * spotlit * Math.min(1, orb.spawn * 1.4);
      if (a <= 0.02) continue;

      const spawnScale = 0.4 + 0.6 * easeOut(orb.spawn);
      // Search matches stand slightly proud of the dimmed field.
      const matchBoost = this.visible && visibleNow ? 1.08 : 1;
      const size = orb.size * spawnScale * (1 + 0.14 * orb.hoverT) * matchBoost;
      const ox = cx + Math.cos(orb.angle) * orb.ring;
      const oy = cy + Math.sin(orb.angle) * orb.ring * 0.96; // slight ellipse for depth
      orb.px = ox;
      orb.py = oy;

      // Comet trail: fading, tapering arc of recent positions — thin at the
      // tail, fuller at the head.
      orb.trail.push(ox, oy);
      if (orb.trail.length > TRAIL_POINTS * 2) orb.trail.splice(0, orb.trail.length - TRAIL_POINTS * 2);
      if (orb.trail.length >= 4 && a > 0.05) {
        for (let i = 2; i + 1 < orb.trail.length; i += 2) {
          const t = i / orb.trail.length; // 0 at tail … ~1 at head
          const fade = t * 0.24 * a;
          ctx.lineWidth = 0.5 + t * 1.6;
          ctx.strokeStyle = `hsla(${orb.hue}, ${orb.sat}%, 62%, ${fade.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(orb.trail[i - 2]!, orb.trail[i - 1]!);
          ctx.lineTo(orb.trail[i]!, orb.trail[i + 1]!);
          ctx.stroke();
        }
      }

      const m = momentum(orb.coin);
      const hours = ageHours(orb.coin);
      const isNew = Number.isFinite(hours) && hours < 24;
      const hue = orb.hue;
      const sat = orb.sat;
      const pulse = 1 + 0.06 * Math.sin(this.time * (1.4 + Math.min(2.2, Math.log10(orb.coin.replies + 1))) + orb.angle);

      // Glow.
      const glowR = size * 1.5 * pulse;
      const glow = ctx.createRadialGradient(ox, oy, 0, ox, oy, glowR);
      glow.addColorStop(0, `hsla(${hue}, ${sat + 5}%, 60%, ${(0.16 + 0.3 * m) * a})`);
      glow.addColorStop(1, `hsla(${hue}, ${sat}%, 60%, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(ox, oy, glowR, 0, Math.PI * 2);
      ctx.fill();

      // Body.
      const body = ctx.createRadialGradient(ox - size * 0.2, oy - size * 0.2, size * 0.1, ox, oy, size / 2);
      body.addColorStop(0, `hsla(${hue}, 100%, 90%, ${0.95 * a})`);
      body.addColorStop(0.55, `hsla(${hue}, ${sat}%, 62%, ${(0.75 + 0.25 * m) * a})`);
      body.addColorStop(1, `hsla(${hue}, ${sat}%, 50%, ${0.4 * a})`);
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(ox, oy, size / 2, 0, Math.PI * 2);
      ctx.fill();

      // Category core: green dot = AI-agent coin, white dot = pump.fun top coin.
      const coreR = Math.max(2.5, size * 0.12);
      ctx.fillStyle = orb.coin.agent ? `rgba(200, 255, 61, ${0.95 * a})` : `rgba(241, 246, 243, ${0.85 * a})`;
      ctx.beginPath();
      ctx.arc(ox, oy, coreR, 0, Math.PI * 2);
      ctx.fill();

      // New-launch halo (dashed ring), curated double-ring, hover ring.
      ctx.lineWidth = 1.5;
      if (isNew) {
        ctx.strokeStyle = `hsla(${hue}, ${sat}%, 70%, ${0.85 * a})`;
        ctx.setLineDash([4, 5]);
        ctx.beginPath();
        ctx.arc(ox, oy, size / 2 + 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (orb.coin.curated) {
        ctx.strokeStyle = `rgba(241, 255, 224, ${0.55 * a})`;
        ctx.beginPath();
        ctx.arc(ox, oy, size / 2 + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (orb.hoverT > 0.03) {
        ctx.strokeStyle = `rgba(242, 246, 243, ${0.85 * orb.hoverT * a})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(ox, oy, size / 2 + 8, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Movers ring: coins up ≥5% this cycle breathe an acid halo — the
      // "something is happening here" signal, visible without hovering.
      const gain = typeof orb.coin.change === 'number' ? orb.coin.change : 0;
      if (gain >= 0.05) {
        const breathe = 0.5 + 0.5 * Math.sin(this.time * 3 + orb.angle * 3);
        ctx.strokeStyle = `rgba(200, 255, 61, ${(0.25 + 0.35 * breathe) * a})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(ox, oy, size / 2 + 5 + breathe * 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Keyboard focus ring — a slow rotating dashed circle.
      if (this.focused === orb.coin.mint) {
        ctx.strokeStyle = `rgba(242, 246, 243, ${0.9 * a})`;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 6]);
        ctx.lineDashOffset = -this.time * 20;
        ctx.beginPath();
        ctx.arc(ox, oy, size / 2 + 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineDashOffset = 0;
      }

      // Ticker labels for the twelve biggest, non-dimmed orbs — on a dark
      // pill so they stay readable over bright orbs, in their own hue.
      if (visibleNow && labeled < 12 && size > 22) {
        labeled++;
        const text = orb.coin.symbol.slice(0, 8).toUpperCase();
        ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        const tw = ctx.measureText(text).width;
        const lx = ox - tw / 2 - 6;
        const ly = oy + size / 2 + 7;
        ctx.fillStyle = 'rgba(8, 12, 17, 0.72)';
        fillRoundRect(ctx, lx, ly, tw + 12, 16, 8);
        ctx.fill();
        ctx.fillStyle = `hsla(${hue}, ${Math.max(35, sat)}%, 74%, ${0.95 * a})`;
        ctx.textAlign = 'center';
        ctx.fillText(text, ox, ly + 12);
      }

      if (visibleNow && this.visible) constellation.push({ orb, a });
    }

    // Search constellation: connect matching orbs with glowing lines.
    if (constellation.length >= 2) {
      constellation.sort((p, q) => Math.atan2(p.orb.py - cy, p.orb.px - cx) - Math.atan2(q.orb.py - cy, q.orb.px - cx));
      ctx.lineWidth = 1.2;
      for (let i = 0; i < constellation.length; i++) {
        const from = constellation[i]!;
        const to = constellation[(i + 1) % constellation.length]!;
        ctx.strokeStyle = `rgba(200, 255, 61, ${0.22 * Math.min(from.a, to.a)})`;
        ctx.beginPath();
        ctx.moveTo(from.orb.px, from.orb.py);
        ctx.lineTo(to.orb.px, to.orb.py);
        ctx.stroke();
      }
    }

    ctx.restore(); // cinematic zoom

    // Vignette in screen space: darkened corners pull the eye to the field.
    const vig = ctx.createRadialGradient(
      width / 2, height / 2, Math.min(width, height) * 0.42,
      width / 2, height / 2, Math.max(width, height) * 0.72
    );
    vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vig.addColorStop(1, 'rgba(2, 4, 7, 0.42)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, width, height);
  }
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Trace a rounded-rect path (caller fills/strokes it). */
function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
