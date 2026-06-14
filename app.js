/* ═══════════════════════════════════════════════════════
   WC 2026 PREDICTION GAME — app.js
   Vanilla JS · Firebase Firestore · No build step
   ═══════════════════════════════════════════════════════ */

'use strict';

const { initializeApp }                                   = window.firebaseApp;
const { getFirestore, collection, doc, getDoc, getDocs,
        setDoc, updateDoc, query, where, orderBy,
        serverTimestamp, writeBatch }                     = window.firebaseFirestore;

// ── Subdivision flag fix (Scotland / England / Wales use invisible tag chars
//    that get stripped when saved as UTF-8 text; define them here in JS instead)
const SUBDIVISION_FLAGS = {
  'Scotland': '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
  'England':  '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
  'Wales':    '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}',
};
function getFlag(teamName, fallback) {
  return SUBDIVISION_FLAGS[teamName] || fallback;
}

// ── All 48 WC 2026 Teams (derived from matches.js) ─────
const ALL_TEAMS = [...new Set(
  MATCHES.filter(m => m.stage === 'Group').flatMap(m => [m.teamA, m.teamB])
)].sort();

// ── App State ──────────────────────────────────────────
const STATE = {
  db: null,
  session: null,
  matches: [],
  predictions: {},
  users: [],
  countdownTimers: [],
  currentPredictMatch: null,
};

// ── Session ────────────────────────────────────────────
const SESSION_KEY = 'wc2026_session';
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

function saveSession(userId, nickname, isAdmin) {
  const session = { userId, nickname, isAdmin, expires: Date.now() + SESSION_TTL };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  STATE.session = { userId, nickname, isAdmin };
}
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (!s || s.expires < Date.now()) { localStorage.removeItem(SESSION_KEY); return null; }
    return s;
  } catch { return null; }
}
function clearSession() { localStorage.removeItem(SESSION_KEY); STATE.session = null; }

// ── PIN Hashing ────────────────────────────────────────
async function hashPin(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Toast ──────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️', lock: '🔒' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${icons[type] || icons.info}</span> ${msg}`;
  document.getElementById('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── View Router ────────────────────────────────────────
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
  // Bottom nav active state
  document.querySelectorAll('.bnav-btn[data-view]').forEach(b =>
    b.classList.toggle('active', b.dataset.view === id));
  const isLogin = id === 'view-login';
  document.getElementById('app-nav').style.display   = isLogin ? 'none' : 'flex';
  document.getElementById('bottom-nav').style.display = isLogin ? 'none' : 'flex';
  // Scroll to top on view change
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ── Time Helpers ───────────────────────────────────────
function formatKickoff(isoString) {
  return new Date(isoString).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });
}

function timeUntil(msOrIso) {
  const ms = typeof msOrIso === 'number' ? msOrIso : new Date(msOrIso).getTime();
  const diff = ms - Date.now();
  if (diff <= 0) return null;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Lock time = kickoff - 5 minutes
function getLockMs(match) {
  return new Date(match.kickoffUTC).getTime() - 5 * 60 * 1000;
}
function isLocked(match) {
  return getLockMs(match) <= Date.now();
}
// Last 30 minutes before lock = show fire badge
function isLastMinuteWindow(match) {
  const lockMs = getLockMs(match);
  const now = Date.now();
  return now >= lockMs - 30 * 60 * 1000 && now < lockMs;
}

// ── Photo resize → base64 (FileReader — works on iOS Safari) ──
function resizeImageToBase64(file, size = 80) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.onload = e => {
      const img = new Image();
      img.onerror = () => reject(new Error('Image decode failed'));
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = size; canvas.height = size;
          const ctx = canvas.getContext('2d');
          // Center-crop to square
          const min = Math.min(img.width, img.height);
          const sx  = (img.width  - min) / 2;
          const sy  = (img.height - min) / 2;
          ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        } catch (err) { reject(err); }
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ── Avatar ─────────────────────────────────────────────
const AVATAR_COLORS = [
  '#E74C3C','#3498DB','#2ECC71','#F39C12',
  '#9B59B6','#1ABC9C','#E67E22','#E91E63',
  '#00BCD4','#FF5722','#607D8B','#795548'
];

function getAvatarHTML(user, size = 36) {
  const name = user.nickname || '?';
  const idx = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length;
  const bg  = AVATAR_COLORS[idx];
  const initials = name.slice(0, 2).toUpperCase();
  const style = `width:${size}px;height:${size}px;font-size:${Math.floor(size * 0.38)}px;line-height:${size}px;`;
  if (user.photoURL) {
    return `<img class="avatar" src="${user.photoURL}" alt="${name}" style="${style}"
      onerror="this.outerHTML='<div class=\\'avatar\\' style=\\'background:${bg};${style}\\'>${initials}</div>'">`;
  }
  return `<div class="avatar" style="background:${bg};${style}">${initials}</div>`;
}

// ── Scoring ────────────────────────────────────────────
function calculatePoints(pA, pB, rA, rB) {
  if (pA === rA && pB === rB) return 10;
  if (Math.sign(pA - pB) === Math.sign(rA - rB)) return 5;
  return 0;
}

// ── Firestore ──────────────────────────────────────────
async function fetchMatches() {
  const snap = await getDocs(collection(STATE.db, 'matches'));
  const fs = {};
  snap.forEach(d => { fs[d.id] = d.data(); });
  STATE.matches = MATCHES.map(m => ({
    ...m,
    resultA: fs[m.matchId]?.resultA ?? null,
    resultB: fs[m.matchId]?.resultB ?? null,
    status:  fs[m.matchId]?.status  ?? m.status,
  }));
}

async function fetchMyPredictions() {
  if (!STATE.session) return;
  const snap = await getDocs(query(
    collection(STATE.db, 'predictions'),
    where('userId', '==', STATE.session.userId)
  ));
  STATE.predictions = {};
  snap.forEach(d => { const p = d.data(); STATE.predictions[p.matchId] = p; });
}

async function fetchUsers() {
  const snap = await getDocs(collection(STATE.db, 'users'));
  STATE.users = [];
  snap.forEach(d => { if (!d.data().disabled) STATE.users.push({ id: d.id, ...d.data() }); });
  STATE.users.sort((a, b) => (b.totalPoints || 0) - (a.totalPoints || 0));
}

// ═══════════════════════════════════════════════════════
// VIEW 1 — LOGIN
// ═══════════════════════════════════════════════════════
async function initLoginView() {
  const snap = await getDocs(collection(STATE.db, 'users'));
  const sel  = document.getElementById('login-user-select');
  sel.innerHTML = '<option value="">— Who are you? —</option>';
  snap.forEach(d => {
    if (d.data().disabled) return;
    const o = document.createElement('option');
    o.value = d.id; o.textContent = d.data().nickname;
    sel.appendChild(o);
  });
}

async function handleLogin() {
  const userId = document.getElementById('login-user-select').value;
  const pin    = document.getElementById('login-pin').value.trim();
  const errEl  = document.getElementById('login-error');
  const btn    = document.getElementById('login-btn');
  errEl.classList.remove('show');
  if (!userId || !pin) { errEl.textContent = 'Select your name and enter your PIN.'; errEl.classList.add('show'); return; }
  btn.disabled = true; btn.textContent = 'Checking…';
  try {
    const snap = await getDoc(doc(STATE.db, 'users', userId));
    if (!snap.exists()) throw new Error('not found');
    const user = snap.data();
    if (await hashPin(pin) !== user.pinHash) throw new Error('wrong pin');
    saveSession(userId, user.nickname, user.isAdmin || false);
    document.getElementById('login-pin').value = '';
    await initApp();
  } catch {
    errEl.textContent = 'Wrong PIN — try again.'; errEl.classList.add('show');
    document.getElementById('login-pin').value = '';
    document.getElementById('login-pin').focus();
  }
  btn.disabled = false; btn.textContent = 'Enter';
}

async function handleRegister() {
  const nickname = document.getElementById('reg-nickname').value.trim();
  const pin      = document.getElementById('reg-pin').value.trim();
  const confirm  = document.getElementById('reg-pin-confirm').value.trim();
  const photoFile = document.getElementById('reg-photo-input').files[0];
  const errEl    = document.getElementById('register-error');
  const btn      = document.getElementById('register-btn');
  errEl.classList.remove('show');
  if (!nickname) { errEl.textContent = 'Enter a nickname.'; errEl.classList.add('show'); return; }
  if (!/^\d{4}$/.test(pin)) { errEl.textContent = 'PIN must be exactly 4 digits.'; errEl.classList.add('show'); return; }
  if (pin !== confirm) { errEl.textContent = 'PINs do not match.'; errEl.classList.add('show'); return; }
  btn.disabled = true; btn.textContent = 'Creating…';
  try {
    const existing = await getDocs(collection(STATE.db, 'users'));
    const taken = []; existing.forEach(d => taken.push(d.data().nickname.toLowerCase()));
    if (taken.includes(nickname.toLowerCase())) {
      errEl.textContent = 'Nickname taken — try another.'; errEl.classList.add('show');
      btn.disabled = false; btn.textContent = 'Join the Game 🏆'; return;
    }
    let photoURL = '';
    if (photoFile) {
      btn.textContent = 'Uploading photo…';
      photoURL = await resizeImageToBase64(photoFile, 80);
    }
    const ref = doc(collection(STATE.db, 'users'));
    await setDoc(ref, {
      nickname, pinHash: await hashPin(pin), mobile: '',
      isAdmin: false, totalPoints: 0, exactScores: 0, correctResults: 0,
      championPick: '', goldenBootPick: '', lastMinuteCount: 0,
      photoURL, createdAt: serverTimestamp()
    });
    saveSession(ref.id, nickname, false);
    showToast(`Welcome, ${nickname}! 🎉`, 'success');
    await initApp();
  } catch (e) {
    errEl.textContent = 'Error — try again.'; errEl.classList.add('show'); console.error('Register error:', e);
  }
  btn.disabled = false; btn.textContent = 'Join the Game 🏆';
}

// ═══════════════════════════════════════════════════════
// CHAMPION / GOLDEN BOOT PICKS
// ═══════════════════════════════════════════════════════
function populateTeamSelects() {
  const opts = ALL_TEAMS.map(t => `<option value="${t}">${t}</option>`).join('');
  const blank = '<option value="">— Pick a team —</option>';
  document.getElementById('champion-select').innerHTML    = blank + opts;
  document.getElementById('golden-boot-select').innerHTML = blank + opts;
}

async function openChampionModal(userData = null) {
  populateTeamSelects();
  if (userData?.championPick)   document.getElementById('champion-select').value    = userData.championPick;
  if (userData?.goldenBootPick) document.getElementById('golden-boot-select').value = userData.goldenBootPick;

  // Change skip button label based on whether picks exist
  const hasPicks = userData?.championPick && userData?.goldenBootPick;
  document.getElementById('skip-champion-btn').textContent = hasPicks ? 'Close' : 'Skip for now';

  // Show current avatar in modal
  const prev = document.getElementById('modal-avatar-preview');
  if (userData?.photoURL) {
    prev.innerHTML = `<img src="${userData.photoURL}" style="width:52px;height:52px;object-fit:cover;">`;
  } else if (STATE.session) {
    prev.innerHTML = getAvatarHTML(STATE.session, 52);
  }

  document.getElementById('champion-modal').style.display = 'flex';
}

async function saveChampionPick() {
  const champion   = document.getElementById('champion-select').value;
  const goldenBoot = document.getElementById('golden-boot-select').value;
  if (!champion || !goldenBoot) { showToast('Pick both a champion and a top-scorer team', 'error'); return; }
  if (!STATE.session?.userId) { showToast('Not logged in', 'error'); return; }
  const btn = document.getElementById('save-champion-btn');
  btn.disabled = true; btn.textContent = 'Saving…';

  // Check for new photo
  const photoFile = document.getElementById('modal-photo-input').files[0];
  let updates = { championPick: champion, goldenBootPick: goldenBoot };
  if (photoFile) {
    btn.textContent = 'Uploading photo…';
    updates.photoURL = await resizeImageToBase64(photoFile, 80);
  }

  try {
    await setDoc(doc(STATE.db, 'users', STATE.session.userId), updates, { merge: true });
    showToast(`🏆 ${champion} to win · ⚽ ${goldenBoot} top scorer!`, 'success');
    document.getElementById('champion-modal').style.display = 'none';
    // Reset photo input
    document.getElementById('modal-photo-input').value = '';
  } catch (e) {
    const msg = e?.code || e?.message || String(e);
    showToast(`Save failed: ${msg}`, 'error');
    console.error('saveChampionPick error:', e);
  }
  btn.disabled = false; btn.textContent = 'Save My Picks';
}

// ═══════════════════════════════════════════════════════
// VIEW 2 — HOME / MATCH FEED
// ═══════════════════════════════════════════════════════
let activeHomeTab = 'upcoming';

async function initHomeView() {
  await Promise.all([fetchMatches(), fetchMyPredictions()]);
  renderHomeTab(activeHomeTab);
  startCountdownTimers();
}

function renderHomeTab(tab) {
  activeHomeTab = tab;
  document.querySelectorAll('#view-home .tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  const now = Date.now();
  const filtered = STATE.matches.filter(m => {
    if (tab === 'upcoming')  return m.status !== 'completed' && new Date(m.kickoffUTC).getTime() > now - 7200000;
    if (tab === 'today')     return isToday(m.kickoffUTC) || m.status === 'locked';
    if (tab === 'completed') return m.status === 'completed';
    return true;
  });
  const list = document.getElementById('match-list');
  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚽</div><div class="empty-state-text">No matches here yet</div></div>`;
    return;
  }
  list.innerHTML = filtered.map(renderMatchCard).join('');
  attachCardListeners();
}

function isToday(iso) {
  const d = new Date(iso), t = new Date();
  return d.getDate() === t.getDate() && d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear();
}

function renderMatchCard(m) {
  const pred      = STATE.predictions[m.matchId];
  const lockMs    = getLockMs(m);
  const locked    = lockMs <= Date.now() || m.status === 'locked' || m.status === 'completed';
  const countdown = timeUntil(lockMs);
  const lastMin   = !locked && isLastMinuteWindow(m);
  const completed = m.status === 'completed' && m.resultA !== null;
  const stageLabel = m.group ? `Group ${m.group}` : m.stage;
  const kickoffStr = new Date(m.kickoffUTC).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });

  // Center — score if done, time if upcoming
  const centerHTML = completed
    ? `<div class="fm-center">
        <div class="fm-score-line">
          <span class="fm-score">${m.resultA}</span>
          <span class="fm-dash">–</span>
          <span class="fm-score">${m.resultB}</span>
        </div>
        <div class="fm-status-label">FT</div>
      </div>`
    : `<div class="fm-center">
        <div class="fm-time">${new Date(m.kickoffUTC).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</div>
        <div class="fm-status-label">${locked ? '🔒' : kickoffStr.split(',')[0]}</div>
      </div>`;

  // Prediction strip at bottom
  let pickStrip = '';
  if (completed) {
    const pts = pred?.pointsAwarded;
    const ptsBadge =
      pts === 10 ? `<span class="fm-pts exact">+10 pts ⚽</span>` :
      pts === 5  ? `<span class="fm-pts winner">+5 pts ✓</span>`  :
      pts === 0  ? `<span class="fm-pts wrong">0 pts</span>`      :
      !pred      ? `<span class="fm-pts none">No pick</span>`     : '';
    pickStrip = `<div class="fm-pick-strip">
      ${pred ? `<span class="fm-pick-label">Your pick</span><span class="fm-pick-score">${pred.predictedA}–${pred.predictedB}</span>` : '<span class="fm-pick-label text-muted">No pick made</span>'}
      ${ptsBadge}
    </div>`;
  } else if (locked) {
    pickStrip = `<div class="fm-pick-strip locked">
      🔒 Locked
      ${pred ? `<span class="fm-pick-score">${pred.predictedA}–${pred.predictedB}</span><span style="color:var(--grass);font-size:0.8rem">✓</span>` : '<span style="color:var(--muted);font-size:0.8rem">No pick</span>'}
    </div>`;
  } else {
    const urgentClass = countdown && !countdown.includes('d') && !countdown.includes('h') ? 'urgent' : '';
    pickStrip = `<div class="fm-pick-strip">
      ${pred
        ? `<span class="fm-pick-label">Your pick</span><span class="fm-pick-score">${pred.predictedA}–${pred.predictedB}</span><button class="fm-btn-edit" data-match="${m.matchId}">Edit</button>`
        : `<button class="fm-btn-predict" data-match="${m.matchId}">+ Predict</button>`}
      ${countdown ? `<span class="fm-countdown ${urgentClass}">${lastMin ? '🔥' : '⏳'} ${countdown}</span>` : ''}
    </div>`;
  }

  return `<div class="fm-card" data-stage="${m.stage}" data-match-id="${m.matchId}">
    <div class="fm-header">${stageLabel} · ${kickoffStr}</div>
    <div class="fm-body">
      <div class="fm-team">
        <span class="fm-flag">${getFlag(m.teamA, m.flagA)}</span>
        <span class="fm-name">${m.teamA}</span>
      </div>
      ${centerHTML}
      <div class="fm-team right">
        <span class="fm-flag">${getFlag(m.teamB, m.flagB)}</span>
        <span class="fm-name">${m.teamB}</span>
      </div>
    </div>
    ${pickStrip}
  </div>`;
}

function attachCardListeners() {
  document.querySelectorAll('.fm-btn-edit, .fm-btn-predict').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); openPredictView(btn.dataset.match); });
  });
}

function startCountdownTimers() {
  STATE.countdownTimers.forEach(clearInterval);
  STATE.countdownTimers = [];
  STATE.countdownTimers.push(setInterval(() => {
    document.querySelectorAll('.fm-countdown').forEach(el => {
      const card = el.closest('.fm-card');
      if (!card) return;
      const m = STATE.matches.find(x => x.matchId === card.dataset.matchId);
      if (!m) return;
      const lockMs = getLockMs(m);
      const t = timeUntil(lockMs);
      if (!t) { fetchMatches().then(() => renderHomeTab(activeHomeTab)); return; }
      const urgent  = !t.includes('d') && !t.includes('h');
      const lastMin = isLastMinuteWindow(m);
      el.textContent = `${lastMin ? '🔥' : '⏳'} Locks in ${t}`;
      el.classList.toggle('urgent', urgent);
    });
  }, 30000));
}

// ═══════════════════════════════════════════════════════
// VIEW 3 — PREDICT / EDIT
// ═══════════════════════════════════════════════════════
async function openPredictView(matchId) {
  const m = STATE.matches.find(x => x.matchId === matchId);
  if (!m) return;
  STATE.currentPredictMatch = m;
  const pred   = STATE.predictions[matchId];
  const locked = isLocked(m) || m.status === 'locked' || m.status === 'completed';

  document.getElementById('predict-meta').textContent    = `${m.matchDay} · ${formatKickoff(m.kickoffUTC)} · ${m.venue}`;
  document.getElementById('predict-flag-a').textContent  = getFlag(m.teamA, m.flagA);
  document.getElementById('predict-flag-b').textContent  = getFlag(m.teamB, m.flagB);
  document.getElementById('predict-team-a').textContent  = m.teamA;
  document.getElementById('predict-team-b').textContent  = m.teamB;
  document.getElementById('predict-kickoff').textContent = formatKickoff(m.kickoffUTC);
  document.getElementById('picker-flag-a').textContent   = getFlag(m.teamA, m.flagA);
  document.getElementById('picker-name-a').textContent   = m.teamA;
  document.getElementById('picker-flag-b').textContent   = getFlag(m.teamB, m.flagB);
  document.getElementById('picker-name-b').textContent   = m.teamB;

  const initA = pred?.predictedA ?? 0, initB = pred?.predictedB ?? 0;
  ['a','b'].forEach(t => {
    const el = document.getElementById(`score-${t}`);
    el.textContent = t === 'a' ? initA : initB;
    el.dataset.val = t === 'a' ? initA : initB;
  });

  const lockedMsg = document.getElementById('predict-locked-msg');
  const saveBtn   = document.getElementById('predict-save-btn');
  lockedMsg.style.display = locked ? 'block' : 'none';
  saveBtn.disabled = locked;
  document.querySelectorAll('.numpad-key').forEach(b => b.disabled = locked);
  document.querySelectorAll('.score-display-btn').forEach(b => b.disabled = locked);
  // Reset numpad to team A
  setNumpadTeam('a');
  document.getElementById('numpad-hint').textContent = locked
    ? '🔒 Predictions are closed'
    : `Entering score for ${m.teamA}`;
  showView('view-predict');
}

// ── Numpad ─────────────────────────────────────────────
let activeNumpadTeam = 'a'; // 'a' or 'b'

function setNumpadTeam(team) {
  activeNumpadTeam = team;
  document.getElementById('score-display-a').classList.toggle('active', team === 'a');
  document.getElementById('score-display-b').classList.toggle('active', team === 'b');
  const hint = team === 'a'
    ? `Entering score for ${document.getElementById('picker-name-a').textContent}`
    : `Entering score for ${document.getElementById('picker-name-b').textContent}`;
  document.getElementById('numpad-hint').textContent = hint;
}

function numpadInput(digit) {
  const el = document.getElementById(`score-${activeNumpadTeam}`);
  if (digit === 'clear') {
    const cur = parseInt(el.dataset.val, 10);
    const next = Math.floor(cur / 10); // backspace
    el.dataset.val = next; el.textContent = next;
  } else if (digit === 'done') {
    // Switch to other team or save
    if (activeNumpadTeam === 'a') setNumpadTeam('b');
    else savePrediction();
  } else {
    const cur = parseInt(el.dataset.val, 10);
    const next = Math.min(20, parseInt(`${cur === 0 ? '' : cur}${digit}`, 10) || parseInt(digit, 10));
    el.dataset.val = next; el.textContent = next;
  }
  // Pulse
  el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
}

function adjustScore(team, delta) {
  const el = document.getElementById(`score-${team}`);
  const next = Math.max(0, Math.min(20, parseInt(el.dataset.val, 10) + delta));
  el.dataset.val = next; el.textContent = next;
  el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
}

async function savePrediction() {
  const m = STATE.currentPredictMatch;
  if (!m || !STATE.session) return;
  if (isLocked(m)) { showToast('Predictions are closed for this match', 'lock'); return; }

  const scoreA   = parseInt(document.getElementById('score-a').dataset.val, 10);
  const scoreB   = parseInt(document.getElementById('score-b').dataset.val, 10);
  const predId   = `${STATE.session.userId}_${m.matchId}`;
  const lastMin  = isLastMinuteWindow(m);
  const existing = STATE.predictions[m.matchId];
  const btn = document.getElementById('predict-save-btn');
  btn.disabled = true; btn.textContent = 'Saving…';

  try {
    const pred = {
      userId: STATE.session.userId, matchId: m.matchId,
      predictedA: scoreA, predictedB: scoreB,
      updatedAt: serverTimestamp(), lastMinute: lastMin,
    };
    if (!existing) pred.submittedAt = serverTimestamp();
    await setDoc(doc(STATE.db, 'predictions', predId), pred, { merge: true });

    // Track last-minute count on user doc (only count first last-minute save per match)
    if (lastMin && !existing?.lastMinute) {
      const uRef  = doc(STATE.db, 'users', STATE.session.userId);
      const uSnap = await getDoc(uRef);
      if (uSnap.exists()) await updateDoc(uRef, { lastMinuteCount: (uSnap.data().lastMinuteCount || 0) + 1 });
    }

    STATE.predictions[m.matchId] = { ...pred, pointsAwarded: existing?.pointsAwarded ?? null };
    showToast(lastMin
      ? `🔥 Last-minute pick! ${m.teamA} ${scoreA}–${scoreB} ${m.teamB}`
      : `Saved: ${m.teamA} ${scoreA}–${scoreB} ${m.teamB}`, 'success');
    showView('view-home');
    renderHomeTab(activeHomeTab);
  } catch (e) { showToast('Error saving — try again', 'error'); console.error(e); }
  btn.disabled = false; btn.textContent = 'Save Prediction';
}

// ═══════════════════════════════════════════════════════
// VIEW 4 — LEADERBOARD
// ═══════════════════════════════════════════════════════
async function initLeaderboard() {
  document.getElementById('leaderboard-body').innerHTML =
    '<tr><td colspan="5" class="text-center"><div class="spinner"></div></td></tr>';
  await fetchUsers();
  renderLeaderboard('overall');
}

async function renderLeaderboard(filter) {
  if (filter === 'overall') { renderLeaderboardTable(STATE.users, null); return; }

  // Weekly filter: week-1 through week-6
  if (filter.startsWith('week-')) {
    const week = parseInt(filter.split('-')[1], 10);
    const start = new Date('2026-06-11T00:00:00Z');
    start.setDate(start.getDate() + (week - 1) * 7);
    const end = new Date(start); end.setDate(start.getDate() + 7);
    const ids = new Set(STATE.matches
      .filter(m => { const t = new Date(m.kickoffUTC).getTime(); return t >= start && t < end; })
      .map(m => m.matchId));
    await buildFilteredLeaderboard(ids, filter); return;
  }

  // Match-day filter
  const ids = new Set(STATE.matches.filter(m => m.matchDay === filter).map(m => m.matchId));
  await buildFilteredLeaderboard(ids, filter);
}

async function buildFilteredLeaderboard(matchIds, filter) {
  const snap = await getDocs(collection(STATE.db, 'predictions'));
  const pts = {}, exact = {}, winner = {};
  snap.forEach(d => {
    const p = d.data();
    if (!matchIds.has(p.matchId)) return;
    pts[p.userId]    = (pts[p.userId]    || 0) + (p.pointsAwarded || 0);
    if (p.pointsAwarded === 10) exact[p.userId]  = (exact[p.userId]  || 0) + 1;
    if (p.pointsAwarded === 5)  winner[p.userId] = (winner[p.userId] || 0) + 1;
  });
  const sorted = STATE.users.map(u => ({
    ...u, filteredPoints: pts[u.id] || 0,
    filteredExact: exact[u.id] || 0, filteredWinner: winner[u.id] || 0,
  })).sort((a, b) => b.filteredPoints - a.filteredPoints);
  renderLeaderboardTable(sorted, filter);
}

function renderLeaderboardTable(users, filter) {
  const myId  = STATE.session.userId;
  const rankIcon = ['🥇','🥈','🥉'];
  const container = document.getElementById('leaderboard-body');

  if (users.length === 0) {
    container.innerHTML = '<div class="lb-empty">No data yet</div>';
    return;
  }

  container.innerHTML = users.map((u, i) => {
    const pts    = filter ? (u.filteredPoints || 0) : (u.totalPoints || 0);
    const exact  = filter ? (u.filteredExact  || 0) : (u.exactScores || 0);
    const winner = filter ? (u.filteredWinner || 0) : (u.correctResults || 0);
    const isMe   = u.id === myId;
    const rankCls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
    const rankDisplay = i < 3 ? `<span class="lb-medal">${rankIcon[i]}</span>` : `<span class="lb-num">${i + 1}</span>`;
    const fireBadge   = u.lastMinuteCount > 0 ? ' 🔥' : '';
    const champLine   = u.championPick ? `<span class="lb-champ-pick">🏆 ${u.championPick}</span>` : '';

    return `<div class="lb-row ${isMe ? 'lb-me' : ''} ${rankCls}">
      <div class="lb-rank">${rankDisplay}</div>
      <div class="lb-avatar">${getAvatarHTML(u, 44)}</div>
      <div class="lb-info">
        <div class="lb-name">${u.nickname}${isMe ? ' <span class="me-tag">You</span>' : ''}${fireBadge}</div>
        <div class="lb-sub">${champLine}<span class="lb-stats">${exact} exact · ${winner} results</span></div>
      </div>
      <div class="lb-pts-col">
        <span class="lb-pts">${pts}</span>
        <span class="lb-pts-label">pts</span>
      </div>
    </div>`;
  }).join('');

  document.getElementById('leaderboard-updated').textContent =
    `Updated ${new Date().toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })}`;
}

function populateLeaderboardFilter() {
  const sel = document.getElementById('leaderboard-filter');
  const matchDays = [...new Set(STATE.matches.map(m => m.matchDay))];
  sel.innerHTML =
    '<option value="overall">🏅 Overall</option>' +
    '<optgroup label="By Week">' +
    ['Jun 11–17','Jun 18–24','Jun 25–Jul 1','Jul 2–8','Jul 9–15','Jul 16–19']
      .map((l, i) => `<option value="week-${i+1}">Week ${i+1} (${l})</option>`).join('') +
    '</optgroup>' +
    '<optgroup label="By Match Day">' +
    matchDays.map(d => `<option value="${d}">${d}</option>`).join('') +
    '</optgroup>';
}

// ═══════════════════════════════════════════════════════
// VIEW 5 — MY PREDICTIONS
// ═══════════════════════════════════════════════════════
async function initMyPredictions() {
  await Promise.all([fetchMatches(), fetchMyPredictions()]);
  renderMyPredictions();
}

function renderMyPredictions() {
  let totalPts = 0, exact = 0, winner = 0;
  const groups = {};
  STATE.matches.forEach(m => {
    const p = STATE.predictions[m.matchId];
    if (!p) return;
    if (!groups[m.matchDay]) groups[m.matchDay] = [];
    groups[m.matchDay].push({ m, p });
    if (p.pointsAwarded === 10) { totalPts += 10; exact++; }
    else if (p.pointsAwarded === 5) { totalPts += 5; winner++; }
  });

  const scored = Object.values(STATE.predictions).filter(p => p.pointsAwarded != null);
  const accuracy = scored.length > 0 ? Math.round(((exact + winner) / scored.length) * 100) : 0;

  document.getElementById('stat-pts').textContent    = totalPts;
  document.getElementById('stat-exact').textContent  = exact;
  document.getElementById('stat-winner').textContent = winner;
  document.getElementById('stat-acc').textContent    = accuracy + '%';

  const container = document.getElementById('my-preds-list');
  if (Object.keys(groups).length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">📋</div><div class="empty-state-text">No predictions yet — go make some!</div></div>`;
    return;
  }
  container.innerHTML = Object.entries(groups).map(([day, items]) => `
    <div class="matchday-group">
      <div class="matchday-label">${day}</div>
      ${items.map(({ m, p }) => {
        const pts = p.pointsAwarded;
        const ptsCls = pts === 10 ? 'exact' : pts === 5 ? 'winner' : pts === 0 ? 'wrong' : 'none';
        const ptsLabel = pts === 10 ? '+10' : pts === 5 ? '+5' : pts === 0 ? '0' : '–';
        const result = m.resultA != null ? `${m.resultA} – ${m.resultB}` : null;
        const fire = p.lastMinute ? ' 🔥' : '';
        return `<div class="pred-fm-card">
          <div class="pred-fm-row">
            <div class="pred-fm-team">
              <span class="pred-fm-flag">${getFlag(m.teamA, m.flagA)}</span>
              <span class="pred-fm-name">${m.teamA}</span>
            </div>
            <div class="pred-fm-center">
              <div class="pred-fm-my-score">${p.predictedA} – ${p.predictedB}</div>
              <div class="pred-fm-score-label">MY PICK${fire}</div>
              ${result
                ? `<div class="pred-fm-result">${result}</div><div class="pred-fm-score-label">RESULT</div>`
                : `<div class="pred-fm-result pending">?–?</div><div class="pred-fm-score-label">PENDING</div>`}
            </div>
            <div class="pred-fm-team right">
              <span class="pred-fm-flag">${getFlag(m.teamB, m.flagB)}</span>
              <span class="pred-fm-name">${m.teamB}</span>
            </div>
          </div>
          <div class="pred-fm-pts ${ptsCls}">${ptsLabel} pts</div>
        </div>`;
      }).join('')}
    </div>`).join('');
}

// ═══════════════════════════════════════════════════════
// VIEW 6 — ADMIN PANEL
// ═══════════════════════════════════════════════════════
let adminTab = 'users';

async function initAdminPanel() {
  if (!STATE.session?.isAdmin) { showToast('Admin access only', 'error'); return; }
  setAdminTab('users');
}

function setAdminTab(tab) {
  adminTab = tab;
  document.querySelectorAll('#view-admin .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.admin-section').forEach(s => s.style.display = s.dataset.tab === tab ? 'block' : 'none');
  if (tab === 'users')   renderAdminUsers();
  if (tab === 'matches') renderAdminMatches();
  if (tab === 'recalc')  renderRecalcSection();
}

async function renderAdminUsers() {
  await fetchUsers();
  const list = document.getElementById('admin-user-list');
  list.innerHTML = STATE.users.map(u => `
    <div class="user-row">
      <div class="user-info" style="display:flex;align-items:center;gap:.75rem">
        ${getAvatarHTML(u, 32)}
        <div>
          <div class="user-nickname">${u.nickname}${u.isAdmin ? ' 👑' : ''}${u.lastMinuteCount > 0 ? ' 🔥' : ''}</div>
          <div class="user-meta">${u.mobile || ''}${u.mobile ? ' · ' : ''}${u.totalPoints || 0} pts${u.championPick ? ` · 🏆 ${u.championPick}` : ''}</div>
        </div>
      </div>
      <button class="btn-danger btn-sm" data-delete-user="${u.id}">Delete</button>
    </div>`).join('');
  list.querySelectorAll('[data-delete-user]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this user?')) return;
      await updateDoc(doc(STATE.db, 'users', btn.dataset.deleteUser), { disabled: true });
      showToast('User disabled', 'success'); renderAdminUsers();
    });
  });
}

async function addAdminUser() {
  const nickname = document.getElementById('new-nickname').value.trim();
  const pin      = document.getElementById('new-pin').value.trim();
  const mobile   = document.getElementById('new-mobile').value.trim();
  if (!nickname || !/^\d{4}$/.test(pin)) { showToast('Nickname and 4-digit PIN required', 'error'); return; }
  try {
    await setDoc(doc(collection(STATE.db, 'users')), {
      nickname, pinHash: await hashPin(pin), mobile: mobile || '',
      isAdmin: false, totalPoints: 0, exactScores: 0, correctResults: 0,
      championPick: '', goldenBootPick: '', lastMinuteCount: 0,
      photoURL: '', createdAt: serverTimestamp()
    });
    showToast(`${nickname} added!`, 'success');
    ['new-nickname','new-pin','new-mobile'].forEach(id => document.getElementById(id).value = '');
    renderAdminUsers();
  } catch (e) { showToast('Error adding user', 'error'); console.error(e); }
}

function renderAdminMatches() {
  const container = document.getElementById('admin-match-list');
  const byDay = {};
  STATE.matches.forEach(m => { if (!byDay[m.matchDay]) byDay[m.matchDay] = []; byDay[m.matchDay].push(m); });
  container.innerHTML = Object.entries(byDay).map(([day, matches]) => `
    <div class="admin-card" style="margin-bottom:1rem">
      <div class="admin-card-head">${day}</div>
      <div class="admin-card-body" style="padding:0">
        ${matches.map(m => `
          <div class="match-admin-row" style="padding:.875rem 1rem">
            <div class="match-admin-teams">
              <span>${getFlag(m.teamA, m.flagA)} ${m.teamA} vs ${m.teamB} ${getFlag(m.teamB, m.flagB)}</span>
              <span class="status-badge ${m.status}">${m.status}</span>
            </div>
            <div class="match-admin-meta">${formatKickoff(m.kickoffUTC)} · ${m.venue}</div>
            <div class="result-entry">
              <input class="result-input" id="res-a-${m.matchId}" type="number" min="0" max="20" placeholder="0" value="${m.resultA ?? ''}">
              <span class="result-dash">–</span>
              <input class="result-input" id="res-b-${m.matchId}" type="number" min="0" max="20" placeholder="0" value="${m.resultB ?? ''}">
              <button class="btn btn-primary btn-sm" style="width:auto" onclick="saveMatchResult('${m.matchId}')">Save Result</button>
              <button class="btn btn-secondary btn-sm" style="width:auto" onclick="setMatchStatus('${m.matchId}')">Set Status</button>
            </div>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

async function saveMatchResult(matchId) {
  const rA = parseInt(document.getElementById(`res-a-${matchId}`).value, 10);
  const rB = parseInt(document.getElementById(`res-b-${matchId}`).value, 10);
  if (isNaN(rA) || isNaN(rB)) { showToast('Enter valid scores', 'error'); return; }
  try {
    await setDoc(doc(STATE.db, 'matches', matchId), { resultA: rA, resultB: rB, status: 'completed' }, { merge: true });
    const pSnap = await getDocs(query(collection(STATE.db, 'predictions'), where('matchId', '==', matchId)));
    const batch = writeBatch(STATE.db);
    let total = 0, exact = 0, correct = 0;
    const deltas = {};
    pSnap.forEach(d => {
      const p = d.data();
      const pts = calculatePoints(p.predictedA, p.predictedB, rA, rB);
      batch.update(d.ref, { pointsAwarded: pts });
      total++; if (pts === 10) exact++; if (pts === 5) correct++;
      deltas[p.userId] = (deltas[p.userId] || 0) + (pts - (p.pointsAwarded ?? 0));
    });
    await batch.commit();
    const uBatch = writeBatch(STATE.db);
    for (const [uid, delta] of Object.entries(deltas)) {
      if (delta === 0) continue;
      const s = await getDoc(doc(STATE.db, 'users', uid));
      if (s.exists()) uBatch.update(doc(STATE.db, 'users', uid), { totalPoints: (s.data().totalPoints || 0) + delta });
    }
    await uBatch.commit();
    showToast(`✅ ${total} predictions scored: ${exact} exact, ${correct} correct`, 'success');
    const m = STATE.matches.find(x => x.matchId === matchId);
    if (m) { m.resultA = rA; m.resultB = rB; m.status = 'completed'; }
  } catch (e) { showToast('Error saving result', 'error'); console.error(e); }
}

async function setMatchStatus(matchId) {
  const statuses = ['upcoming', 'locked', 'completed'];
  const current  = STATE.matches.find(x => x.matchId === matchId)?.status || 'upcoming';
  const next     = statuses[(statuses.indexOf(current) + 1) % statuses.length];
  try {
    await setDoc(doc(STATE.db, 'matches', matchId), { status: next }, { merge: true });
    const m = STATE.matches.find(x => x.matchId === matchId);
    if (m) m.status = next;
    showToast(`Status → ${next}`, 'info');
    renderAdminMatches();
  } catch { showToast('Error updating status', 'error'); }
}

function renderRecalcSection() {
  const sel = document.getElementById('recalc-match-select');
  sel.innerHTML = '<option value="">— Select a completed match —</option>' +
    STATE.matches.filter(m => m.status === 'completed')
      .map(m => `<option value="${m.matchId}">${m.teamA} vs ${m.teamB} (${m.matchDay})</option>`).join('');
}

async function recalcMatch() {
  const id = document.getElementById('recalc-match-select').value;
  if (!id) { showToast('Select a match first', 'error'); return; }
  const m = STATE.matches.find(x => x.matchId === id);
  if (!m || m.resultA == null) { showToast('No result for this match', 'error'); return; }
  await saveMatchResult(id);
}

async function recalcAll() {
  if (!confirm('Rebuild ALL user point totals from scratch?')) return;
  showToast('Rebuilding…', 'info');
  try {
    const uSnap = await getDocs(collection(STATE.db, 'users'));
    const totals = {};
    uSnap.forEach(d => { totals[d.id] = 0; });
    const pSnap = await getDocs(collection(STATE.db, 'predictions'));
    pSnap.forEach(d => {
      const p = d.data();
      if (p.pointsAwarded != null) totals[p.userId] = (totals[p.userId] || 0) + p.pointsAwarded;
    });
    const batch = writeBatch(STATE.db);
    Object.entries(totals).forEach(([uid, pts]) => batch.update(doc(STATE.db, 'users', uid), { totalPoints: pts }));
    await batch.commit();
    showToast('All totals rebuilt!', 'success');
  } catch (e) { showToast('Error rebuilding totals', 'error'); console.error(e); }
}

// ═══════════════════════════════════════════════════════
// APP INIT
// ═══════════════════════════════════════════════════════
async function initApp() {
  const session = STATE.session || loadSession();
  if (!session) { showView('view-login'); await initLoginView(); return; }
  STATE.session = session;
  document.getElementById('admin-nav-btn').style.display = session.isAdmin ? 'flex' : 'none';
  document.getElementById('nav-user-name').textContent = session.nickname;

  // Topbar avatar — fetch user doc for photoURL
  try {
    const uSnap = await getDoc(doc(STATE.db, 'users', session.userId));
    const uData = uSnap.exists() ? uSnap.data() : {};
    document.getElementById('topbar-avatar').innerHTML =
      getAvatarHTML({ nickname: session.nickname, photoURL: uData.photoURL || '' }, 32);
  } catch {
    document.getElementById('topbar-avatar').innerHTML =
      getAvatarHTML({ nickname: session.nickname, photoURL: '' }, 32);
  }

  // Tapping topbar avatar opens My Picks modal
  document.getElementById('topbar-avatar-wrap').onclick = async () => {
    const s = await getDoc(doc(STATE.db, 'users', session.userId));
    openChampionModal(s.exists() ? s.data() : null);
  };
  await initHomeView();
  showView('view-home');
  populateLeaderboardFilter();

  // Show champion/golden boot picker if not set yet
  try {
    const uSnap = await getDoc(doc(STATE.db, 'users', session.userId));
    if (uSnap.exists()) {
      const data = uSnap.data();
      if (!data.championPick || !data.goldenBootPick) {
        setTimeout(() => openChampionModal(data), 900);
      }
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════
// EVENT WIRING
// ═══════════════════════════════════════════════════════
function wireEvents() {
  // Login
  document.getElementById('login-btn').addEventListener('click', handleLogin);
  document.getElementById('login-pin').addEventListener('keydown', e => { if (e.key === 'Enter') handleLogin(); });
  document.getElementById('pin-toggle').addEventListener('click', () => {
    const pin = document.getElementById('login-pin');
    pin.type = pin.type === 'password' ? 'text' : 'password';
    document.getElementById('pin-toggle').textContent = pin.type === 'password' ? '👁' : '🙈';
  });

  // Register toggle
  document.getElementById('show-register-btn').addEventListener('click', () => {
    document.getElementById('login-form').style.display = 'none';
    document.getElementById('register-form').style.display = 'block';
  });
  document.getElementById('show-login-btn').addEventListener('click', () => {
    document.getElementById('register-form').style.display = 'none';
    document.getElementById('login-form').style.display = 'block';
  });
  document.getElementById('register-btn').addEventListener('click', handleRegister);
  document.getElementById('reg-pin-confirm').addEventListener('keydown', e => { if (e.key === 'Enter') handleRegister(); });

  // Photo preview on file select (registration)
  document.getElementById('reg-photo-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const preview = document.getElementById('avatar-preview');
    preview.innerHTML = '<span style="font-size:0.65rem;color:var(--muted)">Loading…</span>';
    try {
      const b64 = await resizeImageToBase64(file, 80);
      preview.innerHTML = `<img src="${b64}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;">`;
    } catch (err) {
      console.error('Photo error:', err);
      preview.innerHTML = '<span class="avatar-cam-icon">❌</span>';
      showToast('Could not load photo — try a JPG or PNG', 'error');
    }
  });

  // Bottom nav
  document.querySelectorAll('.bnav-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const view = btn.dataset.view;
      if      (view === 'view-leaderboard') { showView(view); await initLeaderboard(); }
      else if (view === 'view-my-preds')    { showView(view); await initMyPredictions(); }
      else if (view === 'view-admin')       { showView(view); await initAdminPanel(); }
      else if (view === 'view-home')        { showView(view); await initHomeView(); }
    });
  });

  // Logout
  document.getElementById('logout-btn').addEventListener('click', () => {
    clearSession(); STATE.countdownTimers.forEach(clearInterval);
    showView('view-login'); initLoginView();
  });

  // Home tabs
  document.querySelectorAll('#view-home .tab-btn').forEach(btn =>
    btn.addEventListener('click', () => renderHomeTab(btn.dataset.tab)));

  // Predict view
  document.getElementById('predict-back-btn').addEventListener('click', () => { showView('view-home'); renderHomeTab(activeHomeTab); });
  document.getElementById('predict-save-btn').addEventListener('click', savePrediction);

  // Score display buttons — tap to select which team to edit
  document.getElementById('score-display-a').addEventListener('click', () => setNumpadTeam('a'));
  document.getElementById('score-display-b').addEventListener('click', () => setNumpadTeam('b'));

  // Numpad keys
  document.querySelectorAll('.numpad-key').forEach(btn =>
    btn.addEventListener('click', () => numpadInput(btn.dataset.digit)));

  // Swipe between home tabs
  let touchStartX = 0;
  const tabs = ['upcoming', 'today', 'completed'];
  document.getElementById('match-list').addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
  }, { passive: true });
  document.getElementById('match-list').addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) < 60) return;
    const cur = tabs.indexOf(activeHomeTab);
    const next = dx < 0 ? Math.min(cur + 1, tabs.length - 1) : Math.max(cur - 1, 0);
    if (next !== cur) renderHomeTab(tabs[next]);
  }, { passive: true });

  // Leaderboard
  document.getElementById('leaderboard-filter').addEventListener('change', e => renderLeaderboard(e.target.value));

  // Admin
  document.querySelectorAll('#view-admin .tab-btn').forEach(btn =>
    btn.addEventListener('click', () => setAdminTab(btn.dataset.tab)));
  document.getElementById('admin-add-user-btn').addEventListener('click', addAdminUser);
  document.getElementById('recalc-match-btn').addEventListener('click', recalcMatch);
  document.getElementById('recalc-all-btn').addEventListener('click', recalcAll);

  // Champion modal
  const closeModal = () => { document.getElementById('champion-modal').style.display = 'none'; };
  document.getElementById('save-champion-btn').addEventListener('click', saveChampionPick);
  document.getElementById('skip-champion-btn').addEventListener('click', closeModal);
  document.getElementById('close-champion-btn').addEventListener('click', closeModal);
  // Tap backdrop to close
  document.getElementById('champion-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('champion-modal')) closeModal();
  });
  document.getElementById('my-picks-btn').addEventListener('click', async () => {
    const s = await getDoc(doc(STATE.db, 'users', STATE.session.userId));
    openChampionModal(s.exists() ? s.data() : null);
  });
  // Modal photo preview
  document.getElementById('modal-photo-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const prev = document.getElementById('modal-avatar-preview');
    prev.innerHTML = '<div style="font-size:0.7rem;color:var(--muted)">Processing…</div>';
    try {
      const b64 = await resizeImageToBase64(file, 80);
      prev.innerHTML = `<img src="${b64}" style="width:52px;height:52px;object-fit:cover;border-radius:50%;">`;
    } catch (err) {
      console.error('Photo error:', err);
      prev.innerHTML = '❌';
      showToast('Could not load photo — try a JPG or PNG', 'error');
    }
  });
}

// ── PWA Install Prompt ─────────────────────────────────
let _deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  if (!localStorage.getItem('pwa-dismissed'))
    document.getElementById('install-banner').style.display = 'flex';
});
window.addEventListener('appinstalled', () => {
  document.getElementById('install-banner').style.display = 'none';
});

// ═══════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════
async function boot() {
  const app = initializeApp(FIREBASE_CONFIG);
  STATE.db  = getFirestore(app);
  window.saveMatchResult = saveMatchResult;
  window.setMatchStatus  = setMatchStatus;

  document.getElementById('install-btn').addEventListener('click', async () => {
    if (!_deferredInstallPrompt) return;
    _deferredInstallPrompt.prompt();
    const { outcome } = await _deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') document.getElementById('install-banner').style.display = 'none';
    _deferredInstallPrompt = null;
  });
  document.getElementById('install-dismiss').addEventListener('click', () => {
    document.getElementById('install-banner').style.display = 'none';
    localStorage.setItem('pwa-dismissed', '1');
  });

  wireEvents();
  await initApp();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
