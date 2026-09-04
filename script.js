'use strict';

/* ================= Storage ================= */
const DATA_KEY = 'foco.data.v1';
const TIMER_KEY = 'foco.timer.v1';
const PENDING_KEY = 'foco.pending.v1';
const PUSHED_KEY = 'foco.pushed.v1';
const TOMBSYNC_KEY = 'foco.tombsync.v1';
const KNOWN_KEY = 'foco.known.v1';
const PUSHED_REWARDS_KEY = 'foco.pushedrewards.v1';
const SYNC_INTERVAL = 60000; // 60s: mantém aparelhos iguais sem pesar no servidor
const GOAL_KEY = 'foco.goal.v1';
const GOAL_DATE_KEY = 'foco.goaldate.v1';
const THEME_KEY = 'foco.theme.v1';
const ACCENT_KEY = 'foco.accent.v1';
const PROFILE_KEY = 'foco.profile.v1';

/* Doação: link de apoio "ajude o site a ficar no ar".
   Coloque aqui sua chave Pix / link (Buy me a Coffee, GitHub Sponsors, etc.).
   Ex.: 'pix:seu-email-ou-chave' ou 'https://linkdedoacao.com'. Vazio = botão avisa. */
const DONATION_LINK = '';
const REWARDS_KEY = 'foco.rewards.v1';
const UPOINTS_KEY = 'foco.points.v1';

const defaultState = () => ({ sessions: [], subjects: {}, deletedIds: [] });
let state = defaultState();
let storeKey = DATA_KEY;

/* ================= Recompensas ================= */
let rewardedDays = new Set();
// Dias de recompensa gastos na troca de pontos por cristais: não podem
// ser readicionados pelo awardPendingRewards (a sessão ainda existe no banco).
const SPENT_DAYS_KEY = 'foco.spentdays.v1';
let spentRewardDays = new Set();
const POINTS_PER_DAY = 100;
const SIGNUP_BONUS = 200;

/* ================= Conquistas ================= */
const ACH_KEY = 'foco.ach.v1';
let bestStreak = 0;                 // maior sequência já alcançada
let unlockedAch = new Set();        // ids de conquistas desbloqueadas
let shownAch = new Set();           // ids de conquistas escolhidas para aparecer no perfil
let shownAchLoaded = false;         // evita sobrescrever escolha local na 1ª sincronização

const ACHIEVEMENTS = [
  { id: 'first_session', name: 'Primeiros Passos', desc: 'Registre sua primeira sessão de estudo', tier: 'bronze', check: s => s.sessions >= 1 },
  { id: 'first_goal',    name: 'Meta Alcançada',   desc: 'Cumpra sua meta diária pela primeira vez', tier: 'bronze', check: s => s.goalsMet >= 1 },
  { id: 'streak_3',      name: '3 Dias',           desc: 'Mantenha uma sequência de 3 dias', tier: 'bronze', check: s => s.bestStreak >= 3 },
  { id: 'streak_7',      name: '1 Semana',         desc: 'Sequência de estudo de 7 dias', tier: 'silver', check: s => s.bestStreak >= 7 },
  { id: 'streak_14',     name: '2 Semanas',        desc: 'Sequência de estudo de 14 dias', tier: 'silver', check: s => s.bestStreak >= 14 },
  { id: 'streak_21',     name: '3 Semanas',        desc: 'Sequência de estudo de 21 dias', tier: 'gold', check: s => s.bestStreak >= 21 },
  { id: 'streak_30',     name: '1 Mês',            desc: 'Sequência de estudo de 30 dias', tier: 'gold', check: s => s.bestStreak >= 30 },
  { id: 'streak_60',     name: '2 Meses',          desc: 'Sequência de estudo de 60 dias', tier: 'gem', check: s => s.bestStreak >= 60 },
  { id: 'streak_90',     name: '3 Meses',          desc: 'Sequência de estudo de 90 dias', tier: 'gem', check: s => s.bestStreak >= 90 },
  { id: 'hours_10',      name: '10 Horas',         desc: 'Acumule 10 horas de estudo no total', tier: 'bronze', check: s => s.totalSecs >= 10 * 3600 },
  { id: 'hours_50',      name: '50 Horas',         desc: 'Acumule 50 horas de estudo no total', tier: 'silver', check: s => s.totalSecs >= 50 * 3600 },
  { id: 'hours_100',     name: '100 Horas',        desc: 'Acumule 100 horas de estudo no total', tier: 'gold', check: s => s.totalSecs >= 100 * 3600 },
  { id: 'sessions_10',   name: '10 Sessões',       desc: 'Complete 10 sessões de estudo', tier: 'bronze', check: s => s.sessions >= 10 },
  { id: 'sessions_50',   name: '50 Sessões',       desc: 'Complete 50 sessões de estudo', tier: 'silver', check: s => s.sessions >= 50 },
  { id: 'sessions_100',  name: '100 Sessões',      desc: 'Complete 100 sessões de estudo', tier: 'gold', check: s => s.sessions >= 100 }
];

function achKey() {
  return sb && sb.user ? `${ACH_KEY}.u.${sb.user.id}` : ACH_KEY;
}
function loadAchievements() {
  shownAchLoaded = false;
  try {
    const raw = localStorage.getItem(achKey());
    if (!raw) return;
    const p = JSON.parse(raw);
    if (Number.isFinite(p.bestStreak)) bestStreak = p.bestStreak;
    if (Array.isArray(p.unlocked)) unlockedAch = new Set(p.unlocked);
    if (Array.isArray(p.shown)) {
      shownAch = new Set(p.shown.filter(id => ACHIEVEMENTS.some(a => a.id === id)));
      shownAchLoaded = true;
    }
  } catch { /* ignora */ }
  // Preenchimento padrão: se o usuário ainda não configurou (sem `shown` salvo),
  // mostra todas as desbloqueadas por padrão.
  if (!shownAchLoaded) {
    shownAch = new Set([...unlockedAch].filter(id => ACHIEVEMENTS.some(a => a.id === id)));
  }
}
function saveAchievements() {
  try {
    localStorage.setItem(achKey(), JSON.stringify({ bestStreak, unlocked: [...unlockedAch], shown: [...shownAch] }));
  } catch { /* ignora */ }
}
function pushShownAch() {
  if (!sb.client || !sb.user) return;
  try {
    sb.client.from('profiles')
      .update({ show_achievements: [...shownAch] })
      .eq('user_id', sb.user.id)
      .then(({ error }) => { if (error) console.error('pushShownAch:', error.message); });
  } catch (e) { console.error('pushShownAch:', e); }
}

/* ================= Pontos do usuário (user_points) ================= */
let userPoints = 0;

/* ================= Loja (cristais + bordas) ================= */
// Whitelist da Loja. Esvaziada = liberada para todos. Para restringir,
// coloque os @username (sem @, minúsculo) aqui.
const SHOP_ALLOWED = [];
let crystals = 0;               // saldo de cristais (moeda da loja)
let shopItems = [];             // catálogo: [{id, name, category, cost, color}]
let ownedItems = new Set();     // ids de bordas que o usuário já comprou
let equippedBorder = null;      // id da borda equipada (do perfil do usuário)
const BORDER_COLORS = {};       // id -> cor hex ou flag de efeito (preenchido do catálogo)
const EFFECT_FLAGS = { rgb: 1, gold: 1, ruby: 1, prism: 1, ice: 1, neon: 1, aurora: 1, lava: 1, cosmic: 1 }; // flags de bordas animadas
const PREMIUM_COST = 1000; // bordas com custo >= isso entram no grupo "Premium"

// Troca de pontos por cristais: a cada POINTS_TO_CRYSTAL_RATE pontos = 1 cristal
const POINTS_TO_CRYSTAL_RATE = 6;

// Pacotes de cristais exibidos na loja (bônus sobre o valor base).
// A venda por dinheiro real ainda está por vir — hoje servem de meta/atrativo.
const CRYSTAL_PACKAGES = [
  { id: 'pkg1', label: 'Pacote Pequeno', amount: 300,  bonus: '+0',   base: 300  },
  { id: 'pkg2', label: 'Pacote Médio',    amount: 900,  bonus: '+100', base: 800, tag: '+100 bônus' },
  { id: 'pkg3', label: 'Pacote Grande',   amount: 2500, bonus: '+500', base: 2000, tag: '+500 bônus' },
  { id: 'pkg4', label: 'Pacote Mestre',   amount: 6000, bonus: '+1500', base: 4500, tag: '+1500 bônus', premium: true },
];

function isShopAllowed() {
  if (SHOP_ALLOWED.length === 0) return true; // lista vazia = liberado p/ todos
  const uname = (profile.username || '').replace('@', '').toLowerCase().trim();
  return SHOP_ALLOWED.includes(uname);
}

function isAdmin() {
  return !!(sb.user && ADMIN_USER_ID && sb.user.id === ADMIN_USER_ID);
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
  try {
    const raw = localStorage.getItem(SPENT_DAYS_KEY);
    if (raw) spentRewardDays = new Set(JSON.parse(raw));
  } catch { /* ignora */ }
}

function saveRewards() {
  localStorage.setItem(REWARDS_KEY, JSON.stringify([...rewardedDays]));
  localStorage.setItem(SPENT_DAYS_KEY, JSON.stringify([...spentRewardDays]));
}

function getPoints() { return getTotalPoints(); }

function awardPendingRewards(perDay) {
  const newDays = [];
  perDay.forEach((secs, key) => {
    if (secs >= dayThreshold(key) && !rewardedDays.has(key) && !spentRewardDays.has(key)) {
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
let pushedIds = new Set();   // ids de sessões já confirmadas no servidor (push incremental)
let tombSynced = new Set();  // tombstones já excluídos no servidor
let syncingNow = false;

try { pendingSync = new Set(JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')); } catch { /* ignora */ }
const persistPending = () => localStorage.setItem(PENDING_KEY, JSON.stringify([...pendingSync]));
try { pushedIds = new Set(JSON.parse(localStorage.getItem(PUSHED_KEY) || '[]')); } catch { /* ignora */ }
const persistPushed = () => localStorage.setItem(PUSHED_KEY, JSON.stringify([...pushedIds]));
try { tombSynced = new Set(JSON.parse(localStorage.getItem(TOMBSYNC_KEY) || '[]')); } catch { /* ignora */ }
const persistTombSync = () => localStorage.setItem(TOMBSYNC_KEY, JSON.stringify([...tombSynced]));
let rewardPushed = new Set(); // dias de recompensa já confirmados no servidor
try { rewardPushed = new Set(JSON.parse(localStorage.getItem(PUSHED_REWARDS_KEY) || '[]')); } catch { /* ignora */ }
const persistRewarded = () => localStorage.setItem(PUSHED_REWARDS_KEY, JSON.stringify([...rewardPushed]));
const knownKey = () => sb.user ? `${KNOWN_KEY}.u.${sb.user.id}` : KNOWN_KEY;
const loadKnownIds = () => { try { return new Set(JSON.parse(localStorage.getItem(knownKey()) || '[]')); } catch { return new Set(); } };
const saveKnownIds = ids => localStorage.setItem(knownKey(), JSON.stringify([...ids]));

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
      finishBoot(syncFromCloud);
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
      if (u) finishBoot(syncFromCloud);
    }
  });

  window.addEventListener('online', () => { if (sb.user) flushPending(); });

  // Sync automático periódico: mantém celular e PC como a MESMA coisa,
  // com pull leve (só IDs) pra não pesar no servidor.
  setInterval(() => {
    if (!sb.user || !sb.client) return;
    loadPendingRequests();
    if (!document.hidden && !syncingNow && !bootTimer) syncFromCloud();
  }, SYNC_INTERVAL);
}

/* Mantém a tela de loading visível até a 1ª sincronização terminar,
   com timeout de segurança para nunca travar (ex.: sem internet). */
let bootTimer = null;
function finishBoot(promiseFn) {
  const loader = $('loader');
  if (loader && !loader.classList.contains('hide')) {
    loader.classList.remove('hide'); // garante visível
  }
  showLoader(true);
  const done = () => {
    if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
    hideLoader();
  };
  if (bootTimer) clearTimeout(bootTimer);
  bootTimer = setTimeout(done, 10000); // segurança: máx. 10s na tela de loading
  if (promiseFn) {
    Promise.resolve().then(() => promiseFn()).then(flushPending).then(done).catch(() => done());
  }
}

function showLoader(on) {
  const loader = $('loader');
  if (!loader) return;
  if (on) loader.classList.remove('hide');
  else hideLoader();
}
function hideLoader() {
  const loader = $('loader');
  if (!loader) return;
  loader.classList.add('hide');
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
  sb.user = user;
  loadState();
  loadAchievements();

  if (user) {
    resetLocalTimer();          // não deixa cronômetro de outra conta vazar no aparelho
    loadPendingRequests();
    subscribeTimerSync();
    loadTimerSync();
  } else {
    if (timerChannel && sb.client) { sb.client.removeChannel(timerChannel); timerChannel = null; }
    cloudTimer = null;
    remoteRunning = false;
    if ($('timerSyncCard')) $('timerSyncCard').hidden = true;
  }
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
    $('settingsAccountCard').hidden = false;
    loadProfile();
    pullProfile().then(() => {
      syncProfileUI();
      applyBorderTo($('avatarBtn'), equippedBorder);
    });
    loadShop().then(() => {
      if (currentView === 'shop') renderShop();
      renderProfileBorders();
    });
    setTimeout(() => pushAchievements(), 500);
  } else {
    avatar.textContent = '?';
    avatar.title = 'Conectar conta';
    $('accountSection').hidden = true;
    $('settingsProfileCard').hidden = true;
    $('settingsAppearanceCard').hidden = true;
    $('settingsGoalCard').hidden = true;
    $('settingsDataCard').hidden = true;
    $('settingsAccountCard').hidden = true;
    profile = { displayName: '', username: '', avatarUrl: '', usernameUpdatedAt: null, bio: '' };
    syncProfileUI();
  }
}

function updateSyncUI() {
  const row = $('syncRow');
  row.hidden = !isCloudConfigured();
  const statsBtn = $('syncBtnStats');
  if (statsBtn) statsBtn.hidden = !(isCloudConfigured() && sb.user);
  if (!isCloudConfigured()) return;

  const label = $('syncLabel');
  const dot = $('syncDot');
  const btn = $('syncBtn');
  dot.className = 'sync-dot';

  if (!sb.user) label.textContent = 'Local';
  else if (syncingNow) { label.textContent = 'Sincronizando...'; dot.classList.add('busy'); }
  else if (pendingSync.size > 0) { label.textContent = `${pendingSync.size} pendentes`; dot.classList.add('warn'); }
  else { label.textContent = 'Em dia'; dot.classList.add('ok'); }
  if (btn) btn.disabled = !sb.user || syncingNow;
  if (statsBtn) statsBtn.disabled = !sb.user || syncingNow;
}

async function manualSync() {
  if (!sb.client || !sb.user) return;
  if (syncingNow) return;
  toast('Sincronizando…', 'info');
  try {
    await Promise.resolve().then(() => syncFromCloud());
    await flushPending();
  } catch (e) { console.error('manualSync:', e); }
  updateSyncUI();
  toast('Sincronizado.', 'success');
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
    // Pull leve: sessões só por ID; o corpo vêm apenas quando muda.
    const [{ data: rIds, error: eS }, { data: rj, error: eJ }, { data: rw, error: eR }, { data: rp, error: eP }] = await Promise.all([
      sb.client.from('sessions').select('id'),
      sb.client.from('subjects').select('*'),
      sb.client.from('rewards').select('day_key'),
      sb.client.from('profiles').select('*').eq('user_id', sb.user.id).maybeSingle()
    ]);
    if (eS || eJ) throw eS || eJ;

    const serverIds = new Set((rIds || []).map(r => r.id));
    const known = loadKnownIds();

    // exclusões feitas em outro aparelho: id não está mais no servidor
    const removed = [...known].filter(id => !serverIds.has(id));
    if (removed.length) {
      const del = new Set(removed);
      state.sessions = state.sessions.filter(s => !del.has(s.id));
      saveState();
    }

    // novidades: baixa só o que o aparelho ainda não conhece (em lotes)
    const added = [...serverIds].filter(id => !known.has(id));
    if (added.length) {
      for (let i = 0; i < added.length; i += 100) {
        const { data, error } = await sb.client.from('sessions')
          .select('*').in('id', added.slice(i, i + 100));
        if (error) throw error;
        (data || []).forEach(r => {
          state.sessions = [...state.sessions.filter(s => s.id !== r.id), rowToSession(r)];
          pushedIds.add(r.id); // já está no servidor: não re-envia
        });
      }
      persistPushed();
      saveState();
    }
    saveKnownIds(serverIds);

    // matérias: união de tópicos (poucas linhas por usuário)
    (rj || []).forEach(r => {
      const topics = Array.isArray(r.topics) ? r.topics : [];
      state.subjects[r.name] = [...new Set([...(state.subjects[r.name] || []), ...topics])];
    });

    // recompensas: união de dias
    let changedRewards = false;
    (rw || []).forEach(r => {
      if (!rewardedDays.has(r.day_key)) { rewardedDays.add(r.day_key); changedRewards = true; }
      rewardPushed.add(r.day_key); // já está no servidor
    });
    if (changedRewards) { saveRewards(); persistRewarded(); }
    else if (rw && rw.length) persistRewarded();

    // perfil: usa o do servidor se existir
    if (rp && !eP) {
      profile = {
        displayName: rp.display_name || '',
        username: rp.username || '',
        avatarUrl: rp.avatar_url || '',
        usernameUpdatedAt: rp.username_updated_at || null,
        bio: rp.bio || ''
      };
      localStorage.setItem(profileStoreKey(), JSON.stringify(profile));
      resetProfileForm();
      applyCloudPrefs(rp);
    }

    await loadUserPoints();
    await awardSignupBonus();

    const tombs = new Set(state.deletedIds);
    state.sessions = state.sessions.filter(s => !tombs.has(s.id))
      .sort((a, b) => new Date(b.dateISO) - new Date(a.dateISO));
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
  if (!sb.client || !sb.user) { pendingSync.add(session.id); persistPending(); return; }
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
    pushedIds.add(session.id);
    persistPushed();
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
  try {
    const { error } = await sb.client.from('rewards').upsert(rows);
    if (error) throw error;
    days.forEach(d => rewardPushed.add(d));
    persistRewarded();
  } catch (e) { console.error('pushRewards:', e); }
}

/* Sincroniza conquistas desbloqueadas + melhor sequência para a nuvem. */
async function pushAchievements(ids, best = bestStreak) {
  if (!sb.client || !sb.user) return;
  const idArr = ids && ids.length ? ids : [...unlockedAch];
  if (idArr.length) {
    try {
      const { error } = await sb.client.from('achievements').upsert(
        idArr.map(id => ({ user_id: sb.user.id, achievement_id: id }))
      );
      if (error) console.error('pushAchievements:', error.message);
      else console.log('[ach] pushed', idArr.length, 'achievements');
    } catch (e) { console.error('pushAchievements:', e); }
  }
  try {
    const { error } = await sb.client.from('profiles')
      .update({ best_streak: Math.max(0, best | 0) })
      .eq('user_id', sb.user.id);
    if (error) console.error('pushAchievements best_streak:', error.message);
    else console.log('[ach] pushed best_streak', best);
  } catch (e) { console.error('pushAchievements best:', e); }
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
  const toPush = state.sessions.filter(s => !pushedIds.has(s.id));
  console.log('[sync] syncToCloud: pushing', toPush.length, 'novas de', state.sessions.length);
  for (const s of toPush) await pushSession(s);
  for (const id of state.deletedIds) {
    if (tombSynced.has(id) || pendingSync.has(id)) continue;
    await deleteSessionRemote(id);
    tombSynced.add(id);
    persistTombSync();
  }
  await pushSubjects(Object.keys(state.subjects));
  const newRewardDays = [...rewardedDays].filter(d => !rewardPushed.has(d));
  if (newRewardDays.length) await pushRewards(newRewardDays);
  await pushProfile();
  await setUserPoints(userPoints);
  console.log('[sync] syncToCloud: done');
}

/* ================= Utils ================= */
const $ = id => document.getElementById(id);

$('syncBtn').addEventListener('click', () => { manualSync(); });
$('syncBtnStats').addEventListener('click', () => { manualSync(); });

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

function toast(msg, type = '', html = false) {
  const el = document.createElement('div');
  el.className = `toast ${type}`.trim();
  if (html) el.innerHTML = msg;
  else el.textContent = msg;
  $('toastStack').appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 3200);
}

function openDonation() {
  if (DONATION_LINK) {
    window.open(DONATION_LINK, '_blank', 'noopener');
    return;
  }
  toast('Link de doação não configurado. Adicione sua URL na constante DONATION_LINK no topo de script.js.', '');
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

/* ===== Timer sincronizado entre aparelhos ("luz com 2 interruptores") ===== */
let cloudTimer = null;       // último registro de timer_sync vindo da nuvem (Realtime)
let remoteRunning = false;   // outro aparelho está com o cronômetro RODANDO agora
let timerChannel = null;     // canal Realtime do timer_sync do usuário

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
  pushTimerSync();
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
  pushTimerSync();
}

function resetTimer(clearStorage = true) {
  timer = { running: false, accumulated: 0, startedAt: null };
  stopTick();
  if (clearStorage) localStorage.removeItem(TIMER_KEY);
  renderClock();
  syncTimerUI();
  pushTimerSync(true);
}

/* Zera APENAS o cronômetro local (não envia nada à nuvem).
   Usado ao trocar de conta: evita que o timer pausado de um usuário
   "vaze" para a próxima conta no mesmo aparelho. */
function resetLocalTimer() {
  timer = { running: false, accumulated: 0, startedAt: null };
  stopTick();
  try { localStorage.removeItem(TIMER_KEY); } catch { /* ignora */ }
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
  renderTimerSync();
}

/* ================= Timer sync entre aparelhos ================= */
function timerSyncRecord() {
  return {
    accumulated: timer.running ? 0 : timer.accumulated,
    started_at: timer.running ? new Date(timer.startedAt).toISOString() : null,
    paused_at: timer.running ? null : new Date().toISOString(),
    running: timer.running,
    day_key: dateKey(new Date())
  };
}

/* Envia o estado atual do cronômetro para a nuvem (upsert). */
async function pushTimerSync(cleared = false) {
  if (!sb.client || !sb.user) return;
  try {
    const rec = {
      user_id: sb.user.id,
      ...(cleared
        ? { accumulated: 0, started_at: null, paused_at: null, running: false, day_key: dateKey(new Date()) }
        : timerSyncRecord()),
      updated_at: new Date().toISOString()
    };
    const { error } = await sb.client.from('timer_sync').upsert(rec);
    if (error) console.error('[timerSync] upsert error:', error.message);
    else console.log('[timerSync] push ok:', JSON.stringify(rec));
  } catch (e) { console.error('pushTimerSync:', e); }
}

/* Busca o estado sincronizado na nuvem (ao abrir o app). */
async function loadTimerSync() {
  if (!sb.client || !sb.user) return;
  try {
    const { data, error } = await sb.client.from('timer_sync')
      .select('*').eq('user_id', sb.user.id).maybeSingle();
    if (error) { console.error('[timerSync] load error:', error.message); return; }
    console.log('[timerSync] load:', data ? JSON.stringify(data) : 'no row');
    applyTimerSync(data || null);
  } catch (e) { console.error('loadTimerSync:', e); }
}

/* Aplica (reconcilia) o estado vindo da nuvem — do boot ou do Realtime. */
async function applyTimerSync(record) {
  cloudTimer = record || null;
  const today = dateKey(new Date());

  // regra "mesmo dia": sessão suspensa de outro dia é descartada
  if (cloudTimer && cloudTimer.day_key && cloudTimer.day_key !== today) {
    if (!timer.running) {
      timer = { running: false, accumulated: 0, startedAt: null };
      saveTimer();
    }
    cloudTimer = null;
    if (sb.client && sb.user) {
      try { await sb.client.from('timer_sync').delete().eq('user_id', sb.user.id); } catch (e) { console.error('stale timer delete:', e); }
    }
  }

  if (cloudTimer && cloudTimer.running) {
    // outro aparelho está rodando AGORA -> não contabilizar duas vezes
    remoteRunning = true;
    renderTimerSync();
    return;
  }
  remoteRunning = false;
  renderTimerSync();
}

/* Formata o relógio do horário (HH:MM). */
function fmtClock(iso) {
  try { return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
  catch { return ''; }
}

/* Renderiza o card "luz com 2 interruptores" na aba Estudo. */
function renderTimerSync() {
  const card = $('timerSyncCard');
  if (!card) return;
  const resumeBtn = $('timerSyncResumeBtn');
  const title = $('timerSyncTitle');
  const sub = $('timerSyncSub');
  const icon = $('timerSyncIcon');

  // aparelho local está rodando: é ele o dono -> não mostra banner
  if (timer.running) { card.hidden = true; return; }

  const today = dateKey(new Date());
  const rec = (cloudTimer && cloudTimer.day_key === today) ? cloudTimer : null;

  if (rec && rec.running) {
    card.hidden = false;
    icon.className = 'timer-sync-icon running';
    icon.innerHTML = '<i class="ti ti-device-mobile"></i>';
    title.textContent = 'Estudando em outro aparelho';
    sub.textContent = 'Sessão em andamento desde ' + (rec.started_at ? fmtClock(rec.started_at) : 'agora') + '. Feche este aparelho para não contabilizar duas vezes.';
    resumeBtn.hidden = true;
  } else if (rec && rec.accumulated > 0) {
    card.hidden = false;
    icon.className = 'timer-sync-icon paused';
    icon.innerHTML = '<i class="ti ti-player-pause-filled"></i>';
    title.textContent = 'Sessão pausada';
    sub.textContent = fmtHM(rec.accumulated) + ' registrados' + (rec.paused_at ? ' · pausada às ' + fmtClock(rec.paused_at) : '');
    resumeBtn.hidden = false;
  } else if (!timer.running && elapsedSec() > 0) {
    // sessão local pausada mas ainda não compartilhada de forma útil
    card.hidden = false;
    icon.className = 'timer-sync-icon paused';
    icon.innerHTML = '<i class="ti ti-player-pause-filled"></i>';
    title.textContent = 'Sessão pausada';
    sub.textContent = fmtHM(elapsedSec()) + ' registrados neste aparelho';
    resumeBtn.hidden = false;
  } else {
    card.hidden = true;
  }
}

/* Retoma uma sessão pausada (neste aparelho vira o dono). */
function resumeTimerSync() {
  const rec = cloudTimer;
  timer = {
    running: true,
    accumulated: rec && rec.day_key === dateKey(new Date()) ? (rec.accumulated || 0) : 0,
    startedAt: Date.now()
  };
  saveTimer();
  startTick();
  syncTimerUI();
  renderTimerSync();
  pushTimerSync();
  toast('Cronômetro retomado neste aparelho.', 'success');
}

function subscribeTimerSync() {
  if (!sb.client || !sb.user) return;
  if (timerChannel) { sb.client.removeChannel(timerChannel); timerChannel = null; }
  timerChannel = sb.client
    .channel('timer-sync-' + sb.user.id)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'timer_sync', filter: `user_id=eq.${sb.user.id}` },
      payload => {
        console.log('[timerSync] realtime event:', payload.eventType, payload.new || payload.old || '');
        applyTimerSync(payload.new || payload.old || null);
      })
    .subscribe((status) => console.log('[timerSync] realtime status:', status));
}

/* ================= Views ================= */
const views = ['study', 'progress', 'friends', 'shop', 'settings', 'admin'];
let currentView = 'study';

let progressPane = 'stats';
function setProgressPane(pane) {
  progressPane = pane;
  document.querySelectorAll('.progress-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.pane === pane)
  );
  document.querySelectorAll('.progress-pane').forEach(p =>
    p.hidden = p.dataset.pane !== pane
  );
}

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
  if (name === 'progress') setProgressPane(progressPane);
  if (name === 'settings') syncSettingsUI();
  else if (name === 'study') renderTimerSync();
  else if (name === 'friends') loadFriends();
  else if (name === 'shop') { if (isShopAllowed()) openShop(); else switchView('study'); }
  else if (name === 'admin') { if (isAdmin()) { loadAdminStats(); loadAdminFeedback(); } else switchView('study'); }
  else if (name !== 'study') renderStatsAndFeed();
}

document.querySelectorAll('.nav-btn, .tab-btn').forEach(btn =>
  btn.addEventListener('click', () => switchView(btn.dataset.view))
);

document.querySelectorAll('.progress-tab').forEach(t =>
  t.addEventListener('click', () => setProgressPane(t.dataset.pane))
);

bindAdminUserEvents();

document.querySelectorAll('[data-goto]').forEach(btn =>
  btn.addEventListener('click', () => {
    if (btn.dataset.goto === 'progress' && btn.dataset.pane) progressPane = btn.dataset.pane;
    switchView(btn.dataset.goto);
  })
);

const $adminSettingsBtn = $('adminSettingsBtn');
if ($adminSettingsBtn) $adminSettingsBtn.addEventListener('click', () => switchView('admin'));

const $adminBackBtn = $('adminBackBtn');
if ($adminBackBtn) $adminBackBtn.addEventListener('click', () => switchView('settings'));

/* ================= Botões do cronômetro ================= */
let resetArmed = false;

$('startBtn').addEventListener('click', startTimer);
$('pauseBtn').addEventListener('click', pauseTimer);
$('saveBtn').addEventListener('click', openModal);
$('timerSyncResumeBtn').addEventListener('click', resumeTimerSync);

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
let goalStartKey = null;     // dia em que a meta passou a valer (chave YYYY-MM-DD)

/* Meta passa a valer do dia em diante: dias anteriores contam como cumpridos
   com qualquer estudo; a partir do dia/meta com a meta cheia. */
function ensureGoalStartKey() {
  if (goalStartKey) return;
  try {
    const v = localStorage.getItem(GOAL_DATE_KEY);
    if (v) { goalStartKey = v; return; }
  } catch { /* ignora */ }
  goalStartKey = dateKey(new Date());
  try { localStorage.setItem(GOAL_DATE_KEY, goalStartKey); } catch { /* ignora */ }
}
function dayThreshold(key) {
  return (goalStartKey && key < goalStartKey) ? 1 : dailyGoalSecs;
}

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

/* Estatísticas usadas para avaliar conquistas (do próprio usuário). */
function achievementStats() {
  const totalSecs = state.sessions.reduce((a, s) => a + (s.duration || 0), 0);
  return {
    sessions: state.sessions.length,
    totalSecs,
    bestStreak,
    goalsMet: rewardedDays.size
  };
}

/* Atualiza melhor sequência e desbloqueia conquistas novas (com toast). */
function updateAchievements() {
  const cur = calcStreak();
  if (cur > bestStreak) bestStreak = cur;
  const stats = achievementStats();
  const newly = [];
  ACHIEVEMENTS.forEach(a => {
    if (!unlockedAch.has(a.id) && a.check(stats)) {
      unlockedAch.add(a.id);
      shownAch.add(a.id);
      newly.push(a);
    }
  });
  if (newly.length > 0) {
    saveAchievements();
    pushAchievements(newly.map(a => a.id));
    pushShownAch();
    toast(`${newly.length > 1 ? 'Novas conquistas' : 'Nova conquista'} desbloqueada${newly.length > 1 ? 's' : ''}! 🏅 ${newly.map(a => a.name).join(', ')}`, 'success');
  } else if (cur > 0) {
    saveAchievements();
  }
}

/* Monta o grid de conquistas. `unlocked` = Set de ids desbloqueados (ou null p/ usar local). */
const MEDAL_TIER_COLORS = {
  bronze: { disk: '#cd7f32', inner: '#a8622a', rib: '#8a5a2b', light: '#e8b273' },
  silver: { disk: '#b8c0c8', inner: '#9aa4ad', rib: '#7d8790', light: '#d8e0e8' },
  gold:   { disk: '#e6b72e', inner: '#d19a12', rib: '#a67c10', light: '#f5d76e' },
  gem:    { disk: '#5aa7f0', inner: '#3d8be0', rib: '#2b66a8', light: '#a6d4ff' }
};

function medalSVG(tier, unlocked) {
  const c = MEDAL_TIER_COLORS[tier] || MEDAL_TIER_COLORS.bronze;
  const on = unlocked;
  const disk = on ? c.disk : '#3a3f49';
  const inner = on ? c.inner : '#2c3038';
  const rib = on ? c.rib : '#262a31';
  const light = on ? c.light : '#464c57';
  const op = on ? '1' : '0.4';
  return `<svg class="ach-medal${on ? '' : ' locked'}" viewBox="0 0 40 46" aria-hidden="true">
    <path d="M9 1 L16 15 L2 20 Z" fill="${rib}" opacity="${op}"/>
    <path d="M31 1 L24 15 L38 20 Z" fill="${rib}" opacity="${op}"/>
    <circle cx="20" cy="29" r="13.5" fill="${disk}" opacity="${op}"/>
    <circle cx="20" cy="29" r="10.5" fill="${inner}" opacity="${op}"/>
    <circle cx="20" cy="28.6" r="6.8" fill="none" stroke="${light}" stroke-width="1.1" opacity="${op}"/>
    <path d="M20 24.6 l1.4 3 3.2 .4 -2.4 2.2 .6 3.2 -2.8 -1.7 -2.8 1.7 .6 -3.2 -2.4 -2.2 3.2 -.4 z" fill="${light}" opacity="${op}"/>
  </svg>`;
}

function renderAchievements(container, showSet /* Set|null */) {
  if (!container) return;
  container.innerHTML = '';
  const ids = showSet || shownAch;
  const shown = ACHIEVEMENTS.filter(a => ids.has(a.id));
  if (!shown.length) return;
  shown.forEach(a => {
    const el = document.createElement('div');
    el.className = 'ach-item unlocked';
    el.title = `${a.name} — ${a.desc}`;
    const icon = document.createElement('div');
    icon.className = 'ach-icon';
    icon.innerHTML = medalSVG(a.tier, true);
    const info = document.createElement('div');
    info.className = 'ach-info';
    const name = document.createElement('span');
    name.className = 'ach-name';
    name.textContent = a.name;
    const desc = document.createElement('span');
    desc.className = 'ach-desc';
    desc.textContent = a.desc;
    info.append(name, desc);
    el.append(icon, info);
    container.appendChild(el);
  });
}

/* Renderiza a escolha das conquistas exibidas no perfil (painel de Ajustes).
   Mostra apenas as desbloqueadas; o usuário marca quais quer exibir. */
function renderShownAchievementPicker() {
  const box = $('profileAchievementsPick');
  if (!box) return;
  box.innerHTML = '';
  const unlocked = ACHIEVEMENTS.filter(a => unlockedAch.has(a.id));
  if (!unlocked.length) {
    box.innerHTML = '<p class="field-hint">Você ainda não desbloqueou nenhuma conquista. Complete sessões e sequências para ganhar medalhas.</p>';
    return;
  }
  unlocked.forEach(a => {
    const on = shownAch.has(a.id);
    const wrap = document.createElement('button');
    wrap.type = 'button';
    wrap.className = 'ach-pick' + (on ? ' on' : '');
    wrap.title = a.name + ' — ' + a.desc;
    wrap.dataset.id = a.id;
    wrap.innerHTML = `<span class="ach-pick-medal">${medalSVG(a.tier, on)}</span>
      <span class="ach-pick-name">${escapeHtml(a.name)}</span>
      <span class="ach-pick-check"><i class="ti ${on ? 'ti-check' : 'ti-plus'}"></i></span>`;
    wrap.addEventListener('click', () => toggleShownAchievement(a.id));
    box.appendChild(wrap);
  });
}

function toggleShownAchievement(id) {
  if (shownAch.has(id)) shownAch.delete(id); else shownAch.add(id);
  saveAchievements();
  pushShownAch();
  renderShownAchievementPicker();
  toast(shownAch.has(id) ? 'Conquista adicionada ao perfil.' : 'Conquista removida do perfil.');
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

  // Gráfico semanal alinhado à semana corrente (segunda a domingo)
  window._weekData = [...perDay.keys()].map(k => ({ total: perDay.get(k) }));
}

const STRIP_LABELS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

function renderWeekStrip(perDay) {
  const row = $('weekStrip');
  if (!row) return;
  row.innerHTML = '';

  const today = dateKey(new Date());
  const keys = [...perDay.keys()];
  const daysDone = [...perDay.entries()].filter(([k, v]) => v >= dayThreshold(k)).length;

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

    if (secs >= dayThreshold(key)) {
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

  // Matéria / assunto
  const cellSubject = document.createElement('div');
  cellSubject.className = 'hc-subject';
  const h4 = document.createElement('h4');
  h4.className = 'hc-subject-name';
  h4.textContent = session.subject;

  const p = document.createElement('p');
  p.className = 'hc-topic';
  p.textContent = session.topic || '';
  cellSubject.append(h4, p);

  // Observação (expandida, de cima pra baixo, quebra de linha natural)
  if (session.obs) {
    const obs = document.createElement('p');
    obs.className = 'hc-obs';
    obs.textContent = session.obs;
    cellSubject.appendChild(obs);
  }

  // Tempo
  const cellTime = document.createElement('div');
  cellTime.className = 'hc-time';
  const strong = document.createElement('strong');
  strong.textContent = fmtHM(session.duration);
  cellTime.appendChild(strong);

  // Questões
  const cellQ = document.createElement('div');
  cellQ.className = 'hc-questions';
  const qBadge = document.createElement('span');
  qBadge.className = 'badge';
  qBadge.textContent = session.qTotal > 0 ? `${session.qRight}/${session.qTotal}` : '—';
  cellQ.appendChild(qBadge);

  // Horário
  const cellClock = document.createElement('div');
  cellClock.className = 'hc-clock';
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = new Date(session.dateISO).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  cellClock.appendChild(meta);

  // Ações (editar/excluir só no histórico completo; na Home não polui)
  const cellActions = document.createElement('div');
  cellActions.className = 'hc-actions';

  if (showDelete) {
    const edit = document.createElement('button');
    edit.className = 'edit-btn';
    edit.title = 'Editar matéria / legenda / observação';
    edit.setAttribute('aria-label', `Editar sessão de ${session.subject}`);
    edit.dataset.id = session.id;
    edit.innerHTML = '<i class="ti ti-pencil"></i>';
    cellActions.appendChild(edit);

    const del = document.createElement('button');
    del.className = 'delete-btn';
    del.title = 'Excluir sessão';
    del.setAttribute('aria-label', `Excluir sessão de ${session.subject}`);
    del.dataset.id = session.id;
    del.textContent = '✕';
    cellActions.appendChild(del);
  }

  card.append(cellSubject, cellTime, cellQ, cellClock, cellActions);
  card.dataset.id = session.id;
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

// -------------------------------------------------------------
// Edição inline de matéria e legenda (tempo/horário não mudam)
// -------------------------------------------------------------
function beginEditSession(id, card) {
  const s = state.sessions.find(x => x.id === id);
  if (!s) return;
  if (!card) return;

  card.classList.add('editing');
  card.innerHTML = '';

  const form = document.createElement('div');
  form.className = 'hc-editor';

  const fSubject = document.createElement('div');
  fSubject.className = 'form-group';
  const lSubject = document.createElement('label');
  lSubject.setAttribute('for', `ed-subject-${id}`);
  lSubject.textContent = 'Matéria';
  const iSubject = document.createElement('input');
  iSubject.type = 'text';
  iSubject.id = `ed-subject-${id}`;
  iSubject.value = s.subject || '';
  iSubject.maxLength = 60;
  fSubject.append(lSubject, iSubject);

  const fTopic = document.createElement('div');
  fTopic.className = 'form-group';
  const lTopic = document.createElement('label');
  lTopic.setAttribute('for', `ed-topic-${id}`);
  lTopic.textContent = 'Legenda';
  const iTopic = document.createElement('input');
  iTopic.type = 'text';
  iTopic.id = `ed-topic-${id}`;
  iTopic.value = s.topic || '';
  iTopic.maxLength = 120;
  fTopic.append(lTopic, iTopic);

  const fObs = document.createElement('div');
  fObs.className = 'form-group hc-editor-obs';
  const lObs = document.createElement('label');
  lObs.setAttribute('for', `ed-obs-${id}`);
  lObs.textContent = 'Observação';
  const tObs = document.createElement('textarea');
  tObs.id = `ed-obs-${id}`;
  tObs.rows = 4;
  tObs.maxLength = 1000;
  tObs.placeholder = 'Observações da sessão (opcional)';
  tObs.value = s.obs || '';
  fObs.append(lObs, tObs);

  form.append(fSubject, fTopic, fObs);

  const err = document.createElement('p');
  err.className = 'field-error';
  err.id = `ed-err-${id}`;
  err.hidden = true;
  form.appendChild(err);

  const actions = document.createElement('div');
  actions.className = 'hc-editor-actions';
  const btnCancel = document.createElement('button');
  btnCancel.type = 'button';
  btnCancel.className = 'btn btn-sm';
  btnCancel.textContent = 'Cancelar';
  btnCancel.addEventListener('click', () => renderFeed());
  const btnSave = document.createElement('button');
  btnSave.type = 'button';
  btnSave.className = 'btn btn-primary btn-sm';
  btnSave.textContent = 'Salvar';
  btnSave.addEventListener('click', () => saveEditSession(id, err));
  actions.append(btnCancel, btnSave);
  form.appendChild(actions);

  card.appendChild(form);
  iSubject.focus();
}

async function saveEditSession(id, err) {
  const s = state.sessions.find(x => x.id === id);
  if (!s) return;
  const vSubject = $('ed-subject-' + id).value.trim();
  const vTopic = $('ed-topic-' + id).value.trim();
  const vObs = $('ed-obs-' + id).value.trim();
  if (!vSubject) {
    err.hidden = false;
    err.textContent = 'Informe a matéria.';
    return;
  }
  err.hidden = true;
  s.subject = vSubject;
  s.topic = vTopic;
  s.obs = vObs;
  saveState();
  await pushSession(s);
  renderFeed();
  renderHistory();
  populateFilterSubject();
  renderAll();
  toast('Sessão atualizada.', 'success');
}

// botão de editar (feed)
$('feedList').addEventListener('click', e => {
  const btn = e.target.closest('.edit-btn');
  if (btn) beginEditSession(btn.dataset.id, btn.closest('.history-item'));
});

/* ================= Stats ================= */
function renderStats() {
  // Gráfico semanal
  const chart = $('weekChart');
  chart.innerHTML = '';
  const week = window._weekData || [];
  const max = Math.max(...week.map(d => d.total), 1800);
  const labels = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
  const todayIdx = (new Date().getDay() + 6) % 7; // 0 = Seg ... 6 = Dom

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
function persistSession(session) {
  state.sessions.unshift(session);
  saveState();
  pushSession(session);
  pushSubjects([session.subject]);
  renderAll();
  toast(`Sessão salva: ${fmtHM(session.duration)} de ${session.subject}.`, 'success');
}
function confirmSaveSession(session) {
  persistSession(session);
  resetTimer();
  clearModalForm();
  modal.classList.remove('active');
  grantFocusRewards(session.duration);
}
const DAILY_POINTS_GOAL = 3600; // 1h de foco por dia
const DAILY_POINTS_BONUS = 10;  // bônus ao bater a meta
const PER_SESSION_POINTS = 5;   // cristais por sessão salva

function grantFocusRewards(durationSecs) {
  const rewards = [];
  addCrystals(PER_SESSION_POINTS);
  rewards.push({ amt: PER_SESSION_POINTS, label: 'sessão concluída' });

  const todayKey = dateKey(new Date());
  const todaysSecs = (state.sessions || [])
    .filter(s => dateKey(new Date(s.dateISO)) === todayKey)
    .reduce((a, s) => a + s.duration, 0);
  const key = 'crystalDailyGoal_' + todayKey;
  if (todaysSecs >= DAILY_POINTS_GOAL && !localStorage.getItem(key)) {
    localStorage.setItem(key, '1');
    addCrystals(DAILY_POINTS_BONUS);
    rewards.push({ amt: DAILY_POINTS_BONUS, label: 'meta diária de 1h' });
  }

  const total = rewards.reduce((a, r) => a + r.amt, 0);
  const txt = rewards.length > 1
    ? `+${total}${crystalIcon('0.9em')} (${rewards.map(r => `${r.amt} ${r.label}`).join(', ')})`
    : `+${total}${crystalIcon('0.9em')} (${rewards[0].label})`;
  toast(txt, 'success', true);
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

/* ================= Adicionar sessão manual (Histórico) ================= */
const amModal = document.getElementById('addSessionModal');

function populateAddSubjects() {
  const sel = $('amSubjectSelect');
  sel.innerHTML = '<option value="">Selecione...</option>';
  Object.keys(state.subjects).sort((a, b) => a.localeCompare(b, 'pt-BR')).forEach(sub => {
    const opt = document.createElement('option');
    opt.value = sub;
    opt.textContent = sub;
    sel.appendChild(opt);
  });
}

function openAddSession() {
  const today = dateKey(new Date());
  $('amDate').value = today;
  $('amTime').value = '';
  $('amDurH').value = '0';
  $('amDurM').value = '0';
  $('amDurS').value = '0';
  $('amNewSubjectInput').value = '';
  $('amNewTopicInput').value = '';
  $('amObsInput').value = '';
  $('amError').hidden = true;
  showAmQError('');
  populateAddSubjects();
  clearAddTopics();
  $('amToggleQuestions').checked = false;
  $('amQuestionsBox').hidden = true;
  amModal.classList.add('active');
  setTimeout(() => $('amNewSubjectInput').focus(), 50);
}

function closeAddSession() {
  amModal.classList.remove('active');
}

function clearAddTopics() {
  $('amTopicSelect').innerHTML = '<option value="">Selecione...</option>';
  $('amQTotal').value = '';
  $('amQWrong').value = '';
  $('amQRight').value = '0';
}

function showAmQError(msg) {
  const err = $('amQError');
  err.textContent = msg;
  err.hidden = !msg;
}

amModal.addEventListener('click', e => { if (e.target === amModal) closeAddSession(); });

$('amCancelBtn').addEventListener('click', closeAddSession);

$('amSubjectSelect').addEventListener('change', e => {
  const selected = e.target.value;
  const sel = $('amTopicSelect');
  sel.innerHTML = '<option value="">Selecione...</option>';
  (state.subjects[selected] || []).slice().sort((a, b) => a.localeCompare(b, 'pt-BR')).forEach(top => {
    const opt = document.createElement('option');
    opt.value = top;
    opt.textContent = top;
    sel.appendChild(opt);
  });
});

$('amToggleQuestions').addEventListener('change', e => {
  $('amQuestionsBox').hidden = !e.target.checked;
  showAmQError('');
});

function updateAmRightCount() {
  const total = parseInt($('amQTotal').value, 10) || 0;
  const wrong = parseInt($('amQWrong').value, 10) || 0;
  $('amQRight').value = Math.max(0, total - wrong);
}
$('amQTotal').addEventListener('input', updateAmRightCount);
$('amQWrong').addEventListener('input', updateAmRightCount);

$('addSessionBtn').addEventListener('click', openAddSession);

$('amSaveBtn').addEventListener('click', () => {
  const subject = $('amNewSubjectInput').value.trim() || $('amSubjectSelect').value;
  const topic = $('amNewTopicInput').value.trim() || $('amTopicSelect').value;

  if (!subject) {
    $('amError').textContent = 'Selecione ou crie uma matéria.';
    $('amError').hidden = false;
    $('amNewSubjectInput').focus();
    return;
  }

  const dH = Math.max(0, parseInt($('amDurH').value, 10) || 0);
  const dM = Math.max(0, parseInt($('amDurM').value, 10) || 0);
  const dS = Math.max(0, parseInt($('amDurS').value, 10) || 0);
  const duration = dH * 3600 + dM * 60 + dS;

  if (duration <= 0) {
    $('amError').textContent = 'Informe uma duração maior que zero.';
    $('amError').hidden = false;
    $('amDurH').focus();
    return;
  }

  const useQuestions = $('amToggleQuestions').checked;
  const qTotalV = useQuestions ? parseInt($('amQTotal').value, 10) || 0 : 0;
  const qWrongV = useQuestions ? parseInt($('amQWrong').value, 10) || 0 : 0;

  if (useQuestions && qTotalV === 0) {
    showAmQError('Informe o total de questões.');
    $('amQTotal').focus();
    return;
  }
  if (useQuestions && qWrongV > qTotalV) {
    showAmQError('Erradas não pode ser maior que o total.');
    $('amQWrong').focus();
    return;
  }

  if (!state.subjects[subject]) state.subjects[subject] = [];
  if (topic && !state.subjects[subject].includes(topic)) state.subjects[subject].push(topic);

  // data/horário escolhidos pelo usuário
  const dateStr = $('amDate').value;
  const timeStr = $('amTime').value || '00:00';
  let dateISO;
  if (dateStr) {
    dateISO = new Date(`${dateStr}T${timeStr || '00:00'}:00`).toISOString();
  } else {
    dateISO = new Date(Date.now() - duration * 1000).toISOString();
  }

  const session = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    dateISO,
    duration,
    subject,
    topic: topic || 'Geral',
    obs: $('amObsInput').value.trim(),
    qTotal: qTotalV,
    qRight: Math.max(0, qTotalV - qWrongV)
  };

  persistSession(session);
  pushSubjects([subject]);
  grantFocusRewards(duration);
  closeAddSession();
});

/* ================= Autenticação ================= */
function goToLogin() {
  window.location.href = '/login';
}
function goToApp() {
  window.location.href = '/';
}

$('donateBtn').addEventListener('click', e => {
  e.preventDefault();
  openDonation();
});

$('shopDonateBtn').addEventListener('click', () => {
  openDonation();
});

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
  prefs.theme = theme === 'light' ? 'light' : 'dark';
  document.body.classList.toggle('light', prefs.theme === 'light');
  if (persist) savePrefs();
  document.querySelectorAll('#themeSeg .seg-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.theme === prefs.theme));
}

function applyAccent(name, persist = true) {
  const p = PALETTES[name] || PALETTES.amber;
  prefs.accent = name;
  const root = document.documentElement.style;
  root.setProperty('--accent-color', p.accent);
  root.setProperty('--accent-hover', p.hover);
  root.setProperty('--accent-glow', p.glow);
  if (persist) savePrefs();
  document.querySelectorAll('.swatch').forEach(sw =>
    sw.classList.toggle('active', sw.dataset.palette === prefs.accent));
}

function loadGoal() {
  try {
    const mins = parseInt(localStorage.getItem(GOAL_KEY), 10);
    if (Number.isFinite(mins) && mins >= 5 && mins <= 720) {
      dailyGoalSecs = mins * 60;
      prefs.dailyGoal = mins;
    }
  } catch { /* ignora */ }
  ensureGoalStartKey();
}

/* Preferências sincronizadas na nuvem (tema/paleta/meta) */
let prefs = { theme: 'dark', accent: 'amber', dailyGoal: null };
let isPremium = false; // status premium do perfil (vem do cloud)
let privacy = { showSubjects: true };

function loadPrivacy() {
  try {
    const v = localStorage.getItem('foco.privacy.v1');
    if (v !== null) privacy.showSubjects = v !== '0';
  } catch { /* ignora */ }
  $('privacyShowSubjects').checked = privacy.showSubjects;
}

function savePrivacy(val) {
  privacy.showSubjects = val;
  localStorage.setItem('foco.privacy.v1', val ? '1' : '0');
  if (sb.client && sb.user) pushPrefs();
}

function savePrefs() {
  localStorage.setItem(THEME_KEY, prefs.theme);
  localStorage.setItem(ACCENT_KEY, prefs.accent);
  if (prefs.dailyGoal != null) localStorage.setItem(GOAL_KEY, String(prefs.dailyGoal));
  if (sb.client && sb.user) pushPrefs();
}

async function pushPrefs() {
  if (!sb.client || !sb.user) return;
  try {
    await sb.client.from('profiles').update({
      theme: prefs.theme,
      accent: prefs.accent,
      daily_goal: prefs.dailyGoal,
      privacy_show_subjects: privacy.showSubjects
    }).eq('user_id', sb.user.id);
  } catch (e) { console.error('pushPrefs:', e); }
}

/* Aplica preferências + Premium vindos do cloud ao aparelho atual */
function applyCloudPrefs(r) {
  if (!r) return;
  if (r.theme === 'light' || r.theme === 'dark') {
    prefs.theme = r.theme;
    localStorage.setItem(THEME_KEY, r.theme);
    applyTheme(r.theme, false);
  }
  if (typeof r.accent === 'string' && PALETTES[r.accent]) {
    prefs.accent = r.accent;
    localStorage.setItem(ACCENT_KEY, r.accent);
    applyAccent(r.accent, false);
  }
  if (Number.isFinite(r.daily_goal) && r.daily_goal >= 5 && r.daily_goal <= 720) {
    prefs.dailyGoal = r.daily_goal;
    dailyGoalSecs = r.daily_goal * 60;
    localStorage.setItem(GOAL_KEY, String(r.daily_goal));
    ensureGoalStartKey();
    renderAll();
  }
  if (typeof r.is_premium === 'boolean') {
    isPremium = r.is_premium;
    enforcePremiumGuard();
  }
  if (typeof r.privacy_show_subjects === 'boolean') {
    privacy.showSubjects = r.privacy_show_subjects;
    localStorage.setItem('foco.privacy.v1', r.privacy_show_subjects ? '1' : '0');
    $('privacyShowSubjects').checked = r.privacy_show_subjects;
  }
  if (Array.isArray(r.show_achievements)) {
    shownAch = new Set(r.show_achievements.filter(id => ACHIEVEMENTS.some(a => a.id === id)));
    shownAchLoaded = true;
    saveAchievements();
  }
}

function loadAppearance() {
  prefs.theme = 'dark';
  try { prefs.theme = localStorage.getItem(THEME_KEY) || 'dark'; } catch { /* ignora */ }
  prefs.accent = 'amber';
  try { prefs.accent = localStorage.getItem(ACCENT_KEY) || 'amber'; } catch { /* ignora */ }
  applyTheme(prefs.theme, false);
  applyAccent(prefs.accent, false);
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
  nameEl.innerHTML = `${escapeHtml(profile.displayName || (profile.username ? `@${profile.username}` : 'Seu nome'))}${ownerBadgeHTML(sb.user ? sb.user.id : null)}`;
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
  syncAdminButtons();
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
    const locked = !isPremium && (item.cost || 0) >= PREMIUM_COST;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'profile-border-opt' + (isEquipped ? ' active' : '') + (locked ? ' locked' : '');
    el.title = locked ? 'Requer Premium' : (isEquipped ? 'Em uso — clique para remover' : 'Clique para equipar');
    el.innerHTML = `
      <span class="profile-border-avatar">${shopPreviewAvatar()}</span>
      <span class="profile-border-name">${escapeHtml(borderName(item))}</span>
      ${isEquipped ? '<i class="ti ti-check profile-border-check"></i>' : (locked ? '<i class="ti ti-lock profile-border-lock"></i>' : '')}
    `;
    applyBorderTo(el.querySelector('.profile-border-avatar'), item.id);
    el.addEventListener('click', () => {
      if (locked) { toast('Este item é Premium. Você precisa ser Premium para usá-lo.', 'error'); return; }
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

function syncAdminButtons() {
  const admin = isAdmin();
  const btn = $('adminSettingsBtn');
  const divider = $('adminSettingsDivider');
  if (btn) btn.hidden = !admin;
  if (divider) divider.hidden = !admin;
  if (!admin && currentView === 'admin') switchView('study');
}

function fmtHM(secs) { const m = Math.floor((secs || 0) / 60); const h = Math.floor(m / 60); return h > 0 ? `${h}h ${m % 60}m` : `${m}m`; }

async function loadAdminStats() {
  if (!isAdmin()) return;
  const box = $('adminStats');
  if (!box) return;
  box.innerHTML = '<p class="muted-p">Carregando estatísticas…</p>';
  try {
    const { data: stats, error } = await sb.client.rpc('get_admin_stats');
    if (error) throw error;
    if (!stats) throw new Error('sem dados');
    const s = stats;
    const cards = [
      { l: 'Usuários', v: s.users },
      { l: 'Usuários ativos', v: s.active_users },
      { l: 'Sessões (total)', v: s.sessions },
      { l: 'Tempo total', v: fmtHM(s.seconds_total) },
      { l: 'Sessões hoje', v: s.sessions_today },
      { l: 'Tempo hoje', v: fmtHM(s.seconds_today) },
      { l: 'Feedbacks', v: s.feedback },
      { l: 'Cristais emitidos', v: s.crystals_total },
      { l: 'Itens vendidos', v: s.items_sold },
      { l: 'Amizades', v: s.friendships },
      { l: 'Pedidos de amizade', v: s.friend_requests }
    ];
    box.innerHTML = cards.map(c =>
      `<div class="stat-tile"><span class="stat-tile-val">${escapeHtml(String(c.v))}</span><span class="stat-tile-label">${escapeHtml(c.l)}</span></div>`
    ).join('');
  } catch (e) {
    console.error('loadAdminStats:', e);
    box.innerHTML = '<p class="muted-p">Não foi possível carregar (RPC get_admin_stats pode não ter sido criada).</p>';
  }
}

async function loadAdminFeedback() {
  if (!isAdmin()) return;
  const list = $('adminFeedbackList');
  if (!list) return;
  list.innerHTML = '<p class="muted-p">Carregando…</p>';
  try {
    const { data, error } = await sb.client.rpc('get_admin_feedback', { p_limit: 50 });
    if (error) throw error;
    const rows = data || [];
    if (!rows.length) { list.innerHTML = '<p class="muted-p">Nenhum feedback ainda.</p>'; return; }
    list.innerHTML = rows.map(f =>
      `<div class="feedback-row"><div class="feedback-head"><strong>${escapeHtml(f.username || 'Anônimo')}</strong><span class="muted-p feedback-date">${new Date(f.created_at).toLocaleString('pt-BR')}</span></div><div class="feedback-msg">${escapeHtml(f.message)}</div></div>`
    ).join('');
  } catch (e) {
    console.error('loadAdminFeedback:', e);
    list.innerHTML = '<p class="muted-p">Não foi possível carregar (RPC get_admin_feedback pode não ter sido criada).</p>';
  }
}

function borderCss(itemId) {
  if (!itemId) return '';
  const color = BORDER_COLORS[itemId];
  if (!color || EFFECT_FLAGS[color]) return '';
  return `box-shadow: 0 0 0 3px var(--bg-color), 0 0 0 6px ${color}, 0 0 14px ${color};`;
}

/* ================= GESTÃO DE USUÁRIOS (admin) ================= */
function switchAdminTab(which) {
  const isOverview = which === 'overview';
  $('adminOverview').hidden = !isOverview;
  $('adminUsers').hidden = isOverview;
  document.querySelectorAll('.admin-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.atab === which);
  });
  if (!isOverview && $('adminUserSearch').value) searchAdminUsers();
}

async function adminRpc(name, params) {
  const { data, error } = await sb.client.rpc(name, params);
  if (error) throw error;
  return data;
}

async function searchAdminUsers() {
  if (!isAdmin()) return;
  const box = $('adminUserResults');
  const raw = ($('adminUserSearch').value || '').trim();
  const q = raw.replace(/^@+/, '');
  if (!q) {
    box.innerHTML = '<p class="muted-p">Digite o @username completo ou o ID do usuário para buscar.</p>';
    return;
  }
  box.innerHTML = '<p class="muted-p">Buscando…</p>';
  try {
    const rows = (await adminRpc('admin_search_users', { p_q: q })) || [];
    if (!rows.length) { box.innerHTML = '<p class="muted-p">Nenhum usuário encontrado.</p>'; return; }
    box.innerHTML = rows.map(u => `
      <div class="admin-user-row" data-uid="${u.user_id}">
        <div class="admin-user-avatar">${u.avatar_url
          ? `<img src="${escapeHtml(u.avatar_url)}" alt="" onerror="this.remove()">`
          : (u.display_name || u.username || '?').slice(0,1).toUpperCase()}</div>
        <div class="admin-user-info">
          <strong>${escapeHtml(u.display_name || 'Sem nome')}${u.is_premium ? '<span class="premium-mini-badge" title="Premium"><i class="ti ti-crown"></i></span>' : ''}${ownerBadgeHTML(u.user_id)}</strong>
          <span class="muted-p">${u.username ? '@' + escapeHtml(u.username) : 'sem @username'} · ${u.sessions_count ?? 0} sessões</span>
        </div>
        <div class="admin-user-meta">
          <span title="Cristais">${crystalIcon('1em')} ${u.total_crystals ?? 0}</span>
          <span title="Pontos">· ${u.total_points ?? 0} pts</span>
        </div>
        <button class="btn btn-sm" data-openadmin="1">Gerenciar</button>
      </div>`).join('');
    box.querySelectorAll('.admin-user-row').forEach(row => {
      row.querySelector('[data-openadmin]').addEventListener('click', () => openAdminUser(row.dataset.uid));
    });
  } catch (e) {
    console.error('searchAdminUsers:', e);
    box.innerHTML = '<p class="muted-p">Não foi possível buscar (RPC admin_search_users pode não ter sido criada).</p>';
  }
}

async function openAdminUser(uid) {
  const editor = $('adminUserEditor');
  editor.hidden = false;
  editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('auMsg').textContent = 'Carregando…';
  try {
    const u = await adminRpc('admin_get_user', { p_user_id: uid });
    if (!u) { $('auMsg').textContent = 'Usuário sem perfil registrado.'; return; }
    $('adminEditorTitle').innerHTML =
      `Editar: ${escapeHtml(u.display_name || ('@' + (u.username || '...')))}${ownerBadgeHTML(uid)}`;
    $('auName').value = u.display_name || '';
    $('auUsername').value = u.username || '';
    $('auBio').value = u.bio || '';
    $('auCrystals').value = u.total_crystals ?? 0;
    $('auPoints').value = u.total_points ?? 0;
    editor._premiumState = !!u.is_premium;
    renderAdminPremiumState();
    if (!shopItems.length) await loadShopCatalog();
    fillAdminBorderSelect(u.border_id);
    $('auMsg').innerHTML =
      `${u.sessions_count ?? 0} sessões · ${u.rewards_count ?? 0} recompensas · streak ${u.streak ?? 0} dia(s) · ${crystalIcon('1em')} ${u.total_crystals ?? 0}`;
    editor._uid = uid;
  } catch (e) {
    console.error('openAdminUser:', e);
    editor.hidden = true;
    toast('Não foi possível carregar o usuário.', 'error');
  }
}

function fillAdminBorderSelect(selectedId) {
  const sel = $('auBorder');
  sel.innerHTML = '<option value="0">Nenhuma borda</option>'
    + (shopItems || []).map(i =>
      `<option value="${i.id}"${String(i.id) === String(selectedId) ? ' selected' : ''}>${escapeHtml(i.name)}</option>`).join('');
}

async function saveAdminProfile() {
  if (!isAdmin() || !$('adminUserEditor')._uid) return;
  const uid = $('adminUserEditor')._uid;
  $('auMsg').textContent = 'Salvando…';
  try {
    await adminRpc('admin_update_user', {
      p_user_id: uid,
      p_display_name: $('auName').value,
      p_username: $('auUsername').value,
      p_bio: $('auBio').value,
      p_border_id: parseInt($('auBorder').value, 10) || null,
    });
    $('auMsg').textContent = 'Perfil salvo com sucesso.';
    toast('Perfil atualizado.', 'success');
    searchAdminUsers();
    if (uid === sb.user.id) syncProfilePreview();
  } catch (e) {
    console.error('saveAdminProfile:', e);
    $('auMsg').textContent = 'Erro: ' + (e.message || 'falha ao salvar');
    toast('Erro ao salvar perfil.', 'error');
  }
}

async function saveAdminField(kind) {
  if (!isAdmin() || !$('adminUserEditor')._uid) return;
  const uid = $('adminUserEditor')._uid;
  const inp = kind === 'crystals' ? $('auCrystals') : $('auPoints');
  const val = parseInt(inp.value, 10);
  if (isNaN(val) || val < 0) { toast('Valor inválido.', 'error'); return; }
  try {
    if (kind === 'crystals') await adminRpc('admin_set_crystals', { p_user_id: uid, p_total: val });
    else await adminRpc('admin_set_points', { p_user_id: uid, p_total: val });
    $('auMsg').textContent = (kind === 'crystals' ? 'Cristais' : 'Pontos') + ' atualizados.';
    toast('Salvo.', 'success');
  } catch (e) {
    console.error('saveAdminField:', e);
    $('auMsg').textContent = 'Erro ao salvar.';
    toast('Erro ao salvar.', 'error');
  }
}

function renderAdminPremiumState() {
  const editor = $('adminUserEditor');
  const premium = !!editor._premiumState;
  const st = $('auPremiumStatus');
  const btn = editor.querySelector('[data-auaction="premium"]');
  if (st) { st.textContent = premium ? 'Ativo' : 'Não premium'; st.classList.toggle('is-on', premium); }
  if (btn) {
    btn.classList.toggle('btn-success', !premium);
    btn.innerHTML = premium
      ? '<i class="ti ti-crown-off"></i> Remover Premium'
      : '<i class="ti ti-crown"></i> Conceder Premium';
  }
}

async function toggleAdminPremium() {
  if (!isAdmin() || !$('adminUserEditor')._uid) return;
  const editor = $('adminUserEditor');
  const uid = editor._uid;
  const current = !!editor._premiumState;
  const ok = await confirmDialog({
    title: current ? 'Remover Premium' : 'Conceder Premium',
    text: current
      ? 'Remover o Premium deste usuário? Se ele estiver usando uma borda premium, ela será desequipada automaticamente.'
      : 'Conceder Premium a este usuário? Ele poderá equipar e usar os itens premium da loja.',
    okText: current ? 'Remover Premium' : 'Conceder Premium',
  });
  if (!ok) return;
  try {
    const r = await adminRpc('admin_set_premium', { p_user_id: uid, p_premium: !current });
    editor._premiumState = !!r && !!r.is_premium;
    renderAdminPremiumState();
    $('auMsg').textContent = current ? 'Premium removido e borda premium desequipada.' : 'Premium concedido!';
    toast(current ? 'Premium removido.' : 'Premium concedido!', 'success');
    searchAdminUsers();
  } catch (e) {
    console.error('toggleAdminPremium:', e);
    const em = (e && (e.message || e.error_description)) || 'erro desconhecido';
    $('auMsg').textContent = 'Erro ao alterar Premium: ' + em;
    toast('Erro ao alterar Premium.', 'error');
  }
}

async function resetAdminUser() {
  if (!isAdmin() || !$('adminUserEditor')._uid) return;
  const uid = $('adminUserEditor')._uid;
  const name = $('auName').value || 'este usuário';
  const ok = await confirmDialog({
    title: 'Limpar streak/conquistas',
    text: `Apagar TODAS as sessões e recompensas de ${name}, e zerar pontos e cristais? Essa ação não pode ser desfeita.`,
    okText: 'Limpar tudo',
  });
  if (!ok) return;
  $('auMsg').textContent = 'Limpando…';
  try {
    await adminRpc('admin_reset_user', { p_user_id: uid });
    $('auMsg').textContent = 'Streak, conquistas e cristais zerados.';
    toast('Usuário zerado.', 'success');
    openAdminUser(uid);
    searchAdminUsers();
  } catch (e) {
    console.error('resetAdminUser:', e);
    $('auMsg').textContent = 'Erro ao limpar.';
    toast('Erro ao limpar.', 'error');
  }
}

function bindAdminUserEvents() {
  document.querySelectorAll('.admin-tab').forEach(b =>
    b.addEventListener('click', () => switchAdminTab(b.dataset.atab)));
  $('adminUserSearchBtn').addEventListener('click', searchAdminUsers);
  $('adminUserSearch').addEventListener('keydown', e => { if (e.key === 'Enter') searchAdminUsers(); });
  document.querySelectorAll('[data-auaction]').forEach(b =>
    b.addEventListener('click', () => {
      const a = b.dataset.auaction;
      if (a === 'save') saveAdminProfile();
      else if (a === 'crystals') saveAdminField('crystals');
      else if (a === 'points') saveAdminField('points');
      else if (a === 'reset') resetAdminUser();
      else if (a === 'premium') toggleAdminPremium();
    }));
}

function effectType(itemId) {
  const color = BORDER_COLORS[itemId];
  if (!color || !EFFECT_FLAGS[color]) return null;
  return color;
}

function applyBorderTo(el, itemId) {
  if (!el) return;
  const type = effectType(itemId);
  if (type) {
    el.classList.add('border-eff');
    el.dataset.effect = type;
    el.removeAttribute('style');
    return;
  }
  el.classList.remove('border-eff');
  delete el.dataset.effect;
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
      applyCloudPrefs(data);
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

function ownerBadgeHTML(userId) {
  return ADMIN_USER_ID && userId === ADMIN_USER_ID
    ? ' <span class="owner-badge" title="Dono do site">Owner</span>'
    : '';
}

/* Coroa exibida ao lado do nome de quem é Premium */
function premiumBadgeHTML() {
  return ' <span class="premium-mini-badge" title="Premium"><i class="ti ti-crown"></i></span>';
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
        .select('user_id, username, display_name, avatar_url, bio, border_id, is_premium, privacy_show_subjects')
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
        .select('user_id, username, display_name, avatar_url, bio, border_id, is_premium')
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
    });
  } catch (e) { console.error('loadShopCatalog:', e); }
}

function applyShopState(data) {
  shopItems = (data.catalog || []).filter(i => i.category === 'border');
  shopItems.forEach(i => {
    BORDER_COLORS[i.id] = i.color;
  });
  crystals = data.crystals ?? 0;
  ownedItems = new Set(data.owned || []);
  equippedBorder = data.border ?? null;
  if (typeof data.is_premium === 'boolean') isPremium = data.is_premium;
  else if (data.is_premium == null) isPremium = false;
  enforcePremiumGuard();
}

/* Se o usuário não for Premium mas tiver uma borda premium equipada,
   desequipa localmente (o servidor já desequipa ao remover Premium). */
function enforcePremiumGuard() {
  if (isPremium || equippedBorder == null) return;
  const item = shopItems.find(i => i.id === equippedBorder && (i.cost || 0) >= PREMIUM_COST);
  if (!item) return;
  equippedBorder = null;
  if (currentView === 'shop') renderShop();
  renderProfileBorders();
  applyBorderTo($('avatarBtn'), null);
  applyBorderTo($('profileAvatarLabel'), null);
  syncProfileUI();
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
      sb.client.from('profiles').select('border_id, is_premium').eq('user_id', sb.user.id).maybeSingle()
    ]);
    crystals = bal?.total_crystals ?? 0;
    ownedItems = new Set((owned || []).map(o => o.item_id));
    equippedBorder = me?.border_id ?? null;
    isPremium = me?.is_premium ?? false;
    enforcePremiumGuard();
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

function crystalIcon(size) {
  const w = size || '1em';
  return `<svg class="crystal-ico" style="width:${w};height:${w}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <defs>
    <linearGradient id="geminiG" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#5B8CFF"/>
      <stop offset="52%" stop-color="#B96BFF"/>
      <stop offset="100%" stop-color="#FF5FD0"/>
    </linearGradient>
  </defs>
  <path d="M12 2 L18.6 7.6 L12 22 L5.4 7.6 Z" fill="url(#geminiG)"/>
  <path d="M5.4 7.6 H18.6 L12 11.2 Z" fill="rgba(255,255,255,0.16)"/>
  <path d="M12 11.2 L18.6 7.6 L17 20.4 Z" fill="rgba(0,0,0,0.10)"/>
  <path d="M12 4.4 V7.6 M8.6 5.8 L10.1 7.6 M15.4 5.8 L13.9 7.6" stroke="rgba(255,255,255,0.55)" stroke-width="1.1" stroke-linecap="round"/>
</svg>`;
}

async function addCrystals(amount) {
  if (!amount || amount <= 0) return crystals;
  crystals += amount;
  const chip = $('shopCrystalsChip');
  if (chip) chip.innerHTML = `${crystalIcon()} ${crystals}`;
  if (sb.client && sb.user) {
    try {
      const { data } = await sb.client.rpc('add_crystals', { p_amount: amount });
      if (typeof data === 'number' && Number.isFinite(data)) crystals = data;
    } catch (e) { console.warn('addCrystals:', e); }
  }
  return crystals;
}

/* ================= Troca de pontos por cristais ================= */
const EXCHANGE_RATE = POINTS_TO_CRYSTAL_RATE;

function exchangePreview() {
  const input = $('exchangePointsInput');
  const err = $('exchangeError');
  const ptsPreview = Number(input ? input.value : 0);
  const btn = $('exchangePointsBtn');
  if (err) err.hidden = true;
  if (!btn || !input) return;

  if (!Number.isFinite(ptsPreview) || ptsPreview <= 0) {
    if ($('exchangePreviewCrystals')) $('exchangePreviewCrystals').textContent = '0 cristais';
    btn.disabled = true;
    return;
  }
  if (ptsPreview % EXCHANGE_RATE !== 0) {
    if ($('exchangePreviewCrystals')) $('exchangePreviewCrystals').textContent = '—';
    btn.disabled = true;
    return;
  }
  const gain = ptsPreview / EXCHANGE_RATE;
  if ($('exchangePreviewCrystals')) $('exchangePreviewCrystals').textContent = `${gain} cristais`;
  btn.disabled = ptsPreview > getTotalPoints();
}

function bindExchangeUI() {
  const input = $('exchangePointsInput');
  const btn = $('exchangePointsBtn');
  if (!input || !btn) return;
  input.addEventListener('input', exchangePreview);
  btn.addEventListener('click', doExchange);
}

async function doExchange() {
  if (!sb.client || !sb.user) return;
  const input = $('exchangePointsInput');
  const err = $('exchangeError');
  const btn = $('exchangePointsBtn');
  const pts = Number(input.value);
  if (err) err.hidden = true;

  if (!Number.isFinite(pts) || pts <= 0) {
    if (err) { err.textContent = 'Informe a quantidade de pontos.'; err.hidden = false; }
    return;
  }
  if (pts % EXCHANGE_RATE !== 0) {
    if (err) { err.textContent = `A quantidade deve ser múltipla de ${EXCHANGE_RATE} pontos.`; err.hidden = false; }
    return;
  }
  if (pts > getTotalPoints()) {
    if (err) { err.textContent = 'Você não tem pontos suficientes.'; err.hidden = false; }
    return;
  }

  const gain = pts / EXCHANGE_RATE;
  const ok = await confirmDialog({
    title: 'Trocar pontos por cristais',
    text: `Trocar ${pts} pontos por ${gain} cristais? Essa ação não pode ser desfeita.`,
    okText: 'Trocar',
    okClass: 'btn-primary'
  });
  if (!ok) return;

  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader"></i> Trocando...';
  try {
    const { data, error } = await sb.client.rpc('exchange_points_to_crystals', {
      p_points: pts,
      p_rate: EXCHANGE_RATE
    });
    if (error) throw error;
    // o PostgREST pode devolver array com 1 elemento
    const d = Array.isArray(data) ? data[0] : data;
    // atualiza saldos locais com o que o servidor confirmou
    if (d && Number.isFinite(d.total_points)) userPoints = d.total_points;
    if (d && Number.isFinite(d.total_crystals)) crystals = d.total_crystals;
    // registra que os pontos usados (metas) estão "gastos" para não re-renderizar
    if (d && Array.isArray(d.removed_days)) {
      d.removed_days.forEach(k => {
        if (!k) return;
        rewardedDays.delete(k);
        spentRewardDays.add(k);
      });
    }
    localStorage.setItem(UPOINTS_KEY, userPoints);
    saveRewards();
    input.value = '';
    exchangePreview();
    toast(`Troca feita! +${gain} ${crystalIcon('0.9em')}`, 'success', true);
    const bal = $('exchangePointsBalance');
    if (bal) bal.textContent = String(getTotalPoints());
    renderAll();
    renderShop();
  } catch (e) {
    console.error('doExchange:', e);
    const em = (e.message || e.error_description || String(e) || '').toLowerCase();
    const raw = (e && (e.message || e.error_description)) || 'erro desconhecido';
    const amigavel = em.includes('insuficientes')
      ? 'Pontos insuficientes.'
      : (em.includes('múltipla') ? `Use múltiplos de ${EXCHANGE_RATE} pontos.` : raw);
    if (err) { err.textContent = amigavel; err.hidden = false; }
    toast('Troca falhou: ' + amigavel, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Trocar pontos por cristais';
    exchangePreview();
  }
}

// Atualiza o saldo de pontos exibido na loja e o painel de progresso
function refreshPointsUI() {
  renderMetrics();
  const bal = $('exchangePointsBalance');
  if (bal) bal.textContent = String(getTotalPoints());
}

function renderShop() {
  $('shopCrystalsChip').innerHTML = `${crystalIcon()} ${crystals}`;
  renderCrystalPackages();
  const grid = $('shopGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const normal = shopItems.filter(i => !effectType(i.id) && (i.cost || 0) < PREMIUM_COST);
  const animated = shopItems.filter(i => effectType(i.id) && (i.cost || 0) < PREMIUM_COST);
  const premium = shopItems.filter(i => (i.cost || 0) >= PREMIUM_COST);
  renderShopGroup(grid, 'Simples', normal);
  if (animated.length) renderShopGroup(grid, 'Animadas', animated);
  if (premium.length) {
    const hdr = document.createElement('div');
    hdr.className = 'shop-group-title premium-title';
    hdr.innerHTML = `<span>Premium</span><span class="premium-tag"><i class="ti ti-crown"></i> Exclusivas</span>`;
    grid.appendChild(hdr);
    premium.forEach(item => {
      const owned = ownedItems.has(item.id);
      const isEquipped = equippedBorder === item.id;
      const locked = !isPremium;
      const el = document.createElement('div');
      el.className = 'shop-item' + (isEquipped ? ' equipped' : '');
      el.classList.add('premium-item');
      let right;
      if (!owned) {
        right = locked
          ? `<span class="shop-lock" title="Requer Premium para comprar"><i class="ti ti-lock"></i></span>`
          : `<button class="btn btn-sm btn-crystal" data-act="buy" data-id="${item.id}">${crystalIcon()} ${item.cost}</button>`;
      } else if (locked) {
        right = `<span class="shop-lock" title="Requer Premium"><i class="ti ti-lock"></i></span>`;
      } else {
        right = `<span class="shop-check" title="Comprada"><i class="ti ti-circle-check-filled"></i></span>`;
      }
      el.innerHTML = `
        <div class="shop-avatar">${shopPreviewAvatar()}</div>
        <div class="shop-item-info">
          <span class="shop-item-name">${escapeHtml(borderName(item))}<span class="premium-badge"><i class="ti ti-crown"></i></span></span>
          <span class="shop-item-cost">${locked ? 'Requer Premium' : (owned ? (isEquipped ? 'Em uso' : 'Comprada') : 'Exclusiva')}</span>
        </div>
        ${right}
      `;
      applyBorderTo(el.querySelector('.shop-avatar'), item.id);
      grid.appendChild(el);
    });
    if (!isPremium) {
      const note = document.createElement('p');
      note.className = 'muted-p shop-premium-note';
      note.innerHTML = `<i class="ti ti-crown"></i> Para usar os itens <strong>Premium</strong> você precisa ser <strong>Premium</strong>.`;
      grid.appendChild(note);
    }
  }
  grid.querySelectorAll('button[data-act]').forEach(btn =>
    btn.addEventListener('click', () => {
      buyItem(Number(btn.dataset.id));
    })
  );
}

function renderShopGroup(grid, label, items) {
  const header = document.createElement('div');
  header.className = 'shop-group-title';
  header.textContent = label;
  grid.appendChild(header);
  items.forEach(item => {
    const owned = ownedItems.has(item.id);
    const isEquipped = equippedBorder === item.id;
    const el = document.createElement('div');
    el.className = 'shop-item' + (isEquipped ? ' equipped' : '');
    let right;
    if (!owned) {
      right = `<button class="btn btn-sm btn-crystal" data-act="buy" data-id="${item.id}">${crystalIcon()} ${item.cost}</button>`;
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
}

function renderCrystalPackages() {
  const grid = $('crystalPkgGrid');
  if (!grid) return;
  grid.innerHTML = CRYSTAL_PACKAGES.map(pk => `
    <div class="pkg-card${pk.premium ? ' premium-item' : ''}">
      <div class="pkg-top">
        <span class="pkg-amount">${crystalIcon('1em')} <strong>${pk.amount}</strong></span>
        ${pk.tag ? `<span class="pkg-bonus">${escapeHtml(pk.tag)}</span>` : ''}
      </div>
      <span class="pkg-label">${escapeHtml(pk.label)}</span>
      <button class="btn btn-sm btn-crystal" data-pkg="${pk.id}">Adicionar</button>
    </div>`).join('');
  grid.querySelectorAll('[data-pkg]').forEach(btn =>
    btn.addEventListener('click', onPackageClick));
}

function onPackageClick(e) {
  e.stopPropagation();
  const pk = CRYSTAL_PACKAGES.find(p => p.id === e.currentTarget.dataset.pkg);
  if (!pk) return;
  $('pkgModalName').textContent = pk.label;
  $('pkgModalText').innerHTML =
    `Este pacote dá ${pk.amount} cristais. A compra por dinheiro real ainda não está disponível — ` +
    `por enquanto você ganha cristais a cada sessão de foco.${crystalIcon('1em')}`;
  $('pkgModal').classList.add('active');
}

$('pkgModalCloseBtn').addEventListener('click', () => $('pkgModal').classList.remove('active'));
$('pkgModal').addEventListener('click', e => { if (e.target === $('pkgModal')) $('pkgModal').classList.remove('active'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('pkgModal').classList.remove('active'); });

async function openShop() {
  if (!sb.client || !sb.user) { switchView('study'); return; }
  const loading = $('shopLoading');
  if (loading) loading.hidden = false;
  await loadShop();
  renderShop();
  refreshPointsUI();
  if (loading) loading.hidden = true;
  applyBorderTo($('avatarBtn'), equippedBorder);
}

async function buyItem(itemId) {
  if (!sb.client || !sb.user) return;
  const it = shopItems.find(s => s.id === itemId);
  const name = it ? borderName(it) : 'este item';
  const cost = it ? ` por ${it.cost} cristais` : '';
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
    const em = (e.message || '').toLowerCase();
    if (em.includes('cristais insuficientes')) toast('Cristais insuficientes.', 'error');
    else if (em.includes('premium')) toast('Este item é Premium. Você precisa ser Premium para comprá-lo.', 'error');
    else toast('Não foi possível comprar.', 'error');
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
  } catch (e) {
    console.error('equipItem:', e);
    const msg = (e?.message || e?.error?.message || '').toLowerCase();
    if (msg.includes('premium')) toast('Este item é Premium. Você precisa ser Premium para usá-lo.', 'error');
    else toast('Não foi possível equipar.', 'error');
  }
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
        <span class="friend-name">${escapeHtml(friendLabel(f))}${f.is_premium ? premiumBadgeHTML() : ''}${ownerBadgeHTML(f.user_id)}</span>
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
        <span class="friend-name">${escapeHtml(friendLabel(p))}${p.is_premium ? premiumBadgeHTML() : ''}${ownerBadgeHTML(p.user_id)}</span>
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
  const isMe = sb.user && friendId === sb.user.id;
  const f = isMe ? null : (friendsCache.find(x => x.user_id === friendId) || {});

  if (isMe) {
    $('profileViewName').innerHTML = `${escapeHtml(profile.displayName || '@' + (profile.username || ''))}${isPremium ? premiumBadgeHTML() : ''}${ownerBadgeHTML(friendId)}`;
    $('profileViewUser').textContent = profile.username ? '@' + profile.username : '';
    const av = $('profileViewAvatar');
    av.innerHTML = profile.avatarUrl
      ? `<img src="${escapeHtml(profile.avatarUrl)}" alt="" onerror="this.remove()">`
      : ((profile.displayName || '?').slice(0, 1).toUpperCase());
    applyBorderTo(av, equippedBorder);
    const bioEl = $('profileViewBio');
    bioEl.textContent = profile.bio || '';
    bioEl.hidden = !profile.bio;
  } else {
    const name = f.display_name || ('@' + (f.username || ''));
    const user = f.username ? '@' + f.username : '';
    $('profileViewName').innerHTML = `${escapeHtml(name || 'Usuário')}${f.is_premium ? premiumBadgeHTML() : ''}${ownerBadgeHTML(friendId)}`;
    $('profileViewUser').textContent = user;
    const av = $('profileViewAvatar');
    av.innerHTML = f.avatar_url
      ? `<img src="${escapeHtml(f.avatar_url)}" alt="" onerror="this.remove()">`
      : ((f.display_name || '?').slice(0, 1).toUpperCase());
    applyBorderTo(av, f.border_id);
    const bioEl = $('profileViewBio');
    bioEl.textContent = f.bio || '';
    bioEl.hidden = !f.bio;
  }

  const statsEl = $('profileViewStats');
  statsEl.hidden = true;
  const divEl = $('profileViewDivider');
  divEl.hidden = true;
  const achWrap = $('profileAchievementsWrap');
  achWrap.hidden = true;
  $('profileModal').classList.add('active');

  const achContainer = $('profileAchievements');
  if (achContainer) achContainer.innerHTML = '';

  if (isMe) {
    const totalPoints = getTotalPoints();
    const curStreak = calcStreak();
    const totalSecs = state.sessions.reduce((a, s) => a + (s.duration || 0), 0);
    const monthSecs = state.sessions
      .filter(s => { const d = new Date(s.dateISO); const now = new Date(); const thirtyAgo = new Date(now); thirtyAgo.setDate(now.getDate() - 30); return d >= thirtyAgo; })
      .reduce((a, s) => a + s.duration, 0);
    const sessionsCount = state.sessions.length;

    $('pvPoints').textContent = String(totalPoints);
    $('pvBest').textContent = String(bestStreak);
    $('pvToday').textContent = String(curStreak);
    $('pvMonth').textContent = fmtHM(monthSecs);
    $('pvCrystals').textContent = String(crystals);
    if ($('pvCrystalsTile')) $('pvCrystalsTile').hidden = false;
    $('pvStreak').textContent = String(curStreak);
    $('pvWeek').textContent = fmtHM(totalSecs);
    $('pvSessions').textContent = String(sessionsCount);
    statsEl.hidden = false;
    divEl.hidden = false;
    renderAchievements(achContainer, shownAch);
    achWrap.hidden = shownAch.size === 0;
  } else {
    const s = await loadFriendStats(friendId);
    if (s && f.privacy_show_subjects !== false) {
      $('pvPoints').textContent = String(s.total_points ?? 0);
      $('pvBest').textContent = String(s.best_streak ?? 0);
      $('pvToday').textContent = String(s.streak ?? 0);
      $('pvMonth').textContent = '—';
      if ($('pvCrystalsTile')) $('pvCrystalsTile').hidden = true; // cristais são privados
      $('pvStreak').textContent = String(s.streak ?? 0);
      $('pvWeek').textContent = fmtHM(s.week_seconds ?? 0);
      $('pvSessions').textContent = String(s.total_sessions ?? 0);
      statsEl.hidden = false;
      divEl.hidden = false;
      if (s.achievements && Array.isArray(s.achievements)) {
        renderAchievements(achContainer, new Set(s.achievements));
        achWrap.hidden = s.achievements.length === 0;
      }
    }
  }
}

$('profileViewCloseBtn').addEventListener('click', closeProfileModal);
$('profileModal').addEventListener('click', e => {
  if (e.target === $('profileModal')) closeProfileModal();
});
$('menuMyProfile').addEventListener('click', () => {
  if (sb.user) openProfileModal(sb.user.id);
  $('userMenu').hidden = true;
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
      .select('user_id, username, display_name, avatar_url, border_id, is_premium')
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
    $('friendResultName').innerHTML = `${escapeHtml(hit.display_name || '@' + hit.username)}${hit.is_premium ? premiumBadgeHTML() : ''}`;
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
    localStorage.removeItem(GOAL_DATE_KEY);
    localStorage.removeItem(REWARDS_KEY);
    localStorage.removeItem(PENDING_KEY);
    profile = { displayName: '', username: '', avatarUrl: '', usernameUpdatedAt: null, bio: '' };
    dailyGoalSecs = 30 * 60;
    goalStartKey = null;
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
    localStorage.removeItem(GOAL_DATE_KEY);
    localStorage.removeItem(REWARDS_KEY);
    localStorage.removeItem(PENDING_KEY);
    profile = { displayName: '', username: '', avatarUrl: '', usernameUpdatedAt: null, bio: '' };
    dailyGoalSecs = 30 * 60;
    goalStartKey = null;
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
  renderShownAchievementPicker();
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
    prefs.dailyGoal = v;
    goalStartKey = dateKey(new Date());
    try { localStorage.setItem(GOAL_DATE_KEY, goalStartKey); } catch { /* ignora */ }
    savePrefs();
    renderAll();
    toast(`Meta diária definida: ${v} min.`, 'success');
  });

  $('exportCsvBtn').addEventListener('click', exportCsv);

  $('privacyShowSubjects').addEventListener('change', e => {
    savePrivacy(e.target.checked);
    toast(e.target.checked ? 'Amigos verão suas estatísticas.' : 'Estatísticas ocultas para amigos.', 'success');
  });

  $('sendFeedbackBtn').addEventListener('click', sendFeedback);

  const profileCardToggle = $('profileCardToggle');
  if (profileCardToggle) {
    profileCardToggle.addEventListener('click', () => {
      const body = $('profileCardBody');
      const open = body.hidden;
      body.hidden = !open;
      profileCardToggle.setAttribute('aria-expanded', String(!body.hidden));
    });
  }

  syncSettingsUI();
}

async function sendFeedback() {
  const input = $('feedbackInput');
  const hint = $('feedbackHint');
  const msg = (input.value || '').trim();
  if (!msg) {
    if (hint) hint.textContent = 'Escreva uma mensagem antes de enviar.';
    input.focus();
    return;
  }
  if (!sb.client || !sb.user) {
    if (hint) hint.textContent = 'Conecte sua conta para enviar feedback.';
    return;
  }
  const btn = $('sendFeedbackBtn');
  btn.disabled = true;
  btn.textContent = 'Enviando...';
  try {
    await sb.client.rpc('submit_feedback', { p_message: msg });
    input.value = '';
    if (hint) hint.textContent = '';
    toast('Feedback enviado! Obrigado pela opinião. 💬', 'success');
  } catch (e) {
    console.error('sendFeedback:', e);
    toast('Não foi possível enviar o feedback agora.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ti ti-send"></i> Enviar feedback';
  }
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
    if (sb.user && sb.client && !syncingNow && !bootTimer) syncFromCloud();
  }
});

/* ================= Render geral / boot ================= */
function renderAll() {
  updateAchievements();
  renderMetrics();
  renderHistory();
  renderFeed();
  renderTimerSync();
  if (!$('view-study').classList.contains('active')) renderStats();
}

loadState();
loadGoal();
loadTimer();
if (timer.running) startTick(); // retoma o loop de atualização após recarregar
loadAppearance();
loadPrivacy();
loadProfile();
loadRewards();
loadAchievements();
initCloud();
initSettingsUI();
bindExchangeUI();
initMiniTimer();
renderAll();

window.addEventListener('pageshow', e => {
  if (e.persisted) location.reload();
});

