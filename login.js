'use strict';

const $ = id => document.getElementById(id);

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

let authMode = 'login';

function showAuthError(msg) {
  const err = $('authError');
  err.textContent = msg || '';
  err.hidden = !msg;
}

function setAuthMode(mode) {
  authMode = mode;
  $('authSubmitBtn').textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
  $('authSwitchBtn').textContent = mode === 'login'
    ? 'Não tem conta? Criar uma'
    : 'Já tem conta? Entrar';
  $('authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  showAuthError('');
}

let sbClient = null;

function initAuth() {
  if (typeof supabase === 'undefined' || typeof SUPABASE_URL === 'undefined') return;

  try {
    sbClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { flowType: 'implicit', detectSessionInUrl: true }
    });
  } catch (e) {
    console.error('Supabase:', e);
    return;
  }

  sbClient.auth.getSession().then(({ data }) => {
    if (data?.session?.user) {
      window.location.href = 'index.html';
    }
  });

  const savedEmail = localStorage.getItem('foco.remember.email') || '';
  $('authEmail').value = savedEmail;
}

$('authSwitchBtn').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'));

$('authPassEye').addEventListener('click', () => {
  const inp = $('authPass');
  const icon = $('authPassEye').querySelector('i');
  const isPass = inp.type === 'password';
  inp.type = isPass ? 'text' : 'password';
  icon.className = isPass ? 'ti ti-eye-off' : 'ti ti-eye';
});

$('authSubmitBtn').addEventListener('click', async () => {
  const email = $('authEmail').value.trim();
  const pass = $('authPass').value;

  if (!/^\S+@\S+\.\S+$/.test(email)) return showAuthError('Informe um e-mail válido.');
  if (pass.length < 6) return showAuthError('A senha precisa de pelo menos 6 caracteres.');
  if (!sbClient) return showAuthError('Serviço indisponível. Tente novamente.');

  const btn = $('authSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Aguarde...';

  try {
    const result = authMode === 'login'
      ? await sbClient.auth.signInWithPassword({ email, password: pass })
      : await sbClient.auth.signUp({ email, password: pass });

    if (result.error) throw result.error;

    if ($('rememberLogin').checked) {
      localStorage.setItem('foco.remember.email', email);
    } else {
      localStorage.removeItem('foco.remember.email');
    }

    if (authMode === 'signup' && !result.data.session) {
      toast('Conta criada! Confirme no e-mail que enviamos antes de entrar.', 'success');
    } else {
      toast(`Bem-vindo, ${email}!`, 'success');
      setTimeout(() => { window.location.href = 'index.html'; }, 500);
    }
  } catch (e) {
    const msg = (e.message || '').toLowerCase();
    if (authMode === 'login') {
      if (msg.includes('invalid login')) showAuthError('E-mail ou senha incorretos.');
      else if (msg.includes('not found')) showAuthError('Conta não encontrada. Crie uma conta primeiro.');
      else if (msg.includes('rate limit')) showAuthError('Muitas tentativas. Aguarde um momento.');
      else showAuthError(e.message || 'Falha no login.');
    } else {
      if (msg.includes('already registered')) showAuthError('Este e-mail já tem conta. Faça login.');
      else if (msg.includes('rate limit')) showAuthError('Muitas tentativas. Aguarde um momento.');
      else showAuthError(e.message || 'Falha ao criar conta.');
    }
  } finally {
    btn.disabled = false;
    $('authSubmitBtn').textContent = authMode === 'login' ? 'Entrar' : 'Criar conta';
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.activeElement?.id === 'authPass') {
    $('authSubmitBtn').click();
  }
});

initAuth();
