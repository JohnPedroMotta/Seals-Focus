-- ============================================================
--  Foco · Setup do banco de dados (Supabase / PostgreSQL)
--  Como usar: no painel do seu projeto Supabase, abra
--  "SQL Editor" → "New query" → cole tudo isto → Run.
--  Idempotente: pode rodar de novo sem dar erro.
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

drop policy if exists "dono das sessoes" on public.sessions;
create policy "dono das sessoes"
  on public.sessions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "dono das materias" on public.subjects;
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

drop policy if exists "dono das recompensas" on public.rewards;
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

drop policy if exists "dono do perfil" on public.profiles;
create policy "dono do perfil"
  on public.profiles for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "perfil legivel por qualquer um" on public.profiles;
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

drop policy if exists "dono dos pontos" on public.user_points;
create policy "dono dos pontos"
  on public.user_points for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "pontos legiveis por qualquer um" on public.user_points;
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

drop policy if exists "user e amigo do outro" on public.friendships;
create policy "user e amigo do outro"
  on public.friendships for select
  to authenticated
  using (auth.uid() = user_a or auth.uid() = user_b);

drop policy if exists "qualquer membro desfaz" on public.friendships;
create policy "qualquer membro desfaz"
  on public.friendships for delete
  to authenticated
  using (auth.uid() = user_a or auth.uid() = user_b);

drop policy if exists "pode ler pedidos recebidos/enviados" on public.friend_requests;
create policy "pode ler pedidos recebidos/enviados"
  on public.friend_requests for select
  to authenticated
  using (auth.uid() = from_user or auth.uid() = to_user);

drop policy if exists "pode criar pedidos" on public.friend_requests;
create policy "pode criar pedidos"
  on public.friend_requests for insert
  to authenticated
  with check (auth.uid() = from_user);

drop policy if exists "destinatario pode responder" on public.friend_requests;
create policy "destinatario pode responder"
  on public.friend_requests for update
  to authenticated
  using (auth.uid() = to_user)
  with check (auth.uid() = to_user);

-- RPC: aceitar um pedido de amizade e criar a amizade mútua -------
-- 1) marca o convite como "accepted"
-- 2) insere a amizade (user_a < user_b)
-- Tudo na MESMA transação: se o insert falhar, o update é desfeito também.
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
  update public.friend_requests set status = 'accepted'
    where id = request_id;
  insert into public.friendships (user_a, user_b) values (a, b)
    on conflict (user_a, user_b) do nothing;
end;
$$;

-- Guarda de integridade: NINGUÉM cria amizade sem um convite aceito.
-- Mesmo que amanhã alguém adicione uma policy de INSERT em friendships,
-- este trigger continua vetando ligações sem convite aceito.
create or replace function public.guard_friendship_insert()
returns trigger
language plpgsql
security definer
as $$
begin
  if not exists (
    select 1 from public.friend_requests
    where status = 'accepted'
      and ((from_user = new.user_a and to_user = new.user_b)
        or (from_user = new.user_b and to_user = new.user_a))
  ) then
    raise exception 'amizade só pode ser criada a partir de um convite aceito';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_friendship_insert on public.friendships;
create trigger trg_guard_friendship_insert
  before insert on public.friendships
  for each row execute function public.guard_friendship_insert();

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
