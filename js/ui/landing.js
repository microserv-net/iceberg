/* ICEBERG — the landing page.
 *
 * The berg is drawn, not illustrated: its shape comes from a fixed seed, so the
 * page looks identical on every load, and the descent is bound to scroll
 * position rather than to a timer. Nothing animates on its own except the
 * bubbles, and those stop entirely when the visitor has asked for less motion.
 *
 * The proportions carry the argument: a tenth above the waterline is the
 * session, the rest below is what is already in the repository.
 */

import { reduceMotion, sleep } from '../util.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/* deterministic noise — the same core every time */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* the hero berg: a waterline, a little freeboard, an enormous keel     */
/* ------------------------------------------------------------------ */

/* Proportions are not decorative. The mass above the line is about a tenth of
 * the mass below it, because that ratio is the entire argument of the product:
 * the session you are looking at is the small part. */

function bergOutline(rand, W, H, waterY) {
  // freeboard — jagged, lit, small
  const top = [];
  const peaks = 7;
  for (let i = 0; i <= peaks; i++) {
    const t = i / peaks;
    const x = 46 + t * (W - 92);
    const lift = i === 0 || i === peaks ? 0 : (0.35 + rand() * 0.65);
    const y = waterY - lift * (waterY - 54) * (0.55 + 0.45 * Math.sin(t * Math.PI));
    top.push([x, y]);
  }
  // keel — wide, deep, smoother
  const keel = [];
  const ribs = 9;
  for (let i = 0; i <= ribs; i++) {
    const t = i / ribs;
    const y = waterY + t * (H - 30 - waterY);
    const bulge = Math.sin(t * Math.PI * 0.92) * (0.72 + rand() * 0.28);
    const halfW = 30 + bulge * (W / 2 - 26);
    keel.push([halfW, y]);
  }
  const right = keel.map(([w, y]) => [W / 2 + w, y]);
  const left = [...keel].reverse().map(([w, y]) => [W / 2 - w, y]);
  return { top, right, left };
}

const poly = (pts) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');

function drawBerg(root) {
  const W = 220, H = 620;
  const waterY = 196;                       // ~26% of the height above water
  const rand = rng(0xb3467);
  root.innerHTML = '';

  const defs = svg('defs');

  const above = svg('linearGradient', { id: 'bergAbove', x1: '0', y1: '0', x2: '.4', y2: '1' });
  [['0%', '#eaf7ff', .96], ['55%', '#9fd8ef', .9], ['100%', '#5fa9c9', .85]]
    .forEach(([o, c, a]) => above.append(svg('stop', { offset: o, 'stop-color': c, 'stop-opacity': a })));

  const below = svg('linearGradient', { id: 'bergBelow', x1: '0', y1: '0', x2: '0', y2: '1' });
  [['0%', '#4fbfe0', .55], ['35%', '#1d6b93', .38], ['100%', '#08243a', .16]]
    .forEach(([o, c, a]) => below.append(svg('stop', { offset: o, 'stop-color': c, 'stop-opacity': a })));

  const sea = svg('linearGradient', { id: 'seaFade', x1: '0', y1: '0', x2: '0', y2: '1' });
  [['0%', '#0a2438', .55], ['100%', '#04070c', 0]]
    .forEach(([o, c, a]) => sea.append(svg('stop', { offset: o, 'stop-color': c, 'stop-opacity': a })));

  const glow = svg('filter', { id: 'bergGlow', x: '-50%', y: '-30%', width: '200%', height: '180%' });
  glow.append(svg('feGaussianBlur', { stdDeviation: '7', result: 'b' }));
  const merge = svg('feMerge');
  merge.append(svg('feMergeNode', { in: 'b' }), svg('feMergeNode', { in: 'SourceGraphic' }));
  glow.append(merge);

  defs.append(above, below, sea, glow);
  root.append(defs);

  // the sea below the line
  root.append(svg('rect', { x: 0, y: waterY, width: W, height: H - waterY, fill: 'url(#seaFade)' }));

  const { top, right, left } = bergOutline(rand, W, H, waterY);

  // keel: the nine tenths
  const keelPath = svg('path', {
    d: `${poly(right)}${poly(left).replace('M', 'L')}Z`,
    fill: 'url(#bergBelow)',
    stroke: 'rgba(127,227,255,.22)',
    'stroke-width': 1,
    class: 'berg-keel',
  });
  root.append(keelPath);

  // internal facets, so the keel reads as ice rather than a blob
  const facets = svg('g', { opacity: '.35' });
  for (let i = 1; i < right.length - 1; i++) {
    const [rx, ry] = right[i];
    const lx = W - rx;
    facets.append(svg('line', {
      x1: lx + (rx - lx) * rand() * .4, y1: ry,
      x2: rx - (rx - lx) * rand() * .35, y2: ry + 18 + rand() * 30,
      stroke: 'rgba(127,227,255,.35)', 'stroke-width': .7,
    }));
  }
  root.append(facets);

  // freeboard: the one tenth
  const capPts = [[left.at(-1)[0], waterY], ...top, [right[0][0], waterY]];
  root.append(svg('path', {
    d: `${poly(capPts)}Z`,
    fill: 'url(#bergAbove)',
    stroke: 'rgba(233,243,255,.55)',
    'stroke-width': 1,
    class: 'berg-cap',
  }));

  // the waterline itself — the one hard rule in the picture
  const line = svg('g', { class: 'berg-water' });
  line.append(svg('line', {
    x1: 0, y1: waterY, x2: W, y2: waterY,
    stroke: '#7fe3ff', 'stroke-width': 1.1, opacity: '.85', filter: 'url(#bergGlow)',
  }));
  for (let i = 0; i < 5; i++) {
    const y = waterY + 6 + i * 5;
    line.append(svg('line', {
      x1: 8 + rand() * 30, y1: y, x2: W - 8 - rand() * 30, y2: y,
      stroke: 'rgba(127,227,255,.16)', 'stroke-width': .6,
    }));
  }
  root.append(line);

  // bubbles: the only thing that moves without being asked
  if (!reduceMotion()) {
    const bubbles = svg('g', { class: 'berg-bubbles' });
    for (let i = 0; i < 14; i++) {
      const x = 40 + rand() * (W - 80);
      const r = .8 + rand() * 1.8;
      const b = svg('circle', { cx: x, cy: H, r, fill: 'rgba(127,227,255,.5)' });
      b.style.animation = `rise ${9 + rand() * 11}s linear ${rand() * -14}s infinite`;
      bubbles.append(b);
    }
    root.append(bubbles);
  }

  // labels
  const label = (y, text, anchor, cls) => {
    const t = svg('text', {
      x: anchor === 'end' ? W - 6 : 6, y,
      'text-anchor': anchor, class: cls,
      'font-family': 'IBM Plex Mono, monospace', 'font-size': '8.5',
      'letter-spacing': '.14em', fill: 'currentColor',
    });
    t.textContent = text;
    return t;
  };
  root.append(label(waterY - 8, 'SESSION', 'start', 'berg-lbl berg-lbl--warm'));
  root.append(label(waterY + 22, 'IN YOUR REPOSITORY', 'end', 'berg-lbl'));
}

/* ------------------------------------------------------------------ */
/* the depth rail: the page descends past the waterline                 */
/* ------------------------------------------------------------------ */

function buildRail(el, section) {
  const W = 118;
  const H = Math.max(section.offsetHeight, 1200);
  el.setAttribute('viewBox', `0 0 ${W} ${H}`);
  el.innerHTML = '';
  const cx = W / 2;
  const rand = rng(0xdeeb10);

  const defs = svg('defs');
  const water = svg('linearGradient', { id: 'railWater', x1: '0', y1: '0', x2: '0', y2: '1' });
  [['0%', 'rgba(127,227,255,.20)'], ['30%', 'rgba(23,86,120,.16)'], ['100%', 'rgba(4,10,18,.05)']]
    .forEach(([o, c]) => water.append(svg('stop', { offset: o, 'stop-color': c })));
  const fade = svg('linearGradient', { id: 'railFade', x1: '0', y1: '0', x2: '0', y2: '1' });
  [['0%', '#000', '0'], ['5%', '#000', '1'], ['95%', '#000', '1'], ['100%', '#000', '0']]
    .forEach(([o, c, a]) => fade.append(svg('stop', { offset: o, 'stop-color': c, 'stop-opacity': a })));
  const mask = svg('mask', { id: 'railMask' });
  mask.append(svg('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#railFade)' }));
  defs.append(water, fade, mask);
  el.append(defs);

  const g = svg('g', { mask: 'url(#railMask)' });

  // the water column
  g.append(svg('rect', { x: cx - 30, y: 0, width: 60, height: H, fill: 'url(#railWater)' }));
  // the sounding line
  g.append(svg('line', { x1: cx, y1: 0, x2: cx, y2: H, stroke: 'rgba(127,227,255,.22)', 'stroke-width': 1 }));

  // depth ticks, deeper marks growing sparser and dimmer
  let step = 34;
  for (let y = 40; y < H; y += step) {
    const major = rand() > .72;
    g.append(svg('line', {
      x1: cx - (major ? 13 : 6), y1: y, x2: cx + (major ? 13 : 6), y2: y,
      stroke: major ? 'rgba(127,227,255,.30)' : 'rgba(127,227,255,.13)',
      'stroke-width': major ? 1 : .7,
    }));
    step = 30 + rand() * 26;
  }
  el.append(g);

  // the descended part, filled in by scroll
  const sounded = svg('rect', {
    x: cx - 30, y: 0, width: 60, height: 0,
    fill: 'rgba(127,227,255,.07)', mask: 'url(#railMask)',
  });
  const head = svg('g', { id: 'railHead' });
  head.append(svg('line', { x1: cx - 22, y1: 0, x2: cx + 22, y2: 0, stroke: '#7fe3ff', 'stroke-width': 1.2 }));
  head.append(svg('path', { d: `M${cx - 5} -6 L${cx + 5} -6 L${cx} 5 Z`, fill: '#04070c', stroke: '#7fe3ff', 'stroke-width': 1.2 }));
  el.append(sounded, head);

  return { sounded, head, H };
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */

function fitWordmark() {
  const w = document.getElementById('wordmark');
  if (!w) return;
  w.style.fontSize = '';
  const parent = w.parentElement;
  const available = parent.clientWidth;
  const natural = w.scrollWidth;
  if (natural > available) {
    const size = parseFloat(getComputedStyle(w).fontSize);
    w.style.fontSize = `${size * (available / natural) * 0.99}px`;
  }
}

function revealStrata() {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        e.target.querySelector('.calve-demo')?.classList.add('in');
      }
    }
  }, { rootMargin: '-12% 0px -18% 0px' });
  document.querySelectorAll('.stratum').forEach((s) => io.observe(s));
}

function bindRail() {
  const section = document.getElementById('core');
  const el = document.getElementById('depth-svg');
  if (!section || !el) return;
  let rail = buildRail(el, section);

  const update = () => {
    const rect = section.getBoundingClientRect();
    const travelled = Math.min(1, Math.max(0, (window.innerHeight * .55 - rect.top) / rect.height));
    const y = travelled * rail.H;
    rail.sounded.setAttribute('height', String(y));
    rail.head.setAttribute('transform', `translate(0 ${y})`);
    rail.head.setAttribute('opacity', travelled > 0.002 && travelled < 0.999 ? '1' : '0');
  };

  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { update(); ticking = false; });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  new ResizeObserver(() => { rail = buildRail(el, section); update(); }).observe(section);
  update();
}

async function typePhone() {
  const pre = document.getElementById('phone-term');
  if (!pre) return;
  const script = [
    ['~ $ ', 'cargo build --release', 500],
    ['\n   Compiling nyeda v0.4.1\n    Finished release [optimized]\n', '', 900],
    ['~ $ ', 'exit', 400],
    ['\n', '', 300],
    ['  CALVE  ', 'Rust Dev + LLVM', 700],
    ['\n  reading machine      41 210 files\n  already in your keel  1 184 pieces\n  new                      37 pieces  8.4 MB\n  calved                Rust Dev + LLVM\n', '', 1600],
  ];
  if (reduceMotion()) {
    pre.textContent = script.map(([a, b]) => a + b).join('');
    return;
  }
  const io = new IntersectionObserver(async (entries, obs) => {
    if (!entries[0].isIntersecting) return;
    obs.disconnect();
    for (const [prefix, typed, pause] of script) {
      pre.textContent += prefix;
      for (const ch of typed) { pre.textContent += ch; await sleep(38); }
      pre.textContent += typed ? '\n' : '';
      await sleep(pause);
      if (pre.textContent.length > 700) pre.textContent = pre.textContent.slice(-500);
    }
  }, { threshold: .4 });
  io.observe(pre);
}

/* boot */
const heroBerg = document.getElementById('hero-berg');
if (heroBerg) drawBerg(heroBerg);
fitWordmark();
document.fonts?.ready.then(fitWordmark);
window.addEventListener('resize', fitWordmark);
revealStrata();
bindRail();
typePhone();
