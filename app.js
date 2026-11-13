// =====================================================================
//  Music Wheel : roue des genres, lecture Spotify pendant X minutes, chat en direct
// =====================================================================

// Client ID public de l'app Spotify (pas un secret : le flux PKCE n'utilise jamais le client secret)
const DEFAULT_CLIENT_ID = '73a86de39f33467bade29e5bc7e0d32d';

const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

// Format d'un genre : "Libellé" ou "Libellé = terme de recherche Spotify"
const DEFAULT_GENRES = [
  'Grunge', 'Punk', 'Techno', 'House', 'Rap', 'K-Pop = kpop', 'Hip-Hop = hip hop', 'R&B = rnb',
];

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d = null) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

// Spotify n'accepte plus "localhost" comme redirect URI : on bascule sur 127.0.0.1
if (location.hostname === 'localhost') {
  location.replace(location.href.replace('//localhost', '//127.0.0.1'));
}
const REDIRECT_URI = location.origin + location.pathname;

// ---------------------------------------------------------------------
//  UI helpers
// ---------------------------------------------------------------------
function say(msg, isError = false) {
  const el = $('message');
  el.textContent = msg || '';
  el.classList.toggle('error', isError);
}

// ---------------------------------------------------------------------
//  Auth Spotify (Authorization Code + PKCE, 100% front)
// ---------------------------------------------------------------------
function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(values, (v) => chars[v % chars.length]).join('');
}

async function sha256base64url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function login() {
  const clientId = DEFAULT_CLIENT_ID;
  store.set('mw_client_id', clientId);
  const verifier = randomString(64);
  store.set('mw_verifier', verifier);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: await sha256base64url(verifier),
  });
  location.href = 'https://accounts.spotify.com/authorize?' + params;
}

function saveToken(data) {
  store.set('mw_token', {
    access: data.access_token,
    refresh: data.refresh_token || store.get('mw_token')?.refresh,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
}

async function tokenRequest(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Erreur d\'authentification');
  saveToken(data);
}

async function handleRedirect() {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return;
  history.replaceState(null, '', REDIRECT_URI);
  if (error) { say('Connexion Spotify refusée : ' + error, true); return; }
  await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: store.get('mw_client_id'),
    code_verifier: store.get('mw_verifier'),
  });
  store.del('mw_verifier');
}

let refreshing = null;
async function getToken(forceRefresh = false) {
  const t = store.get('mw_token');
  if (!t) throw new Error('Pas connecté à Spotify');
  if (!forceRefresh && Date.now() < t.expiresAt - 60_000) return t.access;
  refreshing ||= tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: t.refresh,
    client_id: store.get('mw_client_id'),
  }).finally(() => { refreshing = null; });
  await refreshing;
  return store.get('mw_token').access;
}

function isLoggedIn() { return !!store.get('mw_token'); }

function logout() {
  store.del('mw_token');
  player?.disconnect();
  player = null;
  sdkDeviceId = null;
  location.reload();
}

// ---------------------------------------------------------------------
//  API Spotify
// ---------------------------------------------------------------------
async function api(path, { method = 'GET', body, retry = true } = {}) {
  const res = await fetch('https://api.spotify.com/v1' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + await getToken(),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry) {
    await getToken(true);
    return api(path, { method, body, retry: false });
  }
  if (res.status === 204 || res.status === 202) return null;
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Erreur Spotify ${res.status}`);
    err.status = res.status;
    err.reason = data?.error?.reason;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------
//  Lecteur dans le navigateur (Web Playback SDK, nécessite Premium)
// ---------------------------------------------------------------------
let player = null;
let sdkDeviceId = null;
let sdkReady = false;

window.onSpotifyWebPlaybackSDKReady = () => { sdkReady = true; initPlayer(); };

function initPlayer() {
  if (chatMode || !sdkReady || !isLoggedIn() || player) return;
  player = new Spotify.Player({
    name: 'Music Wheel',
    getOAuthToken: (cb) => getToken().then(cb).catch(() => {}),
    volume: 0.7,
  });
  player.addListener('ready', ({ device_id }) => {
    sdkDeviceId = device_id;
    refreshDevices();
  });
  player.addListener('not_ready', () => { sdkDeviceId = null; refreshDevices(); });
  player.addListener('account_error', () => say('Le lecteur navigateur nécessite un compte Spotify Premium. Tu peux choisir un autre appareil (ex : l\'appli Spotify ouverte).', true));
  player.addListener('authentication_error', ({ message }) => say('Erreur d\'auth du lecteur : ' + message, true));
  player.addListener('initialization_error', ({ message }) => say('Lecteur navigateur indisponible : ' + message, true));
  player.addListener('player_state_changed', (st) => {
    if (st) playback = { progress: st.position, at: Date.now(), playing: !st.paused };
    updateNowPlaying();
  });
  player.connect();
}

async function refreshDevices() {
  if (!isLoggedIn()) return;
  const select = $('deviceSelect');
  let devices = [];
  try { devices = (await api('/me/player/devices')).devices || []; }
  catch (e) { say('Impossible de lister les appareils : ' + e.message, true); }
  const options = [];
  if (sdkDeviceId) options.push({ id: sdkDeviceId, name: 'Ce navigateur (Music Wheel)' });
  for (const d of devices) {
    if (d.id && d.id !== sdkDeviceId) options.push({ id: d.id, name: `${d.name} (${d.type})${d.is_active ? ' • actif' : ''}` });
  }
  const saved = store.get('mw_device');
  select.innerHTML = '';
  if (!options.length) select.innerHTML = '<option value="">Aucun appareil : ouvre Spotify quelque part</option>';
  for (const o of options) select.add(new Option(o.name, o.id));
  if (options.some((o) => o.id === saved)) select.value = saved;
}

// ---------------------------------------------------------------------
//  Recherche de morceaux pour un genre
// ---------------------------------------------------------------------
const normalize = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const parseGenre = (entry) => {
  const [label, query] = entry.split('=').map((s) => s.trim());
  return { label, query: normalize(query || label) };
};

const PAGE = 10; // Spotify limite désormais la taille des pages de recherche en mode développement

async function searchTracks(q, offset) {
  const params = new URLSearchParams({ q, type: 'track', limit: PAGE, offset });
  const data = await api('/search?' + params);
  return data.tracks || { items: [], total: 0 };
}

async function collectTracks(q, targetMs) {
  const first = await searchTracks(q, 0);
  const total = Math.min(first.total || 0, 1000);
  if (!total) return [];
  const byId = new Map();
  const add = (items) => items.forEach((t) => t && t.uri && !t.is_local && byId.set(t.id, t));
  add(first.items);

  // On pioche des pages au hasard pour varier, jusqu'à couvrir ~2x la durée voulue
  const maxOffset = Math.max(0, total - PAGE);
  const tried = new Set([0]);
  const duration = () => [...byId.values()].reduce((s, t) => s + t.duration_ms, 0);
  for (let round = 0; round < 4 && duration() < targetMs * 2 && tried.size * PAGE < total; round++) {
    const offsets = [];
    while (offsets.length < 4 && tried.size * PAGE < total) {
      const off = Math.floor(Math.random() * (maxOffset / PAGE + 1)) * PAGE;
      if (!tried.has(off)) { tried.add(off); offsets.push(off); }
    }
    const pages = await Promise.all(offsets.map((o) => searchTracks(q, o).catch(() => ({ items: [] }))));
    pages.forEach((p) => add(p.items));
  }
  return [...byId.values()];
}

async function tracksForGenre(entry, targetMs) {
  const { query } = parseGenre(entry);
  let tracks = await collectTracks(`genre:"${query}"`, targetMs);
  if (tracks.length < 5) tracks = tracks.concat(await collectTracks(query, targetMs));
  // mélange
  for (let i = tracks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  }
  // garder juste assez pour la session (+ marge)
  const out = [];
  let ms = 0;
  for (const t of tracks) {
    if (out.some((o) => o.id === t.id)) continue;
    out.push(t); ms += t.duration_ms;
    if (ms > targetMs + 10 * 60_000 || out.length >= 100) break;
  }
  return out;
}

// Cherche des playlists Spotify pour le genre et en choisit une au hasard parmi les meilleures
async function pickPlaylist(entry) {
  const { query } = parseGenre(entry);
  const seen = new Map();
  for (const q of [query, `${query} playlist`, `best ${query}`]) {
    try {
      const data = await api('/search?' + new URLSearchParams({ q, type: 'playlist', limit: PAGE }));
      for (const p of data.playlists?.items || []) {
        const n = p?.tracks?.total ?? p?.items?.total ?? 0;
        if (p && p.uri && n >= 15) seen.set(p.id, p);
      }
    } catch { /* on tente la requête suivante */ }
    if (seen.size >= 6) break;
  }
  const list = [...seen.values()];
  return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

// ---------------------------------------------------------------------
//  Session de lecture
// ---------------------------------------------------------------------
let session = null; // { genre, endAt, interval, poll, deviceId }

async function startSession(entry) {
  stopSession(false);
  const minutes = Math.max(1, Number($('duration').value) || 15);
  const targetMs = minutes * 60_000;
  const deviceId = $('deviceSelect').value;
  const { label } = parseGenre(entry);

  winner = entry;
  setGenreColor(entry);
  $('result').hidden = false;
  showGenreName(label);
  nowKey = '';
  $('result').classList.remove('playing');
  $('timer').textContent = fmt(targetMs);
  $('nowPlaying').textContent = "Recherche d'une playlist…";
  $('playlistInfo').textContent = '';
  say('');

  if (!isLoggedIn()) { $('nowPlaying').textContent = ''; say('Connecte-toi à Spotify pour lancer la musique.', true); return; }
  if (!deviceId) { $('nowPlaying').textContent = ''; say('Aucun appareil de lecture. Ouvre Spotify (appli ou web) puis clique sur « Rafraîchir les appareils ».', true); return; }

  try {
    const dev = `device_id=${encodeURIComponent(deviceId)}`;
    const playlist = await pickPlaylist(entry);
    if (playlist) {
      // Lecture d'une vraie playlist Spotify, en aléatoire, à partir d'un morceau au hasard
      const total = playlist.tracks?.total || playlist.items?.total || 0;
      await api(`/me/player/play?${dev}`, {
        method: 'PUT',
        body: {
          context_uri: playlist.uri,
          ...(total > 1 ? { offset: { position: Math.floor(Math.random() * Math.min(total, 100)) } } : {}),
        },
      });
      setTimeout(() => api(`/me/player/shuffle?state=true&${dev}`, { method: 'PUT' }).catch(() => {}), 800);
      $('playlistInfo').innerHTML = '';
      const a = document.createElement('a');
      a.href = playlist.external_urls?.spotify || '#';
      a.target = '_blank';
      a.innerHTML = '<svg class="i"><use href="#i-disc"/></svg><span></span>';
      a.querySelector('span').textContent = playlist.name + (playlist.owner?.display_name ? `, par ${playlist.owner.display_name}` : '');
      $('playlistInfo').appendChild(a);
    } else {
      // Repli : pas de playlist trouvée -> on compose une file de morceaux du genre
      const tracks = await tracksForGenre(entry, targetMs);
      if (!tracks.length) throw new Error(`Rien trouvé pour « ${label} ». Essaie un autre terme (ex : "${label} = autre mot-clé").`);
      await api(`/me/player/play?${dev}`, { method: 'PUT', body: { uris: tracks.map((t) => t.uri) } });
      $('playlistInfo').textContent = 'Sélection de morceaux du genre';
    }
  } catch (e) {
    $('nowPlaying').textContent = '';
    if (e.status === 403) say('Spotify refuse la lecture : un compte Premium est nécessaire pour contrôler la lecture via l\'API.', true);
    else if (e.status === 404) say('Appareil introuvable. Ouvre Spotify, lance/pause un son, puis « Rafraîchir les appareils ».', true);
    else say(e.message, true);
    return;
  }

  session = {
    genre: entry,
    deviceId,
    endAt: Date.now() + targetMs,
    total: targetMs,
    interval: setInterval(tick, 500),
    poll: setInterval(updateNowPlaying, 4000),
  };
  $('result').classList.add('live');
  document.body.classList.add('live');
  tick();
  setTimeout(updateNowPlaying, 1500);
}

function tick() {
  if (!session) return;
  const left = session.endAt - Date.now();
  $('timer').textContent = fmt(Math.max(0, left));
  $('progressBar').style.width = `${Math.max(0, Math.min(1, left / session.total)) * 100}%`;
  $('result').classList.toggle('final', left > 0 && left <= 10_000);
  const secs = Math.ceil(left / 1000);
  if (secs >= 1 && secs <= 5 && secs !== session.lastCount) { session.lastCount = secs; showCount(secs); }
  TROLL.maybe();
  if (left <= 0) {
    TROLL.stop();
    stopSession(true);
    $('result').classList.remove('final');
    const auto = $('autoSpin').checked;
    celebrate(auto);
    say(auto ? 'Session terminée ! La roue repart…' : 'Session terminée ! Relance la roue pour un nouveau genre.');
    if (auto) setTimeout(spin, 3300);
    else if (updatePending) setTimeout(() => applyUpdate(false), 3300);
  }
}

function stopSession(pause = true) {
  if (!session) return;
  clearInterval(session.interval);
  clearInterval(session.poll);
  if (pause) api(`/me/player/pause?device_id=${encodeURIComponent(session.deviceId)}`, { method: 'PUT' }).catch(() => {});
  const played = session.genre;
  session = null;
  $('timer').textContent = '00:00';
  $('progressBar').style.width = '0%';
  $('result').classList.remove('live', 'playing');
  document.body.classList.remove('live');
  winner = null;
  markPlayed(played);
}

async function updateNowPlaying() {
  if (!session) return;
  try {
    const state = await api('/me/player');
    const item = state?.item;
    renderNow(item, !!state?.is_playing);
    playback = { progress: state?.progress_ms || 0, at: Date.now(), playing: !!state?.is_playing };
    if (item && item.id !== lyrics.trackId) loadLyrics(item);
  } catch { /* silencieux */ }
}

let nowKey = '';
function trackMeta(item) {
  const meta = document.createElement('div');
  meta.className = 'meta';
  const t = document.createElement('div'); t.className = 'title'; t.textContent = item.name;
  const a = document.createElement('div'); a.className = 'artist'; a.textContent = item.artists.map((x) => x.name).join(', ');
  meta.append(t, a);
  return meta;
}

function renderNow(item, playing) {
  $('result').classList.toggle('playing', playing);
  const key = item ? `${item.id}|${playing}` : '';
  if (key === nowKey) return;
  nowKey = key;
  const el = $('nowPlaying');
  el.innerHTML = '';
  if (!item) return;
  const eq = document.createElement('span');
  eq.className = 'eq' + (playing ? '' : ' paused');
  eq.innerHTML = '<i></i><i></i><i></i><i></i>';
  el.append(eq, trackMeta(item));
}

function showGenreName(label) {
  const el = $('resultGenre');
  el.innerHTML = '';
  [...label].forEach((ch, i) => {
    const span = document.createElement('span');
    span.textContent = ch === ' ' ? '\u00a0' : ch;
    span.style.animationDelay = `${i * 45}ms`;
    el.appendChild(span);
  });
}

// ---------------------------------------------------------------------
//  Paroles (LRCLIB : gratuit, sans clé, paroles synchronisées)
// ---------------------------------------------------------------------
let lyrics = { trackId: null, lines: [], active: -1 };
let playback = { progress: 0, at: 0, playing: false };

function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) lines.push({ t: (Number(m[1]) * 60 + Number(m[2])) * 1000, text });
  }
  return lines.sort((a, b) => a.t - b.t);
}

async function fetchLyrics(item) {
  const artist = item.artists?.[0]?.name || '';
  const base = 'https://lrclib.net/api/';
  try {
    const res = await fetch(base + 'get?' + new URLSearchParams({
      track_name: item.name, artist_name: artist,
      album_name: item.album?.name || '', duration: Math.round(item.duration_ms / 1000),
    }));
    if (res.ok) return await res.json();
  } catch { /* on tente la recherche */ }
  // Repli : recherche plus souple (titre sans "- Remastered", "(feat. ...)", etc.)
  const title = item.name.replace(/\s*[-(\[].*$/, '').trim() || item.name;
  const res = await fetch(base + 'search?' + new URLSearchParams({ track_name: title, artist_name: artist }));
  if (!res.ok) return null;
  const list = await res.json();
  return list.find((r) => r.syncedLyrics) || list.find((r) => r.plainLyrics || r.instrumental) || null;
}

async function loadLyrics(item) {
  lyrics = { trackId: item.id, lines: [], active: -1 };
  const box = $('lyrics');
  $('lyricsTrack').replaceChildren(trackMeta(item));
  box.innerHTML = '<p class="lyrics-empty">Recherche des paroles…</p>';
  box.scrollTop = 0;
  let data = null;
  try { data = await fetchLyrics(item); } catch { /* affiché ci-dessous */ }
  if (lyrics.trackId !== item.id) return; // le morceau a changé entre-temps

  box.innerHTML = '';
  const empty = (msg) => { box.innerHTML = `<p class="lyrics-empty">${msg}</p>`; };
  if (!data) return empty('Paroles introuvables pour ce morceau.');
  if (data.instrumental) return empty('Morceau instrumental.');
  if (data.syncedLyrics) {
    lyrics.lines = parseLrc(data.syncedLyrics);
    for (const l of lyrics.lines) {
      const p = document.createElement('p');
      p.className = 'line';
      p.textContent = l.text || '…';
      box.appendChild(p);
    }
    syncLyrics();
  } else if (data.plainLyrics) {
    const p = document.createElement('p');
    p.className = 'plain';
    p.textContent = data.plainLyrics;
    box.appendChild(p);
  } else empty('Paroles introuvables pour ce morceau.');
}

function syncLyrics() {
  if (!lyrics.lines.length) return;
  const pos = playback.progress + (playback.playing ? Date.now() - playback.at : 0) + 250;
  let i = -1;
  while (i + 1 < lyrics.lines.length && lyrics.lines[i + 1].t <= pos) i++;
  if (i === lyrics.active) return;
  lyrics.active = i;
  const box = $('lyrics');
  [...box.children].forEach((el, k) => {
    el.classList.toggle('active', k === i);
    el.classList.toggle('past', k < i);
  });
  const el = box.children[Math.max(0, i)];
  if (el) box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
}
setInterval(syncLyrics, 250);

async function control(action) {
  if (!session) return;
  const dev = `device_id=${encodeURIComponent(session.deviceId)}`;
  try {
    if (action === 'toggle') {
      const state = await api('/me/player');
      if (state?.is_playing) {
        await api(`/me/player/pause?${dev}`, { method: 'PUT' });
        // Le minuteur continue : la session dure X minutes "réelles"
      } else {
        await api(`/me/player/play?${dev}`, { method: 'PUT' });
      }
    } else {
      await api(`/me/player/${action}?${dev}`, { method: 'POST' });
    }
    setTimeout(updateNowPlaying, 600);
  } catch (e) { say(e.message, true); }
}

// ---------------------------------------------------------------------
//  Moteur de particules plein écran (étincelles, confettis, ondes de choc)
// ---------------------------------------------------------------------
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const PALETTE = ['#1ed760', '#7c5cff', '#ff4fa3', '#ffd23f', '#3fd5ff', '#ffffff', '#ff7a3d'];

const FX = (() => {
  const cv = $('fx');
  const c = cv.getContext('2d');
  let W = 0, H = 0, parts = [], rings = [], running = false;
  const resize = () => {
    const r = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * r; cv.height = H * r;
    c.setTransform(r, 0, 0, r, 0, 0);
  };
  resize();
  addEventListener('resize', resize);

  function loop() {
    c.clearRect(0, 0, W, H);
    c.globalCompositeOperation = 'lighter';
    rings = rings.filter((g) => (g.life -= 0.028) > 0);
    for (const g of rings) {
      g.rad += g.speed;
      c.beginPath(); c.arc(g.x, g.y, g.rad, 0, Math.PI * 2);
      c.strokeStyle = g.color; c.globalAlpha = g.life * 0.7; c.lineWidth = 6 * g.life + 1; c.stroke();
    }
    parts = parts.filter((p) => (p.life -= p.decay) > 0);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy;
      c.globalAlpha = Math.min(1, p.life * 1.5);
      c.fillStyle = p.color;
      if (p.kind === 'confetti') {
        p.vx *= 0.97; p.vy = p.vy * 0.97 + 0.22; p.rot += p.vr;
        c.globalCompositeOperation = 'source-over';
        c.save(); c.translate(p.x, p.y); c.rotate(p.rot);
        c.fillRect(-p.size / 2, -p.size / 4, p.size, (p.size / 2) * Math.abs(Math.cos(p.rot * 2)) + 1);
        c.restore();
        c.globalCompositeOperation = 'lighter';
      } else {
        p.vx *= p.drag; p.vy = p.vy * p.drag + p.grav;
        c.beginPath(); c.arc(p.x, p.y, p.size, 0, Math.PI * 2); c.fill();
        c.globalAlpha *= 0.4;
        c.beginPath(); c.arc(p.x - p.vx * 2.5, p.y - p.vy * 2.5, p.size * 0.8, 0, Math.PI * 2); c.fill();
      }
    }
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    if (parts.length || rings.length) requestAnimationFrame(loop);
    else { running = false; c.clearRect(0, 0, W, H); }
  }

  function burst(x, y, { n = 80, power = 10, colors = PALETTE, kind = 'spark', ring = true, grav = 0.12, drag = 0.955, up = 0 } = {}) {
    if (REDUCED) return;
    if (ring) rings.push({ x, y, rad: 4, speed: power * 1.3, life: 1, color: colors[0] });
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = power * (0.3 + Math.random() * 0.7);
      parts.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - up, kind, grav, drag,
        life: 1, decay: 0.006 + Math.random() * 0.012,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: kind === 'confetti' ? 6 + Math.random() * 7 : 1.6 + Math.random() * 2.6,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
      });
    }
    if (parts.length > 2500) parts.splice(0, parts.length - 2500);
    if (!running) { running = true; requestAnimationFrame(loop); }
  }
  return { burst, get W() { return W; }, get H() { return H; } };
})();

// ---------------------------------------------------------------------
//  Effets sonores synthétisés (aucun fichier audio)
// ---------------------------------------------------------------------
const SFX = (() => {
  let ac = null;
  const ctx = () => {
    if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  };
  const enabled = () => $('sfx')?.checked !== false;

  function tone(freq, dur, { type = 'sine', vol = 0.2, slide = 0, delay = 0 } = {}) {
    const a = ctx(); if (!a) return;
    const t = a.currentTime + delay;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(dur, { vol = 0.3, from = 400, to = 4000, delay = 0 } = {}) {
    const a = ctx(); if (!a) return;
    const t = a.currentTime + delay;
    const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = a.createBufferSource(); src.buffer = buf;
    const f = a.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = a.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(a.destination);
    src.start(t);
  }
  const on = (fn) => (...args) => { if (enabled()) try { fn(...args); } catch { /* audio indisponible */ } };
  return {
    unlock: () => ctx(),
    tick: on(() => tone(1900 + Math.random() * 300, 0.03, { type: 'square', vol: 0.04 })),
    whoosh: on(() => noise(1.2, { vol: 0.18, from: 300, to: 3000 })),
    reveal: on(() => {
      tone(70, 0.7, { vol: 0.6, slide: -40 });
      noise(0.8, { vol: 0.3, from: 5000, to: 200 });
      [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.6, { type: 'triangle', vol: 0.1, delay: 0.06 + i * 0.06 }));
    }),
    beep: on((last) => tone(last ? 1320 : 880, last ? 0.4 : 0.14, { type: 'square', vol: 0.07 })),
    boom: on(() => {
      tone(55, 1.2, { vol: 0.7, slide: -30 });
      noise(1.4, { vol: 0.45, from: 2000, to: 100 });
      [392, 523, 659, 784, 1047].forEach((f, i) => tone(f, 0.35, { type: 'sawtooth', vol: 0.05, delay: 0.2 + i * 0.09 }));
    }),
    horn: on(() => {
      // klaxon de stade façon « air horn »
      [0, 0.28, 0.56].forEach((d, k) => [466, 587, 698].forEach((f) => tone(f, k === 2 ? 0.7 : 0.22, { type: 'sawtooth', vol: 0.05, delay: d })));
    }),
  };
})();
// Les navigateurs exigent un geste de l'utilisateur avant de jouer du son
['pointerdown', 'keydown'].forEach((ev) => addEventListener(ev, () => SFX.unlock(), { once: true }));

// ---------------------------------------------------------------------
//  Couleur du genre en cours + pulsation façon « beat »
// ---------------------------------------------------------------------
let genreColor = '#1ed760';
let genreHue = 140;
function setGenreColor(entry) {
  genreColor = colorFor(entry);
  genreHue = Number(/hsl\((\d+)/.exec(genreColor)?.[1] ?? 140);
  document.documentElement.style.setProperty('--genre', genreColor);
}
const BPM = 124;
function beatLevel(now) {
  if (!session || !playback.playing) return 0;
  const period = 60000 / BPM;
  return Math.pow(1 - (now % period) / period, 3);
}

// ---------------------------------------------------------------------
//  Fond animé : rubans lumineux + particules qui montent
// ---------------------------------------------------------------------
const BG = (() => {
  const cv = $('bgfx');
  const c = cv.getContext('2d');
  const SCALE = 0.5;
  let W = 0, H = 0, energy = 0.3;
  const resize = () => { W = innerWidth; H = innerHeight; cv.width = W * SCALE; cv.height = H * SCALE; c.setTransform(SCALE, 0, 0, SCALE, 0, 0); };
  resize();
  addEventListener('resize', resize);
  const motes = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 2.4, v: 0.3 + Math.random(), tw: Math.random() * 6 }));

  function draw(now, beat) {
    energy += ((session ? (playback.playing ? 1 : 0.5) : 0.3) - energy) * 0.02;
    c.clearRect(0, 0, W, H);
    c.globalCompositeOperation = 'lighter';
    const hues = [genreHue, (genreHue + 120) % 360, (genreHue + 230) % 360];
    hues.forEach((hue, k) => {
      const baseY = H * (0.5 + k * 0.14);
      const amp = H * (0.06 + 0.05 * energy) * (1 + beat * 0.25);
      for (const [width, alpha] of [[90, 0.05], [30, 0.08], [3, 0.5]]) {
        c.beginPath();
        for (let x = -20; x <= W + 20; x += 18) {
          const y = baseY
            + Math.sin(x * 0.0035 + now * 0.00035 * (1 + k * 0.4) + k * 2) * amp
            + Math.sin(x * 0.009 - now * 0.0006 + k) * amp * 0.35 * energy;
          x === -20 ? c.moveTo(x, y) : c.lineTo(x, y);
        }
        c.strokeStyle = `hsla(${hue}, 90%, 60%, ${alpha * (0.6 + energy * 0.6)})`;
        c.lineWidth = width; c.lineCap = 'round';
        c.stroke();
      }
    });
    for (const m of motes) {
      m.y -= (m.v * (0.4 + energy * 1.4)) / H;
      if (m.y < -0.02) { m.y = 1.02; m.x = Math.random(); }
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(now * 0.002 + m.tw));
      c.globalAlpha = tw * (0.35 + energy * 0.4);
      c.fillStyle = `hsl(${(genreHue + m.tw * 40) % 360}, 90%, 75%)`;
      c.beginPath(); c.arc(m.x * W, m.y * H, m.r * (1 + beat * 0.6), 0, Math.PI * 2); c.fill();
    }
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  }
  return { draw };
})();

// ---------------------------------------------------------------------
//  Visualiseur circulaire autour de la roue
// ---------------------------------------------------------------------
const VIZ = (() => {
  const cv = $('viz');
  const c = cv.getContext('2d');
  const S = 640, BARS = 128;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = cv.height = S * dpr;
  let energy = 0.1;
  function draw(now, beat) {
    energy += ((session ? (playback.playing ? 1 : 0.3) : spinning ? 0.7 : 0.12) - energy) * 0.05;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, S, S);
    const cx = S / 2, R0 = S * 0.415, MAX = S * 0.075;
    c.lineCap = 'round';
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < BARS; i++) {
        const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
        const n = (Math.sin(i * 0.31 + now * 0.004) + Math.sin(i * 0.13 - now * 0.0063) + Math.sin(i * 0.047 + now * 0.0021)) / 6 + 0.5;
        const len = MAX * (0.08 + energy * (0.25 + 0.75 * n) * (0.55 + 0.45 * beat));
        const x0 = cx + Math.cos(a) * R0, y0 = cx + Math.sin(a) * R0;
        c.beginPath(); c.moveTo(x0, y0); c.lineTo(x0 + Math.cos(a) * len, y0 + Math.sin(a) * len);
        c.strokeStyle = `hsla(${(genreHue + i * 2.8) % 360}, 95%, 62%, ${pass ? 0.95 : 0.25})`;
        c.lineWidth = pass ? 3 : 9;
        c.stroke();
      }
    }
  }
  return { draw };
})();

// ---------------------------------------------------------------------
//  Révélation plein écran du genre tiré
// ---------------------------------------------------------------------
function revealGenre(label) {
  const el = $('reveal');
  $('revealName').textContent = label;
  el.style.setProperty('--rc', genreColor);
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  SFX.reveal();
  const x = innerWidth / 2, y = innerHeight / 2;
  FX.burst(x, y, { n: 220, power: 17, colors: [genreColor, '#ffffff', genreColor, '#ffd23f'] });
  setTimeout(() => FX.burst(x, y, { n: 120, power: 12, kind: 'confetti', colors: [genreColor, '#ffffff', '#7c5cff', '#ff4fa3', '#ffd23f'], up: 3 }), 120);
  document.body.classList.add('flash');
  setTimeout(() => document.body.classList.remove('flash'), 500);
  setTimeout(() => el.classList.remove('show'), 3000);
}

// Compte à rebours géant sur les 5 dernières secondes
function showCount(n) {
  const el = $('countdown');
  el.textContent = n;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  SFX.beep(n === 1);
}

// ---------------------------------------------------------------------
//  Explosion de fin de chrono (feu d'artifice + confettis plein écran)
// ---------------------------------------------------------------------
function celebrate(autoNext) {
  const boom = $('boom');
  boom.querySelector('small').textContent = autoNext ? 'Nouveau genre dans un instant…' : 'Relance la roue pour continuer !';
  boom.classList.remove('show'); void boom.offsetWidth; boom.classList.add('show');
  document.body.classList.add('flash', 'shake');
  setTimeout(() => document.body.classList.remove('flash', 'shake'), 600);
  setTimeout(() => boom.classList.remove('show'), 3300);
  SFX.boom();
  const W = innerWidth, H = innerHeight;
  FX.burst(W / 2, H / 2, { n: 260, power: 17 });
  FX.burst(W / 2, H / 2, { n: 160, power: 13, kind: 'confetti', up: 4 });
  [250, 550, 850, 1150, 1500, 1850, 2200].forEach((d) => setTimeout(() => {
    FX.burst(W * (0.12 + Math.random() * 0.76), H * (0.12 + Math.random() * 0.5), { n: 100, power: 9, kind: Math.random() < 0.5 ? 'spark' : 'confetti' });
  }, d));
}

// ---------------------------------------------------------------------
//  Fonds troll : scènes animées plein écran (ou GIF perso), de temps
//  en temps pendant la musique, ou via « !troll » dans le chat
// ---------------------------------------------------------------------
const TROLL_MS = 11000;
const TROLL = (() => {
  const layer = $('troll');
  const cv = $('trollCv');
  const c = cv.getContext('2d');
  let W = 0, H = 0, raf = 0, endTimer = 0, active = false, nextAt = 0;
  const SCALE = 0.75;
  const resize = () => { W = innerWidth; H = innerHeight; cv.width = W * SCALE; cv.height = H * SCALE; c.setTransform(SCALE, 0, 0, SCALE, 0, 0); };
  addEventListener('resize', () => { if (active) resize(); });
  const font = (px, w = 700) => `${w} ${px}px "Space Grotesk", Inter, sans-serif`;

  const SCENES = {
    disco: { name: 'Mode disco', make() {
      return (t) => {
        c.fillStyle = '#06020d'; c.fillRect(0, 0, W, H);
        const cx = W / 2, cy = H * 0.14, R = Math.min(W, H) * 0.09;
        c.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 10; i++) {
          const a = Math.PI / 2 + Math.sin(t / 650 + i * 1.3) * 1.1;
          const hue = (i * 36 + t / 8) % 360;
          const g = c.createLinearGradient(cx, cy, cx + Math.cos(a) * H * 1.4, cy + Math.sin(a) * H * 1.4);
          g.addColorStop(0, `hsla(${hue}, 100%, 60%, .6)`); g.addColorStop(1, `hsla(${hue}, 100%, 60%, 0)`);
          c.fillStyle = g;
          c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, H * 1.5, a - 0.06, a + 0.06); c.closePath(); c.fill();
        }
        for (let i = 0; i < 90; i++) {
          const a = i * 2.39 + t / 1800, r = ((i * 37) % 100) / 100;
          c.fillStyle = `hsla(${(i * 29 + t / 6) % 360}, 100%, 70%, .85)`;
          c.beginPath(); c.arc(cx + Math.cos(a) * r * W * 0.7, H * 0.6 + Math.sin(a) * r * H * 0.4, 2 + (i % 4), 0, 7); c.fill();
        }
        c.globalCompositeOperation = 'source-over';
        // boule à facettes
        c.save(); c.beginPath(); c.arc(cx, cy, R, 0, 7); c.clip();
        const tile = R / 5;
        for (let y = -R; y < R; y += tile) for (let x = -R; x < R; x += tile) {
          const l = 30 + 60 * Math.abs(Math.sin(t / 180 + x * 0.09 + y * 0.13));
          c.fillStyle = `hsl(${(t / 10 + x) % 360}, 30%, ${l}%)`;
          c.fillRect(cx + x + 1, cy + y + 1, tile - 2, tile - 2);
        }
        c.restore();
        c.strokeStyle = '#999'; c.lineWidth = 3; c.beginPath(); c.moveTo(cx, 0); c.lineTo(cx, cy - R); c.stroke();
        if (Math.floor(t / 110) % 8 === 0) { c.fillStyle = 'rgba(255,255,255,.35)'; c.fillRect(0, 0, W, H); }
      };
    } },

    logo: { name: 'Le logo qui rebondit', make() {
      const logos = Array.from({ length: 5 }, (_, i) => ({
        x: Math.random() * (W - 300), y: Math.random() * (H - 120),
        vx: (i % 2 ? 1 : -1) * (3 + Math.random() * 3), vy: (i % 3 ? 1 : -1) * (3 + Math.random() * 3), hue: Math.random() * 360,
      }));
      return () => {
        c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(0, 0, W, H);
        const w = Math.min(320, W * 0.3), h = w * 0.38;
        for (const l of logos) {
          l.x += l.vx; l.y += l.vy;
          let hx = false, hy = false;
          if (l.x < 0 || l.x + w > W) { l.vx *= -1; l.x = Math.max(0, Math.min(W - w, l.x)); hx = true; }
          if (l.y < 0 || l.y + h > H) { l.vy *= -1; l.y = Math.max(0, Math.min(H - h, l.y)); hy = true; }
          if (hx || hy) l.hue = (l.hue + 80 + Math.random() * 120) % 360;
          if (hx && hy) { FX.burst(l.x + w / 2, l.y + h / 2, { n: 140, power: 12, kind: 'confetti' }); SFX.horn(); }
          c.save(); c.translate(l.x + w / 2, l.y + h / 2);
          c.fillStyle = `hsl(${l.hue}, 95%, 58%)`;
          c.shadowColor = `hsl(${l.hue}, 95%, 58%)`; c.shadowBlur = 30;
          c.beginPath(); c.ellipse(0, 0, w / 2, h / 2, 0, 0, 7); c.fill();
          c.shadowBlur = 0; c.fillStyle = '#000'; c.textAlign = 'center'; c.textBaseline = 'middle';
          c.font = font(w * 0.13); c.fillText('MUSIC', 0, -h * 0.14);
          c.font = font(w * 0.13); c.fillText('WHEEL', 0, h * 0.16);
          c.restore();
        }
      };
    } },

    matrix: { name: 'Bienvenue dans la matrice', make() {
      const fs = 20, chars = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホBASSDROP0123456789';
      const cols = Math.ceil(W / fs);
      const drops = Array.from({ length: cols }, () => Math.random() * -60);
      c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
      return (t) => {
        c.fillStyle = 'rgba(0,0,0,.09)'; c.fillRect(0, 0, W, H);
        c.font = `700 ${fs}px ui-monospace, monospace`; c.textAlign = 'left';
        for (let i = 0; i < cols; i++) {
          c.fillStyle = Math.random() < 0.04 ? '#e8ffe8' : '#1dff7a';
          c.fillText(chars[Math.floor(Math.random() * chars.length)], i * fs, drops[i] * fs);
          drops[i] = drops[i] * fs > H && Math.random() > 0.97 ? 0 : drops[i] + 1;
        }
        const a = 0.6 + 0.4 * Math.sin(t / 300);
        c.save(); c.textAlign = 'center'; c.textBaseline = 'middle';
        c.font = font(Math.min(W * 0.075, 110)); c.shadowColor = '#1dff7a'; c.shadowBlur = 40;
        c.fillStyle = `rgba(200,255,220,${a})`;
        c.fillText('TU ES DANS LA MATRICE', W / 2, H / 2);
        c.restore();
      };
    } },

    vapor: { name: 'A E S T H E T I C', make() {
      return (t) => {
        const sky = c.createLinearGradient(0, 0, 0, H * 0.6);
        sky.addColorStop(0, '#120030'); sky.addColorStop(0.6, '#5a0a6e'); sky.addColorStop(1, '#ff3c8e');
        c.fillStyle = sky; c.fillRect(0, 0, W, H * 0.6);
        // soleil rayé
        const sr = Math.min(W, H) * 0.22, sx = W / 2, sy = H * 0.6 - sr * 0.35;
        const sun = c.createLinearGradient(0, sy - sr, 0, sy + sr);
        sun.addColorStop(0, '#ffe66d'); sun.addColorStop(1, '#ff2d95');
        c.save(); c.beginPath(); c.arc(sx, sy, sr, 0, 7); c.clip();
        c.fillStyle = sun; c.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
        c.fillStyle = '#5a0a6e';
        for (let k = 0; k < 7; k++) { const yy = sy + k * sr * 0.14 + ((t / 40) % (sr * 0.14)); c.fillRect(sx - sr, yy, sr * 2, 3 + k * 2); }
        c.restore();
        // sol en grille néon
        c.fillStyle = '#0b0016'; c.fillRect(0, H * 0.6, W, H * 0.4);
        c.strokeStyle = '#ff2dd4'; c.lineWidth = 2; c.shadowColor = '#ff2dd4'; c.shadowBlur = 12;
        const hy = H * 0.6, off = (t / 18) % 40;
        for (let i = 0; i < 24; i++) { const y = hy + Math.pow((i * 40 + off) / 960, 2) * H * 0.4 * 2.4; if (y > H) break; c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
        for (let i = -20; i <= 20; i++) { c.beginPath(); c.moveTo(W / 2 + i * 30, hy); c.lineTo(W / 2 + i * W * 0.12, H); c.stroke(); }
        c.shadowBlur = 0;
        c.save(); c.textAlign = 'center'; c.font = font(Math.min(W * 0.09, 130));
        c.fillStyle = '#00f0ff'; c.fillText('ＡＥＳＴＨＥＴＩＣ', W / 2 + 5, H * 0.24 + 5);
        c.fillStyle = '#ff5ad1'; c.fillText('ＡＥＳＴＨＥＴＩＣ', W / 2, H * 0.24);
        c.restore();
      };
    } },

    hypno: { name: 'Regarde la spirale', make() {
      return (t) => {
        const cx = W / 2, cy = H / 2, R = Math.hypot(W, H);
        const rot = t / 260, n = 24;
        for (let i = 0; i < n; i++) {
          c.beginPath(); c.moveTo(cx, cy);
          c.arc(cx, cy, R, rot + (i / n) * Math.PI * 2, rot + ((i + 0.5) / n) * Math.PI * 2);
          c.closePath();
          c.fillStyle = i % 2 ? '#000' : `hsl(${(i * 15 + t / 5) % 360}, 100%, 55%)`;
          c.fill();
        }
        for (let k = 12; k > 0; k--) {
          const r = ((k * 60 + t / 4) % 720);
          c.beginPath(); c.arc(cx, cy, r, 0, 7);
          c.strokeStyle = `rgba(255,255,255,${0.5 - r / 1600})`; c.lineWidth = 6; c.stroke();
        }
        const sc = 1 + 0.15 * Math.sin(t / 200);
        c.save(); c.translate(cx, cy); c.scale(sc, sc); c.textAlign = 'center'; c.textBaseline = 'middle';
        c.font = font(Math.min(W * 0.08, 120)); c.lineWidth = 10; c.strokeStyle = '#000'; c.fillStyle = '#fff';
        c.strokeText('TOURNE… TOURNE…', 0, 0); c.fillText('TOURNE… TOURNE…', 0, 0);
        c.restore();
      };
    } },

    bass: { name: 'Bass boosted', make() {
      document.body.classList.add('quake');
      return (t) => {
        const beat = Math.pow(1 - ((t % 480) / 480), 2);
        c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
        c.globalCompositeOperation = 'lighter';
        for (let k = 0; k < 6; k++) {
          const r = ((t / 3 + k * 140) % 840);
          c.beginPath(); c.arc(W / 2, H / 2, r, 0, 7);
          c.strokeStyle = `hsla(${(k * 50 + t / 6) % 360}, 100%, 60%, ${1 - r / 840})`; c.lineWidth = 18; c.stroke();
        }
        c.globalCompositeOperation = 'source-over';
        const shake = 18 * beat;
        const sx = (Math.random() - 0.5) * shake, sy = (Math.random() - 0.5) * shake;
        c.save(); c.translate(W / 2 + sx, H / 2 + sy); c.scale(1 + beat * 0.25, 1 + beat * 0.25);
        c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = font(Math.min(W * 0.13, 190));
        c.fillStyle = 'rgba(255,0,60,.9)'; c.fillText('BASS BOOSTED', -8, 0);
        c.fillStyle = 'rgba(0,240,255,.9)'; c.fillText('BASS BOOSTED', 8, 0);
        c.fillStyle = '#fff'; c.fillText('BASS BOOSTED', 0, 0);
        c.restore();
        if (beat > 0.95) c.fillStyle = 'rgba(255,255,255,.15)', c.fillRect(0, 0, W, H);
      };
    } },
  };

  const gifList = () => ($('trollGifs').value || '').split(/\s+/).filter((u) => /^https:\/\/\S+$/i.test(u));

  function stop() {
    active = false;
    cancelAnimationFrame(raf);
    clearTimeout(endTimer);
    layer.classList.remove('on');
    document.body.classList.remove('troll', 'quake');
    setTimeout(() => { if (!active) { layer.classList.remove('gif'); $('trollGif').removeAttribute('src'); } }, 700);
  }

  function launch(by) {
    if (active || REDUCED || chatMode) return;
    active = true;
    schedule();
    const gifs = gifList();
    const keys = Object.keys(SCENES);
    const useGif = gifs.length && Math.random() < 0.5;
    let label;
    if (useGif) {
      layer.classList.add('gif');
      $('trollGif').src = gifs[Math.floor(Math.random() * gifs.length)];
      label = 'Pause troll';
    } else {
      layer.classList.remove('gif');
      resize();
      const key = keys[Math.floor(Math.random() * keys.length)];
      const draw = SCENES[key].make();
      label = SCENES[key].name;
      const t0 = performance.now();
      const frame = (now) => { if (!active) return; draw(now - t0); raf = requestAnimationFrame(frame); };
      raf = requestAnimationFrame(frame);
    }
    $('trollTag').textContent = by ? `${label} · lancé par ${by}` : label;
    layer.classList.add('on');
    document.body.classList.add('troll');
    SFX.horn();
    endTimer = setTimeout(stop, TROLL_MS);
  }

  // Prochain troll automatique dans 3 à 7 minutes
  function schedule() { nextAt = Date.now() + (180 + Math.random() * 240) * 1000; }
  schedule();
  function maybe() {
    if (session && !active && $('trollMode').checked && Date.now() > nextAt) launch();
  }
  return { launch, maybe, stop, get active() { return active; } };
})();

const fmt = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------
//  Roue
// ---------------------------------------------------------------------
const canvas = $('wheel');
const ctx = canvas.getContext('2d');
const SIZE = 520; // taille logique ; le canvas est rendu en haute définition
const dpr = Math.min(window.devicePixelRatio || 1, 3);
canvas.width = canvas.height = SIZE * dpr;

let genres = store.get('mw_genres_v2', DEFAULT_GENRES);
let played = store.get('mw_played', []).filter((g) => genres.includes(g));
let rotation = 0;
let spinning = false;
let spinList = null;   // genres figés pendant que la roue tourne
let winner = null;     // genre sur lequel la roue s'est arrêtée

const colorFor = (g) => {
  const i = Math.max(0, genres.indexOf(g));
  return `hsl(${Math.round((360 / Math.max(1, genres.length)) * i)}, 72%, 52%)`;
};
const removeMode = () => $('removePlayed').checked;
// Genres présents sur la roue (sans ceux déjà joués si le mode est actif)
const wheelGenres = () => spinList || (removeMode() ? genres.filter((g) => !played.includes(g)) : genres);

function drawWheel() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = SIZE / 2, cy = SIZE / 2, r = SIZE / 2 - 14;
  ctx.clearRect(0, 0, SIZE, SIZE);
  const list = wheelGenres();
  const n = list.length;

  // anneau extérieur
  ctx.beginPath(); ctx.arc(cx, cy, r + 10, 0, Math.PI * 2);
  ctx.fillStyle = '#1a1a1a'; ctx.fill();
  ctx.strokeStyle = '#2f2f2f'; ctx.lineWidth = 2; ctx.stroke();

  if (!n) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#242424'; ctx.fill();
    ctx.fillStyle = '#a7a7a7'; ctx.font = '600 20px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Ajoute des genres →', cx, cy);
    return;
  }

  const seg = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) {
    const a0 = rotation + i * seg;
    const color = colorFor(list[i]);
    const grad = ctx.createRadialGradient(cx, cy, 30, cx, cy, r);
    grad.addColorStop(0, color.replace('52%)', '38%)'));
    grad.addColorStop(1, color);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a0 + seg);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 2; ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a0 + seg / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    const size = Math.max(12, Math.min(24, 220 / n + 7));
    ctx.font = `800 ${size}px system-ui, sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 4;
    let label = parseGenre(list[i]).label;
    while (ctx.measureText(label).width > r - 70 && label.length > 3) label = label.slice(0, -2) + '…';
    ctx.fillText(label, r - 20, 0);
    ctx.restore();
  }

  // segment gagnant mis en valeur
  const w = list.indexOf(winner);
  if (!spinning && w >= 0) {
    const a0 = rotation + w * seg;
    ctx.save();
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a0, a0 + seg); ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fill();
    ctx.shadowColor = '#fff'; ctx.shadowBlur = 16;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
  }

  // petites lumières sur l'anneau (elles clignotent, plus vite quand la roue tourne)
  const bulbs = 32;
  const phase = Math.floor(performance.now() / (spinning ? 90 : 450));
  for (let i = 0; i < bulbs; i++) {
    const a = (i / bulbs) * Math.PI * 2;
    const on = (i + phase) % 2 === 0;
    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * (r + 5), cy + Math.sin(a) * (r + 5), on ? 3 : 2.2, 0, Math.PI * 2);
    ctx.fillStyle = on ? '#ffffff' : 'rgba(255,255,255,.25)';
    ctx.shadowColor = on ? 'rgba(255,255,255,.9)' : 'transparent'; ctx.shadowBlur = on ? 8 : 0;
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  // moyeu
  ctx.beginPath(); ctx.arc(cx, cy, 40, 0, Math.PI * 2);
  ctx.fillStyle = '#121212'; ctx.fill();
  ctx.strokeStyle = '#f2f2f2'; ctx.lineWidth = 4; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2);
  ctx.fillStyle = genreColor; ctx.fill();
}

// Boucle d'animation : lumières + rotation lente de la roue quand rien ne se passe
const wheelWrap = document.querySelector('.wheel-wrap');
function wheelLoop(now = performance.now()) {
  if (!spinning) {
    if (!session && !winner) rotation = (rotation + 0.0016) % (Math.PI * 2);
    drawWheel();
  }
  const beat = beatLevel(now);
  wheelWrap.style.setProperty('--beat', beat.toFixed(3));
  if (!REDUCED) { VIZ.draw(now, beat); BG.draw(now, beat); }
  requestAnimationFrame(wheelLoop);
}

function winnerIndex(n) {
  const seg = (Math.PI * 2) / n;
  const TAU = Math.PI * 2;
  // le pointeur est en haut (angle -90°)
  const a = (((-Math.PI / 2 - rotation) % TAU) + TAU) % TAU;
  return Math.floor(a / seg) % n;
}

function spin() {
  if (spinning) return;
  // Nouvelle version en ligne : on recharge la page (F5) puis la roue tourne toute seule
  if (updatePending) { stopSession(true); applyUpdate(true); return; }
  if (genres.length < 2) { say('Ajoute au moins 2 genres pour tourner la roue.', true); return; }
  if (!wheelGenres().length) resetPlayed(true);
  // Le lecteur navigateur doit être "activé" par un clic (règle d'autoplay des navigateurs)
  player?.activateElement?.();
  spinList = wheelGenres().slice();
  spinning = true;
  winner = null;
  $('spinBtn').disabled = true;
  document.body.classList.add('spinning');
  say('');

  TROLL.stop();
  SFX.whoosh();
  const pointer = $('pointer');
  let lastIdx = -1, lastAngle = rotation;
  const start = rotation;
  const delta = Math.PI * 2 * (5 + Math.random() * 3) + Math.random() * Math.PI * 2;
  const duration = 5000 + Math.random() * 1500;
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 4);

  const frame = (now) => {
    const t = Math.min(1, (now - t0) / duration);
    rotation = start + delta * ease(t);
    drawWheel();
    // passage d'une case sous le pointeur : tic + petit coup de pointeur + étincelles
    const idx = winnerIndex(spinList.length);
    if (idx !== lastIdx) {
      if (lastIdx !== -1) {
        SFX.tick();
        pointer.classList.remove('flick'); void pointer.offsetWidth; pointer.classList.add('flick');
        const speed = rotation - lastAngle;
        if (speed > 0.02) {
          const r = pointer.getBoundingClientRect();
          FX.burst(r.left + r.width / 2, r.bottom, { n: 8, power: 5, ring: false, colors: ['#ffffff', '#ffd23f', genreColor], grav: 0.25 });
        }
      }
      lastIdx = idx;
    }
    lastAngle = rotation;
    if (t < 1) return requestAnimationFrame(frame);
    rotation %= Math.PI * 2;
    winner = spinList[winnerIndex(spinList.length)];
    spinList = null;
    spinning = false;
    $('spinBtn').disabled = false;
    document.body.classList.remove('spinning');
    setGenreColor(winner);
    drawWheel();
    revealGenre(parseGenre(winner).label);
    startSession(winner);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------
//  Genres joués (mode « retirer de la roue une fois joué »)
// ---------------------------------------------------------------------
function markPlayed(entry) {
  if (!entry || !removeMode() || played.includes(entry)) return;
  played.push(entry);
  if (winner === entry) winner = null;
  store.set('mw_played', played);
  // Tout a été joué : la roue se remplit à nouveau pour un nouveau tour
  if (!genres.some((g) => !played.includes(g))) resetPlayed(true);
  else renderGenres();
}

function resetPlayed(auto = false) {
  played = [];
  store.set('mw_played', played);
  renderGenres();
  if (auto) say('Tous les genres ont été joués : la roue est de nouveau complète !');
}

// ---------------------------------------------------------------------
//  Liste des genres
// ---------------------------------------------------------------------
function renderGenres() {
  const ul = $('genreList');
  ul.innerHTML = '';
  const mode = removeMode();
  genres.forEach((g, i) => {
    const { label, query } = parseGenre(g);
    const isPlayed = mode && played.includes(g);
    const li = document.createElement('li');
    li.classList.toggle('played', isPlayed);
    li.innerHTML = `<span class="dot"></span><span class="name"></span>${isPlayed ? '<span class="tag">joué</span>' : ''}<button title="Supprimer"><svg class="i"><use href="#i-x"/></svg></button>`;
    li.querySelector('.dot').style.background = colorFor(g);
    li.querySelector('.name').textContent = label + (normalize(label) !== query ? `  (${query})` : '');
    li.querySelector('button').onclick = () => {
      genres.splice(i, 1);
      played = played.filter((p) => genres.includes(p));
      store.set('mw_played', played);
      saveGenres();
    };
    ul.appendChild(li);
  });
  const left = mode ? genres.filter((g) => !played.includes(g)).length : genres.length;
  $('genreCount').textContent = mode && played.length ? `${left} / ${genres.length} restants` : `${genres.length} genres`;
  $('resetPlayed').hidden = !(mode && played.length);
  drawWheel();
}

function saveGenres() { store.set('mw_genres_v2', genres); renderGenres(); }

// ---------------------------------------------------------------------
//  Init
// ---------------------------------------------------------------------
function setDuration(min) {
  $('duration').value = min;
  store.set('mw_duration', min);
  document.querySelectorAll('#presets button').forEach((b) => b.classList.toggle('active', Number(b.dataset.min) === min));
  if (!session) $('timer').textContent = fmt(min * 60_000);
}

function bindUI() {
  store.set('mw_client_id', DEFAULT_CLIENT_ID);
  setDuration(store.get('mw_duration', 15));
  $('duration').onchange = (e) => setDuration(Math.min(180, Math.max(1, Number(e.target.value) || 15)));
  document.querySelectorAll('#presets button').forEach((b) => { b.onclick = () => setDuration(Number(b.dataset.min)); });
  $('autoSpin').checked = store.get('mw_autospin_v2', true);
  $('autoSpin').onchange = (e) => store.set('mw_autospin_v2', e.target.checked);
  $('removePlayed').checked = store.get('mw_remove_played', true);
  $('removePlayed').onchange = (e) => { store.set('mw_remove_played', e.target.checked); renderGenres(); };
  $('deviceSelect').onchange = (e) => store.set('mw_device', e.target.value);
  $('sfx').checked = store.get('mw_sfx', true);
  $('sfx').onchange = (e) => store.set('mw_sfx', e.target.checked);
  $('trollMode').checked = store.get('mw_troll', true);
  $('trollMode').onchange = (e) => store.set('mw_troll', e.target.checked);
  $('trollGifs').value = store.get('mw_troll_gifs', '');
  $('trollGifs').onchange = (e) => store.set('mw_troll_gifs', e.target.value.trim());
  $('trollBtn').onclick = () => TROLL.launch();

  $('loginBtn').onclick = login;
  $('logoutBtn').onclick = logout;
  $('refreshDevices').onclick = refreshDevices;
  $('spinBtn').onclick = spin;
  $('stopBtn').onclick = () => { stopSession(true); say('Session arrêtée.'); if (updatePending) applyUpdate(false); };
  $('pauseBtn').onclick = () => control('toggle');
  $('nextBtn').onclick = () => control('next');
  $('prevBtn').onclick = () => control('previous');
  $('resetPlayed').onclick = () => resetPlayed();
  $('resetGenres').onclick = () => { genres = [...DEFAULT_GENRES]; played = []; store.set('mw_played', played); saveGenres(); };
  $('addForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('genreInput').value.trim();
    if (!v) return;
    if (genres.some((g) => normalize(g) === normalize(v))) { say(`« ${v} » est déjà sur la roue.`, true); return; }
    genres.push(v);
    $('genreInput').value = '';
    say('');
    saveGenres();
  };
  // Espace = tourner la roue (hors champs de saisie)
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName)) { e.preventDefault(); spin(); }
  });
}

async function updateAuthUI() {
  const logged = isLoggedIn();
  $('loginBtn').hidden = logged;
  $('logoutBtn').hidden = !logged;
  $('auth').classList.toggle('on', logged);
  if (!logged) { $('authStatus').textContent = 'Non connecté à Spotify'; return; }
  try {
    const me = await api('/me');
    $('authStatus').textContent = `${me.display_name || me.id}${me.product ? ` · ${me.product}` : ''}`;
  } catch (e) {
    $('authStatus').textContent = 'Connecté (profil indisponible)';
  }
}

// ---------------------------------------------------------------------
//  Mise à jour à distance : la page se recharge toute seule quand une
//  nouvelle version est en ligne (vérifiée toutes les 30 s)
// ---------------------------------------------------------------------
let toastTimer = null;
function toast(msg, ms = 4000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// Fichiers surveillés : la page elle-même + nos scripts/styles locaux
const watchedUrls = () => [location.pathname, ...[...document.querySelectorAll('script[src], link[rel="stylesheet"]')]
  .map((e) => e.getAttribute('src') || e.getAttribute('href'))
  .filter((u) => u && !/^(https?:)?\/\//.test(u))];

function hashText(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return h;
}

// cache: 'reload' contourne le cache ET le remplace par la version fraîche,
// donc le rechargement qui suit utilise bien les nouveaux fichiers
async function snapshot() {
  const texts = await Promise.all(watchedUrls().map((u) =>
    fetch(u, { cache: 'reload' }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.status))))));
  return hashText(texts.join('\u0000'));
}

let baseline = null;
let updatePending = false;

async function checkForUpdate() {
  if (updatePending) return;
  try {
    const h = await snapshot();
    if (baseline === null) { baseline = h; return; }
    if (h === baseline) return;
    updatePending = true;
    if (!session && !spinning) applyUpdate(false);
    else toast('Nouvelle version en ligne : la page se mettra à jour au prochain tirage.', 8000);
  } catch { /* hors ligne / serveur coupé : on réessaiera */ }
}

function applyUpdate(spinAfter) {
  if (spinAfter) store.set('mw_spin_after_update', true);
  toast('Nouvelle version, mise à jour…', 0);
  setTimeout(() => location.reload(), 1200);
}

function startUpdateWatcher() {
  checkForUpdate();
  setInterval(checkForUpdate, 30_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
}

// ---------------------------------------------------------------------
//  Chat en direct : relais public ntfy.sh (sans compte ni serveur).
//  Les téléphones ouvrent la page avec ?chat et leurs messages
//  s'affichent sur l'écran principal, façon télé.
// ---------------------------------------------------------------------
const CHAT_URL = 'https://ntfy.sh/musicwheel-live-q8f3k2x9';
const PUBLIC_URL = 'https://cybertrist.github.io/MusicWheel/';
let lastChatTroll = 0;
const CHAT_LIFE = 7500;   // durée d'affichage d'une bulle (ms)
const chatSeen = new Set();
const chatFeed = [];
let chatLastSend = 0;
let chatConnectedAt = Date.now();
const chatId = store.get('mw_chat_id') || randomString(10);
store.set('mw_chat_id', chatId);

const hueOf = (str) => { let h = 7; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function makeBubble(msg) {
  const el = document.createElement('div');
  el.className = 'bubble' + (msg.id === chatId ? ' mine' : '');
  const hue = hueOf(msg.n);
  const av = document.createElement('div');
  av.className = 'av';
  av.textContent = msg.n.charAt(0).toUpperCase();
  av.style.background = `hsl(${hue}, 80%, 65%)`;
  const body = document.createElement('div');
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = msg.n;
  who.style.color = `hsl(${hue}, 85%, 72%)`;
  const txt = document.createElement('div');
  txt.className = 'txt';
  txt.textContent = msg.m;
  body.append(who, txt);
  el.append(av, body);
  return el;
}

function renderTicker() {
  const move = $('tickerMove');
  move.classList.remove('run');
  move.innerHTML = '';
  if (!chatFeed.length) return;
  const items = [...chatFeed].reverse();
  // contenu doublé pour une boucle sans à-coup
  for (let k = 0; k < 2; k++) {
    for (const msg of items) {
      const it = document.createElement('span');
      it.className = 'ticker-item';
      const b = document.createElement('b');
      b.textContent = msg.n;
      b.style.color = `hsl(${hueOf(msg.n)}, 85%, 70%)`;
      it.append(b, document.createTextNode(msg.m));
      move.appendChild(it);
    }
  }
  const width = move.scrollWidth / 2;
  move.style.setProperty('--dur', `${Math.max(14, width / 90)}s`);
  void move.offsetWidth;
  move.classList.add('run');
  const bar = document.querySelector('.ticker');
  bar.classList.remove('flash-new'); void bar.offsetWidth; bar.classList.add('flash-new');
}

function onChatMessage(msg, live) {
  if (chatMode) {
    const log = $('chatLog');
    log.querySelector('.lyrics-empty')?.remove();
    log.appendChild(makeBubble(msg));
    while (log.children.length > 120) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
    return;
  }
  if (live && /^!troll\b/i.test(msg.m) && Date.now() - lastChatTroll > 45_000) {
    lastChatTroll = Date.now();
    TROLL.launch(msg.n);
  }
  chatFeed.push(msg);
  if (chatFeed.length > 15) chatFeed.shift();
  renderTicker();
  if (!live || !$('showChat').checked) return;
  const box = $('bubbles');
  const b = makeBubble(msg);
  b.style.setProperty('--life', `${CHAT_LIFE}ms`);
  box.prepend(b);
  while (box.children.length > 3) box.lastChild.remove();
  setTimeout(() => b.remove(), CHAT_LIFE + 600);
}

function connectChat() {
  chatConnectedAt = Date.now();
  const es = new EventSource(`${CHAT_URL}/sse?since=30m`);
  es.onmessage = (e) => {
    let ev, msg;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.event !== 'message' || chatSeen.has(ev.id)) return;
    chatSeen.add(ev.id);
    try { msg = JSON.parse(ev.message); } catch { return; }
    const n = cleanText(msg.n, 20) || 'Anonyme';
    const m = cleanText(msg.m, 140);
    if (!m) return;
    onChatMessage({ n, m, id: msg.id }, ev.time * 1000 >= chatConnectedAt - 5000);
  };
  // EventSource se reconnecte tout seul ; les doublons sont filtrés par chatSeen
}

async function sendChat(form) {
  const nick = cleanText(form.elements.nick.value, 20);
  const m = cleanText(form.elements.msg.value, 140);
  if (!nick) { form.elements.nick.focus(); toast('Choisis un pseudo.'); return; }
  if (!m) { form.elements.msg.focus(); return; }
  const wait = 3000 - (Date.now() - chatLastSend);
  if (wait > 0) { toast(`Attends ${Math.ceil(wait / 1000)} s entre deux messages.`); return; }
  store.set('mw_chat_nick', nick);
  chatLastSend = Date.now();
  form.elements.msg.value = '';
  try {
    const res = await fetch(CHAT_URL, { method: 'POST', body: JSON.stringify({ n: nick, m, id: chatId }) });
    if (!res.ok) throw new Error(res.status);
  } catch {
    form.elements.msg.value = m;
    toast("Message non envoyé, réessaie dans un instant.");
  }
}

function initChat() {
  for (const form of [$('chatFormHost'), $('chatFormPhone')]) {
    form.elements.nick.value = store.get('mw_chat_nick', '');
    form.onsubmit = (e) => { e.preventDefault(); sendChat(form); };
  }
  if (!chatMode) {
    // En local (127.0.0.1) les téléphones ne peuvent pas joindre le PC : on pointe vers la version en ligne
    const isLocal = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
    const url = (isLocal ? PUBLIC_URL : location.origin + location.pathname) + '?chat';
    $('qrLink').href = url;
    if (window.QRCode) {
      new QRCode($('qrLink'), { text: url, width: 200, height: 200, colorDark: '#0c0c10', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
    }
    $('showChat').checked = store.get('mw_show_chat', true);
    document.body.classList.toggle('hide-chat', !$('showChat').checked);
    $('showChat').onchange = (e) => {
      store.set('mw_show_chat', e.target.checked);
      document.body.classList.toggle('hide-chat', !e.target.checked);
    };
  }
  connectChat();
}

const chatMode = document.documentElement.classList.contains('chat-mode');

(async () => {
  initChat();
  if (chatMode) { startUpdateWatcher(); return; }  // vue téléphone : juste le chat
  bindUI();
  renderGenres();
  try { await handleRedirect(); } catch (e) { say('Connexion échouée : ' + e.message, true); }
  await updateAuthUI();
  wheelLoop();
  if (isLoggedIn()) { initPlayer(); await refreshDevices(); }
  startUpdateWatcher();
  // Rechargé par une mise à jour en fin de session : la roue repart toute seule
  if (store.get('mw_spin_after_update')) {
    store.del('mw_spin_after_update');
    toast('Page mise à jour !');
    setTimeout(spin, 2000);
  }
})();
