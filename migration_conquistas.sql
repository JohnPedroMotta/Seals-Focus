-- ============================================================
--  CONQUISTAS + ESTATÍSTICAS DE AMIGO  (rodar no SQL Editor)
--  Idempotente: seguro rodar de novo (if not exists / or replace)
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

-- Adicionar coluna show_achievements no profiles
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
