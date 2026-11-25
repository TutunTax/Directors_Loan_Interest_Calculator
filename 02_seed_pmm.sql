-- =====================================================================
-- Seed: shared prime-rate history + first client "Precision Moulding & Moulds (PMM)"
-- BEFORE running: create your login in Supabase (Authentication > Users > Add user),
-- then put that same email below. Run in the SQL Editor (it runs as postgres).
-- =====================================================================
do $$
declare
  v_email  text := 'johan@tutin.co.za';          -- <<< your Supabase login email
  v_uid    uuid;
  v_client uuid;
  v_acc    uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(v_email);
  if v_uid is null then raise exception 'Create the user % in Supabase Authentication first', v_email; end if;

  insert into public.platform_admins(user_id) values (v_uid) on conflict do nothing;

  -- Prime lending rate: first day each rate applies (banks apply a change the day after the SARB announcement)
  insert into public.prime_rates(effective_from, rate) values
    ('2021-11-19',7.25),('2022-01-28',7.50),('2022-03-25',7.75),('2022-05-20',8.25),('2022-07-22',9.00),('2022-09-23',9.75),
    ('2022-11-25',10.50),('2023-01-27',10.75),('2023-03-31',11.25),('2023-05-26',11.75),('2024-09-20',11.50),('2024-11-22',11.25),
    ('2025-01-31',11.00),('2025-05-30',10.75),('2025-08-01',10.50),('2025-11-21',10.25),('2026-05-29',10.50)
  on conflict (effective_from) do update set rate = excluded.rate;

  -- Client: PMM
  select id into v_client from public.clients where short_name = 'PMM';
  if v_client is null then
    insert into public.clients(name, short_name, fye_month) values ('Precision Moulding & Moulds (Pty) Ltd','PMM',2) returning id into v_client;
  end if;
  insert into public.client_members(client_id, user_id, role) values (v_client, v_uid, 'admin') on conflict do nothing;

  -- Loan accounts (sage_key = lower-case Sage account name with single spaces)
  insert into public.loan_accounts(client_id, sage_key, sage_account_name, label, desc_prefix)
  values (v_client,'directors loan - m. steenekamp','Directors Loan - M. Steenekamp','M Steenekamp','Interest Loan - M Steenekamp')
  on conflict (client_id, sage_key) do nothing;
  select id into v_acc from public.loan_accounts where client_id=v_client and sage_key='directors loan - m. steenekamp';
  insert into public.loan_rate_rules(client_id, loan_account_id, effective_from, basis, value) values (v_client, v_acc, '2021-11-29','prime',2) on conflict do nothing;

  insert into public.loan_accounts(client_id, sage_key, sage_account_name, label, desc_prefix)
  values (v_client,'directors loan - p kleinhans','Directors Loan - P Kleinhans','P Kleinhans','Interest Loan - P Kleinhans')
  on conflict (client_id, sage_key) do nothing;
  select id into v_acc from public.loan_accounts where client_id=v_client and sage_key='directors loan - p kleinhans';
  insert into public.loan_rate_rules(client_id, loan_account_id, effective_from, basis, value) values (v_client, v_acc, '2023-06-23','prime',2) on conflict do nothing;

  insert into public.loan_accounts(client_id, sage_key, sage_account_name, label, desc_prefix)
  values (v_client,'non current loan (m kleinhans)','Non Current Loan (M Kleinhans)','M Kleinhans','Interest Loan - M Kleinhans')
  on conflict (client_id, sage_key) do nothing;
  select id into v_acc from public.loan_accounts where client_id=v_client and sage_key='non current loan (m kleinhans)';
  insert into public.loan_rate_rules(client_id, loan_account_id, effective_from, basis, value) values (v_client, v_acc, '2025-01-21','prime',0) on conflict do nothing;
end $$;
