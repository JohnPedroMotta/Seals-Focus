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

-- Perfil do usuário (nome + foto + ID) ---------------------------
create table if not exists public.profiles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  username    text unique,
  username_updated_at timestamptz,
  display_name text not null default '',
  avatar_url  text not null default '',
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "dono do perfil"
  on public.profiles for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "perfil legivel por qualquer um"
  on public.profiles for select
  to authenticated
  using (true);

create index if not exists idx_profiles_username
  on public.profiles (username);

-- Coluna para cooldown de troca de @username (14 dias)
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'username_updated_at') then
    alter table public.profiles add column username_updated_at timestamptz;
  end if;
end $$;

-- Pontos do usuário (total editável) -----------------------------
create table if not exists public.user_points (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  total_points integer not null default 0,
  updated_at   timestamptz not null default now()
);

alter table public.user_points enable row level security;

create policy "dono dos pontos"
  on public.user_points for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "pontos legiveis por qualquer um"
  on public.user_points for select
  to authenticated
  using (true);

-- Amizades -------------------------------------------------------
-- Guarda os pares por user_id (NÃO por username), então trocar o
-- @username não quebra a amizade. user_a < user_b evita duplicados.
create table if not exists public.friendships (
  user_a     uuid not null references auth.users (id) on delete cascade,
  user_b     uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a <> user_b)
);

-- Pedidos de amizade pendentes
create table if not exists public.friend_requests (
  id          uuid primary key default gen_random_uuid(),
  from_user   uuid not null references auth.users (id) on delete cascade,
  to_user     uuid not null references auth.users (id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending','accepted','rejected')),
  created_at  timestamptz not null default now(),
  unique (from_user, to_user)
);

alter table public.friendships enable row level security;
alter table public.friend_requests enable row level security;

create policy "user e amigo do outro"
  on public.friendships for select
  to authenticated
  using (auth.uid() = user_a or auth.uid() = user_b);

create policy "pode ler pedidos recebidos/enviados"
  on public.friend_requests for select
  to authenticated
  using (auth.uid() = from_user or auth.uid() = to_user);

create policy "pode criar pedidos"
  on public.friend_requests for insert
  to authenticated
  with check (auth.uid() = from_user);

create policy "destinatario pode responder"
  on public.friend_requests for update
  to authenticated
  using (auth.uid() = to_user)
  with check (auth.uid() = to_user);

-- RPC: aceitar um pedido de amizade e criar a amizade mútua -------
create or replace function accept_friend(request_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  r record;
  a uuid; b uuid;
begin
  select * into r from public.friend_requests where id = request_id
    and to_user = auth.uid() and status = 'pending' for update;
  if not found then
    raise exception 'pedido não encontrado';
  end if;
  a := r.from_user; b := r.to_user;
  if a > b then
    select a, b into b, a; -- normaliza para user_a < user_b
  end if;
  insert into public.friendships (user_a, user_b) values (a, b)
    on conflict (user_a, user_b) do nothing;
  update public.friend_requests set status = 'accepted'
    where id = request_id;
end;
$$;

-- Função para excluir conta e todos os dados do usuário -----------
create or replace function delete_my_account()
returns void
language plpgsql
security definer
as $$
begin
  delete from public.user_points where user_id = auth.uid();
  delete from public.profiles where user_id = auth.uid();
  delete from public.rewards where user_id = auth.uid();
  delete from public.subjects where user_id = auth.uid();
  delete from public.sessions where user_id = auth.uid();
  delete from public.friendships where user_a = auth.uid() or user_b = auth.uid();
  delete from public.friend_requests where from_user = auth.uid() or to_user = auth.uid();
  delete from auth.users where id = auth.uid();
end;
$$;
