// =====================================================================
//  Music Wheel — roue des genres + lecture Spotify pendant X minutes
// =====================================================================

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
  const clientId = $('clientId').value.trim();
  if (!clientId) { say('Colle d\'abord ton Spotify Client ID dans les réglages.', true); return; }
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
  player.addListener('player_state_changed', () => updateNowPlaying());
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
    interval: setInterval(tick, 500),
    poll: setInterval(updateNowPlaying, 8000),
  };
  tick();
  setTimeout(updateNowPlaying, 1500);
}

function tick() {
  if (!session) return;
  const left = session.endAt - Date.now();
  $('timer').textContent = fmt(Math.max(0, left));
  if (left <= 0) {
    stopSession(true);
    say('⏰ Session terminée ! Relance la roue pour un nouveau genre.');
    if ($('autoSpin').checked) setTimeout(spin, 1500);
  }
}

function stopSession(pause = true) {
  if (!session) return;
  clearInterval(session.interval);
  clearInterval(session.poll);
  if (pause) api(`/me/player/pause?device_id=${encodeURIComponent(session.deviceId)}`, { method: 'PUT' }).catch(() => {});
  session = null;
  $('timer').textContent = '00:00';
}

async function updateNowPlaying() {
  if (!session) return;
  try {
    const state = await api('/me/player');
    const item = state?.item;
    $('nowPlaying').textContent = item
      ? `${state.is_playing ? '▶' : '⏸'} ${item.name} — ${item.artists.map((a) => a.name).join(', ')}`
      : '';
  } catch { /* silencieux */ }
}

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

const fmt = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------
//  Roue
// ---------------------------------------------------------------------
const canvas = $('wheel');
const ctx = canvas.getContext('2d');
let genres = store.get('mw_genres_v2', DEFAULT_GENRES);
let rotation = 0;
let spinning = false;

const colorFor = (i, n) => `hsl(${Math.round((360 / n) * i)}, 70%, 52%)`;

function drawWheel() {
  const { width: W, height: H } = canvas;
  const cx = W / 2, cy = H / 2, r = Math.min(cx, cy) - 8;
  ctx.clearRect(0, 0, W, H);
  const n = genres.length;

  if (!n) {
    ctx.fillStyle = '#2a2a2a';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#a7a7a7'; ctx.font = '20px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('Ajoute des genres →', cx, cy);
    return;
  }

  const seg = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) {
    const a0 = rotation + i * seg;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a0 + seg);
    ctx.closePath();
    ctx.fillStyle = colorFor(i, n);
    ctx.fill();
    ctx.strokeStyle = '#121212'; ctx.lineWidth = 2; ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(a0 + seg / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    const size = Math.max(12, Math.min(22, 220 / n + 6));
    ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 3;
    let label = parseGenre(genres[i]).label;
    while (ctx.measureText(label).width > r - 60 && label.length > 3) label = label.slice(0, -2) + '…';
    ctx.fillText(label, r - 18, 0);
    ctx.restore();
  }
  // moyeu
  ctx.beginPath(); ctx.arc(cx, cy, 34, 0, Math.PI * 2);
  ctx.fillStyle = '#121212'; ctx.fill();
  ctx.strokeStyle = '#f2f2f2'; ctx.lineWidth = 3; ctx.stroke();
}

function winnerIndex() {
  const n = genres.length;
  const seg = (Math.PI * 2) / n;
  const TAU = Math.PI * 2;
  // le pointeur est en haut (angle -90°)
  const a = (((-Math.PI / 2 - rotation) % TAU) + TAU) % TAU;
  return Math.floor(a / seg) % n;
}

function spin() {
  if (spinning) return;
  if (genres.length < 2) { say('Ajoute au moins 2 genres pour tourner la roue.', true); return; }
  // Le lecteur navigateur doit être "activé" par un clic (règle d'autoplay des navigateurs)
  player?.activateElement?.();
  spinning = true;
  $('spinBtn').disabled = true;
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
    spinning = false;
    $('spinBtn').disabled = false;
    startSession(genres[winnerIndex()]);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------
//  Liste des genres
// ---------------------------------------------------------------------
function renderGenres() {
  const ul = $('genreList');
  ul.innerHTML = '';
  genres.forEach((g, i) => {
    const { label, query } = parseGenre(g);
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot"></span><span class="name"></span><button title="Supprimer">✕</button>`;
    li.querySelector('.dot').style.background = colorFor(i, genres.length);
    li.querySelector('.name').textContent = label + (normalize(label) !== query ? `  (${query})` : '');
    li.querySelector('button').onclick = () => { genres.splice(i, 1); saveGenres(); };
    ul.appendChild(li);
  });
  drawWheel();
}

function saveGenres() { store.set('mw_genres_v2', genres); renderGenres(); }

// ---------------------------------------------------------------------
//  Init
// ---------------------------------------------------------------------
function bindUI() {
  $('redirectHint').textContent = REDIRECT_URI;
  $('clientId').value = store.get('mw_client_id', '');
  $('clientId').onchange = (e) => store.set('mw_client_id', e.target.value.trim());
  $('duration').value = store.get('mw_duration', 15);
  $('duration').onchange = (e) => store.set('mw_duration', Number(e.target.value) || 15);
  $('autoSpin').checked = store.get('mw_autospin', false);
  $('autoSpin').onchange = (e) => store.set('mw_autospin', e.target.checked);
  $('deviceSelect').onchange = (e) => store.set('mw_device', e.target.value);

  $('loginBtn').onclick = login;
  $('logoutBtn').onclick = logout;
  $('refreshDevices').onclick = refreshDevices;
  $('spinBtn').onclick = spin;
  $('stopBtn').onclick = () => { stopSession(true); say('Session arrêtée.'); };
  $('pauseBtn').onclick = () => control('toggle');
  $('nextBtn').onclick = () => control('next');
  $('prevBtn').onclick = () => control('previous');
  $('resetGenres').onclick = () => { genres = [...DEFAULT_GENRES]; saveGenres(); };
  $('addForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('genreInput').value.trim();
    if (!v) return;
    genres.push(v);
    $('genreInput').value = '';
    saveGenres();
  };
}

async function updateAuthUI() {
  const logged = isLoggedIn();
  $('loginBtn').hidden = logged;
  $('logoutBtn').hidden = !logged;
  if (!logged) { $('authStatus').textContent = 'Non connecté à Spotify'; return; }
  try {
    const me = await api('/me');
    $('authStatus').textContent = `Connecté : ${me.display_name || me.id}${me.product ? ` (${me.product})` : ''}`;
  } catch (e) {
    $('authStatus').textContent = 'Connecté (profil indisponible)';
  }
}

(async () => {
  bindUI();
  renderGenres();
  try { await handleRedirect(); } catch (e) { say('Connexion échouée : ' + e.message, true); }
  await updateAuthUI();
  if (isLoggedIn()) { initPlayer(); refreshDevices(); }
})();
