'use strict';

/* ================= Storage ================= */
const DATA_KEY = 'foco.data.v1';
const TIMER_KEY = 'foco.timer.v1';
const PENDING_KEY = 'foco.pending.v1';
const GOAL_KEY = 'foco.goal.v1';
const THEME_KEY = 'foco.theme.v1';
const ACCENT_KEY = 'foco.accent.v1';
const PROFILE_KEY = 'foco.profile.v1';
const REWARDS_KEY = 'foco.rewards.v1';
const UPOINTS_KEY = 'foco.points.v1';

const defaultState = () => ({ sessions: [], subjects: {}, deletedIds: [] });
let state = defaultState();
let storeKey = DATA_KEY;

/* ================= Recompensas ================= */
let rewardedDays = new Set();
const POINTS_PER_DAY = 100;
const SIGNUP_BONUS = 200;

/* ================= Pontos do usuário (user_points) ================= */
let userPoints = 0;

/* ================= Loja (cristais + bordas) ================= */
// Whitelist temporária: só essas contas veem a aba Loja (fase de teste).
// Use @username sem o @, minúsculo. Pra liberar p/ todo mundo, esvazie o array.
const SHOP_ALLOWED = ['casper', 'tsuy_ru'];
let crystals = 0;               // saldo de cristais (moeda da loja)
let shopItems = [];             // catálogo: [{id, name, category, cost, color}]
let ownedItems = new Set();     // ids de bordas que o usuário já comprou
let equippedBorder = null;      // id da borda equipada (do perfil do usuário)
const BORDER_COLORS = {};       // id -> cor hex (preenchido do catálogo)
const ANIMATED = new Set();     // ids de bordas animadas (ex.: RGB, cor 'rgb')

function isShopAllowed() {
  if (SHOP_ALLOWED.length === 0) return true; // lista vazia = liberado p/ todos
  const uname = (profile.username || '').replace('@', '').toLowerCase().trim();
  return SHOP_ALLOWED.includes(uname);
}

function getTotalPoints() { return userPoints + (rewardedDays.size * POINTS_PER_DAY); }

async function loadUserPoints() {
  const raw = localStorage.getItem(UPOINTS_KEY);
  const cached = Number.isFinite(Number(raw)) ? Number(raw) : 0;
  if (!sb.client || !sb.user) { userPoints = cached; return; }
  try {
    const { data, error } = await sb.client.from('user_points').select('total_points').eq('user_id', sb.user.id).maybeSingle();
    if (error) throw error;
    userPoints = data?.total_points ?? 0;
    localStorage.setItem(UPOINTS_KEY, userPoints);
  } catch { userPoints = cached; }
}

async function setUserPoints(pts) {
  userPoints = Math.max(0, pts);
  localStorage.setItem(UPOINTS_KEY, userPoints);
  if (!sb.client || !sb.user) return;
  try {
    await sb.client.from('user_points').upsert({
      user_id: sb.user.id,
      total_points: userPoints,
      updated_at: new Date().toISOString()
    });
  } catch (e) { console.error('setUserPoints:', e); }
}

async function awardSignupBonus() {
  if (!sb.client || !sb.user) return;
  try {
    const { data } = await sb.client.from('user_points').select('total_points').eq('user_id', sb.user.id).maybeSingle();
    if (!data) {
      await sb.client.from('user_points').upsert({
        user_id: sb.user.id,
        total_points: SIGNUP_BONUS,
        updated_at: new Date().toISOString()
      });
      userPoints = SIGNUP_BONUS;
      localStorage.setItem(UPOINTS_KEY, userPoints);
      $('welcomeOverlay').hidden = false;
    }
  } catch (e) { console.error('awardSignupBonus:', e); }
}

function loadRewards() {
  try {
    const raw = localStorage.getItem(REWARDS_KEY);
    if (raw) rewardedDays = new Set(JSON.parse(raw));
  } catch { /* ignora */ }
}

function saveRewards() {
  localStorage.setItem(REWARDS_KEY, JSON.stringify([...rewardedDays]));
}

function getPoints() { return getTotalPoints(); }

function awardPendingRewards(perDay) {
  const newDays = [];
  perDay.forEach((secs, key) => {
    if (secs >= dailyGoalSecs && !rewardedDays.has(key)) {
      rewardedDays.add(key);
      newDays.push(key);
    }
  });
  if (newDays.length > 0) {
    saveRewards();
    pushRewards(newDays);
    toast(`+${newDays.length * POINTS_PER_DAY} pontos! 🎉`, 'success');
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(storeKey);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    state.subjects = parsed.subjects && typeof parsed.subjects === 'object' ? parsed.subjects : {};
    state.deletedIds = Array.isArray(parsed.deletedIds) ? parsed.deletedIds : [];
  } catch { /* dados corrompidos: começa limpo */ }
}

function saveState() {
  if (state.deletedIds.length > 500) state.deletedIds = state.deletedIds.slice(-500);
  localStorage.setItem(storeKey, JSON.stringify(state));
}

/* ================= Nuvem (Supabase) ================= */
const sb = { client: null, user: null };
let pendingSync = new Set();
let syncingNow = false;

try { pendingSync = new Set(JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')); } catch { /* ignora */ }
const persistPending = () => localStorage.setItem(PENDING_KEY, JSON.stringify([...pendingSync]));

function isCloudConfigured() {
  return typeof supabase !== 'undefined'
    && typeof SUPABASE_URL === 'string' && SUPABASE_URL.startsWith('http')
    && typeof SUPABASE_ANON_KEY === 'string' && SUPABASE_ANON_KEY.length > 20;
}

function initCloud() {
  updateSyncUI();
  if (!isCloudConfigured()) return;
  try { sb.client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { flowType: 'implicit', detectSessionInUrl: true }
  }); }
  catch (e) { console.error('Supabase:', e); return; }

  sb.client.auth.getSession().then(({ data, error }) => {
    console.log('[auth] getSession:', data?.session?.user?.email ?? 'null', error?.message ?? 'ok');
    setCloudUser(data.session?.user ?? null);
    if (sb.user) {
      syncFromCloud().then(flushPending);
    } else {
      goToLogin();
    }
  });
  sb.client.auth.onAuthStateChange((evt, session) => {
    console.log('[auth] onAuthStateChange:', evt, session?.user?.email ?? 'null');
    const u = session?.user ?? null;
    if ((u?.id ?? null) !== (sb.user?.id ?? null)) {
      setCloudUser(u);
      syncProfileUI();
      renderAll();
      if (u) syncFromCloud().then(flushPending);
    }
  });

  window.addEventListener('online', () => { if (sb.user) flushPending(); });

  setInterval(() => {
    if (sb.user && sb.client) {
      loadPendingRequests();
    }
  }, 30000);
}

function setCloudUser(user) {
  // migra dados anônimos se existirem
  if (user) {
    try {
      const anonRaw = localStorage.getItem(DATA_KEY);
      if (anonRaw) {
        const anon = JSON.parse(anonRaw);
        if (Array.isArray(anon.sessions) && anon.sessions.length > 0) {
          const userKey = `${DATA_KEY}.u.${user.id}`;
          const userRaw = localStorage.getItem(userKey);
          const userState = userRaw ? JSON.parse(userRaw) : { sessions: [], subjects: {}, deletedIds: [] };
          const existingIds = new Set((userState.sessions || []).map(s => s.id));
          const merged = (anon.sessions || []).filter(s => !existingIds.has(s.id));
          userState.sessions = [...merged, ...(userState.sessions || [])]
            .sort((a, b) => new Date(b.dateISO) - new Date(a.dateISO));
          userState.subjects = { ...(userState.subjects || {}), ...(anon.subjects || {}) };
          localStorage.setItem(userKey, JSON.stringify(userState));
          localStorage.removeItem(DATA_KEY);
        }
      }
    } catch { /* ignora */ }
  }

  // troca o cache local para o namespace do usuário logado
  storeKey = user ? `${DATA_KEY}.u.${user.id}` : DATA_KEY;
  state = defaultState();
  loadState();

  sb.user = user;
  if (user) loadPendingRequests();
  const avatar = $('avatarInitials');
  if (user) {
    const handle = (user.email || '?').split('@')[0].split(/[._-]/)[0];
    avatar.textContent = (handle.slice(0, 2) || '?').toUpperCase();
    avatar.title = user.email;
    $('userEmail').textContent = user.email;
    $('userMenu').hidden = true;
    $('accountSection').hidden = false;
    $('accountEmail').textContent = user.email;
    $('settingsProfileCard').hidden = false;
    $('settingsAppearanceCard').hidden = false;
    $('settingsGoalCard').hidden = false;
    $('settingsDataCard').hidden = false;
    loadProfile();
    pullProfile().then(() => {
      syncProfileUI();
      applyBorderTo($('avatarBtn'), equippedBorder);
    });
    loadShop().then(() => {
      if (currentView === 'shop') renderShop();
      renderProfileBorders();
    });
  } else {
    avatar.textContent = '?';
    avatar.title = 'Conectar conta';
    $('accountSection').hidden = true;
    $('settingsProfileCard').hidden = true;
    $('settingsAppearanceCard').hidden = true;
    $('settingsGoalCard').hidden = true;
    $('settingsDataCard').hidden = true;
    profile = { displayName: '', username: '', avatarUrl: '', usernameUpdatedAt: null, bio: '' };
    syncProfileUI();
  }
}

function updateSyncUI() {
  const chip = $('syncChip');
  chip.hidden = !isCloudConfigured();
  if (!isCloudConfigured()) return;

  const label = $('syncLabel');
  const dot = $('syncDot');
  dot.className = 'sync-dot';

  if (!sb.user) label.textContent = 'Local';
  else if (syncingNow) { label.textContent = 'Sincronizando...'; dot.classList.add('busy'); }
  else if (pendingSync.size > 0) { label.textContent = `${pendingSync.size} pendentes`; dot.classList.add('warn'); }
  else { label.textContent = 'Em dia'; dot.classList.add('ok'); }
}

const rowToSession = r => ({
  id: r.id,
  dateISO: r.date_iso,
  duration: r.duration,
  subject: r.subject,
  topic: r.topic,
  obs: r.obs || '',
  qTotal: r.q_total || 0,
  qRight: r.q_right || 0
});

async function syncFromCloud() {
  if (!sb.client || !sb.user || syncingNow) return;
  syncingNow = true;
  updateSyncUI();
  console.log('[sync] syncFromCloud: user_id=', sb.user.id);
  try {
    const [{ data: rs, error: eS }, { data: rj, error: eJ }, { data: rw, error: eR }, { data: rp, error: eP }] = await Promise.all([
      sb.client.from('sessions').select('*').order('date_iso', { ascending: false }),
      sb.client.from('subjects').select('*'),
      sb.client.from('rewards').select('*'),
      sb.client.from('profiles').select('*').eq('user_id', sb.user.id).maybeSingle()
    ]);
    console.log('[sync] sessions:', (rs || []).length, 'subjects:', (rj || []).length, 'rewards:', (rw || []).length);
    if (eS) console.error('[sync] sessions error:', eS.message);
    if (eJ) console.error('[sync] subjects error:', eJ.message);
    if (eR) console.error('[sync] rewards error:', eR.message);
    if (eP) console.error('[sync] profiles error:', eP.message);
    if (eS || eJ) throw eS || eJ;

    // união por id; respeita exclusões locais recentes (tombstones)
    const byId = new Map(state.sessions.map(s => [s.id, s]));
    (rs.data || []).forEach(r => { const s = rowToSession(r); if (!byId.has(s.id)) byId.set(s.id, s); });
    const tombs = new Set(state.deletedIds);
    state.sessions = [...byId.values()].filter(s => !tombs.has(s.id))
      .sort((a, b) => new Date(b.dateISO) - new Date(a.dateISO));

    // matérias: união de tópicos
    (rj.data || []).forEach(r => {
      const topics = Array.isArray(r.topics) ? r.topics : [];
      state.subjects[r.name] = [...new Set([...(state.subjects[r.name] || []), ...topics])];
    });

    // recompensas: união de dias
    (rw.data || []).forEach(r => { rewardedDays.add(r.day_key); });
    saveRewards();

    // perfil: usa o do servidor se existir
    if (rp && !rp.error) {
      profile = {
        displayName: rp.display_name || '',
        username: rp.username || '',
        avatarUrl: rp.avatar_url || '',
        usernameUpdatedAt: rp.username_updated_at || null,
        bio: rp.bio || ''
      };
      localStorage.setItem(profileStoreKey(), JSON.stringify(profile));
      resetProfileForm();
    }

    await loadUserPoints();
    await awardSignupBonus();

    saveState();
    await syncToCloud();
    renderAll();
  } catch (e) {
    console.error('Sync:', e);
    toast('Não foi possível sincronizar agora.', 'error');
  } finally {
    syncingNow = false;
    updateSyncUI();
  }
}

async function pushSession(session) {
  if (!sb.client || !sb.user) return;
  try {
    const { error } = await sb.client.from('sessions').upsert({
      id: session.id,
      user_id: sb.user.id,
      date_iso: session.dateISO,
      duration: session.duration,
      subject: session.subject,
      topic: session.topic,
      obs: session.obs || '',
      q_total: session.qTotal || 0,
      q_right: session.qRight || 0
    });
    if (error) throw error;
    pendingSync.delete(session.id);
  } catch (e) {
    console.error('pushSession:', e);
    pendingSync.add(session.id);
  }
  persistPending();
  updateSyncUI();
}

async function deleteSessionRemote(id) {
  if (!sb.client || !sb.user) return;
  try { await sb.client.from('sessions').delete().eq('id', id); } catch (e) { console.error(e); }
  pendingSync.delete(id);
  persistPending();
  updateSyncUI();
}

async function pushSubjects(names) {
  if (!sb.client || !sb.user) return;
  const rows = names.map(name => ({
    user_id: sb.user.id,
    name,
    topics: state.subjects[name] || []
  }));
  try { await sb.client.from('subjects').upsert(rows); }
  catch (e) { console.error('pushSubjects:', e); }
}

async function pushRewards(days) {
  if (!sb.client || !sb.user || !days.length) return;
  const rows = days.map(d => ({ user_id: sb.user.id, day_key: d, points: POINTS_PER_DAY }));
  try { await sb.client.from('rewards').upsert(rows); }
  catch (e) { console.error('pushRewards:', e); }
}

async function flushPending() {
  for (const id of [...pendingSync]) {
    const s = state.sessions.find(x => x.id === id);
    if (s) await pushSession(s); else { pendingSync.delete(id); persistPending(); }
  }
  updateSyncUI();
}

async function syncToCloud() {
  if (!sb.client || !sb.user) return;
  console.log('[sync] syncToCloud: pushing', state.sessions.length, 'sessions');
  for (const s of state.sessions) await pushSession(s);
  await pushSubjects(Object.keys(state.subjects));
  await pushRewards([...rewardedDays]);
  await pushProfile();
  await setUserPoints(userPoints);
  console.log('[sync] syncToCloud: done');
}

/* ================= Utils ================= */
const $ = id => document.getElementById(id);

function fmtHMS(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function fmtHM(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0 && m === 0) return '0min';
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayLabel(key) {
  const today = dateKey(new Date());
  const yesterday = dateKey(new Date(Date.now() - 86400000));
  if (key === today) return 'Hoje';
  if (key === yesterday) return 'Ontem';
  const [y, m, d] = key.split('-');
  return `${d}/${m}/${y}`;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  el.textContent = msg;
  $('toastStack').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 3200);
}

function confirmDialog({ title = 'Confirmar', text = 'Tem certeza?', okText = 'Confirmar', okClass = 'btn-danger' } = {}) {
  return new Promise(resolve => {
    const m = $('confirmModal');
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    const ok = $('confirmOkBtn');
    ok.textContent = okText;
    ok.className = `btn ${okClass}`;
    m.classList.add('active');
    const done = val => {
      m.classList.remove('active');
      ok.removeEventListener('click', onOk);
      $('confirmCancelBtn').removeEventListener('click', onCancel);
      m.removeEventListener('click', onBack);
      document.removeEventListener('keydown', onEsc);
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBack = e => { if (e.target === m) done(false); };
    ok.addEventListener('click', onOk);
    $('confirmCancelBtn').addEventListener('click', onCancel);
    m.addEventListener('click', onBack);
    document.addEventListener('keydown', onEsc);
    function onEsc(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onEsc); done(false); }
    }
  });
}

/* ================= Timer ================= */
let timer = { running: false, accumulated: 0, startedAt: null };
let rafId = null;
let lastShown = '';

function loadTimer() {
  try {
    const raw = localStorage.getItem(TIMER_KEY);
    if (raw) timer = { ...timer, ...JSON.parse(raw) };
  } catch { /* ignora */ }
  syncTimerUI();
  renderClock(true);
}

function saveTimer() {
  localStorage.setItem(TIMER_KEY, JSON.stringify(timer));
}

function elapsedSec() {
  return timer.accumulated + (timer.running ? Math.floor((Date.now() - timer.startedAt) / 1000) : 0);
}

function renderClock(force = false) {
  const str = fmtHMS(elapsedSec());
  if (!force && str === lastShown) return; // só mexe no DOM quando o segundo mudou
  lastShown = str;
  $('timer').textContent = str;
  updateMiniTimer();
}

function tickLoop() {
  renderClock();
  rafId = requestAnimationFrame(tickLoop);
}

function startTick() {
  stopTick();
  lastShown = '';
  rafId = requestAnimationFrame(tickLoop);
}

function stopTick() {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
}

function startTimer() {
  if (timer.running) return;
  timer.running = true;
  timer.startedAt = Date.now();
  saveTimer();
  startTick();
  syncTimerUI();
}

function pauseTimer() {
  if (!timer.running) return;
  timer.accumulated = elapsedSec();
  timer.running = false;
  timer.startedAt = null;
  saveTimer();
  stopTick();
  renderClock();
  syncTimerUI();
}

function resetTimer(clearStorage = true) {
  timer = { running: false, accumulated: 0, startedAt: null };
  stopTick();
  if (clearStorage) localStorage.removeItem(TIMER_KEY);
  renderClock();
  syncTimerUI();
}

function syncTimerUI() {
  const display = $('timer');
  const hint = $('timerHint');

  $('startBtn').hidden = timer.running;
  $('pauseBtn').hidden = !timer.running;
  const hasTime = elapsedSec() > 0 || timer.running;
  $('saveBtn').hidden = !hasTime;
  $('resetBtn').hidden = !hasTime;

  display.classList.toggle('running', timer.running);
  display.classList.toggle('paused', !timer.running && hasTime);
  hint.textContent = timer.running ? 'Registrando...' : hasTime ? 'Pausado' : 'Pronto para começar';
}

/* ================= Views ================= */
const views = ['study', 'stats', 'feed', 'friends', 'shop', 'settings'];
let currentView = 'study';

function switchView(name) {
  currentView = name;
  views.forEach(v => {
    const section = $(`view-${v}`);
    const active = v === name;
    section.classList.toggle('active', active);
    section.hidden = !active;
  });
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === name)
  );
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === name)
  );
  window.scrollTo({ top: 0 });
  if (name === 'settings') syncSettingsUI();
  else if (name === 'friends') loadFriends();
  else if (name === 'shop') { if (isShopAllowed()) openShop(); else switchView('study'); }
  else if (name !== 'study') renderStatsAndFeed();
}

document.querySelectorAll('.nav-btn, .tab-btn').forEach(btn =>
  btn.addEventListener('click', () => switchView(btn.dataset.view))
);

document.querySelectorAll('[data-goto]').forEach(btn =>
  btn.addEventListener('click', () => switchView(btn.dataset.goto))
);

/* ================= Botões do cronômetro ================= */
let resetArmed = false;

$('startBtn').addEventListener('click', startTimer);
$('pauseBtn').addEventListener('click', pauseTimer);
$('saveBtn').addEventListener('click', openModal);

$('resetBtn').addEventListener('click', () => {
  if (!resetArmed) {
    resetArmed = true;
    $('resetBtn').textContent = 'Confirmar?';
    setTimeout(() => {
      resetArmed = false;
      $('resetBtn').textContent = 'Descartar';
    }, 3000);
    return;
  }
  resetArmed = false;
  $('resetBtn').textContent = 'Descartar';
  const hadTime = elapsedSec() > 0;
  resetTimer();
  if (hadTime) toast('Sessão descartada.', '');
});

/* ================= Métricas ================= */
function mondayOfCurrentWeek() {
  const d = new Date();
  const day = d.getDay(); // 0=dom ... 6=sáb
  const mon = new Date(d);
  mon.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  mon.setHours(0, 0, 0, 0);
  return mon;
}

let dailyGoalSecs = 30 * 60; // meta diária configurável (padrão: 30 min)

function last7Days() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({ key: dateKey(d), total: 0 });
  }
  return days;
}

function sessionsInLast7() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 6);
  cutoff.setHours(0, 0, 0, 0);
  return state.sessions.filter(s => new Date(s.dateISO) >= cutoff);
}

function calcStreak() {
  const keys = new Set(state.sessions.map(s => dateKey(new Date(s.dateISO))));
  let cursor = new Date();
  if (!keys.has(dateKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
    if (!keys.has(dateKey(cursor))) return 0;
  }
  let streak = 0;
  while (keys.has(dateKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function renderMetrics() {
  const week = last7Days();
  const byKey = new Map(week.map(d => [d.key, d]));
  let weekSecs = 0;

  sessionsInLast7().forEach(s => {
    byKey.get(dateKey(new Date(s.dateISO))).total += s.duration;
    weekSecs += s.duration;
  });

  const activeDays = [...byKey.values()].filter(d => d.total > 0).length;
  const avgSecs = activeDays > 0 ? Math.round(weekSecs / activeDays) : 0;

  const qTotal = sessionsInLast7().reduce((a, s) => a + s.qTotal, 0);
  const qRight = sessionsInLast7().reduce((a, s) => a + s.qRight, 0);

  $('totalHours').textContent = fmtHM(weekSecs);
  $('avgHours').textContent = fmtHM(avgSecs);
  $('totalQuestions').textContent = qTotal;
  $('accuracySub').textContent = qTotal > 0
    ? `${Math.round((qRight / qTotal) * 100)}% de acertos`
    : 'Sem questões registradas';

  const streak = calcStreak();
  const streakText = streak > 0 ? `${streak} ${streak === 1 ? 'dia' : 'dias'}` : '0 dias';
  $('streakDays').innerHTML = `<i class="ti ti-lightning"></i> ${streakText}`;

  // Card "Hoje": tempo e sessões do dia vs meta
  const todayKey = dateKey(new Date());
  const todays = state.sessions.filter(s => dateKey(new Date(s.dateISO)) === todayKey);
  const todaySecs = todays.reduce((a, s) => a + s.duration, 0);
  $('todayTime').textContent = fmtHM(todaySecs);
  $('todaySessions').textContent =
    `${todays.length} ${todays.length === 1 ? 'sessão' : 'sessões'} · meta ${fmtHM(dailyGoalSecs)}`;

  // Tira da semana corrente (segunda a domingo), mínimo 30 min por dia
  const monday = mondayOfCurrentWeek();
  const perDay = new Map();
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    perDay.set(dateKey(d), 0);
  }
  state.sessions.forEach(s => {
    const k = dateKey(new Date(s.dateISO));
    if (perDay.has(k)) perDay.set(k, perDay.get(k) + s.duration);
  });
  awardPendingRewards(perDay);
  renderWeekStrip(perDay);

  $('totalPoints').textContent = getPoints();
  const breakdown = [];
  if (userPoints > 0) breakdown.push(`${userPoints} bônus`);
  if (rewardedDays.size > 0) breakdown.push(`${rewardedDays.size * POINTS_PER_DAY} de metas`);
  $('pointsSub').textContent = breakdown.length > 0 ? breakdown.join(' + ') : '100 pts por meta cumprida';

  window._weekData = week;
}

const STRIP_LABELS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

function renderWeekStrip(perDay) {
  const row = $('weekStrip');
  if (!row) return;
  row.innerHTML = '';

  const today = dateKey(new Date());
  const keys = [...perDay.keys()];
  const daysDone = [...perDay.values()].filter(v => v >= dailyGoalSecs).length;

  $('weekDaysChip').textContent = `${daysDone} de 7 dias · meta ${fmtHM(dailyGoalSecs)}/dia`;

  keys.forEach((key, i) => {
    const secs = perDay.get(key);
    const day = document.createElement('div');
    day.className = 'strip-day';

    const circle = document.createElement('div');
    circle.className = 'strip-circle';

    const label = document.createElement('span');
    label.className = 'strip-label';
    label.textContent = STRIP_LABELS[i];

    if (secs >= dailyGoalSecs) {
      day.classList.add('done');
      circle.innerHTML = '<i class="ti ti-check"></i>';
    } else if (key < today) {
      day.classList.add('missed');
      circle.innerHTML = '<i class="ti ti-x"></i>';
    } else {
      day.classList.add('future');
    }

    if (key === today) day.classList.add('today');

    day.append(circle, label);
    row.appendChild(day);
  });
}

/* ================= Cards de sessão (DOM seguro) ================= */
function buildSessionCard(session, showDelete) {
  const card = document.createElement('div');
  card.className = 'history-item';

  const info = document.createElement('div');
  info.className = 'history-info';

  const h4 = document.createElement('h4');
  h4.textContent = session.subject;

  const p = document.createElement('p');
  p.textContent = session.topic + (session.obs ? ` — ${session.obs}` : '');

  info.append(h4, p);

  const stats = document.createElement('div');
  stats.className = 'history-stats';

  const strong = document.createElement('strong');
  strong.textContent = fmtHM(session.duration);

  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = new Date(session.dateISO).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  stats.append(strong, meta);

  if (session.qTotal > 0) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `${session.qRight}/${session.qTotal}`;
    strong.appendChild(badge);
  }

  card.append(info, stats);

  if (showDelete) {
    const del = document.createElement('button');
    del.className = 'delete-btn';
    del.title = 'Excluir sessão';
    del.setAttribute('aria-label', `Excluir sessão de ${session.subject}`);
    del.dataset.id = session.id;
    del.textContent = '✕';
    card.appendChild(del);
  }

  return card;
}

function emptyRow(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  const img = document.createElement('img');
  img.src = 'seal.svg';
  img.alt = '';
  img.className = 'empty-seal';
  const p = document.createElement('p');
  p.className = 'empty';
  p.style.padding = '0';
  p.textContent = msg;
  wrap.append(img, p);
  return wrap;
}

function renderHistory() {
  const list = $('historyList');
  list.innerHTML = '';
  const recent = state.sessions.slice(0, 5);
  if (recent.length === 0) {
    list.appendChild(emptyRow('Nenhuma sessão ainda. Inicie o cronômetro e registre seu primeiro estudo!'));
    return;
  }
  recent.forEach(s => list.appendChild(buildSessionCard(s, false)));
}

/* ================= Feed ================= */
function renderFeed() {
  const list = $('feedList');
  list.innerHTML = '';
  populateFilterSubject();

  const query = ($('feedSearch').value || '').toLowerCase().trim();
  const subj = $('filterSubject').value;
  const from = $('filterFrom').value;
  const to = $('filterTo').value;
  const onlyQ = $('filterQuestions').checked;

  const filtered = state.sessions.filter(s => {
    if (subj && s.subject !== subj) return false;
    if (onlyQ && !(s.qTotal > 0)) return false;
    const k = dateKey(new Date(s.dateISO));
    if (from && k < from) return false;
    if (to && k > to) return false;
    if (query) {
      const hay = [s.subject, s.topic, s.obs].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  $('sessionCount').textContent = `${filtered.length} ${filtered.length === 1 ? 'sessão' : 'sessões'}`;

  if (filtered.length === 0) {
    list.appendChild(emptyRow(query ? 'Nada encontrado para essa busca.' : 'Seu histórico aparecerá aqui.'));
    return;
  }

  let currentDay = null;
  filtered.forEach(s => {
    const day = dateKey(new Date(s.dateISO));
    if (day !== currentDay) {
      currentDay = day;
      const label = document.createElement('p');
      label.className = 'day-group-label';
      label.textContent = dayLabel(day);
      list.appendChild(label);
    }
    list.appendChild(buildSessionCard(s, true));
  });
}

$('feedSearch').addEventListener('input', renderFeed);
['filterSubject', 'filterFrom', 'filterTo'].forEach(id => $(id).addEventListener('change', renderFeed));
$('filterQuestions').addEventListener('change', renderFeed);
$('clearFilters').addEventListener('click', clearFeedFilters);

// Exclusão com confirmação em dois cliques
let deleteArmId = null;
$('feedList').addEventListener('click', e => {
  const btn = e.target.closest('.delete-btn');
  if (!btn) return;
  if (deleteArmId === btn.dataset.id) {
    state.sessions = state.sessions.filter(s => s.id !== btn.dataset.id);
    state.deletedIds.push(btn.dataset.id);
    saveState();
    deleteSessionRemote(btn.dataset.id);
    deleteArmId = null;
    renderAll();
    toast('Sessão excluída.', '');
  } else {
    deleteArmId = btn.dataset.id;
    btn.textContent = 'Confirmar?';
    setTimeout(() => {
      if (deleteArmId === btn.dataset.id) {
        deleteArmId = null;
        btn.textContent = '✕';
      }
    }, 3000);
  }
});

/* ================= Stats ================= */
function renderStats() {
  // Gráfico semanal
  const chart = $('weekChart');
  chart.innerHTML = '';
  const week = window._weekData || [];
  const max = Math.max(...week.map(d => d.total), 1800);
  const labels = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const todayIdx = new Date().getDay();

  week.forEach((d, i) => {
    const col = document.createElement('div');
    col.className = 'chart-col';

    const bar = document.createElement('div');
    bar.className = 'chart-bar' + (d.total === 0 ? ' zero' : '');
    bar.style.height = d.total === 0 ? '' : `${Math.max((d.total / max) * 100, 4)}%`;

    const value = document.createElement('span');
    value.className = 'chart-value';
    value.textContent = d.total > 0 ? fmtHM(d.total) : '—';

    const label = document.createElement('span');
    label.className = 'chart-label' + (i === todayIdx ? ' today' : '');
    label.textContent = labels[i];

    bar.appendChild(value);
    col.append(bar, label);
    chart.appendChild(col);
  });

  const weekSecs = week.reduce((a, d) => a + d.total, 0);
  $('weekTotalChip').textContent = `Total: ${fmtHM(weekSecs)}`;

  // Por matéria
  const box = $('subjectStats');
  box.innerHTML = '';
  const perSubject = new Map();
  state.sessions.forEach(s => {
    const cur = perSubject.get(s.subject) || { secs: 0, count: 0 };
    cur.secs += s.duration;
    cur.count++;
    perSubject.set(s.subject, cur);
  });

  if (perSubject.size === 0) {
    box.appendChild(emptyRow('Sem dados ainda.'));
  } else {
    const sorted = [...perSubject.entries()].sort((a, b) => b[1].secs - a[1].secs);
    const maxSub = sorted[0][1].secs;
    sorted.forEach(([name, data]) => {
      const row = document.createElement('div');
      row.className = 'subject-row';

      const head = document.createElement('div');
      head.className = 'subject-row-head';
      const nameEl = document.createElement('strong');
      nameEl.textContent = name;
      const valEl = document.createElement('span');
      valEl.textContent = `${fmtHM(data.secs)} · ${data.count}x`;
      head.append(nameEl, valEl);

      const track = document.createElement('div');
      track.className = 'bar-track';
      const fill = document.createElement('div');
      fill.className = 'bar-fill';
      fill.style.width = `${Math.max((data.secs / maxSub) * 100, 3)}%`;
      track.appendChild(fill);

      row.append(head, track);
      box.appendChild(row);
    });
  }

  // Resumo geral
  const summary = $('summaryList');
  summary.innerHTML = '';
  const allSecs = state.sessions.reduce((a, s) => a + s.duration, 0);
  const allQ = state.sessions.reduce((a, s) => a + s.qTotal, 0);
  const allR = state.sessions.reduce((a, s) => a + s.qRight, 0);

  const bestDayMap = new Map();
  state.sessions.forEach(s => {
    bestDayMap.set(dateKey(new Date(s.dateISO)), (bestDayMap.get(dateKey(new Date(s.dateISO))) || 0) + s.duration);
  });
  const best = [...bestDayMap.entries()].sort((a, b) => b[1] - a[1])[0];

  const rows = [
    ['Tempo total', fmtHM(allSecs)],
    ['Sessões registradas', String(state.sessions.length)],
    ['Melhor dia', best ? `${dayLabel(best[0])} (${fmtHM(best[1])})` : '—'],
    ['Questões respondidas', String(allQ)],
    ['Aproveitamento geral', allQ > 0 ? `${Math.round((allR / allQ) * 100)}%` : '—']
  ];

  rows.forEach(([k, v]) => {
    const li = document.createElement('li');
    const kEl = document.createElement('span');
    kEl.className = 'k';
    kEl.textContent = k;
    const vEl = document.createElement('span');
    vEl.className = 'v';
    vEl.textContent = v;
    li.append(kEl, vEl);
    summary.appendChild(li);
  });
}

function renderStatsAndFeed() {
  renderMetrics();
  renderStats();
  renderFeed();
}

/* ================= Modal ================= */
const modal = $('saveModal');
let timerWasRunning = false;

function openModal() {
  timerWasRunning = timer.running; // guarda ANTES de pausar
  pauseTimer(); // congela o tempo acumulado (sem drift)
  $('modalDuration').textContent = fmtHMS(timer.accumulated);
  populateSubjects();
  modal.classList.add('active');
  setTimeout(() => $('newSubjectInput').focus(), 50);
}

function closeModal() {
  modal.classList.remove('active');
  clearModalForm(false);
  if (timerWasRunning) {
    startTimer(); // retoma de onde parou
  } else {
    syncTimerUI();
  }
}

modal.addEventListener('click', e => {
  if (e.target === modal) closeModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (modal.classList.contains('active')) closeModal();
    $('userMenu').hidden = true;
  }
});

function populateSubjects() {
  const sel = $('subjectSelect');
  sel.innerHTML = '<option value="">Selecione...</option>';
  Object.keys(state.subjects).sort((a, b) => a.localeCompare(b, 'pt-BR')).forEach(sub => {
    const opt = document.createElement('option');
    opt.value = sub;
    opt.textContent = sub;
    sel.appendChild(opt);
  });
}

$('subjectSelect').addEventListener('change', e => {
  const selected = e.target.value;
  const sel = $('topicSelect');
  sel.innerHTML = '<option value="">Selecione...</option>';
  (state.subjects[selected] || []).slice().sort((a, b) => a.localeCompare(b, 'pt-BR')).forEach(top => {
    const opt = document.createElement('option');
    opt.value = top;
    opt.textContent = top;
    sel.appendChild(opt);
  });
});

$('toggleQuestions').addEventListener('change', e => {
  $('questionsBox').hidden = !e.target.checked;
});

function updateRightCount() {
  const total = parseInt($('qTotal').value, 10) || 0;
  const wrong = parseInt($('qWrong').value, 10) || 0;
  $('qRight').value = Math.max(0, total - wrong);
}
$('qTotal').addEventListener('input', updateRightCount);
$('qWrong').addEventListener('input', updateRightCount);

function showQError(msg) {
  const err = $('qError');
  err.textContent = msg;
  err.hidden = !msg;
}

function clearModalForm(clearFields = true) {
  showQError('');
  if (!clearFields) return;
  $('newSubjectInput').value = '';
  $('newTopicInput').value = '';
  $('obsInput').value = '';
  $('subjectSelect').value = '';
  $('topicSelect').innerHTML = '<option value="">Selecione...</option>';
  $('toggleQuestions').checked = false;
  $('questionsBox').hidden = true;
  $('qTotal').value = '';
  $('qWrong').value = '';
  $('qRight').value = '0';
}

$('cancelModalBtn').addEventListener('click', closeModal);
function confirmSaveSession(session) {
  state.sessions.unshift(session);
  saveState();
  pushSession(session);
  pushSubjects([session.subject]);
  resetTimer();
  clearModalForm();
  modal.classList.remove('active');
  renderAll();
  toast(`Sessão salva: ${fmtHM(session.duration)} de ${session.subject}.`, 'success');
}

$('confirmSaveBtn').addEventListener('click', () => {
  const subject = $('newSubjectInput').value.trim() || $('subjectSelect').value;
  const topic = $('newTopicInput').value.trim() || $('topicSelect').value;

  if (!subject) {
    toast('Selecione ou crie uma matéria.', 'error');
    $('newSubjectInput').focus();
    return;
  }

  const useQuestions = $('toggleQuestions').checked;
  const qTotalV = useQuestions ? parseInt($('qTotal').value, 10) || 0 : 0;
  const qWrongV = useQuestions ? parseInt($('qWrong').value, 10) || 0 : 0;

  if (useQuestions && qTotalV === 0) {
    showQError('Informe o total de questões.');
    $('qTotal').focus();
    return;
  }
  if (useQuestions && qWrongV > qTotalV) {
    showQError('Erradas não pode ser maior que o total.');
    $('qWrong').focus();
    return;
  }

  if (!state.subjects[subject]) state.subjects[subject] = [];
  if (topic && !state.subjects[subject].includes(topic)) state.subjects[subject].push(topic);

  const duration = Math.max(timer.accumulated, 1);
  const session = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    dateISO: new Date(Date.now() - duration * 1000).toISOString(),
    duration,
    subject,
    topic: topic || 'Geral',
    obs: $('obsInput').value.trim(),
    qTotal: qTotalV,
    qRight: Math.max(0, qTotalV - qWrongV)
  };

  confirmSaveSession(session);
});

/* ================= Autenticação ================= */
function goToLogin() {
  window.location.href = 'login.html';
}
function goToApp() {
  window.location.href = 'index.html';
}

$('avatarBtn').addEventListener('click', e => {
  e.stopPropagation();
  if (!sb.user && isCloudConfigured()) { goToLogin(); return; }
  if (!sb.user) {
    toast('Configure o Supabase em config.js para sincronizar.', 'error');
    return;
  }
  const menu = $('userMenu');
  menu.hidden = !menu.hidden;
  $('avatarBtn').setAttribute('aria-expanded', String(!menu.hidden));
});

$('footName').addEventListener('click', () => {
  if (!sb.user && isCloudConfigured()) goToLogin();
});

document.addEventListener('click', e => {
  if (!$('userMenu').hidden && !e.target.closest('.avatar-wrap')) {
    $('userMenu').hidden = true;
    $('avatarBtn').setAttribute('aria-expanded', 'false');
  }
});

/* ================= Atalhos de teclado ================= */
document.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (typing || modal.classList.contains('active')) return;

  if (e.code === 'Space') {
    e.preventDefault();
    timer.running ? pauseTimer() : startTimer();
  }
});

/* ================= Aparência: tema claro/escuro + paleta ================= */
const PALETTES = {
  amber:  { label: 'Âmbar', accent: '#f0a63c', hover: '#db8f22', glow: 'rgba(240, 166, 60, 0.22)' },
  laranja:{ label: 'Laranja', accent: '#fb923c', hover: '#f97316', glow: 'rgba(251, 146, 60, 0.22)' },
  amarelo:{ label: 'Amarelo', accent: '#facc15', hover: '#eab308', glow: 'rgba(250, 204, 21, 0.22)' },
  limao:  { label: 'Limão', accent: '#a3e635', hover: '#84cc16', glow: 'rgba(163, 230, 53, 0.22)' },
  verde:  { label: 'Verde', accent: '#34d399', hover: '#10b981', glow: 'rgba(52, 211, 153, 0.22)' },
  teal:   { label: 'Verde-azulado', accent: '#2dd4bf', hover: '#14b8a6', glow: 'rgba(45, 212, 191, 0.22)' },
  ciano:  { label: 'Ciano', accent: '#22d3ee', hover: '#06b6d4', glow: 'rgba(34, 211, 238, 0.22)' },
  azul:   { label: 'Azul', accent: '#60a5fa', hover: '#3b82f6', glow: 'rgba(96, 165, 250, 0.22)' },
  indigo: { label: 'Índigo', accent: '#818cf8', hover: '#6366f1', glow: 'rgba(129, 140, 248, 0.22)' },
  roxo:   { label: 'Roxo', accent: '#a78bfa', hover: '#8b5cf6', glow: 'rgba(167, 139, 250, 0.22)' },
  magenta:{ label: 'Magenta', accent: '#e879f9', hover: '#d946ef', glow: 'rgba(232, 121, 249, 0.22)' },
  rosa:   { label: 'Rosa', accent: '#fb7185', hover: '#f43f5e', glow: 'rgba(251, 113, 133, 0.22)' },
  vermelho:{ label: 'Vermelho', accent: '#f87171', hover: '#ef4444', glow: 'rgba(248, 113, 113, 0.22)' },
  marrom: { label: 'Marrom', accent: '#d6a15c', hover: '#b4833f', glow: 'rgba(214, 161, 92, 0.22)' },
  grafite:{ label: 'Grafite', accent: '#94a3b8', hover: '#64748b', glow: 'rgba(148, 163, 184, 0.22)' }
};

function applyTheme(theme, persist = true) {
  document.body.classList.toggle('light', theme === 'light');
  if (persist) localStorage.setItem(THEME_KEY, theme);
  document.querySelectorAll('#themeSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.theme === theme));
}

function applyAccent(name, persist = true) {
  const p = PALETTES[name] || PALETTES.amber;
  const root = document.documentElement.style;
  root.setProperty('--accent-color', p.accent);
  root.setProperty('--accent-hover', p.hover);
  root.setProperty('--accent-glow', p.glow);
  if (persist) localStorage.setItem(ACCENT_KEY, name);
  document.querySelectorAll('.swatch').forEach(sw =>
    sw.classList.toggle('active', sw.dataset.palette === name));
}

function loadGoal() {
  try {
    const mins = parseInt(localStorage.getItem(GOAL_KEY), 10);
    if (Number.isFinite(mins) && mins >= 5 && mins <= 720) dailyGoalSecs = mins * 60;
  } catch { /* ignora */ }
}

function loadAppearance() {
  let theme = 'dark';
  try { theme = localStorage.getItem(THEME_KEY) || 'dark'; } catch { /* ignora */ }
  applyTheme(theme, false);
  let pal = 'amber';
  try { pal = localStorage.getItem(ACCENT_KEY) || 'amber'; } catch { /* ignora */ }
  applyAccent(pal, false);
}

/* ================= Perfil ================= */
let profile = { displayName: '', username: '', avatarUrl: '', usernameUpdatedAt: null, bio: '' };
let pendingPhotoBlob = null;

function profileStoreKey() {
  return sb.user ? `${PROFILE_KEY}.u.${sb.user.id}` : PROFILE_KEY;
}

function loadProfile() {
  profile = { displayName: '', username: '', avatarUrl: '', usernameUpdatedAt: null, bio: '' };
  try {
    const raw = localStorage.getItem(profileStoreKey());
    if (raw) profile = { ...profile, ...JSON.parse(raw) };
  } catch { /* ignora */ }
  resetProfileForm();
}

function applyProfilePhoto(src) {
  const img = $('profilePhoto');
  const empty = $('profileAvatarEmpty');
  img.hidden = !src;
  empty.hidden = !!src;
  if (src) img.src = src;
}

function syncProfilePreview() {
  const nameEl = $('profileSummaryName');
  const subEl = $('profileSummarySub');
  nameEl.textContent = profile.displayName || (profile.username ? `@${profile.username}` : 'Seu nome');
  if (subEl) subEl.textContent = profile.username ? `@${profile.username}` : '';
}

function resetProfileForm() {
  $('profileNameInput').value = profile.displayName || '';
  $('profileUsernameInput').value = profile.username || '';
  $('profileBioInput').value = profile.bio || '';
  const bc = $('bioCount');
  if (bc) bc.textContent = String((profile.bio || '').length);
  $('usernameError').hidden = true;
  pendingPhotoBlob = null;
  applyProfilePhoto(profile.avatarUrl);
  updateProfileButtons();
  syncProfileUI();
  syncProfilePreview();
  const hintEl = $('usernameCooldownHint');
  if (hintEl && profile.username && profile.usernameUpdatedAt) {
    const cooldownMs = 14 * 24 * 60 * 60 * 1000;
    const remaining = new Date(profile.usernameUpdatedAt).getTime() + cooldownMs - Date.now();
    if (remaining > 0) {
      const days = Math.ceil(remaining / (24 * 60 * 60 * 1000));
      hintEl.textContent = `O @username poderá ser alterado novamente em ${days} dia(s).`;
      hintEl.hidden = false;
    } else {
      hintEl.hidden = true;
    }
  }
}

function syncProfileUI() {
  const img = $('avatarPhoto');
  const initials = $('avatarInitials');
  const logged = !!sb.user;
  const hasPhoto = logged && !!profile.avatarUrl;
  if (hasPhoto) img.src = profile.avatarUrl;
  img.hidden = !hasPhoto;
  initials.hidden = hasPhoto;

  const nameEl = $('footName');
  if (logged) {
    const label = profile.displayName || (profile.username ? `@${profile.username}` : '');
    nameEl.textContent = label;
    nameEl.hidden = !label;
  } else {
    nameEl.textContent = 'Fazer login';
    nameEl.hidden = false;
  }

  syncShopButtons();
  applyBorderTo($('avatarBtn'), sb.user ? equippedBorder : null);
  applyBorderTo($('profileAvatarLabel'), sb.user ? equippedBorder : null);
}

function renderProfileBorders() {
  const section = $('profileBorderSection');
  const grid = $('profileBorderGrid');
  if (!section || !grid) return;
  if (!sb.user) { section.hidden = true; return; }
  const owned = shopItems.filter(i => ownedItems.has(i.id));
  section.hidden = false;
  $('profileBorderEmpty').hidden = owned.length > 0;
  grid.innerHTML = '';
  owned.forEach(item => {
    const isEquipped = equippedBorder === item.id;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'profile-border-opt' + (isEquipped ? ' active' : '');
    el.title = isEquipped ? 'Em uso — clique para remover' : 'Clique para equipar';
    el.innerHTML = `
      <span class="profile-border-avatar">${shopPreviewAvatar()}</span>
      <span class="profile-border-name">${escapeHtml(borderName(item))}</span>
      ${isEquipped ? '<i class="ti ti-check profile-border-check"></i>' : ''}
    `;
    applyBorderTo(el.querySelector('.profile-border-avatar'), item.id);
    el.addEventListener('click', () => {
      if (equippedBorder === item.id) unequipItem(item.id);
      else equipItem(item.id);
    });
    grid.appendChild(el);
  });
}

function syncShopButtons() {
  const show = isShopAllowed();
  const nav = $('shopNavBtn');
  const tab = $('shopTabBtn');
  if (nav) nav.hidden = !show;
  if (tab) tab.hidden = !show;
  if (!show && currentView === 'shop') switchView('study');
}

function borderCss(itemId) {
  if (!itemId) return '';
  const color = BORDER_COLORS[itemId];
  if (!color || color === 'rgb') return '';
  return `box-shadow: 0 0 0 3px var(--bg-color), 0 0 0 6px ${color}, 0 0 14px ${color};`;
}

function applyBorderTo(el, itemId) {
  if (!el) return;
  if (itemId && ANIMATED.has(itemId)) {
    el.classList.add('border-anim');
    el.removeAttribute('style');
    return;
  }
  el.classList.remove('border-anim');
  const inline = borderCss(itemId);
  if (inline) el.setAttribute('style', inline);
  else el.removeAttribute('style');
}

function saveProfile() {
  localStorage.setItem(profileStoreKey(), JSON.stringify(profile));
}

function uploadAvatar(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = 400;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(size / img.width, size / img.height);
        ctx.drawImage(img, (size - img.width * scale) / 2, (size - img.height * scale) / 2,
          img.width * scale, img.height * scale);
        // WebP comprime melhor o storage; cai pra JPEG se o navegador não suportar
        const exportAs = document.createElement('canvas').toDataURL('image/webp').startsWith('data:image/webp')
          ? 'image/webp'
          : 'image/jpeg';
        canvas.toBlob(blob => resolve(blob), exportAs, 0.85);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function pushAvatarToStorage(blob) {
  if (!sb.client || !sb.user || !blob) return profile.avatarUrl;
  const isWebp = blob.type === 'image/webp';
  const ext = isWebp ? 'webp' : 'jpg';
  const path = `${sb.user.id}/avatar.${ext}`;
  try {
    const { error: delErr } = await sb.client.storage.from('avatars').remove([path]);
    if (delErr) console.warn('Avatar remove old:', delErr);
    const { error: upErr } = await sb.client.storage.from('avatars').upload(path, blob, {
      contentType: isWebp ? 'image/webp' : 'image/jpeg', upsert: true
    });
    if (upErr) throw upErr;
    const { data } = sb.client.storage.from('avatars').getPublicUrl(path);
    return data.publicUrl + '?t=' + Date.now();
  } catch (e) {
    console.error('pushAvatar:', e);
    return profile.avatarUrl;
  }
}

async function pushProfile() {
  if (!sb.client || !sb.user) return;
  try {
    await sb.client.from('profiles').upsert({
      user_id: sb.user.id,
      username: profile.username || null,
      username_updated_at: profile.usernameUpdatedAt || null,
      display_name: profile.displayName || '',
      avatar_url: profile.avatarUrl || '',
      bio: profile.bio || '',
      updated_at: new Date().toISOString()
    });
  } catch (e) { console.error('pushProfile:', e); }
}

async function pullProfile() {
  if (!sb.client || !sb.user) return;
  try {
    const { data, error } = await sb.client.from('profiles').select('*').eq('user_id', sb.user.id).maybeSingle();
    if (error) throw error;
    if (data) {
      profile = {
        displayName: data.display_name || '',
        username: data.username || '',
        avatarUrl: data.avatar_url || '',
        usernameUpdatedAt: data.username_updated_at || null,
        bio: data.bio || ''
      };
      localStorage.setItem(profileStoreKey(), JSON.stringify(profile));
      resetProfileForm();
    } else {
      console.log('[profile] No profile found, creating for', sb.user.id);
      const handle = (sb.user.email || '').split('@')[0].split(/[._-]/)[0];
      const display = sb.user.user_metadata?.full_name || sb.user.user_metadata?.name || handle || '';
      const { error: upErr } = await sb.client.from('profiles').upsert({
        user_id: sb.user.id,
        username: null,
        display_name: display,
        avatar_url: '',
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });
      if (upErr) console.error('[profile] upsert error:', upErr);
      else console.log('[profile] Created profile for', sb.user.email);
      profile.displayName = display;
      profile.username = '';
      profile.avatarUrl = '';
      localStorage.setItem(profileStoreKey(), JSON.stringify(profile));
      resetProfileForm();
    }
  } catch (e) { console.error('pullProfile:', e); }
}

async function checkUsernameAvailable(username) {
  if (!sb.client || !username) return true;
  try {
    const { data, error } = await sb.client.from('profiles')
      .select('user_id').eq('username', username).maybeSingle();
    if (error) throw error;
    return !data || data.user_id === sb.user?.id;
  } catch { return true; }
}

function updateProfileButtons() {
  const nameDirty = ($('profileNameInput').value.trim() || '') !== (profile.displayName || '');
  const userDirty = ($('profileUsernameInput').value.trim() || '') !== (profile.username || '');
  const bioDirty = ($('profileBioInput').value || '') !== (profile.bio || '');
  const dirty = pendingPhotoBlob !== null || nameDirty || userDirty || bioDirty;
  $('profileUndoBtn').disabled = !dirty;
  $('profileSaveBtn').disabled = !dirty;
}

$('profileNameInput').addEventListener('input', updateProfileButtons);
$('profileUsernameInput').addEventListener('input', updateProfileButtons);
$('profileBioInput').addEventListener('input', () => {
  const v = $('profileBioInput').value;
  if (v.length > 150) $('profileBioInput').value = v.slice(0, 150);
  const bc = $('bioCount');
  if (bc) bc.textContent = String($('profileBioInput').value.length);
  updateProfileButtons();
});

$('profileSaveBtn').addEventListener('click', async () => {
  const newName = $('profileNameInput').value.trim();
  let newUsername = $('profileUsernameInput').value.trim().toLowerCase();
  if (newUsername.startsWith('@')) newUsername = newUsername.slice(1);

  function showUsernameError(msg) {
    const el = $('usernameError');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => { el.hidden = true; }, 10000);
  }

  if (newUsername && !/^[a-zA-Z0-9_.-]+$/.test(newUsername)) {
    showUsernameError('Apenas letras, números, _ . - (sem @)');
    return;
  }
  if (newUsername && newUsername.length < 2) {
    showUsernameError('Mínimo de 2 caracteres.');
    return;
  }
  if (newUsername) {
    const avail = await checkUsernameAvailable(newUsername);
    if (!avail) {
      showUsernameError('Esse @username já está em uso.');
      return;
    }
  }

  const usernameChanged = newUsername !== (profile.username || '');
  if (usernameChanged && profile.username) {
    const cooldownMs = 14 * 24 * 60 * 60 * 1000;
    const lastChange = profile.usernameUpdatedAt ? new Date(profile.usernameUpdatedAt).getTime() : 0;
    const remaining = lastChange + cooldownMs - Date.now();
    if (remaining > 0) {
      const days = Math.ceil(remaining / (24 * 60 * 60 * 1000));
      showUsernameError(`Você pode trocar o @username novamente em ${days} dia(s).`);
      return;
    }
  }

  const btn = $('profileSaveBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader"></i> Salvando...';

  if (pendingPhotoBlob) {
    profile.avatarUrl = await pushAvatarToStorage(pendingPhotoBlob);
  }

  profile.displayName = newName;
  profile.bio = $('profileBioInput').value || '';
  if (usernameChanged) {
    profile.username = newUsername;
    profile.usernameUpdatedAt = new Date().toISOString();
  }
  saveProfile();
  await pushProfile();

  pendingPhotoBlob = null;
  $('usernameError').hidden = true;
  btn.innerHTML = '<i class="ti ti-device-floppy"></i> Salvar';
  updateProfileButtons();
  syncProfileUI();
  syncProfilePreview();
  $('profileEditSection').hidden = true;
  $('profileEditToggle').classList.remove('open');
  $('profileEditToggle').innerHTML = '<i class="ti ti-pencil"></i> Editar perfil';
  toast('Perfil salvo.', 'success');
});

$('profileUndoBtn').addEventListener('click', resetProfileForm);

$('profileEditToggle').addEventListener('click', () => {
  const section = $('profileEditSection');
  const isOpen = !section.hidden;
  section.hidden = isOpen;
  $('profileEditToggle').classList.toggle('open', !isOpen);
  if (isOpen) {
    $('profileEditToggle').innerHTML = '<i class="ti ti-pencil"></i> Editar perfil';
  } else {
    $('profileEditToggle').innerHTML = '<i class="ti ti-x"></i> Cancelar';
    resetProfileForm();
  }
});

$('profilePhotoInput').addEventListener('change', async e => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !file.type.startsWith('image/')) return;

  pendingPhotoBlob = file;
  const url = URL.createObjectURL(file);
  applyProfilePhoto(url);
  updateProfileButtons();
});

/* ================= Amigos ================= */
let friendsCache = [];
let friendsRequests = [];

function fmtFriendDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function friendLabel(p) {
  return p.display_name || (p.username ? `@${p.username}` : 'Usuário');
}

function friendSub(p) {
  return p.username ? `@${p.username}` : '';
}

async function loadFriends() {
  if (!sb.client || !sb.user) return;
  try {
    const { data: linkRows, error } = await sb.client
      .from('friendships')
      .select('user_a, user_b')
      .or(`user_a.eq.${sb.user.id},user_b.eq.${sb.user.id}`);
    if (error) throw error;

    const friendIds = (linkRows || []).map(r =>
      r.user_a === sb.user.id ? r.user_b : r.user_a);

    friendsCache = [];
    if (friendIds.length > 0) {
      const { data: profs, error: pErr } = await sb.client
        .from('profiles')
        .select('user_id, username, display_name, avatar_url, bio, border_id')
        .in('user_id', friendIds);
      if (pErr) throw pErr;
      friendsCache = (profs || []).map(p => ({ ...p, user_id: p.user_id }));
    }
  } catch (e) {
    console.error('loadFriends:', e);
    friendsCache = [];
  }
  renderFriends();
  await loadPendingRequests();
}

async function fetchPendingRequests() {
  try {
    const { data: reqs, error: rErr } = await sb.client
      .from('friend_requests')
      .select('*')
      .eq('to_user', sb.user.id)
      .eq('status', 'pending');
    if (rErr) throw rErr;
    const fromIds = (reqs || []).map(r => r.from_user);
    let fromProfs = {};
    if (fromIds.length > 0) {
      const { data } = await sb.client.from('profiles')
        .select('user_id, username, display_name, avatar_url, bio, border_id')
        .in('user_id', fromIds);
      (data || []).forEach(p => { fromProfs[p.user_id] = p; });
    }
    friendsRequests = (reqs || []).map(r => ({ ...r, profile: fromProfs[r.from_user] }));
  } catch (e) {
    console.error('fetchPendingRequests:', e);
    friendsRequests = [];
  }
}

/* ================= LOJA ================= */
async function grantCrystalsOnce() {
  if (!sb.client || !sb.user) return;
  try { await sb.client.rpc('grant_starting_crystals'); } catch (e) { console.error('grantCrystalsOnce:', e); }
}

async function loadShopCatalog() {
  if (!sb.client || !sb.user) return;
  try {
    const { data: items, error } = await sb.client
      .from('shop_items')
      .select('id, name, category, cost, color')
      .order('sort_order');
    if (error) throw error;
    shopItems = (items || []).filter(i => i.category === 'border');
    shopItems.forEach(i => {
      BORDER_COLORS[i.id] = i.color;
      if (i.color === 'rgb') ANIMATED.add(i.id);
    });
  } catch (e) { console.error('loadShopCatalog:', e); }
}

function applyShopState(data) {
  shopItems = (data.catalog || []).filter(i => i.category === 'border');
  shopItems.forEach(i => {
    BORDER_COLORS[i.id] = i.color;
    if (i.color === 'rgb') ANIMATED.add(i.id);
  });
  crystals = data.crystals ?? 0;
  ownedItems = new Set(data.owned || []);
  equippedBorder = data.border ?? null;
}

async function loadShop() {
  if (!sb.client || !sb.user) return;
  try {
    const { data, error } = await sb.client.rpc('get_shop_state');
    if (error) throw error;
    applyShopState(data);
    return;
  } catch (e) {
    console.warn('loadShop: get_shop_state falhou, usando fallback:', e.message);
  }
  try {
    await grantCrystalsOnce();
    await loadShopCatalog();
    const [{ data: bal }, { data: owned }, { data: me }] = await Promise.all([
      sb.client.from('user_crystals').select('total_crystals').eq('user_id', sb.user.id).maybeSingle(),
      sb.client.from('user_items').select('item_id').eq('user_id', sb.user.id),
      sb.client.from('profiles').select('border_id').eq('user_id', sb.user.id).maybeSingle()
    ]);
    crystals = bal?.total_crystals ?? 0;
    ownedItems = new Set((owned || []).map(o => o.item_id));
    equippedBorder = me?.border_id ?? null;
  } catch (e2) { console.error('loadShop fallback:', e2); }
}

function shopPreviewAvatar() {
  if (profile.avatarUrl) {
    return `<img class="shop-preview-photo" src="${escapeHtml(profile.avatarUrl)}" alt="">`;
  }
  return `<span>${escapeHtml((profile.displayName || '?').slice(0, 1).toUpperCase())}</span>`;
}

function borderName(item) {
  return (item.name || '').replace(/^Borda\s+/i, '');
}

function renderShop() {
  $('shopCrystalsChip').textContent = `💎 ${crystals}`;
  renderShopGrid('shopGrid', shopItems);
}

function renderShopGrid(gridId, items) {
  const grid = $(gridId);
  if (!grid) return;
  grid.innerHTML = '';
  items.forEach(item => {
    const owned = ownedItems.has(item.id);
    const isEquipped = equippedBorder === item.id;
    const el = document.createElement('div');
    el.className = 'shop-item' + (isEquipped ? ' equipped' : '');
    let right;
    if (!owned) {
      right = `<button class="btn btn-sm btn-primary" data-act="buy" data-id="${item.id}">💎 ${item.cost}</button>`;
    } else {
      right = `<span class="shop-check" title="Comprada"><i class="ti ti-circle-check-filled"></i></span>`;
    }
    el.innerHTML = `
      <div class="shop-avatar">${shopPreviewAvatar()}</div>
      <div class="shop-item-info">
        <span class="shop-item-name">${escapeHtml(borderName(item))}</span>
        <span class="shop-item-cost">${owned ? (isEquipped ? 'Em uso' : 'Comprada') : ''}</span>
      </div>
      ${right}
    `;
    applyBorderTo(el.querySelector('.shop-avatar'), item.id);
    grid.appendChild(el);
  });
  grid.querySelectorAll('button[data-act]').forEach(btn =>
    btn.addEventListener('click', () => {
      buyItem(Number(btn.dataset.id));
    })
  );
}

async function openShop() {
  if (!sb.client || !sb.user) { switchView('study'); return; }
  const loading = $('shopLoading');
  if (loading) loading.hidden = false;
  await loadShop();
  renderShop();
  if (loading) loading.hidden = true;
  applyBorderTo($('avatarBtn'), equippedBorder);
}

async function buyItem(itemId) {
  if (!sb.client || !sb.user) return;
  const it = shopItems.find(s => s.id === itemId);
  const name = it ? borderName(it) : 'este item';
  const cost = it ? ` por ${it.cost}💎` : '';
  const ok = await confirmDialog({
    title: 'Confirmar compra',
    text: `Você tem certeza de que quer comprar "${name}"${cost}?`,
    okText: 'Comprar',
    okClass: 'btn-primary'
  });
  if (!ok) return;
  try {
    const { data, error } = await sb.client.rpc('buy_item', { p_item_id: itemId });
    if (error) throw error;
    await loadShop();
    renderShop();
    applyBorderTo($('avatarBtn'), equippedBorder);
    toast('Borda comprada! Agora equipe para usar.', 'success');
  } catch (e) {
    console.error('buyItem:', e);
    toast(e.message === 'cristais insuficientes' ? 'Cristais insuficientes.' : 'Não foi possível comprar.', 'error');
  }
}

async function equipItem(itemId) {
  if (!sb.client || !sb.user) return;
  try {
    const { error } = await sb.client.rpc('equip_border', { p_item_id: itemId });
    if (error) throw error;
    equippedBorder = itemId;
    await loadShop();
    if (currentView === 'shop') renderShop();
    applyBorderTo($('avatarBtn'), equippedBorder);
    applyBorderTo($('profileAvatarLabel'), equippedBorder);
    renderProfileBorders();
    syncProfileUI();
    toast('Borda equipada!', 'success');
  } catch (e) { console.error('equipItem:', e); toast('Não foi possível equipar.', 'error'); }
}

async function unequipItem(itemId) {
  if (!sb.client || !sb.user) return;
  try {
    const { error } = await sb.client.rpc('unequip_border');
    if (error) throw error;
    equippedBorder = null;
    await loadShop();
    if (currentView === 'shop') renderShop();
    applyBorderTo($('avatarBtn'), null);
    applyBorderTo($('profileAvatarLabel'), null);
    renderProfileBorders();
    syncProfileUI();
  } catch (e) { console.error('unequipItem:', e); }
}

function renderFriends() {
  const list = $('friendsList');
  const empty = $('friendsEmpty');
  const count = $('friendsCountChip');
  list.innerHTML = '';
  empty.hidden = friendsCache.length > 0;
  count.textContent = String(friendsCache.length);
  friendsCache.forEach(f => {
    const el = document.createElement('div');
    el.className = 'friend-row';
    el.innerHTML = `
      <div class="friend-avatar">${f.avatar_url
        ? `<img src="${escapeHtml(f.avatar_url)}" alt="" onerror="this.remove()">`
        : (f.display_name ? f.display_name.slice(0,1).toUpperCase() : '?')}</div>
      <div class="friend-info">
        <span class="friend-name">${escapeHtml(friendLabel(f))}</span>
        <span class="friend-user">${escapeHtml(friendSub(f)) || 'sem @username'}</span>
      </div>
      <button class="btn btn-sm friend-view" data-id="${f.user_id}" title="Ver perfil">
        <i class="ti ti-search"></i>
      </button>
      <button class="btn btn-sm btn-danger friend-remove" data-id="${f.user_id}" title="Desfazer amizade">
        <i class="ti ti-user-x"></i>
      </button>
    `;
    applyBorderTo(el.querySelector('.friend-avatar'), f.border_id);
    list.appendChild(el);
  });
  list.querySelectorAll('.friend-view').forEach(btn =>
    btn.addEventListener('click', () => openProfileModal(btn.dataset.id))
  );
  list.querySelectorAll('.friend-remove').forEach(btn =>
    btn.addEventListener('click', () => removeFriend(btn.dataset.id))
  );
}

function updateFriendsBadges() {
  const n = friendsRequests.length;
  const navBadge = $('friendsNavBadge');
  const tabBadge = $('friendsTabBadge');
  if (navBadge) { navBadge.hidden = n === 0; navBadge.textContent = n > 99 ? '99+' : String(n); }
  if (tabBadge) { tabBadge.hidden = n === 0; tabBadge.textContent = n > 99 ? '99+' : String(n); }
}

async function loadPendingRequests() {
  if (!sb.client || !sb.user) return;
  await fetchPendingRequests();
  updateFriendsBadges();
  renderRequests();
}

function renderRequests() {
  const list = $('requestsList');
  const empty = $('requestsEmpty');
  const count = $('requestsCountChip');
  list.innerHTML = '';
  empty.hidden = friendsRequests.length > 0;
  count.hidden = friendsRequests.length === 0;
  count.textContent = String(friendsRequests.length);
  updateFriendsBadges();
  friendsRequests.forEach(r => {
    const p = r.profile || {};
    const el = document.createElement('div');
    el.className = 'friend-row';
    el.innerHTML = `
      <div class="friend-avatar">${p.avatar_url
        ? `<img src="${escapeHtml(p.avatar_url)}" alt="" onerror="this.remove()">`
        : (p.display_name ? p.display_name.slice(0,1).toUpperCase() : '?')}</div>
      <div class="friend-info">
        <span class="friend-name">${escapeHtml(friendLabel(p))}</span>
        <span class="friend-user">${escapeHtml(friendSub(p)) || 'sem @username'}</span>
      </div>
      <div class="friend-actions">
        <button class="btn btn-sm btn-success request-accept" data-id="${r.id}"><i class="ti ti-check"></i></button>
        <button class="btn btn-sm btn-danger request-reject" data-id="${r.id}"><i class="ti ti-x"></i></button>
      </div>
    `;
    applyBorderTo(el.querySelector('.friend-avatar'), p.border_id);
    list.appendChild(el);
  });
  list.querySelectorAll('.request-accept').forEach(btn =>
    btn.addEventListener('click', () => acceptRequest(btn.dataset.id))
  );
  list.querySelectorAll('.request-reject').forEach(btn =>
    btn.addEventListener('click', () => rejectRequest(btn.dataset.id))
  );
}

async function acceptRequest(id) {
  if (!sb.client) return;
  try {
    const { error } = await sb.client.rpc('accept_friend', { request_id: id });
    if (error) throw error;
    toast('Amizade aceita!', 'success');
    loadFriends();
  } catch (e) {
    toast(e.message || 'Erro ao aceitar.', 'error');
  }
}

async function rejectRequest(id) {
  if (!sb.client) return;
  try {
    const { error } = await sb.client.from('friend_requests')
      .update({ status: 'rejected' }).eq('id', id);
    if (error) throw error;
    loadFriends();
  } catch (e) {
    toast(e.message || 'Erro ao recusar.', 'error');
  }
}

function closeProfileModal() {
  $('profileModal').classList.remove('active');
}

async function loadFriendStats(friendId) {
  if (!sb.client || !sb.user) return null;
  try {
    const { data, error } = await sb.client.rpc('get_friend_stats', { friend_id: friendId });
    if (error) throw error;
    return (data && data[0]) || null;
  } catch (e) {
    console.error('loadFriendStats:', e);
    return null;
  }
}

async function openProfileModal(friendId) {
  const f = friendsCache.find(x => x.user_id === friendId) || {};
  const name = f.display_name || ('@' + (f.username || ''));
  const user = f.username ? '@' + f.username : '';
  $('profileViewName').textContent = name || 'Usuário';
  $('profileViewUser').textContent = user;
  const av = $('profileViewAvatar');
  av.innerHTML = f.avatar_url
    ? `<img src="${escapeHtml(f.avatar_url)}" alt="" onerror="this.remove()">`
    : ((f.display_name || '?').slice(0, 1).toUpperCase());
  applyBorderTo(av, f.border_id);
  const bioEl = $('profileViewBio');
  bioEl.textContent = f.bio || '';
  bioEl.hidden = !f.bio;

  const statsEl = $('profileViewStats');
  statsEl.hidden = true;
  const divEl = $('profileViewDivider');
  divEl.hidden = true;
  $('profileModal').classList.add('active');

  const s = await loadFriendStats(friendId);
  if (s) {
    $('pvPoints').textContent = String(s.total_points ?? 0);
    $('pvStreak').textContent = String(s.streak ?? 0);
    $('pvWeek').textContent = fmtHM(s.week_seconds ?? 0);
    $('pvSessions').textContent = String(s.total_sessions ?? 0);
    statsEl.hidden = false;
    divEl.hidden = false;
  }
}

$('profileViewCloseBtn').addEventListener('click', closeProfileModal);
$('profileModal').addEventListener('click', e => {
  if (e.target === $('profileModal')) closeProfileModal();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeProfileModal();
});

async function removeFriend(friendId) {
  const name = (friendsCache.find(f => f.user_id === friendId) || {}).display_name
    || 'esse amigo';
  const ok = await confirmDialog({
    title: 'Desfazer amizade',
    text: `Desfazer amizade com ${name}?`,
    okText: 'Desfazer',
  });
  if (!ok) return;
  try {
    const my = sb.user.id;
    const a = my < friendId ? my : friendId;
    const b = my < friendId ? friendId : my;
    const { error } = await sb.client.from('friendships').delete()
      .eq('user_a', a).eq('user_b', b);
    if (error) throw error;
    toast('Amizade desfeita.', 'success');
    friendsCache = friendsCache.filter(f => f.user_id !== friendId);
    renderFriends();
    loadFriends();
  } catch (e) {
    toast(e.message || 'Erro ao remover.', 'error');
  }
}

$('friendSearchBtn').addEventListener('click', async () => {
  const q = $('friendSearchInput').value.trim();
  const err = $('friendSearchError');
  err.hidden = true;
  if (!q) return;
  if (!sb.client) { err.textContent = 'Você precisa estar logado.'; err.hidden = false; return; }
  const username = q.replace('@', '').toLowerCase();
  try {
    const { data, error } = await sb.client.from('profiles')
      .select('user_id, username, display_name, avatar_url, border_id')
      .ilike('username', username + '%')
      .limit(5);
    if (error) throw error;
    const hit = (data || []).find(p => p.username && p.username === username) || (data || [])[0];
    if (!hit) {
      err.textContent = 'Nenhum usuário encontrado com esse @username.';
      err.hidden = false;
      $('friendSearchResults').hidden = true;
      return;
    }
    $('friendResultName').textContent = hit.display_name || '@' + hit.username;
    $('friendResultUser').textContent = '@' + hit.username;
    const avEl = $('friendResultAvatar');
    avEl.innerHTML = hit.avatar_url
      ? `<img src="${escapeHtml(hit.avatar_url)}" alt="" onerror="this.remove()">`
      : (hit.display_name ? hit.display_name.slice(0,1).toUpperCase() : '?');
    avEl.classList.toggle('has-photo', !!hit.avatar_url);
    applyBorderTo(avEl, hit.border_id);
    $('friendSendBtn').dataset.uid = hit.user_id;
    $('friendSearchResults').hidden = false;
  } catch (e) {
    err.textContent = e.message || 'Erro na busca.';
    err.hidden = false;
  }
});

$('friendSendBtn').addEventListener('click', async () => {
  const uid = $('friendSendBtn').dataset.uid;
  if (!uid || !sb.client) return;
  const btn = $('friendSendBtn');
  btn.disabled = true;
  try {
    const { data: me } = await sb.client.from('profiles').select('user_id').eq('user_id', sb.user.id).maybeSingle();
    if (me && me.user_id === uid) {
      toast('Você não pode se adicionar.', 'error');
      return;
    }
    const { data: existing } = await sb.client.from('friendships').select('user_a,user_b')
      .or(`and(user_a.eq.${uid},user_b.eq.${sb.user.id}),and(user_a.eq.${sb.user.id},user_b.eq.${uid})`)
      .maybeSingle();
    if (existing) {
      toast('Vocês já são amigos.', 'success');
      return;
    }
    const { error } = await sb.client.from('friend_requests').insert({
      from_user: sb.user.id, to_user: uid
    });
    if (error) {
      const msg = (error.message || '').toLowerCase();
      if (msg.includes('already exists') || msg.includes('duplicate key')) {
        toast('Pedido já enviado.', 'success');
      } else throw error;
    } else {
      toast('Pedido de amizade enviado!', 'success');
    }
  } catch (e) {
    toast(e.message || 'Erro ao enviar pedido.', 'error');
  } finally {
    btn.disabled = false;
  }
});

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ================= Welcome overlay ================= */
$('welcomeCloseBtn').addEventListener('click', () => { $('welcomeOverlay').hidden = true; });

/* ================= Conta: logout / senha / excluir ================= */

$('passwordToggle').addEventListener('click', () => {
  const section = $('passwordSection');
  const toggle = $('passwordToggle');
  const isOpen = !section.hidden;
  section.hidden = isOpen;
  toggle.classList.toggle('open', !isOpen);
  if (isOpen) {
    $('currentPassInput').value = '';
    $('newPassInput').value = '';
    $('passError').hidden = true;
  }
});

$('changePassBtn').addEventListener('click', async () => {
  const current = $('currentPassInput').value;
  const next = $('newPassInput').value;
  const errEl = $('passError');

  if (current.length < 6 || next.length < 6) {
    errEl.textContent = 'As senhas devem ter pelo menos 6 caracteres.';
    errEl.hidden = false;
    return;
  }
  if (current === next) {
    errEl.textContent = 'A nova senha deve ser diferente da atual.';
    errEl.hidden = false;
    return;
  }

  try {
    $('changePassBtn').disabled = true;
    const { error: loginErr } = await sb.client.auth.signInWithPassword({ email: sb.user.email, password: current });
    if (loginErr) {
      errEl.textContent = 'Senha atual incorreta.';
      errEl.hidden = false;
      return;
    }
    const { error } = await sb.client.auth.updateUser({ password: next });
    if (error) throw error;
    errEl.hidden = true;
    $('currentPassInput').value = '';
    $('newPassInput').value = '';
    toast('Senha atualizada com sucesso.', 'success');
    $('passwordSection').hidden = true;
    $('passwordToggle').classList.remove('open');
  } catch (e) {
    errEl.textContent = e.message || 'Erro ao atualizar senha.';
    errEl.hidden = false;
  } finally {
    $('changePassBtn').disabled = false;
  }
});

$('logoutBtn').addEventListener('click', async () => {
  try {
    await sb.client.auth.signOut();
    localStorage.removeItem(storeKey);
    localStorage.removeItem(profileStoreKey());
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem(THEME_KEY);
    localStorage.removeItem(ACCENT_KEY);
    localStorage.removeItem(GOAL_KEY);
    localStorage.removeItem(REWARDS_KEY);
    localStorage.removeItem(PENDING_KEY);
    profile = { displayName: '', username: '', avatarUrl: '', usernameUpdatedAt: null, bio: '' };
    dailyGoalSecs = 30 * 60;
    toast('Conta desconectada.', 'success');
    goToLogin();
  } catch {
    toast('Erro ao sair.', 'error');
  }
});

$('deleteAccountToggle').addEventListener('click', () => {
  const section = $('deleteAccountSection');
  const toggle = $('deleteAccountToggle');
  const isOpen = !section.hidden;
  section.hidden = isOpen;
  toggle.classList.toggle('open', !isOpen);
  if (isOpen) {
    $('deletePassConfirm').value = '';
    $('deleteError').hidden = true;
  }
});

$('deleteAccountBtn').addEventListener('click', async () => {
  const pass = $('deletePassConfirm').value;
  const errEl = $('deleteError');

  if (pass.length < 6) {
    errEl.textContent = 'Digite sua senha para confirmar (mínimo 6 caracteres).';
    errEl.hidden = false;
    return;
  }

  try {
    $('deleteAccountBtn').disabled = true;
    const { error: loginErr } = await sb.client.auth.signInWithPassword({ email: sb.user.email, password: pass });
    if (loginErr) {
      errEl.textContent = 'Senha incorreta.';
      errEl.hidden = false;
      $('deleteAccountBtn').disabled = false;
      return;
    }

    const uid = sb.user.id;

    await Promise.all([
      sb.client.from('sessions').delete().eq('user_id', uid),
      sb.client.from('subjects').delete().eq('user_id', uid),
      sb.client.from('rewards').delete().eq('user_id', uid),
      sb.client.from('profiles').delete().eq('user_id', uid),
      sb.client.from('user_points').delete().eq('user_id', uid)
    ]);

    const { error: delErr } = await sb.client.rpc('delete_my_account');
    if (delErr) {
      console.error('delete_my_account RPC failed:', delErr);
      await sb.client.auth.signOut();
      toast('Dados excluídos. Para exclusão completa da conta, entre em contato.', 'success');
    } else {
      toast('Conta excluída com sucesso.', 'success');
    }

    localStorage.removeItem(storeKey);
    localStorage.removeItem(profileStoreKey());
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem(THEME_KEY);
    localStorage.removeItem(ACCENT_KEY);
    localStorage.removeItem(GOAL_KEY);
    localStorage.removeItem(REWARDS_KEY);
    localStorage.removeItem(PENDING_KEY);
    profile = { displayName: '', username: '', avatarUrl: '', usernameUpdatedAt: null, bio: '' };
    dailyGoalSecs = 30 * 60;
    sb.user = null;
    goToLogin();
  } catch (e) {
    errEl.textContent = e.message || 'Erro ao excluir conta.';
    errEl.hidden = false;
  } finally {
    $('deleteAccountBtn').disabled = false;
  }
});

/* ================= Ajustes: metas / dados / notificações ================= */
function syncSettingsUI() {
  $('goalInput').value = Math.round(dailyGoalSecs / 60);
  renderProfileBorders();
}

function initSettingsUI() {
  document.querySelectorAll('#themeSeg .seg-btn').forEach(btn =>
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme)));

  const row = $('swatchRow');
  Object.entries(PALETTES).forEach(([name, p]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.palette = name;
    b.title = p.label;
    b.setAttribute('aria-label', `Cor ${p.label}`);
    b.style.background = p.accent;
    b.addEventListener('click', () => applyAccent(name));
    row.appendChild(b);
  });
  applyAccent((() => { try { return localStorage.getItem(ACCENT_KEY) || 'amber'; } catch { return 'amber'; }})(), false);

  $('saveGoalBtn').addEventListener('click', () => {
    const v = parseInt($('goalInput').value, 10);
    if (!Number.isFinite(v) || v < 5 || v > 720) {
      toast('Informe uma meta entre 5 e 720 minutos.', 'error');
      return;
    }
    dailyGoalSecs = v * 60;
    localStorage.setItem(GOAL_KEY, String(v));
    renderAll();
    toast(`Meta diária definida: ${v} min.`, 'success');
  });

  $('exportCsvBtn').addEventListener('click', exportCsv);

  syncSettingsUI();
}

/* ================= Exportar / Importar ================= */
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => dateKey(new Date()).replaceAll('-', '');

function exportJson() {
  const payload = {
    app: 'seals-focus',
    exportedAt: new Date().toISOString(),
    sessions: state.sessions,
    subjects: state.subjects
  };
  downloadFile(
    `seals-focus-backup-${stamp()}.json`,
    JSON.stringify(payload, null, 2),
    'application/json'
  );
  toast('Backup JSON exportado.', 'success');
}

const csvCell = v => `"${String(v ?? '').replaceAll('"', '""')}"`;

function exportCsv() {
  const head = ['data_iso', 'duracao_seg', 'materia', 'assunto', 'observacao', 'q_total', 'q_acertos'];
  const lines = [head.join(';')];
  state.sessions.forEach(s => {
    lines.push([s.dateISO, s.duration, s.subject, s.topic, s.obs || '', s.qTotal || 0, s.qRight || 0].map(csvCell).join(';'));
  });
  downloadFile(
    `seals-focus-sessoes-${stamp()}.csv`,
    '\ufeff' + lines.join('\r\n'),
    'text/csv;charset=utf-8'
  );
  toast(`${state.sessions.length} sessões exportadas em CSV.`, 'success');
}

function importJson(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.sessions)) throw new Error('formato inválido');

      const byId = new Map(state.sessions.map(s => [s.id, s]));
      const addedIds = [];
      const newNames = new Set();

      data.sessions.forEach(s => {
        if (!s || !s.id || typeof s.duration !== 'number') return;
        if (state.deletedIds.includes(s.id)) return;
        if (!byId.has(s.id)) { byId.set(s.id, s); addedIds.push(s.id); }
        if (s.subject) newNames.add(s.subject);
      });
      state.sessions = [...byId.values()].sort((a, b) => new Date(b.dateISO) - new Date(a.dateISO));

      if (data.subjects && typeof data.subjects === 'object') {
        Object.entries(data.subjects).forEach(([name, topics]) => {
          if (!Array.isArray(topics)) return;
          state.subjects[name] = [...new Set([...(state.subjects[name] || []), ...topics])];
          newNames.add(name);
        });
      }

      saveState();
      renderAll();

      if (sb.user && addedIds.length > 0) {
        addedIds.forEach(id => pendingSync.add(id));
        pushSubjects([...newNames]);
        flushPending();
      }
      toast(`${addedIds.length} nova(s) sessão(ões) importada(s).`, 'success');
    } catch (err) {
      console.error(err);
      toast('Arquivo inválido. Use um backup JSON deste app.', 'error');
    }
  };
  reader.readAsText(file);
}

/* ================= Mini timer flutuante ================= */
let timerCardVisible = true;

function initMiniTimer() {
  const mt = $('miniTimer');
  if (!mt) return;
  const card = document.querySelector('.timer-card');
  if (!card || !('IntersectionObserver' in window)) { timerCardVisible = false; updateMiniTimer(); return; }
  const io = new IntersectionObserver(entries => {
    timerCardVisible = entries[0].isIntersecting;
    updateMiniTimer();
  }, { threshold: 0.15 });
  io.observe(card);

  mt.addEventListener('click', () => {
    timer.running ? pauseTimer() : startTimer();
  });
}

function updateMiniTimer() {
  const mt = $('miniTimer');
  if (!mt) return;
  const has = timer.running || elapsedSec() > 0;
  mt.hidden = !has || timerCardVisible;
  mt.classList.toggle('running', timer.running);
  const secs = elapsedSec();
  const hh = Math.floor(secs / 3600);
  const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  $('miniTime').textContent = hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}
/* ================= Ajuvas helpers para filtros do feed ================= */
function populateFilterSubject() {
  const sel = $('filterSubject');
  if (!sel) return;
  const prev = sel.value;
  const names = new Set(Object.keys(state.subjects));
  state.sessions.forEach(s => names.add(s.subject));
  sel.innerHTML = '<option value="">Todas as matérias</option>' +
    [...names].sort((a, b) => a.localeCompare(b, 'pt-BR'))
      .map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function clearFeedFilters() {
  $('filterSubject').value = '';
  $('filterFrom').value = '';
  $('filterTo').value = '';
  $('filterQuestions').checked = false;
  renderFeed();
}

/* ================= Persistência do timer ao sair ================= */
window.addEventListener('beforeunload', saveTimer);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    saveTimer();
  } else {
    renderClock(true); // volta pra aba já com a hora certa
    if (timer.running) startTick(); // rAF pausou em segundo plano: retoma o loop
    renderMetrics();
  }
});

/* ================= Render geral / boot ================= */
function renderAll() {
  renderMetrics();
  renderHistory();
  renderFeed();
  if (!$('view-study').classList.contains('active')) renderStats();
}

loadState();
loadGoal();
loadTimer();
if (timer.running) startTick(); // retoma o loop de atualização após recarregar
loadAppearance();
loadProfile();
loadRewards();
initCloud();
initSettingsUI();
initMiniTimer();
renderAll();

window.addEventListener('pageshow', e => {
  if (e.persisted) location.reload();
});

