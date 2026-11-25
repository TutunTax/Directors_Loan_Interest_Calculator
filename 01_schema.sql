-- =====================================================================
-- Director & related-party loan interest — multi-tenant schema (Supabase)
-- Run this whole file once in: Supabase Dashboard -> SQL Editor -> New query
-- A "client" is a tenant (e.g. Precision Moulding & Moulds). Every client
-- table carries client_id and is protected by Row Level Security.
-- =====================================================================

-- ---------- tables ----------
create table if not exists public.platform_admins (          -- the practice owner(s): see and manage every client
  user_id uuid primary key references auth.users(id) on delete cascade
);

create table if not exists public.clients (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  short_name      text,
  fye_month       int  not null default 2 check (fye_month between 1 and 12),   -- financial year-end month
  expense_account text not null default '',                                     -- Sage ledger account debited with interest
  ref_prefix      text not null default 'INTJNL',                               -- journal reference prefix
  created_at      timestamptz not null default now()
);

create table if not exists public.client_members (
  client_id uuid not null references public.clients(id) on delete cascade,
  user_id   uuid not null references auth.users(id)   on delete cascade,
  role      text not null check (role in ('admin','staff','viewer')),
  created_at timestamptz not null default now(),
  primary key (client_id, user_id)
);
create index if not exists client_members_user_idx on public.client_members(user_id);

create table if not exists public.loan_accounts (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references public.clients(id) on delete cascade,
  sage_key            text not null,            -- lower-cased, single-spaced Sage account name (match key)
  sage_account_name   text not null,            -- as it appears on the Sage export
  label               text not null default '', -- short name used on journals/statements
  desc_prefix         text not null default '', -- e.g. "Interest Loan - M Steenekamp"
  sage_ledger_account text not null default '', -- Sage ledger account credited with interest
  created_at          timestamptz not null default now(),
  unique (client_id, sage_key)
);

create table if not exists public.loan_rate_rules (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.clients(id) on delete cascade,
  loan_account_id uuid not null references public.loan_accounts(id) on delete cascade,
  effective_from  date not null,
  basis           text not null check (basis in ('prime','fixed')),   -- prime + value, or fixed rate = value
  value           numeric(7,4) not null,
  unique (loan_account_id, effective_from)
);
create index if not exists loan_rate_rules_client_idx on public.loan_rate_rules(client_id);

create table if not exists public.prime_rates (               -- shared by all clients
  effective_from date primary key,                            -- first day the new prime rate applies
  rate           numeric(6,3) not null
);

create table if not exists public.interest_runs (             -- log of journals produced (audit trail)
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  as_at        date not null,
  reference    text not null,
  journal_date date not null,
  total        numeric(14,2) not null,
  lines        jsonb not null default '[]',
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);
create index if not exists interest_runs_client_idx on public.interest_runs(client_id, created_at desc);

-- ---------- helper functions (used by RLS) ----------
create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create or replace function public.is_member(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_platform_admin()
      or exists (select 1 from public.client_members where client_id = c and user_id = auth.uid());
$$;

create or replace function public.can_edit(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_platform_admin()
      or exists (select 1 from public.client_members where client_id = c and user_id = auth.uid() and role in ('admin','staff'));
$$;

create or replace function public.is_client_admin(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_platform_admin()
      or exists (select 1 from public.client_members where client_id = c and user_id = auth.uid() and role = 'admin');
$$;

-- ---------- row level security ----------
alter table public.platform_admins enable row level security;
alter table public.clients         enable row level security;
alter table public.client_members  enable row level security;
alter table public.loan_accounts   enable row level security;
alter table public.loan_rate_rules enable row level security;
alter table public.prime_rates     enable row level security;
alter table public.interest_runs   enable row level security;

drop policy if exists pa_self_read on public.platform_admins;
create policy pa_self_read on public.platform_admins for select to authenticated using (user_id = auth.uid());

drop policy if exists clients_read on public.clients;
create policy clients_read   on public.clients for select to authenticated using (public.is_member(id));
drop policy if exists clients_update on public.clients;
create policy clients_update on public.clients for update to authenticated using (public.can_edit(id)) with check (public.can_edit(id));
-- (clients are created through create_client(), never by direct insert)

drop policy if exists members_read on public.client_members;
create policy members_read on public.client_members for select to authenticated using (public.is_member(client_id));
-- (members are changed through add_member()/remove_member())

drop policy if exists la_read  on public.loan_accounts;
drop policy if exists la_write on public.loan_accounts;
create policy la_read  on public.loan_accounts for select to authenticated using (public.is_member(client_id));
create policy la_write on public.loan_accounts for all    to authenticated using (public.can_edit(client_id)) with check (public.can_edit(client_id));

drop policy if exists lr_read  on public.loan_rate_rules;
drop policy if exists lr_write on public.loan_rate_rules;
create policy lr_read  on public.loan_rate_rules for select to authenticated using (public.is_member(client_id));
create policy lr_write on public.loan_rate_rules for all    to authenticated using (public.can_edit(client_id)) with check (public.can_edit(client_id));

drop policy if exists prime_read  on public.prime_rates;
drop policy if exists prime_write on public.prime_rates;
create policy prime_read  on public.prime_rates for select to authenticated using (true);
create policy prime_write on public.prime_rates for all    to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists runs_read   on public.interest_runs;
drop policy if exists runs_insert on public.interest_runs;
create policy runs_read   on public.interest_runs for select to authenticated using (public.is_member(client_id));
create policy runs_insert on public.interest_runs for insert to authenticated with check (public.can_edit(client_id) and created_by = auth.uid());

-- ---------- privileges ----------
revoke all on all tables in schema public from anon;
grant select on public.platform_admins, public.clients, public.client_members, public.prime_rates to authenticated;
grant update on public.clients to authenticated;
grant select, insert, update, delete on public.loan_accounts, public.loan_rate_rules to authenticated;
grant insert, update, delete on public.prime_rates to authenticated;
grant select, insert on public.interest_runs to authenticated;

-- ---------- RPCs called by the app ----------
-- Create a new client (platform admins only). The caller becomes its admin.
create or replace function public.create_client(p_name text, p_short text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_platform_admin() then raise exception 'Only the practice owner can create clients'; end if;
  insert into public.clients(name, short_name) values (trim(p_name), nullif(trim(coalesce(p_short,'')),'')) returning id into v_id;
  insert into public.client_members(client_id, user_id, role) values (v_id, auth.uid(), 'admin') on conflict do nothing;
  return v_id;
end $$;

-- Give an existing Supabase user access to a client (client admins only).
create or replace function public.add_member(p_client uuid, p_email text, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid;
begin
  if not public.is_client_admin(p_client) then raise exception 'Not allowed'; end if;
  if p_role not in ('admin','staff','viewer') then raise exception 'Role must be admin, staff or viewer'; end if;
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email));
  if v_uid is null then raise exception 'No user with that email. Invite them first (Supabase > Authentication > Users > Invite user).'; end if;
  insert into public.client_members(client_id, user_id, role) values (p_client, v_uid, p_role)
  on conflict (client_id, user_id) do update set role = excluded.role;
end $$;

create or replace function public.remove_member(p_client uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_client_admin(p_client) then raise exception 'Not allowed'; end if;
  delete from public.client_members where client_id = p_client and user_id = p_user;
end $$;

create or replace function public.list_members(p_client uuid) returns table(user_id uuid, email text, role text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_client_admin(p_client) then raise exception 'Not allowed'; end if;
  return query select m.user_id, u.email::text, m.role from public.client_members m join auth.users u on u.id = m.user_id
               where m.client_id = p_client order by u.email;
end $$;

-- Save a client's settings + loan accounts + rate rules in one transaction.
-- security INVOKER: row level security still decides whether the caller may write.
create or replace function public.save_client_settings(p_client uuid, p jsonb) returns void
language plpgsql set search_path = public as $$
declare a jsonb; r jsonb; v_acc uuid;
begin
  update public.clients set
    expense_account = coalesce(p->'client'->>'expense_account', expense_account),
    ref_prefix      = coalesce(nullif(p->'client'->>'ref_prefix',''), ref_prefix),
    fye_month       = coalesce((p->'client'->>'fye_month')::int, fye_month)
  where id = p_client;
  if not found then raise exception 'Client not found or not allowed'; end if;

  for a in select * from jsonb_array_elements(coalesce(p->'accounts','[]'::jsonb)) loop
    insert into public.loan_accounts(client_id, sage_key, sage_account_name, label, desc_prefix, sage_ledger_account)
    values (p_client, a->>'sage_key', a->>'sage_account_name', coalesce(a->>'label',''), coalesce(a->>'desc_prefix',''), coalesce(a->>'sage_ledger_account',''))
    on conflict (client_id, sage_key) do update set
      sage_account_name = excluded.sage_account_name, label = excluded.label,
      desc_prefix = excluded.desc_prefix, sage_ledger_account = excluded.sage_ledger_account
    returning id into v_acc;

    delete from public.loan_rate_rules where loan_account_id = v_acc;
    for r in select * from jsonb_array_elements(coalesce(a->'rates','[]'::jsonb)) loop
      insert into public.loan_rate_rules(client_id, loan_account_id, effective_from, basis, value)
      values (p_client, v_acc, (r->>'from')::date, r->>'basis', (r->>'value')::numeric)
      on conflict (loan_account_id, effective_from) do update set basis = excluded.basis, value = excluded.value;
    end loop;
  end loop;
end $$;

-- Replace the shared prime-rate table (platform admins only, enforced by RLS).
create or replace function public.save_prime(p jsonb) returns void
language plpgsql set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Only the practice owner can change prime rates'; end if;
  delete from public.prime_rates where effective_from not in (select (x->>'from')::date from jsonb_array_elements(p) x);
  insert into public.prime_rates(effective_from, rate)
    select (x->>'from')::date, (x->>'rate')::numeric from jsonb_array_elements(p) x
  on conflict (effective_from) do update set rate = excluded.rate;
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
