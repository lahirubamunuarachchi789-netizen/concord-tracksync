-- ============================================================
-- Concord TrackSync - Supabase schema for the SRL NUM table
-- Used by the Finishing Dual-Scan validation (Validation 3): the
-- 13-digit Box Code extracted from the Inner Box QR is looked up
-- here to compare its `size` against the Shoe org_qr size.
-- Run in: Supabase Dashboard -> SQL Editor (idempotent)
-- ============================================================

create table if not exists srl_num (
  id      bigserial primary key,
  box_num text,
  size    text
);

-- One authoritative size per inner box code (the guard looks up by
-- box_num with limit 1 - the unique index makes that deterministic).
create unique index if not exists srl_num_box_num_key
  on srl_num (box_num);

-- Row Level Security: the browser client only needs to read sizes to
-- run the Dual-Scan validation - no writes from the scanner UI.
alter table srl_num enable row level security;

drop policy if exists "tracksync_srl_num_select" on srl_num;
create policy "tracksync_srl_num_select"
  on srl_num for select
  to anon, authenticated
  using (true);