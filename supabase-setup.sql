-- =========================================================
-- A PAGAMENTOS AUTOMÁTICOS  (rodar UMA única vez no Supabase)
-- SQL Editor do Supabase -> colar -> Run
-- =========================================================

-- 1) Log de pagamentos (impede creditar 2x e serve de auditoria)
create table if not exists public.payments_log (
  payment_id bigint primary key,
  user_id uuid not null,
  item_id text not null,
  amount_paid numeric not null default 0,
  credited_at timestamptz not null default now()
);

-- 2) Registrar o pagamento uma única vez (false se já existe)
create or replace function public.payment_record(
  p_payment_id bigint,
  p_user_id uuid,
  p_item_id text,
  p_amount numeric
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  insert into public.payments_log(payment_id, user_id, item_id, amount_paid)
  values (p_payment_id, p_user_id, p_item_id, p_amount)
  on conflict (payment_id) do nothing;
  return found;
end $$;

-- 3) Adicionar cristais (retorna o novo saldo)
create or replace function public.payment_add_crystals(
  p_user_id uuid,
  p_amount integer
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_total integer;
begin
  update public.user_crystals
     set total_crystals = total_crystals + p_amount
   where user_id = p_user_id;
  if not found then
    insert into public.user_crystals(user_id, total_crystals)
    values (p_user_id, p_amount);
  end if;
  select total_crystals into v_total from public.user_crystals where user_id = p_user_id;
  return v_total;
end $$;

-- 4) Ativar Premium
create or replace function public.payment_set_premium(p_user_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set is_premium = true where user_id = p_user_id;
  return found;
end $$;

-- 5) Só o service_role (webhook) chama estas funções; usuários comuns não
revoke execute on function public.payment_record(bigint, uuid, text, numeric) from anon, authenticated;
revoke execute on function public.payment_add_crystals(uuid, integer) from anon, authenticated;
revoke execute on function public.payment_set_premium(uuid) from anon, authenticated;
grant execute on function public.payment_record(bigint, uuid, text, numeric) to service_role;
grant execute on function public.payment_add_crystals(uuid, integer) to service_role;
grant execute on function public.payment_set_premium(uuid) to service_role;