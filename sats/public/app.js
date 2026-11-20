/**
 * Zappot Sats — the browser side.
 *
 * No framework, no build step: the coordinator serves this file and the API it talks to. Identity is
 * a Nostr key. If a NIP-07 extension is present every action is signed by it; if not, the page signs
 * with a guest key kept in this tab (see vendor/guest-nostr.js). Failing both, practice circles still
 * work through a throwaway server-side identity.
 */

import { generateSecretKeyHex, getPublicKeyHex, signEvent as signGuestEvent } from './vendor/guest-nostr.js';

const S = {
  health: null,
  nostr: null, // { pubkey, npub } from a NIP-07 extension
  demo: null, // { demoId, npub } throwaway identity
  useNostr: false,
  list: [],
  circle: null,
  flags: [],
  invoice: null,
  reminder: null,
  briefing: null,
  score: null,
  error: null,
};

const PRACTICE_KEY = 'potluck.practice';

// ------------------------------------------------------------------------------------------- helpers

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const sats = (n) => Number(n ?? 0).toLocaleString('en-US');

function short(value, head = 10, tail = 5) {
  const v = String(value ?? '');
  return v.length <= head + tail ? v : `${v.slice(0, head)}…${v.slice(-tail)}`;
}

/**
 * The Lightning proof behind a movement of sats: the invoice that settled and the preimage that
 * proves it, or a plain note that a practice circle booked the payment without moving sats. A judge
 * can check the hash instead of trusting the page.
 */
function paymentProof(l) {
  if (l.sats == null) return '';
  if (l.simulated) return '<span class="proof">recorded · no sats moved</span>';
  const bits = [];
  if (l.paymentHash) bits.push(`payment hash <code>${esc(l.paymentHash)}</code>`);
  if (l.preimage) bits.push(`preimage <code>${esc(l.preimage)}</code>`);
  return bits.length ? `<span class="proof">${bits.join(' · ')}</span>` : '';
}

function duration(seconds) {
  if (seconds <= 0) return 'now';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

const niceDuration = (s) =>
  s % 86400 === 0 ? `${s / 86400} day${s === 86400 ? '' : 's'}` : s % 3600 === 0 ? `${s / 3600} h` : `${Math.round(s / 60)} min`;

const PHASE_INDEX = { forming: 0, active: 1, completed: 2, cancelled: 3 };
const PHASE_LABEL = { forming: 'Forming', active: 'Active', completed: 'Completed', cancelled: 'Cancelled' };

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* an empty or non-JSON answer falls back to the status code */
  }
  if (!res.ok) {
    // Demo identities live in the coordinator's memory, so restarting it forgets the one this tab
    // cached. Get a fresh identity and replay the request once instead of stranding the page.
    if (res.status === 401 && data.error === 'UnknownDemo' && path !== '/api/demo/identity') {
      try {
        sessionStorage.removeItem('potluck.demo');
      } catch {
        /* storage may be unavailable */
      }
      S.demo = await api('/api/demo/identity', { method: 'POST' });
      try {
        sessionStorage.setItem('potluck.demo', JSON.stringify(S.demo));
      } catch {
        /* ignore */
      }
      return api(path, options);
    }
    throw new Error(data.message || `request failed (${res.status})`);
  }
  return data;
}

let toastTimer;
function toast(message, kind = '') {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.className = `toast ${kind}`.trim();
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, kind === 'err' ? 9000 : 5000);
}

// npub encoding, so a NIP-07 hex pubkey can be matched against member npubs.
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function convertBits(bytes, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of bytes) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}

function npubEncode(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return '';
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
  const words = convertBits(bytes, 8, 5, true);
  const checksum = [];
  const mod = polymod([...hrpExpand('npub'), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  for (let i = 0; i < 6; i += 1) checksum.push((mod >> (5 * (5 - i))) & 31);
  return `npub1${[...words, ...checksum].map((d) => B32[d]).join('')}`;
}

function myNpub() {
  if (S.useNostr && S.nostr) return S.nostr.npub;
  if (S.demo) return S.demo.npub;
  return '';
}

/** Sign an action with the extension, or hand the server a practice identity. */
async function sign(action, circleId, payload = {}) {
  // The guest key signs locally, with the same event shape an extension would return.
  if (S.useNostr && S.nostr?.guest) {
    const event = signGuestEvent(
      {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['action', action], ...(circleId ? [['circle', circleId]] : [])],
        content: JSON.stringify(payload),
      },
      S.nostr.secret,
    );
    return { event };
  }
  if (S.useNostr && S.nostr && window.nostr?.signEvent) {
    const event = await window.nostr.signEvent({
      kind: 27235,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['action', action], ...(circleId ? [['circle', circleId]] : [])],
      content: JSON.stringify(payload),
    });
    return { event };
  }
  if (!S.demo) throw new Error('connect a Nostr identity first');
  return { demoId: S.demo.demoId, payload };
}

// ------------------------------------------------------------------------------------ avatars and ring

/** Bright brand swatches, same palette the on-chain app uses for generated avatars. */
const SWATCH = ['#d2563b', '#f0a35e', '#e8bd4a', '#2f8f6b', '#8cc7a8', '#6aa3d5', '#8e5c8a', '#e47e93', '#2f4858'];

/** Six deterministic bytes from any string, so a member looks the same on every screen. */
function bytesOf(text) {
  const out = [];
  let h = 2166136261;
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < text.length; j += 1) {
      h ^= text.charCodeAt(j);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h = Math.imul(h ^ (i + 1), 16777619) >>> 0;
    out.push(h & 255);
  }
  return out;
}

function avatarStyle(address) {
  const b = bytesOf(String(address).toLowerCase());
  const pick = [];
  for (let i = 0; pick.length < 3; i += 1) {
    const c = SWATCH[(b[i % 6] + i * 7) % SWATCH.length];
    if (!pick.includes(c)) pick.push(c);
  }
  const off = (x) => ((x / 255) * 2 - 1) * 0.42;
  const ax = off(b[3]);
  const ay = off(b[4]);
  return { c1: pick[0], c2: pick[1], c3: pick[2], ax, ay, bx: -ax * 1.15 + off(b[5]) * 0.25, by: -ay * 1.15 };
}

let clipSeq = 0;
function avatarG(address, cx, cy, r) {
  const s = avatarStyle(address);
  const id = `avc${(clipSeq += 1)}`;
  return `<defs><clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${r}" /></clipPath></defs>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${s.c1}" />
    <g clip-path="url(#${id})">
      <circle cx="${cx + s.ax * r}" cy="${cy + s.ay * r}" r="${r * 0.64}" fill="${s.c2}" />
      <circle cx="${cx + s.bx * r}" cy="${cy + s.by * r}" r="${r * 0.28}" fill="${s.c3}" />
    </g>
    <circle cx="${cx}" cy="${cy}" r="${r - 0.5}" fill="none" stroke="rgba(23, 20, 15, 0.12)" stroke-width="1" />`;
}

function avatarSvg(address, size = 22) {
  return `<svg class="avatar" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${avatarG(address, 12, 12, 12)}</svg>`;
}

/**
 * The circle drawn as seats around a pot: who paid this round, who took which pot, who is next in
 * line. `preview` draws an empty circle for the hero before a circle exists.
 */
function ringSvg(c, preview = null) {
  const n = c ? c.config.size : preview.size;
  const R = 148;
  const AV = n > 8 ? 17 : 21;
  const you = myNpub();
  const round = c ? c.currentRound : 0;
  const paidNow = c && c.phase === 'active' ? c.paid[String(round)] ?? [] : [];
  const paidCount = c ? c.members.filter((m) => paidNow.includes(m.npub)).length : 0;
  const potRaw = c ? c.potSats : preview.pot;
  const showing = c && c.phase === 'active' ? c.collected[String(round)] ?? 0 : potRaw;

  let leader = null;
  if (c && c.phase === 'active') {
    if (c.config.mode === 'auction' && c.topBidder[String(round)]) leader = c.topBidder[String(round)];
    else {
      const next = c.members.find((m) => !m.won && !m.defaulted);
      leader = next ? next.npub : null;
    }
  }

  const top = c ? (c.phase === 'active' ? `ROUND ${round}` : PHASE_LABEL[c.phase].toUpperCase()) : 'PRACTICE';
  const seats = Array.from({ length: n }, (_, i) => (c ? c.members[i] ?? null : null));

  const parts = [];
  parts.push(
    `<svg class="big-ring" viewBox="0 0 400 400" role="img" aria-label="${seats.filter(Boolean).length} of ${n} seats around a ${sats(potRaw)} sats pot">`,
  );
  parts.push(`<defs>
    <radialGradient id="ringPot" cx="0.38" cy="0.32" r="0.75">
      <stop offset="0" stop-color="#e7bf5c" /><stop offset="0.6" stop-color="#c99a2e" /><stop offset="1" stop-color="#a87b1c" />
    </radialGradient>
    <filter id="ringSoft" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="3" stdDeviation="3.5" flood-color="#3b2b05" flood-opacity="0.16" />
    </filter>
  </defs>`);
  parts.push(`<circle cx="200" cy="200" r="${R}" class="ring-track" />`);

  if (c && c.phase === 'active') {
    const circ = 2 * Math.PI * R;
    const frac = n ? paidCount / n : 0;
    parts.push(
      `<circle cx="200" cy="200" r="${R}" class="ring-progress" style="stroke-dasharray:${frac * circ} ${circ}" transform="rotate(-90 200 200)" />`,
    );
  }

  seats.forEach((m, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const x = 200 + R * Math.cos(a);
    const y = 200 + R * Math.sin(a);
    if (!m) {
      parts.push(
        `<circle cx="${x}" cy="${y}" r="${AV}" class="seat-empty-ring" /><text x="${x}" y="${y + 5}" text-anchor="middle" class="seat-plus">+</text>`,
      );
      return;
    }
    const isLeader = leader && m.npub === leader;
    const ring = m.defaulted ? 'def' : c && c.phase === 'active' && paidNow.includes(m.npub) ? 'paid' : '';
    const isMe = m.npub === you;
    if (isLeader) {
      parts.push(`<line x1="${x}" y1="${y}" x2="200" y2="200" class="spoke on" />`);
      parts.push(`<circle cx="${x}" cy="${y}" r="${AV + 7}" class="seat-halo" />`);
    }
    parts.push(`<g filter="url(#ringSoft)">${avatarG(m.npub, x, y, AV)}</g>`);
    if (ring) parts.push(`<circle cx="${x}" cy="${y}" r="${AV + 2.5}" class="seat-ring ${ring}" />`);
    if (m.won) {
      parts.push(`<g transform="translate(${x + AV * 0.78} ${y - AV * 0.78})" class="seat-badge">
        <rect x="-13" y="-9" width="26" height="18" rx="9" /><text y="4" text-anchor="middle">R${m.wonRound}</text></g>`);
    }
    const label = isMe ? 'you' : short(m.npub, 7, 3);
    parts.push(
      `<text x="${x}" y="${y + (y > 200 ? AV + 20 : -AV - 10)}" text-anchor="middle" class="${isMe ? 'me-t' : 'seat-name'}">${esc(label)}</text>`,
    );
  });

  parts.push(`<g filter="url(#ringSoft)"><circle cx="200" cy="200" r="64" fill="url(#ringPot)" /></g>`);
  parts.push(`<circle cx="200" cy="200" r="56" fill="none" stroke="#fff" stroke-opacity="0.3" stroke-width="1.5" />`);
  parts.push(`<text x="200" y="186" text-anchor="middle" class="pot-t">${top}</text>`);
  parts.push(`<text x="200" y="215" text-anchor="middle" class="pot-v">${sats(showing)}</text>`);
  parts.push(
    `<text x="200" y="234" text-anchor="middle" class="pot-s">${c && c.phase === 'active' ? `of ${sats(potRaw)} sats` : 'sats pot'}</text>`,
  );
  parts.push('</svg>');
  return parts.join('');
}

// -------------------------------------------------------------------------------------------- boot

async function boot() {
  try {
    S.health = await api('/api/health');
  } catch {
    document.getElementById('main').innerHTML =
      '<div class="page"><div class="empty"><p>The coordinator is not answering. Start it with <code>npm start</code>.</p></div></div>';
    return;
  }

  const badge = document.getElementById('wallet-badge');
  badge.className = `netpick ${S.health.nwc ? 'net-live' : ''}`.trim();
  badge.title = S.health.nwc ? 'Invoices are issued by your NWC wallet' : S.health.nwcError ?? '';
  badge.querySelector('.netname').textContent = S.health.nwc ? 'Lightning wallet' : 'No wallet';
  badge.querySelector('.nettag').textContent = S.health.nwc ? 'NWC' : 'OFF';

  if (S.health.demo) {
    // Keep the practice identity across a reload, so a half-played practice circle is still yours.
    let cached = null;
    try {
      cached = sessionStorage.getItem('potluck.demo');
    } catch {
      /* storage may be unavailable */
    }
    if (cached) {
      try {
        S.demo = JSON.parse(cached);
      } catch {
        S.demo = null;
      }
    }
    if (!S.demo) {
      try {
        S.demo = await api('/api/demo/identity', { method: 'POST' });
        try {
          sessionStorage.setItem('potluck.demo', JSON.stringify(S.demo));
        } catch {
          /* ignore */
        }
      } catch {
        /* practice circles are optional */
      }
    }
  }

  if (window.nostr?.getPublicKey) {
    try {
      const pubkey = await window.nostr.getPublicKey();
      S.nostr = { pubkey, npub: npubEncode(pubkey) };
    } catch {
      /* the extension is installed but locked; the button retries */
    }
  }

  // A guest key already used in this tab should survive a reload, or the seat it joined is orphaned.
  if (!S.useNostr) {
    try {
      const saved = sessionStorage.getItem(GUEST_KEY);
      if (saved && /^[0-9a-f]{64}$/.test(saved)) {
        const pubkey = getPublicKeyHex(saved);
        S.nostr = { pubkey, npub: npubEncode(pubkey), guest: true, secret: saved };
        S.useNostr = true;
      }
    } catch {
      /* storage blocked: no guest identity to restore */
    }
  }

  updateIdentityButton();
  await loadList();
  render();
}

function updateIdentityButton() {
  // The button carries an icon now, so set the two label spans instead of its whole text.
  const btn = document.getElementById('identity-btn');
  const connected = Boolean(S.useNostr && S.nostr);
  const guest = Boolean(S.nostr?.guest);
  const lg = btn.querySelector('.lg');
  const sm = btn.querySelector('.sm');
  if (lg) lg.textContent = !connected ? 'Connect Nostr' : guest ? 'Guest Nostr key' : short(S.nostr.npub, 8, 4);
  if (sm) sm.textContent = !connected ? 'Connect' : guest ? 'Guest' : 'Connected';
  btn.title = guest
    ? `Guest Nostr key (no extension) — ${S.nostr.npub}. Stored in this tab only; it disappears when the tab closes.`
    : connected
      ? S.nostr.npub
      : 'Sign with Alby or nos2x, or create a guest key in this tab';
}

/**
 * A key that lives in this tab, for when no extension is installed. Returns the stored secret so a
 * reload keeps the same identity (joining a circle and then losing the key would strand the seat).
 */
const GUEST_KEY = 'potluck.guestKey';

function guestSecret() {
  try {
    const existing = sessionStorage.getItem(GUEST_KEY);
    if (existing && /^[0-9a-f]{64}$/.test(existing)) return existing;
    const fresh = generateSecretKeyHex();
    sessionStorage.setItem(GUEST_KEY, fresh);
    return fresh;
  } catch {
    // Storage can be blocked; the key then lasts only as long as this page.
    return generateSecretKeyHex();
  }
}

async function connectNostr() {
  // An extension is always the better identity: it owns the key across sites and tabs.
  if (window.nostr?.getPublicKey) {
    try {
      const pubkey = await window.nostr.getPublicKey();
      S.nostr = { pubkey, npub: npubEncode(pubkey) };
      S.useNostr = true;
      updateIdentityButton();
      render();
      toast('Nostr identity connected', 'ok');
      return true;
    } catch (e) {
      toast(e.message || 'the extension refused', 'err');
      return false;
    }
  }

  // No extension: sign here instead of leaving the visitor with an error and no way to join.
  try {
    const secret = guestSecret();
    const pubkey = getPublicKeyHex(secret);
    S.nostr = { pubkey, npub: npubEncode(pubkey), guest: true, secret };
    S.useNostr = true;
    updateIdentityButton();
    render();
    toast('Guest Nostr key (no extension): this tab only, and gone when it closes.', 'ok');
    return true;
  } catch (e) {
    toast(e.message || 'could not create a guest key', 'err');
    return false;
  }
}

// -------------------------------------------------------------------------------------------- data

async function loadList() {
  try {
    const r = await api('/api/circles');
    S.list = r.circles ?? [];
  } catch (e) {
    S.error = e.message;
  }
}

async function loadCircle(id) {
  const r = await api(`/api/circles/${id}`);
  S.circle = r.circle;
  try {
    const f = await api(`/api/circles/${id}/flags`);
    S.flags = f.flags ?? [];
  } catch {
    S.flags = [];
  }
  return S.circle;
}

// ------------------------------------------------------------------------------------------- render

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, id] = hash.split('/');
  if (page === 'c' && id) return { page: 'circle', id };
  if (page === 'practice') return { page: 'practice' };
  if (page === 'score') return { page: 'score', id: id || '' };
  return { page: 'home' };
}

/** Keep the nav in step with the route, the way the on-chain app does. */
function markNav(page) {
  for (const [name, id] of [
    ['home', 'nav-circles'],
    ['practice', 'nav-practice'],
    ['score', 'nav-score'],
  ]) {
    const el = document.getElementById(id);
    if (el) el.className = page === name || (page === 'circle' && name === 'home') ? 'on' : '';
  }
}

function render() {
  const r = route();
  const main = document.getElementById('main');
  markNav(r.page);
  stopStory();

  if (r.page === 'circle') {
    if (!S.circle || S.circle.id !== r.id) {
      main.innerHTML = '<div class="page"><div class="loading">Loading circle…</div></div>';
      loadCircle(r.id)
        .then(() => render())
        .catch((e) => {
          main.innerHTML = `<div class="page"><div class="empty"><p>${esc(e.message)}</p></div></div>`;
        });
      return;
    }
    main.innerHTML = circleView(S.circle);
    paintCountdowns();
    return;
  }

  if (r.page === 'practice') {
    let id = null;
    try {
      id = localStorage.getItem(PRACTICE_KEY);
    } catch {
      /* storage may be unavailable */
    }
    if (!id) {
      main.innerHTML = practiceIntro();
      return;
    }
    if (!S.circle || S.circle.id !== id) {
      main.innerHTML = '<div class="page"><div class="loading">Loading your practice circle…</div></div>';
      loadCircle(id)
        .then(() => render())
        .catch(() => {
          try {
            localStorage.removeItem(PRACTICE_KEY);
          } catch {
            /* ignore */
          }
          render();
        });
      return;
    }
    main.innerHTML = practiceView(S.circle);
    paintCountdowns();
    return;
  }

  if (r.page === 'score') {
    // A link like #/score/<npub> (the last practice step) looks the record up on arrival.
    if (r.id && S.scoreQuery !== r.id) {
      main.innerHTML = '<div class="page"><div class="loading">Looking up the savings record…</div></div>';
      lookupScore(r.id).then(() => render());
      return;
    }
    main.innerHTML = scoreView();
    return;
  }

  main.innerHTML = homeView();
  paintCountdowns();
  startStory();
}

// ------------------------------------------------------------------------------------- hero story

const STORY_MEMBERS = [
  { name: 'Mei', color: '#d2563b' },
  { name: 'Budi', color: '#2f4858' },
  { name: 'Lucía', color: '#c99a2e' },
  { name: 'Ama', color: '#1e6b52' },
  { name: 'Arjun', color: '#6b4e71' },
  { name: 'Linh', color: '#9c3f2b' },
];
const STORY_ORDER = [0, 3, 1, 4, 2, 5];
const STORY_PAY = 21;
const STORY_ROUND = 3.6;
const STORY_HOLD = 2.6;
const STORY_LOOP = STORY_ROUND * 6 + STORY_HOLD;
const SC = 200;
const SR = 136;
const SAV = 23;

const easeInOut = (x) => (x < 0 ? 0 : x > 1 ? 1 : x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

const storySeat = (i) => {
  const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
  return { x: SC + SR * Math.cos(a), y: SC + SR * Math.sin(a), dx: Math.cos(a), dy: Math.sin(a) };
};

function along(p, q, k, bend = 22) {
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const cx = mx - ((q.y - p.y) / len) * bend;
  const cy = my + ((q.x - p.x) / len) * bend;
  const u = 1 - k;
  return { x: u * u * p.x + 2 * u * k * cx + k * k * q.x, y: u * u * p.y + 2 * u * k * cy + k * k * q.y };
}

/** One frame of the home illustration: everyone pays, one member takes the pot, round after round. */
function storyInner(t) {
  const done = t >= STORY_ROUND * 6;
  const r = done ? 5 : Math.min(5, Math.floor(t / STORY_ROUND));
  const rt = done ? STORY_ROUND : t - r * STORY_ROUND;
  const winner = STORY_ORDER[r];
  const coins = STORY_MEMBERS.map((_, i) => ({ i, k: easeInOut((rt - i * 0.12) / 0.8), landed: rt >= i * 0.12 + 0.8 }));
  const collected = coins.filter((c) => c.landed).length * STORY_PAY;
  const payK = done ? 1 : easeInOut((rt - 1.8) / 0.8);
  const paying = !done && rt >= 1.8 && rt < 2.6;
  const paid = done || rt >= 2.6;
  const pulse = !done && rt >= 1.4 && rt < 1.8 ? 1 + 0.05 * Math.sin(((rt - 1.4) / 0.4) * Math.PI) : 1;
  const winners = new Set(STORY_ORDER.slice(0, paid ? r + 1 : r));
  const line = done
    ? 'Six rounds, six pots. Every payment is now on the record.'
    : rt < 1.8
      ? `Everyone pays ${STORY_PAY} sats into the pot`
      : `${STORY_MEMBERS[winner].name} takes the ${STORY_PAY * 6} sats pot`;

  const parts = [];
  parts.push(`<svg viewBox="0 0 400 400" role="img" aria-label="A six-member savings circle paying out one pot per round">`);
  parts.push(`<defs>
    <radialGradient id="sPot" cx="0.38" cy="0.32" r="0.75"><stop offset="0" stop-color="#e7bf5c"/><stop offset="0.6" stop-color="#c99a2e"/><stop offset="1" stop-color="#a87b1c"/></radialGradient>
    <radialGradient id="sCoin" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="#f6d77c"/><stop offset="0.7" stop-color="#d6a63a"/><stop offset="1" stop-color="#a87b1c"/></radialGradient>
    <radialGradient id="sShine" cx="0.34" cy="0.28" r="0.75"><stop offset="0" stop-color="#fff" stop-opacity="0.32"/><stop offset="0.55" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <filter id="sSoft" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="3.5" flood-color="#3b2b05" flood-opacity="0.18"/></filter>
  </defs>`);
  parts.push(`<circle cx="${SC}" cy="${SC}" r="${SR}" class="story-track"/>`);
  STORY_MEMBERS.forEach((_, i) => {
    const s = storySeat(i);
    parts.push(`<line x1="${s.x}" y1="${s.y}" x2="${SC}" y2="${SC}" class="story-spoke ${!done && rt < 1.4 ? 'flow' : ''}"/>`);
  });
  if (!done && rt < 1.8) {
    coins.forEach(({ i, k, landed }) => {
      if (k <= 0 || landed) return;
      const p = along(storySeat(i), { x: SC, y: SC }, k);
      parts.push(`<circle cx="${p.x}" cy="${p.y}" r="7.5" fill="url(#sCoin)" stroke="#a87b1c" stroke-width="1"/>`);
    });
  }
  parts.push(
    `<g filter="url(#sSoft)" transform="translate(${SC} ${SC}) scale(${pulse}) translate(${-SC} ${-SC})"><circle cx="${SC}" cy="${SC}" r="58" fill="url(#sPot)"/><circle cx="${SC}" cy="${SC}" r="50" fill="none" stroke="#fff" stroke-opacity="0.32" stroke-width="1.5"/></g>`,
  );
  parts.push(`<text x="${SC}" y="${SC - 16}" text-anchor="middle" class="story-pot-t">${done ? 'COMPLETE' : `ROUND ${r + 1}`}</text>`);
  parts.push(`<text x="${SC}" y="${SC + 13}" text-anchor="middle" class="story-pot-v">${done ? 6 : rt < 1.8 ? collected : STORY_PAY * 6}</text>`);
  parts.push(
    `<text x="${SC}" y="${SC + 31}" text-anchor="middle" class="story-pot-s">${done ? 'pots paid' : rt < 1.8 ? 'sats' : `sats to ${STORY_MEMBERS[winner].name}`}</text>`,
  );
  if (paying) {
    // The payout leaves from the pot's rim, so it never crosses the amount printed on the pot.
    const w = storySeat(winner);
    const d = Math.hypot(w.x - SC, w.y - SC) || 1;
    const rim = { x: SC + ((w.x - SC) / d) * 58, y: SC + ((w.y - SC) / d) * 58 };
    const p = along(rim, w, payK, -26);
    parts.push(
      `<g filter="url(#sSoft)"><circle cx="${p.x}" cy="${p.y}" r="13" fill="url(#sCoin)" stroke="#a87b1c" stroke-width="1.2"/><circle cx="${p.x}" cy="${p.y}" r="8.5" fill="none" stroke="#fff" stroke-opacity="0.45" stroke-width="1.2"/></g>`,
    );
  }
  STORY_MEMBERS.forEach((m, i) => {
    const s = storySeat(i);
    const isWinner = !done && i === winner && rt >= 1.8;
    const anchor = Math.abs(s.dx) < 0.3 ? 'middle' : s.dx > 0 ? 'start' : 'end';
    const tx = Math.abs(s.dx) < 0.3 ? s.x : s.x + s.dx * 42;
    const ty = Math.abs(s.dx) < 0.3 ? s.y + s.dy * 44 + 4 : s.y + s.dy * 42 + 4;
    parts.push('<g>');
    if (isWinner) parts.push(`<circle cx="${s.x}" cy="${s.y}" r="${SAV + 6}" class="story-halo"/>`);
    parts.push(`<g filter="url(#sSoft)"><circle cx="${s.x}" cy="${s.y}" r="${SAV}" fill="${m.color}"/></g>`);
    parts.push(`<circle cx="${s.x}" cy="${s.y}" r="${SAV}" fill="url(#sShine)"/>`);
    parts.push(`<text x="${s.x}" y="${s.y + 5.5}" text-anchor="middle" class="story-initial">${esc(m.name[0])}</text>`);
    parts.push(`<text x="${tx}" y="${ty}" text-anchor="${anchor}" class="story-name">${esc(m.name)}</text>`);
    if (winners.has(i)) {
      parts.push(`<g transform="translate(${s.x + 17} ${s.y - 17})" class="story-badge"><circle r="9"/><path d="M-4 0.5 L-1.2 3.2 L4.2 -2.6"/></g>`);
    }
    parts.push('</g>');
  });
  parts.push('</svg>');
  parts.push(
    `<figcaption><span class="story-round">${done ? 'Circle complete' : `Round ${r + 1} of 6`}</span><span class="story-line">${esc(line)}</span></figcaption>`,
  );
  return parts.join('');
}

function storyMarkup(t) {
  return `<figure class="story-fig" id="hero-story" aria-label="Animation: a six-person savings circle paying out one pot per round">${storyInner(t)}</figure>`;
}

let storyTimer = null;
function stopStory() {
  if (storyTimer) {
    clearInterval(storyTimer);
    storyTimer = null;
  }
}

function startStory() {
  stopStory();
  const el = document.getElementById('hero-story');
  if (!el) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    el.innerHTML = storyInner(STORY_ROUND * 2 + 3);
    return;
  }
  const t0 = performance.now();
  storyTimer = setInterval(() => {
    const node = document.getElementById('hero-story');
    if (!node) {
      stopStory();
      return;
    }
    node.innerHTML = storyInner(((performance.now() - t0) / 1000) % STORY_LOOP);
  }, 60);
}

function homeView() {
  const who = myNpub();
  const cards = S.list.length
    ? `<div class="cards">${S.list
        .map((c) => {
          const seats = Array.from(
            { length: c.config.size },
            (_, i) => {
              const m = c.members[i];
              if (!m) return '<span class="seat-open"></span>';
              return `<span class="seat-av ${m.defaulted ? 'def' : m.won ? 'won' : ''}" title="${esc(short(m.npub, 8, 4))}">${avatarSvg(m.npub, 24)}</span>`;
            },
          ).join('');
          return `<a class="card" href="#/c/${esc(c.id)}">
            <div class="card-top">
              <span class="pill p${PHASE_INDEX[c.phase]}">${esc(PHASE_LABEL[c.phase])}</span>
              <span class="muted small mode">${c.config.mode === 'auction' ? 'Auction' : 'Join order'}${c.demo ? ' · practice (bots)' : ''}</span>
            </div>
            <h3>${esc(c.name)}</h3>
            <div class="card-nums">
              <div><b>${sats(c.config.contributionSats)}</b><span>sats a round</span></div>
              <div><b>${c.members.length}/${c.config.size}</b><span>members</span></div>
              <div><b>${sats(c.potSats)}</b><span>pot</span></div>
            </div>
            <div class="seat-stack">${seats}</div>
          </a>`;
        })
        .join('')}</div>`
    : '<div class="empty"><p>No circles yet. Start the first one below.</p></div>';

  const story = storyMarkup(0);

  return `<div class="page">
    <section class="hero">
      <div>
        <p class="eyebrow">COMMUNITY TONTINES ON LIGHTNING · SATS</p>
        <h1>Save together.<br />Get the pot <em>in turns.</em></h1>
        <p class="lede">
          Across Senegal and West Africa, millions save through tontines and susu circles. Everyone
          contributes each round, and one member takes the whole pot—but cash handling, manual
          tracking, and late payments can break the circle.
        </p>
        <p class="lede">
          Zappot automates the tontine on Bitcoin Lightning. Instant NWC invoices settle every round,
          AI reminders keep members on track, and every on-time payment builds a portable, verifiable
          savings score on Nostr.
        </p>
        <div class="cta-row">
          <a class="btn big" href="#/practice">Try a whole circle in 3 minutes
            <svg width="17" height="17" viewBox="0 0 256 256" aria-hidden="true"><path d="M224 128a8 8 0 0 1-2.34 5.66l-96 96a8 8 0 1 1-11.32-11.32L204.69 128H32a8 8 0 0 1 0-16h172.69l-90.35-90.34a8 8 0 1 1 11.32-11.32l96 96A8 8 0 0 1 224 128Z" fill="currentColor" /></svg>
          </a>
        </div>
      </div>
      ${story}
    </section>

    <ul class="trust">
      <li>${S.health.nwc
        ? `<span><svg width="17" height="17" viewBox="0 0 256 256" aria-hidden="true"><path d="M212.6 121.3 96.9 218.6a8 8 0 0 1-13-7.1l14.6-60.3-42-6a8 8 0 0 1-6-12.9L166.2 34.5a8 8 0 0 1 13 7.1l-14.6 60.3 42 6a8 8 0 0 1 6 12.9Z" fill="currentColor" /></svg> Lightning wallet connected</span>`
        : `<span class="warn"><svg width="17" height="17" viewBox="0 0 256 256" aria-hidden="true"><path d="M212.6 121.3 96.9 218.6a8 8 0 0 1-13-7.1l14.6-60.3-42-6a8 8 0 0 1-6-12.9L166.2 34.5a8 8 0 0 1 13 7.1l-14.6 60.3 42 6a8 8 0 0 1 6 12.9Z" fill="currentColor" /></svg> No wallet yet: practice records only</span>`}</li>
      <li><span><svg width="17" height="17" viewBox="0 0 256 256" aria-hidden="true"><path d="M208 88h-24V56a56 56 0 0 0-112 0v32H48a16 16 0 0 0-16 16v96a16 16 0 0 0 16 16h160a16 16 0 0 0 16-16v-96a16 16 0 0 0-16-16Zm-96-32a24 24 0 0 1 48 0v32h-48Z" fill="currentColor" /></svg> No admin keys, no custody</span></li>

    </ul>

    <section class="list">
      <div class="list-head">
        <h2>Circles</h2>
        ${S.list.length ? `<span class="count">${S.list.length} created</span>` : ''}
      </div>
      ${cards}
    </section>

    <section class="create" id="start">
      <div class="create-head"><h2>Start a circle</h2></div>
      <p class="muted">You join like everyone else after creating it. Once it starts, nobody can change the rules.</p>
      <div class="grid">
        <label class="field wide"><span class="field-label">Name</span>
          <span class="field-box"><input id="c-name" value="Friday lunch circle" maxlength="60" /></span></label>
        <label class="field"><span class="field-label">Each round</span>
          <span class="field-box"><input id="c-contribution" value="21" inputmode="numeric" /><span class="unit">sats</span></span></label>
        <label class="field"><span class="field-label">Members</span>
          <span class="field-box"><input id="c-size" value="4" inputmode="numeric" /></span></label>
        <label class="field"><span class="field-label">Round length</span>
          <span class="field-box"><select id="c-round">
            <option value="60">1 minute (demo)</option>
            <option value="3600">1 hour</option>
            <option value="86400">1 day</option>
            <option value="604800" selected>1 week</option>
          </select></span></label>
        <label class="field"><span class="field-label">Collateral</span>
          <span class="field-box"><input id="c-collateral" value="21" inputmode="numeric" /><span class="unit">sats</span></span></label>
        <label class="field"><span class="field-label">Winner's bond</span>
          <span class="field-box"><input id="c-bond" value="0" inputmode="numeric" /><span class="unit">%</span></span></label>
        <label class="field"><span class="field-label">Who takes the pot</span>
          <span class="field-box"><select id="c-mode">
            <option value="fixed">In join order</option>
            <option value="auction">Auction (highest discount)</option>
          </select></span></label>
        <label class="field"><span class="field-label">Max auction discount</span>
          <span class="field-box"><input id="c-discount" value="10" inputmode="numeric" /><span class="unit">%</span></span></label>
      </div>
      <label class="practice-toggle">
        <input type="checkbox" id="c-practice" checked />
        Fill the other seats with bots (practice circle)
      </label>
      <p class="small muted" style="margin:-4px 0 14px;max-width:640px">
        A practice circle has no real members: the coordinator runs the other seats so you can play a whole
        circle alone. Untick it to invite people instead.
      </p>
      <div class="cta-row"><button class="btn big" data-act="create">Create circle</button></div>
    </section>
  </div>`;
}

/**
 * The loop in one place. The page shows every step before the circle exists, so a visitor can see
 * what they are starting, and `practiceView` plays the same list once there is a circle — which also
 * keeps the numbering stable from the first click to the last.
 */
const PRACTICE_CONFIG = { size: 4, contributionSats: 21, collateralSats: 21, mode: 'auction' };

/**
 * The whole loop, in the order the practice page plays it: seats, a bid for the pot, every round,
 * the money back at the end and the record it leaves. The intro and the running view share this
 * list, so the numbering never jumps around.
 */
function practiceOutline(simulated, config = PRACTICE_CONFIG) {
  const auction = config.mode === 'auction';
  return [
    {
      key: 'create',
      title: 'Create the practice circle',
      body: `Four seats, ${sats(config.contributionSats)} sats a round${auction ? ', auction mode' : ''}, 1-minute rounds. With a Lightning wallet connected you pay a real invoice; without one the payments are recorded and nothing moves.`,
    },
    {
      key: 'join',
      title: 'Take your seat',
      body: `You join like everyone else: ${sats(config.collateralSats)} sats of collateral is locked until the circle ends. The simulated members join on their own.`,
    },
    {
      key: 'pay',
      title: 'Pay round 1. The bots pay too',
      body: `Your contribution is ${sats(config.contributionSats)} sats, paid to a Lightning invoice. The simulated members pay the same amount into the pot.`,
    },
    {
      key: 'bid',
      title: 'Outbid the bots for the pot',
      body: auction
        ? 'Bid a discount in sats. The highest bid takes this round’s pot at the deadline, and the discount is shared by everyone else.'
        : 'This circle hands the pot out in join order, so there is nothing to bid.',
    },
    {
      key: 'settle',
      title: 'Close round 1',
      body: 'The pot goes to the winning bid, and any missed contribution is covered from collateral.',
    },
    {
      key: 'payout',
      title: 'Claim your payout',
      body: simulated
        ? 'If you took the pot, the coordinator records the payout instead of paying it.'
        : 'If you took the pot, the coordinator pays you over Lightning in one click. Paste your own invoice only if you want the sats in your own wallet.',
    },
    {
      key: 'rounds',
      title: 'Play the remaining rounds',
      body: 'Everyone pays, one member takes the pot, round after round, until every seat has had one.',
    },
    {
      key: 'end',
      title: 'Take your collateral and bond back',
      body: 'When the last round closes, your collateral and any bond comes back to you.',
    },
    {
      key: 'record',
      title: 'See your savings record',
      body: 'Every finished circle writes your on-time payments to a score any lender, merchant or future circle can read.',
    },
  ];
}

/** The frame the intro, a live circle and a spent one share, so the copy lives in one place. */
function practicePage({ top = '', steps, below = '', c = null }) {
  return `<div class="page practice">
    <p class="eyebrow">Try it alone · sats on lightning</p>
    <h1>A whole circle in three minutes.</h1>
    <p class="lede">
      You and ${(c?.config.size ?? PRACTICE_CONFIG.size) - 1} simulated members. They join, pay every round and
      settle rounds with you. You pay, take a pot and get paid at the end — every step below is a real request
      to the coordinator.
    </p>
    ${top}
    <div class="practice-grid">
      <div class="pg-steps">${steps}${below}</div>
      ${practiceSide(c)}
    </div>
  </div>`;
}

function practiceIntro() {
  const list = practiceOutline(!S.health?.nwc)
    .map(
      (s, i) => `<li class="${i === 0 ? 'now' : ''}"><span class="step-n">${i + 1}</span><h3>${esc(s.title)}</h3><p>${esc(s.body)}</p>${
        s.key === 'create'
          ? '<div class="step-actions"><button class="btn" data-act="practice-create">Create a practice circle</button></div>'
          : ''
      }</li>`,
    )
    .join('');
  return practicePage({ steps: `<ul class="steps-list">${list}</ul>` });
}

/** The right-hand card: the same ring as the circle page, plus where the seats and the round stand. */
function practiceSide(c) {
  const pill = c
    ? `<span class="pill p${PHASE_INDEX[c.phase]}">${esc(PHASE_LABEL[c.phase])}</span>`
    : '<span class="pill p0">Not created</span>';
  const line = c
    ? `${c.members.length} of ${c.config.size} seats taken · ${sats(c.config.contributionSats)} a round`
    : `Four seats · ${sats(21)} a round`;
  return `<aside class="pg-side">
        <div class="side-card">
          <div class="side-head">
            <h3>Your practice circle</h3>
            ${pill}
          </div>
          <div class="side-body">${c ? ringSvg(c) : ringSvg(null, { size: 4, pot: 84 })}</div>
          <p class="side-status">${esc(line)}</p>
        </div>
      </aside>`;
}

/** A finished or cancelled circle keeps its record, but the guide must not offer live actions on it. */
function endedPracticeView(c, member) {
  const note = member
    ? 'This practice circle is over. Its record stays on the circle page; start a fresh one to play the loop again with real buttons.'
    : 'This practice circle was played with a different identity, so there is nothing left for you to do in it.';
  const steps = `<ul class="steps-list">
    <li class="now">
      <span class="step-n">1</span>
      <h3>Start a fresh practice circle</h3>
      <p>${esc(note)}</p>
      <div class="step-actions">
        <button class="btn" data-act="practice-reset">Start a new practice circle</button>
        <a class="btn ghost" href="#/c/${esc(c.id)}">Open the full circle page</a>
      </div>
    </li>
  </ul>`;
  return practicePage({ steps, c });
}

function practiceView(c) {
  const you = myNpub();
  const simulated = !S.health?.nwc;
  const member = c.members.find((m) => m.npub === you);
  const round = c.currentRound;
  const active = c.phase === 'active';
  const completed = c.phase === 'completed';
  const auction = c.config.mode === 'auction';
  const paidNow = c.paid[String(round)] ?? [];
  const everyonePaid = active && c.members.every((m) => m.defaulted || paidNow.includes(m.npub));
  const left = c.roundDeadline ? c.roundDeadline - Math.floor(Date.now() / 1000) : 0;
  // An auction round waits for its deadline; a fixed-order circle can close once everyone has paid.
  // The server closes a round only once `now > deadline`, so the button must wait for the same second.
  const canSettle = active && (left < 0 || (!auction && everyonePaid));
  const canPay = active && member && !member.defaulted && !paidNow.includes(you);
  const canBid = active && auction && left > 0 && member && !member.won && !member.defaulted && paidNow.includes(you);
  // Whatever a finished round owes this member stays claimable until it is taken, before or after the end.
  const owed = member
    ? member.claimable + (completed || c.phase === 'cancelled' ? member.bond + member.collateralLeft : 0)
    : 0;
  const topBidder = c.topBidder[String(round)] ?? null;
  const topDiscount = c.topDiscount[String(round)] ?? 0;

  // A cancelled circle has nothing left to play. A completed one still owes collateral back and has a
  // savings record to open, so its guide stays up.
  if (c.phase === 'cancelled') return endedPracticeView(c, member);

  // Same list the intro showed, with the create step ticked off: the numbers do not jump around.
  const steps = practiceOutline(simulated, c.config);

  const done = {
    create: true,
    join: Boolean(member) && c.members.length === c.config.size,
    pay: c.results.length > 0 || everyonePaid,
    bid: !auction || topBidder === you || c.results.length > 0,
    settle: c.results.length > 0,
    // Once the circle is over, anything still claimable is taken with the collateral, on the last step.
    payout: c.results.length > 0 && (completed || !member || member.claimable === 0),
    rounds: c.results.length === c.config.size,
    end: completed && owed === 0,
    record: Boolean(S.score && S.score.npub === you),
  };
  const current = steps.findIndex((s) => !done[s.key]);

  /** Whatever the circle owes this member: real sats with a wallet, a labelled record without one. */
  const claim = () =>
    simulated
      ? `<button class="btn" data-act="payout">Record payout of ${sats(owed)} sats</button>`
      : `<span class="small muted">You are owed ${sats(owed)} sats. The coordinator pays it over Lightning; paste your own invoice to send it to your wallet instead.</span>
         <input id="payout-invoice" placeholder="your own invoice, optional — lnbc…" />
         <button class="btn" data-act="payout">Get paid ${sats(owed)} sats</button>
         <button class="btn ghost" data-act="record-payout">No wallet? Record the payout</button>`;

  const bidBox = canBid
    ? `<div class="bid">
        <p class="small muted">Best bid ${
          topDiscount > 0 ? `${sats(topDiscount)} sats by ${topBidder === you ? 'you' : 'a member'}` : 'none yet'
        } · the cap is ${sats(c.maxDiscountSats)} sats.</p>
        <div class="row">
          <input id="bid-amount" placeholder="discount in sats" inputmode="numeric" />
          <button class="btn" data-act="bid">Bid</button>
          <button class="btn ghost" data-act="demo-bid">A member bids</button>
        </div>
      </div>`
    : '';

  const closeButton = `<button class="btn dark" data-act="settle">Close round ${round}</button>`;

  /**
   * Which step is doing the work right now. Round one walks the guide pay → bid → close, the way the
   * steps are written; from round two the same controls live in "Play the remaining rounds". Either
   * way a control exists once on the page, and a claim for an earlier pot never hides it.
   */
  const host = !active
    ? null
    : c.results.length > 0
      ? 'rounds'
      : canPay || !everyonePaid
        ? 'pay'
        : canBid && topBidder !== you
          ? 'bid'
          : 'settle';

  /** The dashed round box from the on-chain practice: where the round stands, with its actions inside. */
  const roundBox = (inner) => `<div class="round-box">
      <div class="round-head">
        <span>Round ${round} of ${c.config.size}</span>
        <span>${paidNow.length} of ${c.members.length} paid</span>
        <span>pot ${sats(c.collected[String(round)] ?? 0)} / ${sats(c.potSats)}</span>
        <span>time left: <b data-countdown="${c.roundDeadline}">${duration(left)}</b></span>
      </div>${inner}
    </div>`;

  const payButtons = [
    canPay ? `<button class="btn" data-act="contribute">Pay ${sats(c.config.contributionSats)} sats</button>` : '',
    canPay && !simulated ? '<button class="btn ghost" data-act="record-contribute">No sats? Record it instead</button>' : '',
    everyonePaid ? '' : '<button class="btn ghost" data-act="demo-pay">Members pay</button>',
    canSettle ? closeButton : '',
  ]
    .filter(Boolean)
    .join('');

  const payActions = payButtons
    ? `<div class="step-actions">${payButtons}</div>`
    : '<p class="small muted">Everyone has paid. Anyone can close the round at the deadline.</p>';

  const hostActions = !host
    ? ''
    : host === 'bid'
      ? bidBox
      : host === 'settle'
        ? canSettle
          ? `<div class="step-actions">${closeButton}</div>`
          : '<p class="small muted">Waiting for the deadline: then anyone can close the round.</p>'
        : host === 'rounds'
          ? `${payActions}${bidBox}`
          : payActions;

  // A step carries only the action that belongs to it alone; a claim is offered wherever it is owed.
  const stepActions = (key) => {
    if (key === host) return roundBox(hostActions);
    switch (key) {
      case 'join':
        if (c.phase !== 'forming' || c.members.length >= c.config.size) return '';
        return `<div class="step-actions">${
          member
            ? '<button class="btn" data-act="demo-join">Fill the open seats</button>'
            : '<button class="btn" data-act="join">Take the seat</button>'
        }</div>`;
      case 'payout':
        return owed > 0 && !completed ? `<div class="step-actions">${claim()}</div>` : '';
      case 'end':
        return owed > 0 && completed ? `<div class="step-actions">${claim()}</div>` : '';
      case 'record':
        return `<div class="step-actions"><a class="btn ghost" href="#/score/${esc(you)}">See your savings record</a></div>`;
      default:
        return '';
    }
  };

  const list = steps
    .map((s, i) => {
      const action = stepActions(s.key);
      const head = `<span class="step-n">${done[s.key] ? '✓' : i + 1}</span><h3>${esc(s.title)}</h3>`;
      // A finished step is one line with a tick, so the guide stays a walkthrough rather than a wall
      // of text with the buttons somewhere else.
      if (done[s.key] && !action) return `<li class="done">${head}</li>`;
      return `<li class="${done[s.key] ? 'done' : i === current ? 'now' : ''}">${head}<p>${esc(s.body)}</p>${action}</li>`;
    })
    .join('');

  const finished = steps.every((s) => done[s.key]);
  const banner = finished
    ? '<p class="note">That is the whole loop: seats, bids, pots, payouts, and the record it left behind. Start over to play it again.</p>'
    : !member && c.phase !== 'forming'
      ? '<p class="note bad">This practice circle was played with a different identity. Start over to play it again as yourself.</p>'
      : '';

  const below = `<div class="step-actions">
          <a class="btn ghost" href="#/c/${esc(c.id)}">Open the full circle page</a>
          <button class="btn ghost" data-act="practice-reset">Start over</button>
        </div>
        <section class="panel" style="margin-top:24px">
          <h3>AI coordinator</h3>
          <p class="small muted">Plain-language help: what this circle needs next, and a reminder you can forward to the group.</p>
          <div class="row" style="flex-wrap:wrap;gap:8px">
            <button class="btn ghost" data-act="briefing" style="margin:0">What needs doing?</button>
            <select id="reminder-lang" style="max-width:150px">
              <option value="fr">Français</option>
              <option value="en">English</option>
              <option value="wo">Wolof</option>
            </select>
            <button class="btn ghost" data-act="reminder" style="margin:0">Write me a reminder</button>
          </div>
          ${S.briefing ? `<div class="reminder">${esc(S.briefing)}</div>` : ''}
          ${S.reminder ? `<div class="reminder">${esc(S.reminder)}</div>` : ''}
        </section>
        <section class="live" style="margin-top:24px">
          <h3>Transactions <span class="live-sub small muted">every payment, bid and payout, with its Lightning proof</span></h3>
          <ul>${c.log
            .slice(-40)
            .reverse()
            .map(
              (l) => `<li>
                <span class="when">${new Date(l.at * 1000).toLocaleTimeString()}</span>
                <span class="what">${esc(l.kind)}${l.npub ? ` · ${esc(short(l.npub, 7, 4))}` : ''}${l.note ? ` <span class="muted small">${esc(l.note)}</span>` : ''}${paymentProof(l)}</span>
                <span class="tail">${l.sats != null ? sats(l.sats) : ''}</span>
              </li>`,
            )
            .join('')}</ul>
        </section>`;

  return practicePage({
    top: banner,
    steps: `<ul class="steps-list">${list}</ul>`,
    below,
    c,
  });
}

function scoreCard(s) {
  const arc = Math.PI * 80;
  const frac = Math.max(0, Math.min(1, (s.score ?? 0) / 1000));
  const stats = s.stats ?? {};
  return `<div class="score-card">
    <div class="score-top">
      <svg class="gauge" viewBox="0 0 200 120" role="img" aria-label="Savings score ${s.score} of 1000">
        <defs>
          <linearGradient id="gaugeFill" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="#d2563b" /><stop offset="1" stop-color="#1e6b52" />
          </linearGradient>
        </defs>
        <path class="gauge-track" d="M20 100 A80 80 0 0 1 180 100" />
        <path class="gauge-fill" d="M20 100 A80 80 0 0 1 180 100" style="stroke-dasharray:${frac * arc} ${arc}" />
        <text x="100" y="86" text-anchor="middle" class="gauge-v">${s.score ?? 0}</text>
        <text x="100" y="106" text-anchor="middle" class="gauge-s">OF 1000</text>
      </svg>
      <div>
        <div class="score-who">${avatarSvg(s.npub, 34)}<b>${esc(short(s.npub, 12, 6))}</b></div>
        <p class="muted small">${esc(s.text ?? '')}</p>
        <ul class="flags">${(s.notes ?? []).map((n) => `<li class="info">${esc(n)}</li>`).join('')}</ul>
      </div>
    </div>
    <div class="seat-facts">
      <div><span>Circles completed</span><b>${stats.circlesCompleted ?? 0}</b></div>
      <div><span>Defaults</span><b>${stats.circlesDefaulted ?? 0}</b></div>
      <div><span>On-time payments</span><b>${stats.onTimePayments ?? 0}</b></div>
      <div><span>Missed</span><b>${stats.missedPayments ?? 0}</b></div>
      <div><span>Contributed</span><b>${sats(stats.totalContributedSats ?? 0)} sats</b></div>
    </div>
  </div>`;
}

async function lookupScore(value) {
  S.scoreQuery = value;
  try {
    S.score = await api(`/api/reputation/${encodeURIComponent(value)}`);
    S.scoreError = '';
  } catch (e) {
    // A mangled npub is the usual failure, and the page used to answer it with "paste an npub".
    S.score = null;
    S.scoreError =
      e.status === 400 || /npub/i.test(e.message)
        ? 'That is not a valid npub. It is 63 characters, starts with npub1 — check for a character lost in the copy.'
        : e.message || 'that lookup failed';
  }
}

function scoreView() {
  return `<div class="page score-page">
    <p class="eyebrow">Savings score</p>
    <h1>Look up a savings record</h1>
    <p class="lede">
      Every finished circle writes each member's on-time payments, missed rounds and defaults. Any lender,
      merchant or future circle can read it without trusting this app.
    </p>
    <div class="row search">
      <input id="score-npub" placeholder="npub1…" value="${esc(S.scoreQuery ?? myNpub())}" />
      <button class="btn" data-act="score-lookup">Look up</button>
    </div>
    ${
      S.score
        ? scoreCard(S.score)
        : S.scoreError
          ? `<div class="empty bad"><p>${esc(S.scoreError)}</p></div>`
          : '<div class="empty"><p>Paste an npub to see what their circles say about them.</p></div>'
    }
  </div>`;
}

function circleView(c) {
  const now = Math.floor(Date.now() / 1000);
  // A practice circle with no wallet books payments instead of moving sats.
  const simulated = !S.health?.nwc && c.demo;
  const you = myNpub();
  const member = c.members.find((m) => m.npub === you);
  const round = c.currentRound;
  const collected = c.collected[String(round)] ?? 0;
  const paidNow = c.paid[String(round)] ?? [];
  const allPaid = c.members.every((m) => m.defaulted || paidNow.includes(m.npub));
  const left = c.roundDeadline ? c.roundDeadline - now : 0;
  const canSettle = c.phase === 'active' && (left < 0 || (c.config.mode === 'fixed' && allPaid));
  const isCreator = c.creatorNpub === you;

  const rows = c.members
    .map(
      (m, i) => `<tr class="${m.npub === you ? 'me' : ''}">
        <td data-label="#">${i + 1}</td>
        <td data-label="Member" class="who">${avatarSvg(m.npub, 20)} ${esc(short(m.npub, 8, 4))}</td>
        <td data-label="This round">${
          c.phase !== 'active'
            ? '—'
            : m.defaulted
              ? '<span class="bad">defaulted</span>'
              : paidNow.includes(m.npub)
                ? '<span class="good">paid</span>'
                : '<span class="muted">not yet</span>'
        }</td>
        <td data-label="On time">${m.onTime}</td>
        <td data-label="Missed">${m.missed || '—'}</td>
        <td data-label="Pot">${m.won ? `round ${m.wonRound}` : '—'}</td>
        <td data-label="Collateral">${sats(m.collateralLeft)}</td>
        <td data-label="Bond">${sats(m.bond)}</td>
      </tr>`,
    )
    .join('');
  const openRows = Array.from(
    { length: Math.max(0, c.config.size - c.members.length) },
    () => '<tr class="empty-row"><td colspan="8">open seat</td></tr>',
  ).join('');

  const actions = [];
  if (c.phase === 'forming' && !member && c.members.length < c.config.size) {
    actions.push('<button class="btn" data-act="join">Join the circle</button>');
  }
  if (c.phase === 'active' && member && !member.defaulted && !paidNow.includes(member.npub)) {
    actions.push(
      `<button class="btn" data-act="contribute">${simulated ? 'Pay this round (practice)' : 'Pay this round'}</button>`,
    );
  }
  if (
    c.phase === 'active' &&
    c.config.mode === 'auction' &&
    member &&
    !member.won &&
    !member.defaulted &&
    paidNow.includes(member.npub) &&
    left > 0
  ) {
    actions.push(`<div class="bid">
      <p class="small muted">Want this round's pot? Offer a discount (max ${sats(c.maxDiscountSats)} sats); it is shared by everyone else.</p>
      <div class="row"><input id="bid-amount" placeholder="discount in sats" inputmode="numeric" />
      <button class="btn" data-act="bid">Bid</button></div>
    </div>`);
  }
  if (canSettle) actions.push(`<button class="btn dark" data-act="settle">Close round ${round}</button>`);
  if (c.phase === 'forming' && isCreator) {
    actions.push('<button class="btn ghost" data-act="cancel">Cancel before it starts</button>');
  }
  if (member) {
    const owed =
      member.claimable + (c.phase === 'completed' || c.phase === 'cancelled' ? member.bond + member.collateralLeft : 0);
    if (owed > 0) {
      actions.push(
        simulated
          ? `<div class="invoice-box">
              <p class="small" style="margin:0">You are owed <b>${sats(owed)} sats</b>. No wallet is connected, so this practice payout is recorded rather than paid.</p>
              <button class="btn" data-act="payout">Record payout of ${sats(owed)} sats</button>
            </div>`
          : `<div class="invoice-box">
              <p class="small" style="margin:0">You are owed <b>${sats(owed)} sats</b>. ${
                c.demo
                  ? 'The coordinator pays it over Lightning; paste your own invoice to send it to your wallet instead.'
                  : 'Paste a Lightning invoice for exactly that amount and the circle pays it.'
              }</p>
              <input id="payout-invoice" placeholder="${c.demo ? 'your own invoice, optional — lnbc…' : 'lnbc…'}" />
              <button class="btn" data-act="payout">Get paid ${sats(owed)} sats</button>
            </div>`,
      );
    }
  }
  // A practice circle is played alone, so its bot controls say so: nobody should mistake a simulated
  // member for a person who joined.
  if (c.demo) {
    actions.push(`<div class="round-box">
      <p class="small muted" style="margin:0">Simulated members (bots). The coordinator runs these seats, so no real person is behind them.</p>
      <div class="step-actions">
        <button class="btn ghost" data-act="demo-join">Bots join the open seats</button>
        <button class="btn ghost" data-act="demo-pay">Bots pay this round</button>
        ${c.config.mode === 'auction' ? '<button class="btn ghost" data-act="demo-bid">A bot bids</button>' : ''}
      </div>
    </div>`);
  }

  const invoice = S.invoice
    ? `<div class="invoice-box">
        <p class="small" style="margin:0">Pay <b>${sats(S.invoice.amountSats)} sats</b> with any Lightning wallet.</p>
        <code>${esc(S.invoice.invoice)}</code>
        <div class="row" style="flex-wrap:wrap;gap:8px">
          <button class="btn" data-act="copy-invoice">Copy invoice</button>
          <a class="btn ghost" href="lightning:${esc(S.invoice.invoice)}">Open wallet</a>
          <button class="btn dark" data-act="confirm">I have paid</button>
        </div>
      </div>`
    : '';

  const flags = S.flags.length
    ? `<ul class="flags">${S.flags.map((f) => `<li class="${esc(f.severity)}">${esc(f.text)}</li>`).join('')}</ul>`
    : '';

  const activity = c.log
    .slice(-40)
    .reverse()
    .map(
      (l) => `<li>
        <span class="when">${new Date(l.at * 1000).toLocaleTimeString()}</span>
        <span class="what">${esc(l.kind)}${l.npub ? ` · ${esc(short(l.npub, 7, 4))}` : ''}${l.note ? ` <span class="muted small">${esc(l.note)}</span>` : ''}${paymentProof(l)}</span>
        <span class="tail">${l.sats != null ? sats(l.sats) : ''}</span>
      </li>`,
    )
    .join('');

  const legend = [
    c.phase === 'active' ? '<li><i class="lg-paid"></i> Paid this round</li>' : '',
    '<li><i class="lg-won"></i> Took the pot</li>',
    c.members.some((m) => m.defaulted) ? '<li><i class="lg-def"></i> Defaulted</li>' : '',
    c.members.length < c.config.size ? '<li><i class="lg-open"></i> Open seat</li>' : '',
  ]
    .filter(Boolean)
    .join('');

  return `<div class="page">
    <a class="back" href="#/">← All circles</a>

    <section class="circle-head">
      <div>
        <p class="eyebrow">
          ${c.config.mode === 'auction' ? 'Auction' : 'Join order'} · ${c.config.size} members · rounds every ${niceDuration(c.config.roundSeconds)}${c.demo ? ' · practice' : ''}
        </p>
        <h1>${esc(c.name)}</h1>
        <div class="facts">
          <div><span>Each round</span><b>${sats(c.config.contributionSats)} sats</b></div>
          <div><span>Pot</span><b>${sats(c.potSats)} sats</b></div>
          <div><span>Collateral</span><b>${sats(c.config.collateralSats)} sats</b></div>
          <div><span>Bond</span><b>${c.config.bondBps / 100}%</b></div>
        </div>
      </div>
      <div class="status">
        <span class="pill p${PHASE_INDEX[c.phase]}">${esc(PHASE_LABEL[c.phase])}</span>
        <p class="round">${c.phase === 'active' ? `Round ${round} <span>of ${c.config.size}</span>` : PHASE_LABEL[c.phase]}</p>
        ${
          c.phase === 'active'
            ? `<p>${left > 0 ? `Closes in <b data-countdown="${c.roundDeadline}">${duration(left)}</b>` : 'Round closed · ready to settle'}</p>
               <div class="meter"><i style="width:${c.potSats ? Math.min(100, (collected / c.potSats) * 100) : 0}%"></i></div>
               <p class="muted small">Collected ${sats(collected)} of ${sats(c.potSats)} sats · ${paidNow.length} of ${c.members.length} paid</p>`
            : c.phase === 'forming'
              ? `<p>${c.members.length} of ${c.config.size} seats filled</p>`
              : c.phase === 'completed'
                ? '<p>All pots paid out.</p>'
                : '<p>Cancelled before it started.</p>'
        }
      </div>
    </section>

    ${flags}

    ${
      c.demo
        ? `<p class="note">Practice circle: the other seats are simulated members run by the coordinator, not
           people who joined. ${
             S.health?.nwc
               ? 'Sats you pay and take here are real Lightning payments on the connected wallet.'
               : 'No wallet is connected, so every payment is recorded and nothing moves.'
           } <a class="inline-link" href="#/practice">See the guided practice</a></p>`
        : ''
    }

    <section class="circle-body">
      <div class="ring-wrap">
        ${ringSvg(c)}
        <ul class="legend">${legend}</ul>
      </div>
      <div class="panel">
        <h3>Your seat</h3>
        ${
          member
            ? `<p class="small muted">On time ${member.onTime} · missed ${member.missed || 0} · collateral ${sats(member.collateralLeft)} sats · bond ${sats(member.bond)} sats · received ${sats(member.received)} sats</p>`
            : '<p class="small muted">You are not a member of this circle.</p>'
        }
        ${actions.join('\n')}
        ${invoice}
      </div>
    </section>

    <section class="members">
      <h3>Members</h3>
      <table class="rtable">
        <thead><tr><th>#</th><th>Member</th><th>This round</th><th>On time</th><th>Missed</th><th>Pot</th><th>Collateral</th><th>Bond</th></tr></thead>
        <tbody>${rows}${openRows}</tbody>
      </table>
    </section>

    <section class="live">
      <h3>Transactions <span class="live-sub small muted">every payment, bid and payout, with its Lightning proof</span></h3>
      <ul>${activity || '<li><span class="when">—</span><span class="what muted">Nothing yet.</span><span class="tail"></span></li>'}</ul>
    </section>

    <section class="panel" style="margin-top:24px">
      <h3>Coordinator</h3>
      <p class="small muted">Plain-language help: what needs doing, and a reminder you can forward to the group.</p>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <button class="btn ghost" data-act="briefing" style="margin:0">What needs doing?</button>
        <select id="reminder-lang" style="max-width:150px">
          <option value="fr">Français</option>
          <option value="en">English</option>
          <option value="wo">Wolof</option>
        </select>
        <button class="btn ghost" data-act="reminder" style="margin:0">Write me a reminder</button>
      </div>
      ${S.briefing ? `<div class="reminder">${esc(S.briefing)}</div>` : ''}
      ${S.reminder ? `<div class="reminder">${esc(S.reminder)}</div>` : ''}
    </section>

    <p class="small muted" style="margin-top:18px">
      Sats in ${sats(c.balance.inSats)} · owed to members ${sats(c.balance.owedSats)} · paid out ${sats(c.balance.paidOutSats)}.
      The difference is always zero: no satoshi is created or stranded.
    </p>
  </div>`;
}

function paintCountdowns() {
  document.querySelectorAll('[data-countdown]').forEach((node) => {
    const deadline = Number(node.getAttribute('data-countdown'));
    if (!deadline) return;
    const left = deadline - Math.floor(Date.now() / 1000);
    node.textContent = left > 0 ? duration(left) : 'ready to close';
  });
}

/**
 * The countdown text ticks every second, but whether the round can be closed is decided when the view
 * is rendered. Refresh the open circle once when its deadline passes, so "Close round" appears on its
 * own instead of only after a reload.
 */
let settlePrompted = '';
setInterval(() => {
  paintCountdowns();
  const c = S.circle;
  if (!c || c.phase !== 'active' || !c.roundDeadline) return;
  const key = `${c.id}:${c.currentRound}`;
  if (c.roundDeadline - Math.floor(Date.now() / 1000) < 0 && settlePrompted !== key) {
    settlePrompted = key;
    void loadCircle(c.id)
      .then(() => render())
      .catch(() => {
        /* the next tick tries again */
        settlePrompted = '';
      });
  }
}, 1000);

// ------------------------------------------------------------------------------------------ actions

async function act(action) {
  const c = S.circle;
  try {
    switch (action) {
      case 'create': {
        const practice = document.getElementById('c-practice').checked;
        const mode = document.getElementById('c-mode').value;
        const config = {
          contributionSats: Number(document.getElementById('c-contribution').value),
          size: Number(document.getElementById('c-size').value),
          roundSeconds: Number(document.getElementById('c-round').value),
          joinWindowSeconds: 86400,
          collateralSats: Number(document.getElementById('c-collateral').value),
          bondBps: Math.round(Number(document.getElementById('c-bond').value) * 100),
          maxDiscountBps: mode === 'auction' ? Math.round(Number(document.getElementById('c-discount').value) * 100) : 0,
          mode,
        };
        const name = document.getElementById('c-name').value.trim();
        // Sign with whatever identity is connected — the extension, the guest key, or the throwaway
        // demo identity. Creating with one key and joining with another would seat the visitor in
        // their own circle as a stranger.
        const r = await api('/api/circles', {
          method: 'POST',
          body: { name, config, ...(practice ? { demo: true } : {}), ...(await sign('create', null, { name, config })) },
        });
        toast('Circle created', 'ok');
        location.hash = `#/c/${r.circle.id}`;
        return;
      }
      case 'join':
        await api(`/api/circles/${c.id}/join`, { method: 'POST', body: await sign('join', c.id) });
        toast('You joined', 'ok');
        break;
      case 'contribute': {
        const r = await api(`/api/circles/${c.id}/contribute`, { method: 'POST', body: await sign('contribute', c.id) });
        if (r.simulated) {
          S.invoice = null;
          toast(`Practice payment of ${sats(c.config.contributionSats)} sats recorded. No sats moved.`, 'ok');
        } else {
          S.invoice = r;
          toast('Invoice ready: pay it, then press "I have paid"', 'ok');
        }
        break;
      }
      case 'confirm': {
        if (!S.invoice) return;
        await api(`/api/circles/${c.id}/contribute/confirm`, {
          method: 'POST',
          body: await sign('contribute', c.id, { paymentHash: S.invoice.paymentHash }),
        });
        S.invoice = null;
        toast('Payment confirmed on Lightning', 'ok');
        break;
      }
      case 'copy-invoice':
        await navigator.clipboard.writeText(S.invoice.invoice);
        toast('Invoice copied', 'ok');
        return;
      case 'bid': {
        const amount = Number(document.getElementById('bid-amount').value);
        await api(`/api/circles/${c.id}/bid`, { method: 'POST', body: await sign('bid', c.id, { discountSats: amount }) });
        toast('Bid placed', 'ok');
        break;
      }
      case 'settle': {
        const r = await api(`/api/circles/${c.id}/settle`, { method: 'POST', body: await sign('settle', c.id) });
        toast(r.result?.winner ? `Round closed: ${sats(r.result.payout)} sats to the winner` : 'Round closed', 'ok');
        break;
      }
      case 'record-contribute': {
        // A practice circle only. The server refuses this for a real circle, so nothing here can
        // manufacture a payment in a circle that is supposed to move sats.
        await api(`/api/circles/${c.id}/contribute`, { method: 'POST', body: await sign('contribute', c.id, { record: true }) });
        S.invoice = null;
        toast(`Recorded, no sats moved: this counts as your ${sats(c.config.contributionSats)} sats for the practice round.`, 'ok');
        break;
      }
      case 'record-payout': {
        const r = await api(`/api/circles/${c.id}/payout`, { method: 'POST', body: await sign('payout', c.id, { record: true }) });
        toast(`Recorded, no sats moved: practice payout of ${sats(r.paidSats)} sats.`, 'ok');
        break;
      }
      case 'payout': {
        const field = document.getElementById('payout-invoice');
        const invoice = field ? field.value.trim() : '';
        const r = await api(`/api/circles/${c.id}/payout`, {
          method: 'POST',
          body: await sign('payout', c.id, { invoice }),
        });
        toast(
          r.simulated
            ? `Practice payout of ${sats(r.paidSats)} sats recorded. No sats moved.`
            : `Paid ${sats(r.paidSats)} sats over Lightning${r.selfInvoiced ? ' · the practice wallet issued and paid the invoice' : ''}${
                r.paymentHash ? ` · payment ${short(r.paymentHash, 8, 6)}` : ''
              }`,
          'ok',
        );
        break;
      }
      case 'cancel':
        await api(`/api/circles/${c.id}/cancel`, { method: 'POST', body: await sign('cancel', c.id) });
        toast('Circle cancelled', 'ok');
        break;
      case 'reminder': {
        const lang = document.getElementById('reminder-lang').value;
        const r = await api(`/api/circles/${c.id}/reminder`, {
          method: 'POST',
          body: await sign('reminder', c.id, { lang }),
        });
        S.reminder = r.text;
        break;
      }
      case 'briefing': {
        const r = await api(`/api/circles/${c.id}/briefing`);
        S.briefing = r.text;
        break;
      }
      case 'demo-join':
      case 'demo-pay':
      case 'demo-bid': {
        // Fill every open seat in one click: a step that needs two presses is a step people get stuck on.
        const open = Math.max(1, c.config.size - c.members.length);
        const payload = action === 'demo-join' ? { join: open } : action === 'demo-pay' ? { pay: true } : { bid: true };
        await api(`/api/circles/${c.id}/demo`, { method: 'POST', body: payload });
        break;
      }
      case 'practice-create': {
        // An auction circle, so the practice run can show a bid for the pot the way the on-chain
        // practice does, not just a fixed join order.
        const config = {
          contributionSats: 21,
          size: 4,
          roundSeconds: 60,
          joinWindowSeconds: 86400,
          collateralSats: 21,
          bondBps: 0,
          maxDiscountBps: 1000,
          mode: 'auction',
        };
        const name = 'Practice circle';
        const r = await api('/api/circles', {
          method: 'POST',
          body: { name, config, demo: true, ...(await sign('create', null, { name, config })) },
        });
        try {
          localStorage.setItem(PRACTICE_KEY, r.circle.id);
        } catch {
          /* storage may be unavailable */
        }
        S.circle = r.circle;
        render();
        return;
      }
      case 'practice-reset':
        try {
          localStorage.removeItem(PRACTICE_KEY);
        } catch {
          /* ignore */
        }
        S.circle = null;
        render();
        return;
      case 'score-lookup': {
        const field = document.getElementById('score-npub');
        const value = field ? field.value.trim() : '';
        if (!value) throw new Error('paste an npub first');
        await lookupScore(value);
        render();
        return;
      }
      default:
        return;
    }
    await loadCircle(c.id);
    await loadList();
    render();
  } catch (e) {
    toast(e.message || 'that did not work', 'err');
  }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-act]');
  if (target) {
    event.preventDefault();
    void act(target.getAttribute('data-act'));
    return;
  }
  const card = event.target.closest('a.card');
  if (card) {
    event.preventDefault();
    location.hash = card.getAttribute('href');
  }
});

document.getElementById('identity-btn').addEventListener('click', () => {
  void connectNostr();
});

window.addEventListener('hashchange', () => {
  S.invoice = null;
  S.reminder = null;
  S.briefing = null;
  S.circle = null;
  render();
});

void boot();
