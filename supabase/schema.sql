-- ============================================================
-- Concord TrackSync - Supabase schema for authentication
-- Table: "Loging Table"  (name kept exactly as specified)
-- Run in: Supabase Dashboard -> SQL Editor
--
-- Verified live on 2026-09-01: the table already exists and is
-- readable with the publishable key (HTTP 200, row "Lahiru").
-- This script is idempotent: run it to guarantee the table shape
-- and to add the RLS policies below if they are missing.
-- ============================================================

-- 1. Table (idempotent)
create table if not exists "Loging Table" (
  "Username"   text primary key,
  "Department" text not null,
  "Password"   text not null,
  "created_at" timestamptz not null default now()
);

-- 2. Row Level Security
alter table "Loging Table" enable row level security;

-- 3. Policies for the browser client (publishable/anon key)
--    a) Registration inserts
drop policy if exists "tracksync_allow_insert" on "Loging Table";
create policy "tracksync_allow_insert"
  on "Loging Table"
  for insert
  to anon, authenticated
  with check (true);

--    b) Login lookups
drop policy if exists "tracksync_allow_select" on "Loging Table";
create policy "tracksync_allow_select"
  on "Loging Table"
  for select
  to anon, authenticated
  using (true);

-- ============================================================
-- SECURITY NOTE
-- The requested design compares passwords client-side and stores
-- them in plain text; the select policy therefore exposes every
-- row to anyone holding the publishable key. Acceptable for a
-- small internal tool, but for production-grade security:
--   * store password hashes (pgcrypt) or migrate to Supabase Auth
--   * move validation into a Postgres function / Edge Function so
--     plaintext passwords are never returned to the browser.
-- ============================================================
