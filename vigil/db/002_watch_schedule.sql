-- Every 15 minutes, ask the site to check every watched area for newly
-- listed registrants (api/registry-watch.js). Before this runs, set the
-- shared secret by hand (same value as Vercel's WATCH_SECRET):
--   insert into private.settings (name, value) values ('watch_secret', '...');
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule(
  'vigil-registry-watch',
  '*/15 * * * *',
  $$
  select net.http_get(
    url := 'https://vigil-mauve-one.vercel.app/api/registry-watch',
    headers := jsonb_build_object('x-vigil-watch', (select value from private.settings where name = 'watch_secret')),
    timeout_milliseconds := 60000
  );
  $$
);
