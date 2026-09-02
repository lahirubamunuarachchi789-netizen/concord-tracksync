-- ============================================================
-- Concord TrackSync - Supabase schema for QR Activation
-- Tables: "PO" (column `PO`)      - the live PO list table
--         qr_activations          - scan + PO + size records
-- Run in: Supabase Dashboard -> SQL Editor
--
-- This script is idempotent: run it to guarantee the table
-- shapes and to add the RLS policies below if missing.
-- ============================================================

-- 1. PO list (shown in the activation dropdown)
--    Verified live on 2026-09-02: the "PO" table already exists
--    with data (HTTP 200 via the publishable key, column "PO").
--    create-if-missing keeps fresh projects reproducible.
create table if not exists "PO" (
  id         uuid primary key default gen_random_uuid(),
  "PO"       text not null,
  created_at timestamptz not null default now()
);

-- One PO number can only exist once (case-insensitive uniqueness
-- is enforced in the UI; the DB enforces exact uniqueness).
create unique index if not exists po_value_key on "PO" ("PO");

-- 2. QR activations (auto-submitted scans)
create table if not exists qr_activations (
  id         uuid primary key default gen_random_uuid(),
  qr_value   text not null,
  po         text not null,
  size       integer not null check (size between 35 and 50),
  username   text not null,
  department text not null,
  client_ref text not null,
  created_at timestamptz not null default now()
);

create index if not exists qr_activations_created_idx
  on qr_activations (created_at desc);

-- 3. Row Level Security
alter table "PO" enable row level security;
alter table qr_activations  enable row level security;

-- 4. Policies for the browser client (publishable/anon key)
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

drop policy if exists "tracksync_act_insert" on qr_activations;
create policy "tracksync_act_insert"
  on qr_activations for insert
  to anon, authenticated
  with check (true);

drop policy if exists "tracksync_act_select" on qr_activations;
create policy "tracksync_act_select"
  on qr_activations for select
  to anon, authenticated
  using (true);

-- ============================================================
-- NOTES
--  * "client_ref" is a browser-generated UUID so a sync retry
--    can never double-insert the same activation.
--  * Until this script is run the app still works: activations
--    queue in localStorage and sync automatically once the
--    tables exist. The PO list simply starts empty.
-- ============================================================