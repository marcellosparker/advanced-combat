-- Advanced Combat — online testing schema (Supabase / Postgres)
-- Run once in Supabase: SQL Editor → New query → paste → Run.
-- Safe to re-run: it creates what's missing and replaces policies/views.

-- ---------- PROFILES ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null unique
               check (char_length(display_name) between 3 and 20
                      and display_name ~ '^[A-Za-z0-9_ .-]+$'),
  created_at   timestamptz not null default now()
);

-- Create a profile automatically when someone signs up.
-- Uses the name they picked at sign-up, or "Commander-xxxx" if it's missing/taken.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  wanted text := coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), '');
  final  text;
begin
  if wanted ~ '^[A-Za-z0-9_ .-]{3,20}$'
     and not exists (select 1 from public.profiles where lower(display_name) = lower(wanted)) then
    final := wanted;
  else
    final := 'Commander-' || substr(replace(new.id::text, '-', ''), 1, 6);
  end if;
  insert into public.profiles (id, display_name) values (new.id, final);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- GAMES (one row per finished game vs the AI) ----------
create table if not exists public.games (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  won           boolean not null,
  player_co     text not null check (char_length(player_co) <= 20),
  ai_co         text not null check (char_length(ai_co) <= 20),
  days          int  not null check (days between 1 and 999),
  win_by        text check (win_by in ('hq', 'rout')),
  rank_letter   text check (rank_letter in ('S','A','B','C','D')),
  score         int  check (score between 0 and 100),
  fog           boolean not null default false,
  luck          boolean not null default true,
  map           text not null default 'crossroads' check (char_length(map) <= 40),
  stats         jsonb not null default '{}'::jsonb check (pg_column_size(stats) < 8000),
  client_version text check (char_length(client_version) <= 20),
  created_at    timestamptz not null default now()
);
create index if not exists games_user_idx on public.games(user_id, created_at desc);

-- ---------- FEEDBACK ----------
create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles(id) on delete set null,
  category    text not null check (category in ('bug','balance','idea','other')),
  message     text not null check (char_length(message) between 3 and 4000),
  context     jsonb not null default '{}'::jsonb check (pg_column_size(context) < 200000),
  user_agent  text check (char_length(user_agent) <= 400),
  client_version text check (char_length(client_version) <= 20),
  created_at  timestamptz not null default now()
);

-- ---------- ROW LEVEL SECURITY ----------
alter table public.profiles enable row level security;
alter table public.games    enable row level security;
alter table public.feedback enable row level security;

-- Profiles: anyone signed in can see display names (for the leaderboard);
-- you can only rename yourself.
drop policy if exists "profiles readable by signed-in" on public.profiles;
create policy "profiles readable by signed-in" on public.profiles
  for select to authenticated using (true);
drop policy if exists "update own profile" on public.profiles;
create policy "update own profile" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Games: you insert and read only your own. No updates or deletes from the client.
drop policy if exists "insert own games" on public.games;
create policy "insert own games" on public.games
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "read own games" on public.games;
create policy "read own games" on public.games
  for select to authenticated using (user_id = auth.uid());

-- Feedback: you can submit; nobody can read it from the client (you read it in the dashboard).
drop policy if exists "submit feedback" on public.feedback;
create policy "submit feedback" on public.feedback
  for insert to authenticated with check (user_id = auth.uid());

-- ---------- LEADERBOARD ----------
-- Aggregates only; runs with the view owner's rights so it can count everyone's games
-- without exposing individual game rows.
create or replace view public.leaderboard
with (security_invoker = false) as
select
  p.id                                         as user_id,
  p.display_name,
  count(g.id)::int                             as games,
  count(g.id) filter (where g.won)::int        as wins,
  round(100.0 * count(g.id) filter (where g.won) / nullif(count(g.id), 0))::int as win_rate,
  max(g.score) filter (where g.won)            as best_score,
  (array_agg(g.rank_letter order by g.score desc nulls last) filter (where g.won))[1] as best_rank,
  min(g.days) filter (where g.won)             as fastest_win
from public.profiles p
join public.games g on g.user_id = p.id
group by p.id, p.display_name;

revoke all on public.leaderboard from anon;
grant select on public.leaderboard to authenticated;
