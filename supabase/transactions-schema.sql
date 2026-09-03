-- ============================================================
-- Concord TrackSync - Supabase schema for STANDARD transactions
-- Flow: scanned MSK QR -> msk lookup (msk_qr -> org_qr, ONLY when
--            status = 'Active') -> strict guards -> data_updates insert
-- Tables used: msk         (id, msk_qr, org_qr, status)
--              departments (id, department, sequence) - see
--                          departments-schema.sql
--              data_updates (shared with the QR Activation flow)
-- Run in: Supabase Dashboard -> SQL Editor (idempotent)
-- ============================================================

-- 1. msk mapping table.
--    status gates every standard scan: ONLY 'Active' rows resolve a
--    scanned msk_qr to its org_qr ('Packed' / other statuses block).
create table if not exists msk (
  id     bigserial primary key,
  msk_qr text not null,
  org_qr text not null,
  status text not null default 'Active'
);

-- Migration for live tables created before the status column existed.
alter table msk add column if not exists status text;
-- Existing mappings stay scannable - everything already in the table
-- is treated as Active until explicitly marked otherwise.
update msk set status = 'Active' where status is null;
alter table msk alter column status set default 'Active';
alter table msk alter column status set not null;

-- A scanned MSK QR must map to exactly one org QR.
create unique index if not exists msk_msk_qr_key on msk (msk_qr);

-- 2. Standard-transaction records (shared with QR Activation).
--    The standard flow writes ONLY these columns:
--      qr_code       = org_qr resolved from the msk table
--      inner_qr      = Inner Box QR captured by the Dual-Scan process
--                      (Finishing departments; NULL for single scans
--                      and bypassed QC statuses)
--      record_status = 'IN' | 'OUT'
--      qc_status     = Forward | B Grade | C Grade | Lab Testing
--                      | Return | Reworked
--      created_at    = scan timestamp (now())
--      department    = logged-in user's department
--      count         = -1 when qc_status = 'Return', else 1
--      created_by    = logged-in user's username
create table if not exists data_updates (
  id            bigserial primary key,
  qr_code       text,
  inner_qr      text,
  record_status text,
  qc_status     text,
  created_at    timestamptz,
  department    text,
  count         integer,
  created_by    text
);

-- Migration for live tables created before the Dual-Scan feature:
-- the Inner Box QR captured in Finishing departments (nullable -
-- single scans and bypassed QC statuses store NULL).
alter table data_updates add column if not exists inner_qr text;

-- 3. Row Level Security
alter table msk enable row level security;
alter table data_updates enable row level security;

-- 4. Policies for the browser client (publishable/anon key)
--    a) msk: read-only - the lookup gate must never be writable
--       from the scanner UI.
drop policy if exists "tracksync_msk_select" on msk;
create policy "tracksync_msk_select"
  on msk for select
  to anon, authenticated
  using (true);

--    b) data_updates: transactions are append-only (no update /
--       delete policies by design).
drop policy if exists "tracksync_data_updates_insert" on data_updates;
create policy "tracksync_data_updates_insert"
  on data_updates for insert
  to anon, authenticated
  with check (true);

drop policy if exists "tracksync_data_updates_select" on data_updates;
create policy "tracksync_data_updates_select"
  on data_updates for select
  to anon, authenticated
  using (true);

-- ============================================================
-- NOTES
--  * The old "Transactions" table is deprecated - the app no
--    longer reads or writes it, and nothing here creates it.
--    Optional cleanup of a legacy install:
--      drop table if exists "Transactions";
--  * Offline scans queue in localStorage as
--    { client_ref, payload } and replay the same payload on sync.
--  * A scan with no msk row for the scanned QR is blocked before
--    any write; a queued legacy v1 entry that cannot be resolved
--    through msk is dropped at sync time.
-- ============================================================