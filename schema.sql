-- ============================================================
--  Foco · Setup do banco de dados (Supabase / PostgreSQL)
--  Como usar: no painel do seu projeto Supabase, abra
--  "SQL Editor" → "New query" → cole tudo isto → Run.
-- ============================================================

-- Sessões de estudo -------------------------------------------
create table if not exists public.sessions (
  id          uuid primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  date_iso    timestamptz not null,
  duration    integer not null check (duration >= 1),
  subject     text not null,
  topic       text not null default 'Geral',
  obs         text not null default '',
  q_total     integer not null default 0,
  q_right     integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists idx_sessions_user_date
  on public.sessions (user_id, date_iso desc);

-- Matérias e assuntos -----------------------------------------
create table if not exists public.subjects (
  user_id  uuid not null references auth.users (id) on delete cascade,
  name     text not null,
  topics   jsonb not null default '[]'::jsonb,
  primary key (user_id, name)
);

-- Segurança: cada usuário só acessa os PRÓPRIOS dados ----------
alter table public.sessions enable row level security;
alter table public.subjects enable row level security;

create policy "dono das sessoes"
  on public.sessions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "dono das materias"
  on public.subjects for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Dias recompensados (pontos) ----------------------------------
create table if not exists public.rewards (
  user_id  uuid not null references auth.users (id) on delete cascade,
  day_key  text not null,
  points   integer not null default 100,
  created_at timestamptz not null default now(),
  primary key (user_id, day_key)
);

alter table public.rewards enable row level security;

create policy "dono das recompensas"
  on public.rewards for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Perfil do usuário (nome + foto) --------------------------------
create table if not exists public.profiles (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  name      text not null default '',
  photo     text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "dono do perfil"
  on public.profiles for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
