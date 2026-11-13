// =====================================================================
//  Music Wheel — roue des genres + lecture Spotify pendant X minutes
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
//  Lecteur dans le navigateur (Web Playback SDK — nécessite Premium)
// ---------------------------------------------------------------------
let player = null;
let sdkDeviceId = null;
let sdkReady = false;

window.onSpotifyWebPlaybackSDKReady = () => { sdkReady = true; initPlayer(); };

function initPlayer() {
  if (!sdkReady || !isLoggedIn() || player) return;
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
  if (!options.length) select.innerHTML = '<option value="">Aucun appareil — ouvre Spotify quelque part</option>';
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

  $('result').hidden = false;
  $('resultGenre').textContent = label;
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
      a.textContent = `📀 Playlist : ${playlist.name}${playlist.owner?.display_name ? ' — par ' + playlist.owner.display_name : ''}`;
      $('playlistInfo').appendChild(a);
    } else {
      // Repli : pas de playlist trouvée -> on compose une file de morceaux du genre
      const tracks = await tracksForGenre(entry, targetMs);
      if (!tracks.length) throw new Error(`Rien trouvé pour « ${label} ». Essaie un autre terme (ex : "${label} = autre mot-clé").`);
      await api(`/me/player/play?${dev}`, { method: 'PUT', body: { uris: tracks.map((t) => t.uri) } });
      $('playlistInfo').textContent = '🎵 Sélection de morceaux du genre';
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
  tick();
  setTimeout(updateNowPlaying, 1500);
}

function tick() {
  if (!session) return;
  const left = session.endAt - Date.now();
  $('timer').textContent = fmt(Math.max(0, left));
  $('progressBar').style.width = `${Math.max(0, Math.min(1, left / session.total)) * 100}%`;
  $('result').classList.toggle('final', left > 0 && left <= 10_000);
  if (left <= 0) {
    stopSession(true);
    $('result').classList.remove('final');
    const auto = $('autoSpin').checked;
    celebrate(auto);
    say(auto ? '⏰ Session terminée ! La roue repart…' : '⏰ Session terminée ! Relance la roue pour un nouveau genre.');
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
  $('result').classList.remove('live');
  markPlayed(played);
}

async function updateNowPlaying() {
  if (!session) return;
  try {
    const state = await api('/me/player');
    const item = state?.item;
    $('nowPlaying').textContent = item
      ? `${state.is_playing ? '▶' : '⏸'} ${item.name} — ${item.artists.map((a) => a.name).join(', ')}`
      : '';
    playback = { progress: state?.progress_ms || 0, at: Date.now(), playing: !!state?.is_playing };
    if (item && item.id !== lyrics.trackId) loadLyrics(item);
  } catch { /* silencieux */ }
}

// ---------------------------------------------------------------------
//  Paroles (LRCLIB — gratuit, sans clé, paroles synchronisées)
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
  $('lyricsTrack').textContent = `${item.name} — ${item.artists.map((a) => a.name).join(', ')}`;
  box.innerHTML = '<p class="lyrics-empty">Recherche des paroles…</p>';
  box.scrollTop = 0;
  let data = null;
  try { data = await fetchLyrics(item); } catch { /* affiché ci-dessous */ }
  if (lyrics.trackId !== item.id) return; // le morceau a changé entre-temps

  box.innerHTML = '';
  const empty = (msg) => { box.innerHTML = `<p class="lyrics-empty">${msg}</p>`; };
  if (!data) return empty('Paroles introuvables pour ce morceau.');
  if (data.instrumental) return empty('🎼 Morceau instrumental.');
  if (data.syncedLyrics) {
    lyrics.lines = parseLrc(data.syncedLyrics);
    for (const l of lyrics.lines) {
      const p = document.createElement('p');
      p.className = 'line';
      p.textContent = l.text || '♪';
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
//  Explosion de fin de chrono (feu d'artifice + confettis plein écran)
// ---------------------------------------------------------------------
function celebrate(autoNext) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const boom = $('boom');
  boom.querySelector('small').textContent = autoNext ? 'Nouveau genre dans un instant…' : 'Relance la roue pour continuer !';
  boom.classList.remove('show'); void boom.offsetWidth; boom.classList.add('show');
  document.body.classList.add('flash', 'shake');
  setTimeout(() => document.body.classList.remove('flash', 'shake'), 600);
  setTimeout(() => boom.classList.remove('show'), 3300);
  if (reduce) return;

  const cv = $('fx');
  const c = cv.getContext('2d');
  const r = Math.min(window.devicePixelRatio || 1, 2);
  const W = innerWidth, H = innerHeight;
  cv.width = W * r; cv.height = H * r;
  c.setTransform(r, 0, 0, r, 0, 0);

  const COLORS = ['#1ed760', '#7c5cff', '#ff4fa3', '#ffd23f', '#3fd5ff', '#ffffff', '#ff7a3d'];
  const pick = () => COLORS[Math.floor(Math.random() * COLORS.length)];
  const parts = [];
  const rings = [];

  const burst = (x, y, n, power, kind = 'spark') => {
    rings.push({ x, y, rad: 0, life: 1, color: pick() });
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = power * (0.35 + Math.random() * 0.65);
      parts.push({
        x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (kind === 'confetti' ? 4 : 0),
        life: 1, decay: 0.006 + Math.random() * 0.012, color: pick(), kind,
        size: kind === 'confetti' ? 6 + Math.random() * 6 : 2 + Math.random() * 2.5,
        rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
      });
    }
  };

  // grosse explosion au centre, puis des feux d'artifice autour
  burst(W / 2, H / 2, 220, 16, 'spark');
  burst(W / 2, H / 2, 140, 13, 'confetti');
  const timers = [250, 550, 850, 1150, 1500, 1850].map((d) => setTimeout(() => {
    burst(W * (0.15 + Math.random() * 0.7), H * (0.15 + Math.random() * 0.5), 90, 9, Math.random() < 0.5 ? 'spark' : 'confetti');
  }, d));

  const t0 = performance.now();
  const frame = (now) => {
    c.clearRect(0, 0, W, H);
    c.globalCompositeOperation = 'lighter';
    for (const g of rings) {
      g.rad += 14; g.life -= 0.03;
      if (g.life <= 0) continue;
      c.beginPath(); c.arc(g.x, g.y, g.rad, 0, Math.PI * 2);
      c.strokeStyle = g.color; c.globalAlpha = g.life * 0.6; c.lineWidth = 4 * g.life + 1; c.stroke();
    }
    for (const p of parts) {
      if (p.life <= 0) continue;
      p.life -= p.decay;
      p.x += p.vx; p.y += p.vy;
      if (p.kind === 'confetti') { p.vx *= 0.97; p.vy = p.vy * 0.97 + 0.25; p.rot += p.vr; }
      else { p.vx *= 0.955; p.vy = p.vy * 0.955 + 0.12; }
      c.globalAlpha = Math.max(0, p.life);
      c.fillStyle = p.color;
      if (p.kind === 'confetti') {
        c.globalCompositeOperation = 'source-over';
        c.save(); c.translate(p.x, p.y); c.rotate(p.rot);
        c.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2 * Math.abs(Math.cos(p.rot * 2)) + 1);
        c.restore();
        c.globalCompositeOperation = 'lighter';
      } else {
        c.beginPath(); c.arc(p.x, p.y, p.size, 0, Math.PI * 2); c.fill();
        c.globalAlpha *= 0.35; c.beginPath(); c.arc(p.x - p.vx * 2, p.y - p.vy * 2, p.size * 0.8, 0, Math.PI * 2); c.fill();
      }
    }
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    if (now - t0 < 4200) requestAnimationFrame(frame);
    else { timers.forEach(clearTimeout); c.clearRect(0, 0, W, H); }
  };
  requestAnimationFrame(frame);
}

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

  // petites lumières sur l'anneau
  const bulbs = 28;
  for (let i = 0; i < bulbs; i++) {
    const a = (i / bulbs) * Math.PI * 2 + (spinning ? rotation * 0.2 : 0);
    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * (r + 5), cy + Math.sin(a) * (r + 5), 2.4, 0, Math.PI * 2);
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.85)' : 'rgba(29,185,84,.9)'; ctx.fill();
  }

  // moyeu
  ctx.beginPath(); ctx.arc(cx, cy, 40, 0, Math.PI * 2);
  ctx.fillStyle = '#121212'; ctx.fill();
  ctx.strokeStyle = '#f2f2f2'; ctx.lineWidth = 4; ctx.stroke();
  ctx.fillStyle = '#1db954'; ctx.font = '26px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('♫', cx, cy + 1);
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

  const start = rotation;
  const delta = Math.PI * 2 * (5 + Math.random() * 3) + Math.random() * Math.PI * 2;
  const duration = 5000 + Math.random() * 1500;
  const t0 = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 4);

  const frame = (now) => {
    const t = Math.min(1, (now - t0) / duration);
    rotation = start + delta * ease(t);
    drawWheel();
    if (t < 1) return requestAnimationFrame(frame);
    rotation %= Math.PI * 2;
    winner = spinList[winnerIndex(spinList.length)];
    spinList = null;
    spinning = false;
    $('spinBtn').disabled = false;
    document.body.classList.remove('spinning');
    drawWheel();
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
  if (auto) say('🔁 Tous les genres ont été joués : la roue est de nouveau complète !');
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
    li.innerHTML = `<span class="dot"></span><span class="name"></span>${isPlayed ? '<span class="tag">joué</span>' : ''}<button title="Supprimer">✕</button>`;
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
    else toast('🔄 Nouvelle version en ligne : la page se mettra à jour au prochain tirage.', 8000);
  } catch { /* hors ligne / serveur coupé : on réessaiera */ }
}

function applyUpdate(spinAfter) {
  if (spinAfter) store.set('mw_spin_after_update', true);
  toast('✨ Nouvelle version — mise à jour…', 0);
  setTimeout(() => location.reload(), 1200);
}

function startUpdateWatcher() {
  checkForUpdate();
  setInterval(checkForUpdate, 30_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
}

(async () => {
  bindUI();
  renderGenres();
  try { await handleRedirect(); } catch (e) { say('Connexion échouée : ' + e.message, true); }
  await updateAuthUI();
  if (isLoggedIn()) { initPlayer(); await refreshDevices(); }
  startUpdateWatcher();
  // Rechargé par une mise à jour en fin de session : la roue repart toute seule
  if (store.get('mw_spin_after_update')) {
    store.del('mw_spin_after_update');
    toast('✅ Page mise à jour !');
    setTimeout(spin, 2000);
  }
})();
