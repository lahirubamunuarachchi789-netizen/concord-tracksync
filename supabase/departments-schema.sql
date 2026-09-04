-- ============================================================
-- Concord TrackSync - Supabase schema for the DEPARTMENTS mapping
-- Powers the strict standard-transaction sequence guards:
--   Rule 2: preceding sequence net count must be exactly +1
--   Rule 3: prospective net count (current + scan +/-1) must stay
--           between 0 and 1 inclusive (-1 scans are QC Returns)
--   Rule 4: parallel departments (SAME sequence) net count must be 0
-- Multiple departments share one sequence (e.g. Sequence 1 =
-- 'Upper Line 01'..'Upper Line 04', Sequence 3 = 'Lasting 01',
-- 'Lasting 02') - the guards always sum across the whole level.
-- Run in: Supabase Dashboard -> SQL Editor (idempotent)
-- ============================================================

-- 1. Exact table shape: id, department (text), sequence (integer).
create table if not exists departments (
  id        bigserial primary key,
  department text,
  sequence  integer
);

-- A department name must resolve to exactly one sequence level.
create unique index if not exists departments_department_key
  on departments (department);

-- 2. Row Level Security: the browser client only needs to read the
--    mapping to run the guards - no writes from the scanner UI.
alter table departments enable row level security;

drop policy if exists "tracksync_departments_select" on departments;
create policy "tracksync_departments_select"
  on departments for select
  to anon, authenticated
  using (true);

-- 3. Seed example (adjust to the real factory floor before use).
--    Sequence 1 has four parallel lines; Sequence 3 has two.
insert into departments (department, sequence)
values
  ('Upper Line 01', 1),
  ('Upper Line 02', 1),
  ('Upper Line 03', 1),
  ('Upper Line 04', 1),
  ('Lasting 01', 3),
  ('Lasting 02', 3)
on conflict (department) do nothing;

-- 4. Index for the guard sums: every check sums data_updates.count
--    for one qr_code across a set of departments.
create index if not exists data_updates_qr_code_department_idx
  on data_updates (qr_code, department);

-- ============================================================
-- NOTES
--  * previous_seq = the HIGHEST sequence strictly below the user's
--    current sequence (levels may be sparse, e.g. 1 -> 3 is legal).
--  * Standard scans write department = the logged-in user's
--    department string, exactly as stored here - keep the values in
--    "Loging Table"."Department" in sync with departments.department.
-- ============================================================