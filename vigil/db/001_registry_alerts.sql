-- Vigil: "newly listed" sex offender registry alerts that reach phones
-- even when the app is closed (Supabase project "Vigil").
--
-- Phones subscribe with an approximate area (rounded to about 1 km). Every
-- 15 minutes pg_cron asks the site to check each area's registry and push
-- anything new (002_watch_schedule.sql).
--
-- Nothing is readable through the public API: row level security is on with
-- no policies, and every function needs the watch secret, which only the
-- site holds (Vercel env WATCH_SECRET; here in private.settings, set by
-- hand, never committed).

create schema if not exists private;

create table private.settings (
  name text primary key,
  value text not null
);
alter table private.settings enable row level security;

create table public.push_subscriptions (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  state text not null,
  lat double precision not null, -- rounded to 0.01 degree
  lon double precision not null,
  radius_mi double precision not null,
  area_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index push_subscriptions_area_key on public.push_subscriptions (area_key);
alter table public.push_subscriptions enable row level security;

create table public.registry_areas (
  area_key text primary key,
  baseline_at timestamptz,
  last_checked timestamptz
);
alter table public.registry_areas enable row level security;

-- Registrant IDs seen per area (IDs only: no names, addresses or places),
-- dropped 14 days after they were last seen, per Iowa's terms.
create table public.registry_seen (
  area_key text not null,
  registrant_id text not null,
  last_seen timestamptz not null default now(),
  primary key (area_key, registrant_id)
);
alter table public.registry_seen enable row level security;

create or replace function private.watch_ok(p_secret text) returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce(length(p_secret) >= 32, false)
    and exists (select 1 from private.settings where name = 'watch_secret' and value = p_secret);
$$;

create or replace function public.vigil_subscribe(
  p_secret text, p_endpoint text, p_p256dh text, p_auth text,
  p_state text, p_lat double precision, p_lon double precision, p_radius_mi double precision
) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_lat double precision := round(p_lat::numeric, 2);
  v_lon double precision := round(p_lon::numeric, 2);
  v_key text;
begin
  if not private.watch_ok(p_secret) then raise exception 'not allowed'; end if;
  -- Only the browsers' push services; the site posts to this address.
  if length(p_endpoint) > 1000 or p_endpoint !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com|web\.push\.apple\.com)/' then
    raise exception 'unsupported push service';
  end if;
  if p_state !~ '^[A-Z]{2}$' or p_lat not between -15 and 72 or p_lon not between -180 and 180
     or p_radius_mi not between 0.5 and 10 or length(p_p256dh) > 200 or length(p_auth) > 100 then
    raise exception 'bad subscription';
  end if;
  v_key := p_state || ':' || v_lat || ',' || v_lon || ',' || p_radius_mi;
  insert into public.push_subscriptions (endpoint, p256dh, auth, state, lat, lon, radius_mi, area_key)
  values (p_endpoint, p_p256dh, p_auth, p_state, v_lat, v_lon, p_radius_mi, v_key)
  on conflict (endpoint) do update set
    p256dh = excluded.p256dh, auth = excluded.auth, state = excluded.state, lat = excluded.lat,
    lon = excluded.lon, radius_mi = excluded.radius_mi, area_key = excluded.area_key, updated_at = now();
  insert into public.registry_areas (area_key) values (v_key) on conflict do nothing;
  return v_key;
end;
$$;

create or replace function public.vigil_unsubscribe(p_secret text, p_endpoint text) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.watch_ok(p_secret) then raise exception 'not allowed'; end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;
end;
$$;

-- Areas someone is watching, least recently checked first. Areas nobody
-- watches any more are forgotten.
create or replace function public.vigil_watch_areas(p_secret text)
returns table (area_key text, state text, lat double precision, lon double precision, radius_mi double precision, subscribers bigint, baseline boolean)
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.watch_ok(p_secret) then raise exception 'not allowed'; end if;
  delete from public.registry_seen s where not exists (select 1 from public.push_subscriptions p where p.area_key = s.area_key);
  delete from public.registry_areas a where not exists (select 1 from public.push_subscriptions p where p.area_key = a.area_key);
  return query
    select a.area_key, min(p.state), min(p.lat), min(p.lon), min(p.radius_mi), count(*), a.baseline_at is not null
    from public.registry_areas a join public.push_subscriptions p on p.area_key = a.area_key
    group by a.area_key, a.baseline_at, a.last_checked
    order by a.last_checked nulls first;
end;
$$;

-- Records what an area's registry lists now and returns the IDs not seen
-- there before. The first look at an area only records what's there.
create or replace function public.vigil_watch_diff(p_secret text, p_area_key text, p_ids text[]) returns text[]
language plpgsql security definer set search_path = ''
as $$
declare
  v_baseline timestamptz;
  v_new text[];
begin
  if not private.watch_ok(p_secret) then raise exception 'not allowed'; end if;
  select baseline_at into v_baseline from public.registry_areas where area_key = p_area_key for update;
  if not found then return '{}'; end if;
  select coalesce(array_agg(i), '{}') into v_new
    from (select distinct unnest(p_ids) as i) ids
    where not exists (select 1 from public.registry_seen s where s.area_key = p_area_key and s.registrant_id = ids.i);
  insert into public.registry_seen (area_key, registrant_id, last_seen)
    select p_area_key, i, now() from (select distinct unnest(p_ids) as i) ids
    on conflict (area_key, registrant_id) do update set last_seen = now();
  delete from public.registry_seen where area_key = p_area_key and last_seen < now() - interval '14 days';
  update public.registry_areas set last_checked = now(), baseline_at = coalesce(baseline_at, now()) where area_key = p_area_key;
  if v_baseline is null then return '{}'; end if;
  return v_new;
end;
$$;

create or replace function public.vigil_area_subscribers(p_secret text, p_area_key text)
returns table (endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = ''
as $$
begin
  if not private.watch_ok(p_secret) then raise exception 'not allowed'; end if;
  return query select s.endpoint, s.p256dh, s.auth from public.push_subscriptions s where s.area_key = p_area_key;
end;
$$;
