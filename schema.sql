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

-- Colunas de sincronização (tema/paleta/meta) e Premium — idempotente
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'theme') then
    alter table public.profiles add column theme text not null default 'dark';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'accent') then
    alter table public.profiles add column accent text not null default 'amber';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'daily_goal') then
    alter table public.profiles add column daily_goal integer;
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'is_premium') then
    alter table public.profiles add column is_premium boolean not null default false;
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'privacy_show_subjects') then
    alter table public.profiles add column privacy_show_subjects boolean not null default true;
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

-- Upgrades de efeito (idempotente): merece bordas estáticas para efeitos animados
update public.shop_items set color = 'gold', cost = 400
  where name = 'Borda Dourada' and color <> 'gold';
update public.shop_items set color = 'ruby', cost = 350
  where name = 'Borda Rubi' and color <> 'ruby';
insert into public.shop_items (name, category, cost, color, sort_order) values
  ('Borda Prisma',   'border', 600, 'prism',    8)
on conflict (name) do nothing;

-- ══════════ Bordas PREMIUM (raras e animadas) ══════════
insert into public.shop_items (name, category, cost, color, sort_order) values
  ('Borda Ice',     'border', 1200, 'ice',     9),
  ('Borda Neon',    'border', 1500, 'neon',   10),
  ('Borda Aurora',  'border', 1500, 'aurora', 11),
  ('Borda Lava',    'border', 2000, 'lava',   12),
  ('Borda Cosmic',  'border', 2500, 'cosmic', 13)
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
  v_isp   boolean;
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
  select coalesce(is_premium, false) into v_isp from public.profiles where user_id = v_uid;

  return json_build_object(
    'catalog', v_cat,
    'crystals', v_bal,
    'owned', v_owned,
    'border', v_border,
    'is_premium', v_isp
  );
end;
$$;

-- Compra atômica: confere/bônus não aplicado + desconta cristais + registra item.
-- Itens premium (cost >= 1000) só podem ser comprados por quem é Premium.
create or replace function public.buy_item(p_item_id integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cost int;
  v_bal  int;
  v_is_premium boolean;
begin
  select cost into v_cost from public.shop_items where id = p_item_id;
  if not found then
    raise exception 'item não existe';
  end if;

  if v_cost >= 1000 then
    select coalesce(is_premium, false) into v_is_premium from public.profiles where user_id = auth.uid();
    if not v_is_premium then
      raise exception 'necessário ser Premium para comprar este item';
    end if;
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

-- Soma cristais ao saldo do usuário (recompensas por foco) e devolve o novo saldo
create or replace function public.add_crystals(p_amount int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new int;
begin
  if p_amount <= 0 then
    return (select coalesce(total_crystals, 0) from public.user_crystals where user_id = auth.uid());
  end if;

  insert into public.user_crystals (user_id, total_crystals)
  values (auth.uid(), 0) on conflict (user_id) do nothing;

  update public.user_crystals
     set total_crystals = total_crystals + p_amount,
         updated_at = now()
   where user_id = auth.uid()
   returning total_crystals into v_new;

  return v_new;
end;
$$;

-- Equipa uma borda que o usuário possui (itens premium exigem Premium)
create or replace function public.equip_border(p_item_id integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_need_premium boolean;
  v_is_premium   boolean;
begin
  if not exists (
    select 1 from public.user_items where user_id = auth.uid() and item_id = p_item_id
  ) then
    raise exception 'você não possui este item';
  end if;

  -- item é premium se custo >= 1000
  select (cost >= 1000) into v_need_premium from public.shop_items where id = p_item_id;
  if v_need_premium then
    select coalesce(is_premium, false) into v_is_premium from public.profiles where user_id = auth.uid();
    if not v_is_premium then
      raise exception 'necessário ser Premium para usar este item';
    end if;
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

-- Guarda: só dá pra equipar borda que o usuário realmente possui, e
-- itens premium (cost >= 1000) exigem Premium (do usuário alvo).
-- Bloqueia UPDATE burlado direto em profiles.border_id (protege a loja).
create or replace function public.guard_border_equip()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_need_premium boolean;
  v_isp   boolean;
  v_uid   uuid := auth.uid();
  v_admin uuid := '104915e0-319a-40db-a9f9-568bcaf2d456';
begin
  if new.border_id is not null and new.border_id is distinct from old.border_id then
    -- posse: usuário só equipa o que é dele; admin pode atribuir livremente
    if not exists (
      select 1 from public.user_items
      where user_id = v_uid and item_id = new.border_id
    ) and v_uid <> v_admin then
      raise exception 'você não possui esta borda';
    end if;

    -- itens premium (cost >= 1000) exigem Premium no usuário alvo do perfil
    select (cost >= 1000) into v_need_premium from public.shop_items where id = new.border_id;
    if v_need_premium then
      select coalesce(is_premium, false) into v_isp from public.profiles where user_id = new.user_id;
      if not v_isp then
        raise exception 'necessário ser Premium para usar este item';
      end if;
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

-- Feedback/opinião dos usuários ------------------------------------
create table if not exists public.feedback (
  id          bigserial primary key,
  user_id     uuid references auth.users (id) on delete set null,
  username    text,
  message     text not null,
  created_at  timestamptz not null default now()
);

alter table public.feedback enable row level security;

-- Qualquer autenticado pode enviar feedback; leitura fica restrita
-- (você lê direto no painel Supabase — tabela fechada para o público).
drop policy if exists "feedback: enviar" on public.feedback;
create policy "feedback: enviar"
  on public.feedback for insert
  to authenticated
  with check (auth.uid() = user_id);

-- RPC de envio (security definer): captura user_id + username sozinho
create or replace function public.submit_feedback(p_message text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
begin
  if p_message is null or length(trim(p_message)) = 0 then
    raise exception 'mensagem vazia';
  end if;

  select username into v_username from public.profiles where user_id = auth.uid();

  insert into public.feedback (user_id, username, message, created_at)
  values (auth.uid(), v_username, left(trim(p_message), 1000), now());
end;
$$;

-- ================= Painel Admin =================
-- Só o UID do dono pode chamar. Qualquer outro chama → erro (não vaza dados).
create or replace function public.get_admin_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin  uuid := '104915e0-319a-40db-a9f9-568bcaf2d456';
  v_users       int;
  v_active      int;
  v_sessions    int;
  v_seconds     bigint;
  v_sessions_today int;
  v_seconds_today  bigint;
  v_feedback    int;
  v_crystals    bigint;
  v_items       int;
  v_friends     int;
  v_requests    int;
begin
  if auth.uid() <> v_admin then
    raise exception 'acesso negado';
  end if;

  select count(*) into v_users      from public.profiles;
  select count(distinct user_id) into v_active from public.sessions;
  select count(*) into v_sessions   from public.sessions;
  select coalesce(sum(duration),0) into v_seconds from public.sessions;
  select count(*) into v_sessions_today from public.sessions where date_iso::date = current_date;
  select coalesce(sum(duration),0) into v_seconds_today from public.sessions where date_iso::date = current_date;
  select count(*) into v_feedback   from public.feedback;
  select coalesce(sum(total_crystals),0) into v_crystals from public.user_crystals;
  select count(*) into v_items      from public.user_items;
  select count(*) into v_friends    from public.friendships;
  select count(*) into v_requests   from public.friend_requests;

  return jsonb_build_object(
    'users',           v_users,
    'active_users',    v_active,
    'sessions',        v_sessions,
    'seconds_total',   v_seconds,
    'sessions_today',  v_sessions_today,
    'seconds_today',   v_seconds_today,
    'feedback',        v_feedback,
    'crystals_total',  v_crystals,
    'items_sold',      v_items,
    'friendships',     v_friends,
    'friend_requests', v_requests
  );
end;
$$;

-- Últimos feedbacks (admin)
create or replace function public.get_admin_feedback(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid := '104915e0-319a-40db-a9f9-568bcaf2d456';
  v_rows  jsonb;
begin
  if auth.uid() <> v_admin then
    raise exception 'acesso negado';
  end if;

  select coalesce(jsonb_agg(row_to_jsonb(t) order by t.created_at desc), '[]'::jsonb)
    into v_rows
    from (
      select f.id, f.username, f.message, f.created_at
      from public.feedback f
      order by f.created_at desc
      limit p_limit
    ) t;

  return v_rows;
end;
$$;


/* =========================================================
 *  GESTÃO DE USUÁRIOS (admin)
 *  Todas as funções exigem auth.uid() = UID da conta dona.
 * ========================================================= */

-- Busca usuários por nome/@username (parcial, case-insensitive)
create or replace function public.admin_search_users(p_q text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid := '104915e0-319a-40db-a9f9-568bcaf2d456';
  v_rows  jsonb;
  v_q     text;
begin
  if auth.uid() <> v_admin then
    raise exception 'acesso negado';
  end if;

  -- ignora o "@" opcional no termo de busca (user digita @shizouki)
  v_q := regexp_replace(coalesce(trim(p_q), ''), '^@+', '');

  select coalesce(jsonb_agg(t order by t.display_name asc), '[]'::jsonb)
    into v_rows
    from (
      select
        pr.user_id,
        pr.username,
        pr.display_name,
        pr.avatar_url,
        pr.border_id,
        pr.is_premium,
        coalesce(cr.total_crystals, 0) as total_crystals,
        coalesce(pn.total_points,  0)  as total_points,
        (select count(*) from public.sessions s where s.user_id = pr.user_id) as sessions_count
      from public.profiles pr
      left join public.user_crystals cr on cr.user_id = pr.user_id
      left join public.user_points   pn on pn.user_id = pr.user_id
      where length(v_q) >= 1
         and (
           lower(pr.username) = lower(v_q)
           or pr.user_id::text = v_q
           or lower(pr.display_name) = lower(v_q)
         )
      limit 50
    ) t;

  return v_rows;
end;
$$;

-- Detalhe completo de um usuário (incluindo streak atual)
create or replace function public.admin_get_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid := '104915e0-319a-40db-a9f9-568bcaf2d456';
  v_res   jsonb;
  v_streak int;
  v_last date;
  v_cur date;
  v_dayset date[];
begin
  if auth.uid() <> v_admin then
    raise exception 'acesso negado';
  end if;

  -- cálculo de streak: dias consecutivos com sessão, terminando hoje ou ontem
  v_streak := 0;
  select array_agg(d order by d desc) into v_dayset
    from (select distinct (date_iso::date) as d from public.sessions where user_id = p_user_id) t;

  if v_dayset is not null then
    select max(d) into v_last
      from (select distinct (date_iso::date) as d from public.sessions where user_id = p_user_id) t;
    if v_last >= current_date - 1 then
      v_cur := v_last;
      v_streak := 0;
      while v_cur is not null and array_position(v_dayset, v_cur) is not null loop
        v_streak := v_streak + 1;
        v_cur := v_cur - 1;
      end loop;
    end if;
  end if;

  select jsonb_build_object(
    'user_id',      pr.user_id,
    'username',     pr.username,
    'display_name', pr.display_name,
    'avatar_url',   pr.avatar_url,
    'bio',          pr.bio,
    'border_id',    pr.border_id,
    'is_premium',   pr.is_premium,
    'total_crystals', coalesce(cr.total_crystals, 0),
    'total_points',   coalesce(pn.total_points,  0),
    'sessions_count', (select count(*) from public.sessions s where s.user_id = pr.user_id),
    'rewards_count',  (select count(*) from public.rewards r where r.user_id = pr.user_id),
    'streak',       v_streak
  ) into v_res
  from public.profiles pr
  left join public.user_crystals cr on cr.user_id = pr.user_id
  left join public.user_points   pn on pn.user_id = pr.user_id
  where pr.user_id = p_user_id;

  -- conta pode não ter perfil ainda
  if v_res is null then
    return null;
  end if;

  return v_res;
end;
$$;

-- Edita dados do perfil de um usuário
create or replace function public.admin_update_user(
  p_user_id uuid,
  p_display_name text,
  p_username text,
  p_bio text,
  p_border_id int
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid := '104915e0-319a-40db-a9f9-568bcaf2d456';
begin
  if auth.uid() <> v_admin then
    raise exception 'acesso negado';
  end if;

  if p_username is null or length(trim(p_username)) = 0 then
    raise exception 'username obrigatorio';
  end if;

  -- username único (ignorando você mesmo)
  if exists (
    select 1 from public.profiles
    where username = trim(p_username) and user_id <> p_user_id
  ) then
    raise exception 'username ja em uso';
  end if;

  update public.profiles
     set display_name = coalesce(trim(p_display_name), ''),
         username     = trim(p_username),
         bio          = coalesce(p_bio, ''),
         border_id    = p_border_id,
         updated_at   = now()
   where user_id = p_user_id;

  if not found then
    raise exception 'usuario nao encontrado';
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- Define os cristais de um usuário
create or replace function public.admin_set_crystals(p_user_id uuid, p_total int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid := '104915e0-319a-40db-a9f9-568bcaf2d456';
begin
  if auth.uid() <> v_admin then
    raise exception 'acesso negado';
  end if;

  insert into public.user_crystals (user_id, total_crystals, updated_at)
  values (p_user_id, greatest(p_total,0), now())
  on conflict (user_id)
  do update set total_crystals = greatest(p_total,0), updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

-- Define os pontos de um usuário
create or replace function public.admin_set_points(p_user_id uuid, p_total int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid := '104915e0-319a-40db-a9f9-568bcaf2d456';
begin
  if auth.uid() <> v_admin then
    raise exception 'acesso negado';
  end if;

  insert into public.user_points (user_id, total_points, updated_at)
  values (p_user_id, greatest(p_total,0), now())
  on conflict (user_id)
  do update set total_points = greatest(p_total,0), updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

-- Limpa streak/conquistas: apaga sessões, recompensas e zera pontos/cristais
create or replace function public.admin_reset_user(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid := '104915e0-319a-40db-a9f9-568bcaf2d456';
begin
  if auth.uid() <> v_admin then
    raise exception 'acesso negado';
  end if;

  delete from public.sessions where user_id = p_user_id;
  delete from public.rewards  where user_id = p_user_id;

  insert into public.user_points   (user_id, total_points, updated_at)
  values (p_user_id, 0, now())
  on conflict (user_id) do update set total_points = 0, updated_at = now();

  insert into public.user_crystals (user_id, total_crystals, updated_at)
  values (p_user_id, 0, now())
  on conflict (user_id) do update set total_crystals = 0, updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

-- Define (ou remove) o status PREMIUM de um usuário.
-- Ao remover o Premium, desequipa automaticamente qualquer borda premium
-- que esteja ativa (o usuário mantém o item comprado, mas não pode usá-lo).
create or replace function public.admin_set_premium(p_user_id uuid, p_premium boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid := '104915e0-319a-40db-a9f9-568bcaf2d456';
begin
  if auth.uid() <> v_admin then
    raise exception 'acesso negado';
  end if;

  if not exists (select 1 from public.profiles where user_id = p_user_id) then
    raise exception 'usuario nao encontrado';
  end if;

  if p_premium then
    update public.profiles
       set is_premium = true, updated_at = now()
     where user_id = p_user_id;
  else
    -- remove o premium e desequipa bordas premium (cost >= 1000)
    update public.profiles
       set is_premium = false,
           border_id = case
             when (select cost from public.shop_items where id = profiles.border_id) >= 1000
             then null
             else border_id
           end,
           updated_at = now()
     where user_id = p_user_id;
  end if;

  return jsonb_build_object('ok', true, 'is_premium', p_premium);
end;
$$;



-- ============================================================
--  CONQUISTAS
-- ============================================================

create table if not exists public.achievements (
  user_id        uuid not null references auth.users (id) on delete cascade,
  achievement_id text not null,
  unlocked_at    timestamptz not null default now(),
  primary key (user_id, achievement_id)
);

alter table public.achievements enable row level security;

drop policy if exists "dono das conquistas" on public.achievements;
create policy "dono das conquistas"
  on public.achievements for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

alter publication supabase_realtime add table public.achievements;

-- Adicionar coluna best_streak no profiles (se ainda não existir)
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'best_streak') then
    alter table public.profiles add column best_streak integer not null default 0;
  end if;
end $$;

-- Adicionar coluna show_achievements no profiles (conquistas que o usuário
-- escolheu exibir no perfil; NULL = não configurado = mostra todas as
-- desbloqueadas; vazio [] = não mostra nenhuma)
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'show_achievements') then
    alter table public.profiles add column show_achievements text[];
  end if;
end $$;

-- ============================================================
--  ESTATÍSTICAS AGREGADAS DE UM AMIGO (só para quem é amigo).
--  Retorna pontos, sessões, tempo da semana, tempo de hoje,
--  sequência atual, melhor sequência e lista de conquistas.
-- ============================================================
drop function if exists public.get_friend_stats(uuid);
create or replace function public.get_friend_stats(friend_id uuid)
returns table (
  total_points bigint,
  total_sessions bigint,
  week_seconds bigint,
  today_seconds bigint,
  streak integer,
  best_streak integer,
  achievements text[]
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
  _best_streak integer := 0;
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

  select coalesce(b.best_streak, 0) into _best_streak
    from public.profiles b where b.user_id = friend_id;

  total_points := coalesce((select public.user_points.total_points from public.user_points where user_id = friend_id), 0);
  total_sessions := coalesce((select count(*)::bigint from public.sessions where user_id = friend_id), 0);
  week_seconds := coalesce((select sum(duration)::bigint from public.sessions
                             where user_id = friend_id and date_iso >= now() - interval '7 days'), 0);
  today_seconds := coalesce((select sum(duration)::bigint from public.sessions
                              where user_id = friend_id and date_iso >= date_trunc('day', now())), 0);
  streak := _streak;
  best_streak := _best_streak;
  achievements := case
    when (select b.show_achievements from public.profiles b where b.user_id = friend_id) is null then
      (select coalesce(array_agg(a.achievement_id), '{}'::text[])
         from public.achievements a where a.user_id = friend_id)
    else
      (select coalesce(array_agg(a.achievement_id), '{}'::text[])
         from public.achievements a
         where a.user_id = friend_id
           and a.achievement_id = any(
             (select b.show_achievements from public.profiles b where b.user_id = friend_id)
           ))
  end;
  return next;
end;
$$;

/* ============================================================
   TIMER SYNC  (pausar num aparelho e retomar em outro, mesmo dia)
   "Luz com 2 interruptores": o cronômetro pausado fica sincronizado
   entre PC e celular via Realtime.
   ============================================================ */
create table if not exists public.timer_sync (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  accumulated  integer not null default 0,   -- segundos acumulados quando pausado
  started_at   timestamptz,                  -- início da sessão (relógio ao vivo)
  paused_at    timestamptz,                  -- quando pausou
  running      boolean not null default false,
  day_key      text not null default '',     -- data de início -> regra "mesmo dia"
  updated_at   timestamptz default now()
);

alter table public.timer_sync enable row level security;

drop policy if exists timer_sync_select on public.timer_sync;
create policy timer_sync_select on public.timer_sync
  for select using (auth.uid() = user_id);

drop policy if exists timer_sync_insert on public.timer_sync;
create policy timer_sync_insert on public.timer_sync
  for insert with check (auth.uid() = user_id);

drop policy if exists timer_sync_update on public.timer_sync;
create policy timer_sync_update on public.timer_sync
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- habilita o Realtime (as mudanças chegam sozinhas nos aparelhos)
alter table public.timer_sync replica identity full;
alter publication supabase_realtime add table public.timer_sync;
