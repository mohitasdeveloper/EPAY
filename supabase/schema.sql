-- Run in the EcoPay Supabase project's SQL editor.
-- Tables have RLS on and no policies, so the anon key can only use the functions below.
create table ep_profiles (
  student_id text primary key,
  name text not null,
  course text,
  dp_url text,
  kind text not null default 'user' check (kind in ('user', 'business')),
  balance integer not null default 0 check (balance >= 0),
  created_at timestamptz not null default now()
);
create table ep_tx (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  from_id text references ep_profiles(student_id),   -- null = reward from the club
  to_id text not null references ep_profiles(student_id),
  amount integer not null check (amount > 0),
  note text,
  title text
);
create table ep_notifications (
  id uuid primary key default gen_random_uuid(),
  to_id text not null references ep_profiles(student_id),
  title text not null,
  body text not null,
  seen boolean not null default false,
  created_at timestamptz not null default now()
);
alter table ep_profiles enable row level security;
alter table ep_tx enable row level security;
alter table ep_notifications enable row level security;

-- Business accounts (users can't log in as these). Add more as needed.
insert into ep_profiles (student_id, name, kind) values
  ('biz_green_cafe', 'Green Cafe', 'business'),
  ('biz_metro', 'Metro Transit', 'business');

-- Called on every app open: creates the profile from the URL params, or refreshes name/course/photo.
create or replace function ep_login(p_id text, p_name text, p_course text, p_dp text)
returns ep_profiles language sql security definer set search_path = public as $$
  insert into ep_profiles (student_id, name, course, dp_url) values (p_id, p_name, p_course, nullif(p_dp, ''))
  on conflict (student_id) do update set name = excluded.name, course = excluded.course, dp_url = excluded.dp_url
    where ep_profiles.kind = 'user'
  returning *;
$$;

create or replace function ep_people(p_id text)
returns table (student_id text, name text, course text, dp_url text, kind text)
language sql security definer set search_path = public as $$
  select p.student_id, p.name, p.course, p.dp_url, p.kind from ep_profiles p
  where p.student_id <> p_id order by (p.kind = 'business') desc, p.name limit 500;
$$;

create or replace function ep_feed(p_id text)
returns table (id uuid, created_at timestamptz, from_id text, to_id text, amount int, note text, title text,
               other_id text, other_name text, other_dp text, other_kind text)
language sql security definer set search_path = public as $$
  select t.id, t.created_at, t.from_id, t.to_id, t.amount, t.note, t.title, o.student_id, o.name, o.dp_url, o.kind
  from ep_tx t
  left join ep_profiles o on o.student_id = (case when t.from_id = p_id then t.to_id else t.from_id end)
  where t.from_id = p_id or t.to_id = p_id
  order by t.created_at desc limit 300;
$$;

create or replace function ep_transfer(p_from text, p_to text, p_amount int, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare bal int;
begin
  if p_amount <= 0 then raise exception 'Enter a valid amount'; end if;
  if p_from = p_to then raise exception 'You cannot pay yourself'; end if;
  select balance into bal from ep_profiles where student_id = p_from for update;
  if bal is null then raise exception 'Unknown sender'; end if;
  if bal < p_amount then raise exception 'Not enough EcoPoints'; end if;
  update ep_profiles set balance = balance + p_amount where student_id = p_to;
  if not found then raise exception 'Unknown recipient'; end if;
  update ep_profiles set balance = balance - p_amount where student_id = p_from;
  insert into ep_tx (from_id, to_id, amount, note) values (p_from, p_to, p_amount, nullif(trim(p_note), ''));
  insert into ep_notifications (to_id, title, body)
    select p_to, 'Points received', name || ' sent you ' || p_amount || ' EP' from ep_profiles where student_id = p_from;
end $$;

create or replace function ep_notifs(p_id text)
returns table (id uuid, title text, body text, seen boolean, created_at timestamptz)
language sql security definer set search_path = public as $$
  select n.id, n.title, n.body, n.seen, n.created_at from ep_notifications n
  where n.to_id = p_id order by n.created_at desc limit 50;
$$;

create or replace function ep_read(p_id text)
returns void language sql security definer set search_path = public as $$
  update ep_notifications set seen = true where to_id = p_id and not seen;
$$;

-- Admin only (SQL editor): select ep_credit('5213361', 150, 'Recycling Reward');
create or replace function ep_credit(p_id text, p_amount int, p_title text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update ep_profiles set balance = balance + p_amount where student_id = p_id;
  if not found then raise exception 'Unknown student'; end if;
  insert into ep_tx (from_id, to_id, amount, title) values (null, p_id, p_amount, p_title);
  insert into ep_notifications (to_id, title, body) values (p_id, 'Points received', 'You earned ' || p_amount || ' EP: ' || p_title);
end $$;
revoke execute on function ep_credit(text, int, text) from public, anon, authenticated;
