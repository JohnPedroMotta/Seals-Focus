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
  bio         text not null default '',
  updated_at  timestamptz not null default now(),
  constraint profiles_bio_maxlen check (char_length(bio) <= 150)
);

-- Coluna de Bio (texto livre, até 150 caracteres) — roda sem erro se já existir
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'bio') then
    alter table public.profiles add column bio text not null default '';
  end if;
end $$;

-- Garante a restrição de tamanho da bio mesmo se a tabela já existir
-- sem ela (idempotente).
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'profiles_bio_maxlen'
                   and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles
      add constraint profiles_bio_maxlen check (char_length(bio) <= 150);
  end if;
end $$;

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

-- Estatísticas agregadas de um amigo (só para quem é amigo).
-- Retorna pontos, sessões, tempo da semana, tempo de hoje e sequência.
-- NOTA: calcula os dias pelo servidor (UTC); pode haver pequena
-- defasagem de 1 dia perto da virada do fuso do usuário.
create or replace function public.get_friend_stats(friend_id uuid)
returns table (
  total_points bigint,
  total_sessions bigint,
  week_seconds bigint,
  today_seconds bigint,
  streak integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  _is_friend boolean;
  _cursor date;
  _d date;
  _streak integer := 0;
begin
  select exists(
    select 1 from public.friendships
    where (user_a = auth.uid() and user_b = friend_id)
       or (user_a = friend_id and user_b = auth.uid())
  ) into _is_friend;
  if not _is_friend then
    raise exception 'sem permissão para ver estas estatísticas';
  end if;

  if exists (select 1 from public.sessions where user_id = friend_id and (date_iso)::date = current_date) then
    _cursor := current_date;
  elsif exists (select 1 from public.sessions where user_id = friend_id and (date_iso)::date = current_date - 1) then
    _cursor := current_date - 1;
  else
    _cursor := null;
  end if;

  if _cursor is not null then
    loop
      select distinct (date_iso)::date into _d
      from public.sessions
      where user_id = friend_id and (date_iso)::date = _cursor;
      if not found then exit; end if;
      _streak := _streak + 1;
      _cursor := _cursor - 1;
    end loop;
  end if;

  total_points := coalesce((select public.user_points.total_points from public.user_points where user_id = friend_id), 0);
  total_sessions := coalesce((select count(*)::bigint from public.sessions where user_id = friend_id), 0);
  week_seconds := coalesce((select sum(duration)::bigint from public.sessions
                            where user_id = friend_id and date_iso >= now() - interval '7 days'), 0);
  today_seconds := coalesce((select sum(duration)::bigint from public.sessions
                             where user_id = friend_id and date_iso >= date_trunc('day', now())), 0);
  streak := _streak;
  return next;
end;
$$;

-- ============================================================
--  LOJA · Cristais + itens cosméticos (bordas de perfil)
-- ============================================================

-- Moeda da loja (cristais) — separada dos pontos
create table if not exists public.user_crystals (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  total_crystals integer not null default 0,
  updated_at     timestamptz not null default now()
);

-- Catálogo de itens da loja (bordas)
create table if not exists public.shop_items (
  id         serial primary key,
  name       text not null unique,
  category   text not null default 'border' check (category in ('border')),
  cost       integer not null default 0 check (cost >= 0),
  color      text not null default '',
  sort_order integer not null default 0
);

-- Garante UNIQUE em name mesmo se a tabela já existir (idempotente)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'shop_items_name_key'
      and conrelid = 'public.shop_items'::regclass
  ) then
    alter table public.shop_items add constraint shop_items_name_key unique (name);
  end if;
end $$;

-- Itens que cada usuário comprou
create table if not exists public.user_items (
  user_id     uuid not null references auth.users (id) on delete cascade,
  item_id     integer not null references public.shop_items (id) on delete cascade,
  purchased_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

-- Coluna do perfil: borda equipada no momento
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'border_id') then
    alter table public.profiles add column border_id integer
      references public.shop_items (id) on delete set null;
  end if;
end $$;

alter table public.user_crystals enable row level security;
alter table public.user_items enable row level security;

-- RLS: cristais/inventário só do dono
drop policy if exists "dono dos cristais" on public.user_crystals;
create policy "dono dos cristais"
  on public.user_crystals for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "dono dos itens" on public.user_items;
create policy "dono dos itens"
  on public.user_items for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Catálogo legível por qualquer usuário autenticado (loja pública)
alter table public.shop_items enable row level security;
drop policy if exists "loja legivel" on public.shop_items;
create policy "loja legivel"
  on public.shop_items for select
  to authenticated
  using (true);

-- Itens iniciais (bordas coloridas) — idempotente
insert into public.shop_items (name, category, cost, color, sort_order) values
  ('Borda Âmbar',    'border', 100, '#f0a63c', 1),
  ('Borda Esmeralda','border', 100, '#34d399', 2),
  ('Borda Safira',   'border', 100, '#38bdf8', 3),
  ('Borda Rubi',     'border', 150, '#f87171', 4),
  ('Borda Dourada',  'border', 250, '#facc15', 5),
  ('Borda Rosa',     'border', 150, '#f472b6', 6),
  ('Borda RGB',      'border', 500, 'rgb',      7)
on conflict (name) do nothing;

-- Saldo inicial de cristais (bônus único, idempotente)
-- Só concede quando o usuário NÃO tem linha ainda (primeira visita à loja)
create or replace function public.grant_starting_crystals()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_crystals (user_id, total_crystals)
  values (auth.uid(), 300)
  on conflict (user_id) do nothing;
end;
$$;

-- Estado completo da loja em UMA chamada (elimina vários round-trips).
-- Garante os cristais iniciais (300) e devolve catálogo + saldo +
-- inventário + borda equipada num único JSON.
create or replace function public.get_shop_state()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  v_cat   json;
  v_bal   int;
  v_owned json;
  v_border int;
begin
  insert into public.user_crystals (user_id, total_crystals)
  values (v_uid, 300) on conflict (user_id) do nothing;

  select coalesce(cat.j, '[]'::json)
    into v_cat
    from (
      select json_agg(json_build_object(
        'id', id, 'name', name, 'category', category, 'cost', cost, 'color', color
      ) order by sort_order) j
      from public.shop_items
    ) cat;

  select coalesce(total_crystals, 0) into v_bal
    from public.user_crystals where user_id = v_uid;

  select coalesce(ui.j, '[]'::json) into v_owned
    from (
      select json_agg(item_id) j
      from public.user_items where user_id = v_uid
    ) ui;

  select border_id into v_border from public.profiles where user_id = v_uid;

  return json_build_object(
    'catalog', v_cat,
    'crystals', v_bal,
    'owned', v_owned,
    'border', v_border
  );
end;
$$;

-- Compra atômica: confere/bônus não aplicado + desconta cristais + registra item
create or replace function public.buy_item(p_item_id integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cost int;
  v_bal  int;
begin
  select cost into v_cost from public.shop_items where id = p_item_id;
  if not found then
    raise exception 'item não existe';
  end if;

  select total_crystals into v_bal from public.user_crystals where user_id = auth.uid();
  if not found then
    v_bal := 0;
  end if;

  if exists (select 1 from public.user_items where user_id = auth.uid() and item_id = p_item_id) then
    raise exception 'você já possui este item';
  end if;

  if v_bal < v_cost then
    raise exception 'cristais insuficientes';
  end if;

  update public.user_crystals
     set total_crystals = total_crystals - v_cost,
         updated_at = now()
   where user_id = auth.uid();

  insert into public.user_items (user_id, item_id) values (auth.uid(), p_item_id);

  return true;
end;
$$;

-- Equipa uma borda que o usuário possui
create or replace function public.equip_border(p_item_id integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.user_items where user_id = auth.uid() and item_id = p_item_id
  ) then
    raise exception 'você não possui este item';
  end if;
  update public.profiles
     set border_id = p_item_id,
         updated_at = now()
   where user_id = auth.uid();
end;
$$;

-- Desequipa (remove borda ativa — "nenhuma")
create or replace function public.unequip_border()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
     set border_id = null,
         updated_at = now()
   where user_id = auth.uid();
end;
$$;

-- Guarda: só dá pra equipar borda que o usuário realmente possui.
-- Bloqueia UPDATE burlado direto em profiles.border_id (protege a loja).
create or replace function public.guard_border_equip()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.border_id is not null and new.border_id is distinct from old.border_id then
    if not exists (
      select 1 from public.user_items
      where user_id = auth.uid() and item_id = new.border_id
    ) then
      raise exception 'você não possui esta borda';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_border_equip on public.profiles;
create trigger trg_guard_border_equip
  before update on public.profiles
  for each row execute function public.guard_border_equip();

-- Função para excluir conta e todos os dados do usuário -----------
create or replace function delete_my_account()
returns void
language plpgsql
security definer
as $$
begin
  delete from public.user_points where user_id = auth.uid();
  delete from public.user_crystals where user_id = auth.uid();
  delete from public.user_items where user_id = auth.uid();
  delete from public.profiles where user_id = auth.uid();
  delete from public.rewards where user_id = auth.uid();
  delete from public.subjects where user_id = auth.uid();
  delete from public.sessions where user_id = auth.uid();
  delete from public.friendships where user_a = auth.uid() or user_b = auth.uid();
  delete from public.friend_requests where from_user = auth.uid() or to_user = auth.uid();
  delete from auth.users where id = auth.uid();
end;
$$;
