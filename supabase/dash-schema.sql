-- ============================================================
-- Concord TrackSync - Live Dashboard "dash" table
-- One row per department per production day (SLST calendar date).
-- Feeds the Live Dashboard metric cards, the horse-race header
-- (planed_qty is the finish-line target) and weekly plan achievement.
-- ============================================================

create table if not exists "dash" (
  id                 bigserial primary key,
  department         text not null,
  date               date not null,
  planed_qty         integer not null default 0,
  eficiancy          numeric not null default 0,
  available_man_power integer not null default 0,
  created_at         timestamptz not null default now(),

  constraint dash_department_date_unique unique (department, date)
);

create index if not exists dash_department_date_idx
  on "dash" (department, date);

-- Row Level Security: browser client reads the dashboard anonymously.
alter table "dash" enable row level security;

drop policy if exists "tracksync_dash_select" on "dash";
create policy "tracksync_dash_select"
  on "dash"
  for select
  to anon, authenticated
  using (true);

drop policy if exists "tracksync_dash_insert" on "dash";
create policy "tracksync_dash_insert"
  on "dash"
  for insert
  to anon, authenticated
  with check (true);