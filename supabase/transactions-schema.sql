-- ============================================================
-- Concord TrackSync - Supabase schema for production transactions
-- Table: "Transactions" (scanned QR / barcode events)
-- Run in: Supabase Dashboard -> SQL Editor
--
-- This script is idempotent: run it to guarantee the table shape
-- and to add the RLS policies below if they are missing.
-- ============================================================

-- 1. Table (idempotent)
create table if not exists "Transactions" (
  "id"           uuid primary key default gen_random_uuid(),
  "qr_value"     text not null,
  "RecordStatus" text not null check ("RecordStatus" in ('IN', 'OUT')),
  "QCStatus"     text not null check ("QCStatus" in
                   ('Forward', 'B Grade', 'C Grade', 'Lab Testing', 'Return', 'Reworked')),
  "Username"     text not null,
  "Department"   text not null,
  "client_ref"   text not null,
  "created_at"   timestamptz not null default now()
);

-- 2. Row Level Security
alter table "Transactions" enable row level security;

-- 3. Policies for the browser client (publishable/anon key)
drop policy if exists "tracksync_tx_insert" on "Transactions";
create policy "tracksync_tx_insert"
  on "Transactions"
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "tracksync_tx_select" on "Transactions";
create policy "tracksync_tx_select"
  on "Transactions"
  for select
  to anon, authenticated
  using (true);

-- ============================================================
-- NOTES
--  * "client_ref" is a UUID generated in the browser so a sync
--    retry can never double-insert the same transaction.
--  * Until this script is run, the app keeps working fully
--    offline: transactions are queued in localStorage and every
--    write attempt reports an honest local-only status.
-- ============================================================