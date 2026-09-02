-- ============================================================
-- Concord TrackSync - Supabase schema for QR Activation
-- Tables: "PO"          (column `PO`) - live PO list table
--         pod           (po, mqc, size) - MQC lookup per PO/size
--         data_updates  - auto-submitted activation records
--         msk           (id, msk_qr, org_qr) - duplicate guard
-- Run in: Supabase Dashboard -> SQL Editor
--
-- Verified live on 2026-09-02: "PO", "pod", "data_updates" and
-- "msk" all exist (msk is currently empty). This script is
-- idempotent - it only guarantees the RLS setup the browser
-- client needs; the create-if-missing DDL is for fresh projects
-- and never alters the existing tables.
-- ============================================================

-- 1. PO list (shown in the activation dropdown)
create table if not exists "PO" (
  id         uuid primary key default gen_random_uuid(),
  "PO"       text not null,
  created_at timestamptz not null default now()
);

-- One PO number can only exist once (case-insensitive uniqueness
-- is enforced in the UI; the DB enforces exact uniqueness).
create unique index if not exists po_value_key on "PO" ("PO");

-- 2. pod - MQC lookup (read-only for the app).
--    Live shape: po text, mqc text, size (one row per PO/size).
--    The app queries: select mqc where po = [selected PO]
--    (preferring a po + size match) when building the qr_code.
create table if not exists pod (
  id    uuid primary key default gen_random_uuid(),
  po    text not null,
  mqc   text,
  size  text,
  created_at timestamptz not null default now()
);

-- 3. data_updates - activation records written on every scan.
--    Live shape (verified with a real insert + cleanup):
--      id           serial primary key
--      qr_code      text   ";mqc;po;size;scanned;"
--      record_status text  (IN | OUT)
--      qc_status    text   (Forward | B Grade | C Grade |
--                           Lab Testing | Return | Reworked)
--      created_at   timestamptz (scan time)
--      department   text   (logged-in user's department)
--      count        integer (-1 when qc_status = 'Return', else 1)
--      created_by   text   (logged-in user's username)
create table if not exists data_updates (
  id            serial primary key,
  qr_code       text not null,
  record_status text,
  qc_status     text,
  created_at    timestamptz not null default now(),
  department    text,
  count         integer not null default 1,
  created_by    text
);

create index if not exists data_updates_created_idx
  on data_updates (created_at desc);

-- 4. msk - duplicate activation guard (verified live: table exists).
--    Exact shape: id, msk_qr, org_qr - the old `status` column is
--    GONE and the app does not reference it.
--      msk_qr = raw scanned QR value
--      org_qr = formatted ";mqc;po;size;scanned;" string
--    A scan whose formatted string already exists in org_qr is
--    blocked before anything is written to either table.
create table if not exists msk (
  id     bigserial primary key,
  msk_qr text,
  org_qr text
);

create unique index if not exists msk_org_qr_key on msk (org_qr);

-- 5. Row Level Security
alter table "PO"          enable row level security;
alter table pod           enable row level security;
alter table data_updates  enable row level security;
alter table msk           enable row level security;

-- 6. Policies for the browser client (publishable/anon key)
drop policy if exists "tracksync_po_select" on "PO";
create policy "tracksync_po_select"
  on "PO" for select
  to anon, authenticated
  using (true);

drop policy if exists "tracksync_po_insert" on "PO";
create policy "tracksync_po_insert"
  on "PO" for insert
  to anon, authenticated
  with check (true);

drop policy if exists "tracksync_po_delete" on "PO";
create policy "tracksync_po_delete"
  on "PO" for delete
  to anon, authenticated
  using (true);

-- pod: read-only (MQC lookup)
drop policy if exists "tracksync_pod_select" on pod;
create policy "tracksync_pod_select"
  on pod for select
  to anon, authenticated
  using (true);

-- data_updates: the floor app inserts scans and reads them back
-- for the on-screen log. No delete/update by design.
drop policy if exists "tracksync_du_insert" on data_updates;
create policy "tracksync_du_insert"
  on data_updates for insert
  to anon, authenticated
  with check (true);

drop policy if exists "tracksync_du_select" on data_updates;
create policy "tracksync_du_select"
  on data_updates for select
  to anon, authenticated
  using (true);

-- msk: the duplicate guard is read on every scan and written on
-- every valid activation. No delete/update from the browser by
-- design (deactivating a QR is a manual DB operation).
drop policy if exists "tracksync_msk_select" on msk;
create policy "tracksync_msk_select"
  on msk for select
  to anon, authenticated
  using (true);

drop policy if exists "tracksync_msk_insert" on msk;
create policy "tracksync_msk_insert"
  on msk for insert
  to anon, authenticated
  with check (true);

-- ============================================================
-- NOTES
--  * qr_code format: ";mqc;po;size;scanned;" - when the PO has no
--    matching row in pod (or pod is unreachable) the MQC part is
--    empty, keeping the structure: ";;po;size;scanned;".
--  * count = -1 marks QC 'Return' records; every other QC status
--    writes count = 1.
--  * Duplicate prevention: before any write the app checks
--    msk.org_qr for the formatted string - a match blocks the
--    scan completely (nothing is written to data_updates or msk)
--    and the worker sees a "QR code has already been activated"
--    warning. The same check re-runs when flushing the offline
--    queue, so a queued scan can never be written twice.
--  * If the browser is offline the scan is queued in localStorage
--    and synced automatically once connectivity returns.
-- ============================================================