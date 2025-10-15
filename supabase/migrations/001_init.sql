-- Core entities
create extension if not exists pgcrypto;

create table if not exists team (
  id uuid primary key default gen_random_uuid(),
  name text not null
);

create table if not exists season (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  start_date date,
  end_date date
);

create table if not exists player (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references team(id) on delete cascade,
  shirt_number int,
  initials text
);

create table if not exists match (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references team(id) on delete cascade,
  season_id uuid references season(id) on delete set null,
  opponent text,
  kickoff_at timestamptz,
  half_length_minutes int default 10,
  max_on_field int default 8
);

create table if not exists match_player (
  id uuid primary key default gen_random_uuid(),
  match_id uuid references match(id) on delete cascade,
  player_id uuid references player(id) on delete cascade,
  is_starting boolean default false
);

create table if not exists playing_interval (
  id uuid primary key default gen_random_uuid(),
  match_id uuid references match(id) on delete cascade,
  player_id uuid references player(id) on delete cascade,
  start_ms int not null,
  end_ms int
);

do $$ begin
  create type event_kind as enum ('SUB','TRY','TACKLE','OTHER');
exception
  when duplicate_object then null;
end $$;

create table if not exists event (
  id uuid primary key default gen_random_uuid(),
  match_id uuid references match(id) on delete cascade,
  player_id uuid references player(id) on delete set null,
  at_ms int not null,
  kind event_kind not null,
  note text
);

-- Simple minutes rollup (view)
create or replace view v_player_minutes as
select
  p.id as player_id,
  pi.match_id,
  sum( (coalesce(pi.end_ms, 0) - pi.start_ms) ) as played_ms
from playing_interval pi
join player p on p.id = pi.player_id
group by p.id, pi.match_id;
