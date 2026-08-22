'use strict';

/* ================= Storage ================= */
const DATA_KEY = 'foco.data.v1';
const TIMER_KEY = 'foco.timer.v1';
const PENDING_KEY = 'foco.pending.v1';

const defaultState = () => ({ sessions: [], subjects: {}, deletedIds: [] });
let state = defaultState();
let storeKey = DATA_KEY;

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
  try { sb.client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); }
  catch (e) { console.error('Supabase:', e); return; }

  sb.client.auth.getSession().then(({ data }) => {
    setCloudUser(data.session?.user ?? null);
    if (sb.user) syncFromCloud().then(flushPending);
  });
  sb.client.auth.onAuthStateChange((_evt, session) => {
    const u = session?.user ?? null;
    if ((u?.id ?? null) !== (sb.user?.id ?? null)) {
      setCloudUser(u);
      renderAll();
      if (u) syncFromCloud().then(flushPending);
    }
  });

  window.addEventListener('online', () => { if (sb.user) flushPending(); });
}

function setCloudUser(user) {
  // troca o cache local para o namespace do usuário logado
  storeKey = user ? `${DATA_KEY}.u.${user.id}` : DATA_KEY;
  state = defaultState();
  loadState();

  sb.user = user;
  const avatar = $('avatarInitials');
  if (user) {
    const handle = (user.email || '?').split('@')[0].split(/[._-]/)[0];
    avatar.textContent = (handle.slice(0, 2) || '?').toUpperCase();
    avatar.title = user.email;
    $('userEmail').textContent = user.email;
    $('userMenu').hidden = true;
  } else {
    avatar.textContent = '?';
    avatar.title = 'Conectar conta';
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
  try {
    const [{ data: rs }, { data: rj }] = await Promise.all([
      sb.client.from('sessions').select('*').order('date_iso', { ascending: false }),
      sb.client.from('subjects').select('*')
    ]);
    if (rs.error || rj.error) throw rs.error || rj.error;

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

    saveState();
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

async function flushPending() {
  for (const id of [...pendingSync]) {
    const s = state.sessions.find(x => x.id === id);
    if (s) await pushSession(s); else { pendingSync.delete(id); persistPending(); }
  }
  updateSyncUI();
}

/* ================= Utils ================= */
const $ = id => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

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

/* ================= Timer ================= */
let timer = { running: false, accumulated: 0, startedAt: null };
let tickInterval = null;

function loadTimer() {
  try {
    const raw = localStorage.getItem(TIMER_KEY);
    if (raw) timer = { ...timer, ...JSON.parse(raw) };
  } catch { /* ignora */ }
  syncTimerUI();
  renderClock();
}

function saveTimer() {
  localStorage.setItem(TIMER_KEY, JSON.stringify(timer));
}

function elapsedSec() {
  return timer.accumulated + (timer.running ? Math.floor((Date.now() - timer.startedAt) / 1000) : 0);
}

function renderClock() {
  $('timer').textContent = fmtHMS(elapsedSec());
}

function startTick() {
  clearInterval(tickInterval);
  tickInterval = setInterval(renderClock, 250);
}

function stopTick() {
  clearInterval(tickInterval);
  tickInterval = null;
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
const views = ['study', 'stats', 'feed'];

function switchView(name) {
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
  if (name !== 'study') renderStatsAndFeed();
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

const MIN_DAY_SECS = 30 * 60; // 30 minutos para contar como dia estudado

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
  $('streakDays').textContent = streak > 0 ? `⚡ ${streak} ${streak === 1 ? 'dia' : 'dias'}` : '⚡ 0 dias';

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
  renderWeekStrip(perDay);

  window._weekData = week;
}

const STRIP_LABELS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

function renderWeekStrip(perDay) {
  const row = $('weekStrip');
  if (!row) return;
  row.innerHTML = '';

  const today = dateKey(new Date());
  const keys = [...perDay.keys()];
  const daysDone = [...perDay.values()].filter(v => v >= MIN_DAY_SECS).length;

  $('weekDaysChip').textContent = `${daysDone} de 7 dias · mín. 30 min/dia`;

  keys.forEach((key, i) => {
    const secs = perDay.get(key);
    const day = document.createElement('div');
    day.className = 'strip-day';

    const circle = document.createElement('div');
    circle.className = 'strip-circle';

    const label = document.createElement('span');
    label.className = 'strip-label';
    label.textContent = STRIP_LABELS[i];

    if (secs >= MIN_DAY_SECS) {
      day.classList.add('done');
      circle.textContent = '✓';
    } else if (key < today) {
      day.classList.add('missed');
      circle.textContent = '✕';
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

  const query = ($('feedSearch').value || '').toLowerCase().trim();
  const filtered = query
    ? state.sessions.filter(s =>
        [s.subject, s.topic, s.obs].filter(Boolean).some(f => f.toLowerCase().includes(query)))
    : state.sessions;

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
  pauseTimer(); // congela o tempo acumulado (sem drift)
  timerWasRunning = timer.accumulated > 0;

  $('modalDuration').textContent = `${fmtHMS(timer.accumulated)} registrados`;
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
    if (authModal.classList.contains('active')) authModal.classList.remove('active');
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

  // Registra matérias/assuntos novos na estrutura persistida
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

  state.sessions.unshift(session);
  saveState();

  // sincroniza com a nuvem (se logado)
  pushSession(session);
  pushSubjects([subject]);

  resetTimer();
  clearModalForm();
  modal.classList.remove('active');
  renderAll();

  toast(`Sessão salva: ${fmtHM(duration)} de ${subject}.`, 'success');
});

/* ================= Autenticação ================= */
const authModal = $('authModal');
let authMode = 'login';

function showAuthError(msg) {
  const err = $('authError');
  err.textContent = msg || '';
  err.hidden = !msg;
}

function setAuthMode(mode, keepError = false) {
  authMode = mode;
  $('authTitle').textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
  $('authSubmitBtn').textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
  $('authSwitchBtn').textContent = mode === 'login'
    ? 'Não tem conta? Criar uma'
    : 'Já tem conta? Entrar';
  $('authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  if (!keepError) showAuthError('');
}

function openAuthModal() {
  setAuthMode('login');
  $('authEmail').value = '';
  $('authPass').value = '';
  authModal.classList.add('active');
  setTimeout(() => $('authEmail').focus(), 50);
}

$('avatarBtn').addEventListener('click', e => {
  e.stopPropagation();
  if (!sb.user && isCloudConfigured()) { openAuthModal(); return; }
  if (!sb.user) {
    toast('Configure o Supabase em config.js para sincronizar.', 'error');
    return;
  }
  const menu = $('userMenu');
  menu.hidden = !menu.hidden;
  $('avatarBtn').setAttribute('aria-expanded', String(!menu.hidden));
});

document.addEventListener('click', e => {
  if (!$('userMenu').hidden && !e.target.closest('.avatar-wrap')) {
    $('userMenu').hidden = true;
    $('avatarBtn').setAttribute('aria-expanded', 'false');
  }
});

authModal.addEventListener('click', e => {
  if (e.target === authModal) authModal.classList.remove('active');
});

$('authSwitchBtn').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'));
$('authCancelBtn').addEventListener('click', () => authModal.classList.remove('active'));

$('authSubmitBtn').addEventListener('click', async () => {
  const email = $('authEmail').value.trim();
  const pass = $('authPass').value;

  if (!/^\S+@\S+\.\S+$/.test(email)) return showAuthError('Informe um e-mail válido.');
  if (pass.length < 6) return showAuthError('A senha precisa de pelo menos 6 caracteres.');

  const btn = $('authSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Aguarde...';

  try {
    const result = authMode === 'login'
      ? await sb.client.auth.signInWithPassword({ email, password: pass })
      : await sb.client.auth.signUp({ email, password: pass });

    if (result.error) throw result.error;

    if (authMode === 'signup' && !result.data.session) {
      toast('Conta criada! Confirme no e-mail que enviamos antes de entrar.', 'success');
    } else {
      toast(`Bem-vindo, ${email}!`, 'success');
    }
    authModal.classList.remove('active');
  } catch (e) {
    const msg = (e.message || '').toLowerCase();
    if (msg.includes('already registered')) showAuthError('Este e-mail já tem conta. Faça login.');
    else if (msg.includes('invalid login')) showAuthError('E-mail ou senha incorretos.');
    else if (msg.includes('rate limit')) showAuthError('Muitas tentativas. Aguarde um momento.');
    else showAuthError(e.message || 'Falha na autenticação.');
  } finally {
    btn.disabled = false;
    setAuthMode(authMode, true); // mantém a mensagem de erro visível, se houver
  }
});

// Sair da conta (confirmação em 2 cliques)
let logoutArmed = false;
$('logoutBtn').addEventListener('click', async () => {
  if (!logoutArmed) {
    logoutArmed = true;
    $('logoutBtn').textContent = 'Confirmar saída?';
    setTimeout(() => {
      logoutArmed = false;
      $('logoutBtn').textContent = 'Sair da conta';
    }, 3000);
    return;
  }
  logoutArmed = false;
  $('logoutBtn').textContent = 'Sair da conta';
  try { await sb.client.auth.signOut(); toast('Você saiu da conta.'); }
  catch (e) { console.error(e); }
});

/* ================= Atalhos de teclado ================= */
document.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (typing || modal.classList.contains('active') || authModal.classList.contains('active')) return;

  if (e.code === 'Space') {
    e.preventDefault();
    timer.running ? pauseTimer() : startTimer();
  }
});

/* ================= Persistência do timer ao sair ================= */
window.addEventListener('beforeunload', saveTimer);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    saveTimer();
    renderMetrics(); // recalcula ao voltar para a aba
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
loadTimer();
initCloud();
renderAll();
