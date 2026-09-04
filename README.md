# Concord TrackSync

Production Tracking System authentication module for **Concord Footwear (Pvt) Ltd**.
Built with **Next.js 15 (App Router) + Tailwind CSS + Supabase**.

## Features

- Split-screen industrial design: blue-purple gradient brand panel + clean white auth card
- Smooth animated **Sign In / Register** toggle (sliding pill indicator + fade/slide forms)
- **Register**: collects `Username`, `Department`, `Password` and inserts into the Supabase `Loging Table` (duplicate usernames blocked)
- **Login**: queries `Loging Table` to validate credentials, with success/error toast notifications
- **Post-login app shell**: collapsible sidebar (Home / Dashboard / Transactions / Reports / Stock), sticky header with user profile & logout, gradient welcome hero and KPI dashboard
- **Route protection**: `middleware.js` guards protected sections with the `tracksync_auth` cookie, backed by a client-side session check in the shell
- Configuration is read **dynamically and safely** from environment variables, with built-in publishable fallbacks
- Password visibility toggle, loading states, mobile-friendly layout

## Getting started

```bash
npm install
npm run dev
# open http://localhost:3000
```

Production:

```bash
npm run build
npm run start
```

## Environment variables

`.env` is already created at the project root and **is ignored by `.gitignore`** so the
credentials below are never pushed to GitHub:

```env
NEXT_PUBLIC_SUPABASE_URL=https://zpfhzpjdrvduisubzlhk.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_nPjB9DdglN8IHMfx6v8g6g_NxNnyQ5U
```

For new machines, copy `.env.example` to `.env` and fill in the values.
Restart the dev server after changing `.env`.

## Database setup

Supabase table **`Loging Table`** with fields **`Username`**, **`Department`**, **`Password`**
(exact name/casing, including the space). Verified live: the table already exists in the
connected project.

If you need to recreate it, or if you hit *Row Level Security* errors, run
[`supabase/schema.sql`](supabase/schema.sql) in **Supabase Dashboard → SQL Editor**.
It (idempotently) creates the table, enables RLS, and adds `insert`/`select` policies for
the publishable key so registration and login work from the browser.

## Standard transaction validation rules (`/transactions`)

Every **Standard Transactions** scan runs four strict guards BEFORE anything is written to
`data_updates` (see [`lib/transactionGuards.js`](lib/transactionGuards.js)). Execution order:

1. **Active-status MSK gate** (`msk`): the scanned QR resolves to an `org_qr` only from a row
   whose `status` is `Active` (case-insensitive). `Packed` / other statuses are ignored —
   with no active row the scan is blocked:
   *“Scan blocked — No active MSK QR mapping found!”*
2. **Preceding department net count** (`departments` + `data_updates`): for `current_seq > 1`
   the net sum of `count` for the resolved `org_qr` across **all** departments on the highest
   sequence strictly below the user's sequence must be exactly **+1**:
   *“Scan blocked — Previous department sequence scan is incomplete or net count is not +1!”*
3. **Current department net count (prospective)** (`data_updates`): the net **after** this scan
   (`current net + the scan's ±1 increment`, −1 for `Return`) must stay between **0 and 1**
   inclusive. A Return on a +1 net clears it to 0 (allowed — a returned item can be re-scanned);
   a Pass on a +1 net (prospective 2) is blocked with
   *"Scan blocked — QR code has already been scanned in this department (Net count is already +1)!"*;
   a Return on a 0 net (prospective −1) is blocked with
   *"Scan blocked — QR code has no Net Count in this department (a Return would drive net count below zero)!"*
4. **Parallel sequence mutual exclusion** (`departments` + `data_updates`): departments sharing
   the user's exact `sequence` must hold a net count of **0** for the `org_qr`:
   *“Scan blocked — QR code has an active count in a parallel department with the same sequence!”*

Only when all four pass is the standard record written (`qr_code` = resolved `org_qr`,
`record_status`, `qc_status`, dynamic `count` (+1 / −1 for `Return`), `department`,
`created_by`, `created_at`). A blocked scan never writes and flashes the status panels amber.

Run the guard test-suite with `npm test` (Node built-in test runner, no extra dependencies).

## Dual-Scan for Finishing departments (`/transactions`)

Finishing lines record a Shoe QR **together with** its Inner Box QR
([`lib/transactionDualScan.js`](lib/transactionDualScan.js)):

- **Normal Dual-Scan** — the logged-in user's department is `Finishing 01`, `Finishing 02` or
  `Finishing 03` **and** the selected QC Status is NOT `B Grade` / `C Grade` / `Lab Testing`:
  Scan 1 captures the **Inner Box QR** (focus auto-shifts), Scan 2 on the **Shoe QR** submits
  the pair; inputs then reset to stage 1 for the next pair.
- **QC bypass** — with `B Grade`, `C Grade` or `Lab Testing` selected (even in a Finishing
  department), Dual-Scan is disabled: the Inner Box field is hidden, focus stays on the
  Shoe QR and every scan submits immediately.
- **Persistence** — dual pairs are written to `data_updates` with `inner_qr` set; bypassed /
  non-Finishing scans persist `inner_qr = null`
  (column added by `supabase/transactions-schema.sql`).

### Packing Department: single-scan Inner Box lookup

For the **Packing** department the flow is the reverse of Dual-Scan — the Shoe QR is never
scanned by the user ([`components/transactions/TransactionsView.jsx`](components/transactions/TransactionsView.jsx)):

- **Single scan** — the user scans ONLY the **Inner Box QR** into the scan field (gun input
  placeholder switches to *“Scan the Inner Box QR...”* and an info strip marks the mode).
- **Automatic resolution** — `resolveOrgQrFromInnerBox()` in
  [`lib/transactionsService.js`](lib/transactionsService.js) queries `data_updates` by
  `inner_qr` to resolve the recorded Shoe QR (`qr_code`). When a box has been re-paired over
  its lifetime the **latest** association wins (`ORDER BY created_at DESC LIMIT 1`).
- **Unlinked Inner Box** — when no matching `org_qr` exists, the scan is rejected (nothing is
  written) with the error: *"Unlinked Inner Box — This Inner Box QR has no recorded Shoe QR in
  the system."* An unreachable `data_updates` table also blocks the scan, fail-safe, with an
  honest offline message instead.
- **Validation** — once the `org_qr` is resolved, ALL standard guards (Rules 1–5) run against
  it for the Packing department, with the msk gate (Rule 1) bypassed and the Finishing
  Dual-Scan Inner Box checks (V1–V3 + Duplicate Inner Box Guard) **skipped** — the scanned box
  is by definition already registered in `data_updates` (exactly how the `org_qr` was
  resolved). The preceding/current/parallel net count guards and the downstream department
  sequence guard are fully enforced on the resolved `org_qr`.
- **Record** — the insert is the standard `data_updates` shape: `qr_code` = resolved Shoe QR,
  `inner_qr` = scanned Inner Box QR, `department` = Packing, plus `record_status`, `qc_status`,
  `count` (+1 / −1 for `Return`), `created_by`, `created_at`.
- **Automatic msk lifecycle** — immediately after a Packing record is saved
  (`syncMskStatusForPackingTransaction` in
  [`lib/transactionsService.js`](lib/transactionsService.js)), the Packing net count for the
  resolved Shoe QR decides the `msk` row status (`WHERE org_qr = <org_qr>`): net **+1** →
  `status = 'Packed'` (the shoe can no longer be scanned on the floor — Rule 1 ignores
  non-Active rows), net **0** (a Return/Undo reverted the packing) → `status = 'Active'`.
  The sync never throws and never re-routes a saved transaction into the offline queue;
  offline-queued Packing rows run the same trigger when `retryQueuedTransactions` flushes
  them. Non-Packing departments never mutate `msk.status`.

### Inner Box pair validation (runs before the sequence guards)

When an Inner Box QR is captured, three strict checks run on the Shoe scan
(see `validateDualScanPair` in `lib/transactionDualScan.js`, wired into
`lib/transactionGuards.js`):

1. **URL structure** — `inner_qr` must contain the exact substring
   `http://blaklader.com`; otherwise: *"Invalid Inner Box QR format: Must contain
   http://blaklader.com"*.
2. **PO match** — from `inner_qr` the PO is read from the GS1 `10` (batch/lot) element:
   the label is split on the GS1 group separator (`\u001d`) and the segment that *is* the
   `10` element yields the PO (`\u001d10148925\u001d` → `148925` → trailing 4 = `8925`).
   A separator-less variant (digits running straight into the `8200`/`http` URL AI) is
   handled by walking back over that contiguous digit run only, so control characters and
   other AIs can never corrupt the extraction; the original backwards skip-8-take-4 scan
   remains as a legacy fallback for URL-path labels. From the Shoe `org_qr`
   (`;mqc;po;size;scanned;`), a hyphenated PO (`148925-01`) is stripped to `148925` and a
   plain PO (`144065`) is used as is, then the last 4 digits are compared (`8925` / `4065`);
   a mismatch fails with *"PO Number Mismatch between Inner Box QR and Shoe QR"*.
3. **Size match** — digits 4–16 of `inner_qr` (skip the first 3, take the next 13) form the
   Box Code, which is `.trim()`-cleaned and looked up in the `srl_num` table (`box_num` →
   `size`, created by `supabase/srl-num-schema.sql`) and compared against the Shoe `org_qr`
   size (the 3rd `;` field of `;mqc;po;size;scanned;`). Both sides are compared as
   `String(size).trim().toUpperCase()` (with numeric tolerance so `'35.0'` matches `'35'`).
   Distinct failures: no `srl_num` row → *"Box code [extractedCode] not found in srl_num
   database"*; different sizes → *"Size Mismatch: Inner Box Size ('[dbSize]') does not
   match Shoe Size ('[shoeSize]')"* naming both values for debugging. An unreachable
   `srl_num` table blocks the scan fail-safe.

**Global failure reset** — if ANY check fails (these three or any of the four standard
guards), the captured Inner Box QR is discarded, the Inner Box field is cleared and focus
returns to it for a completely fresh pair.

The same Dual-Scan process is enabled for the **QR Activation** tab
([`lib/qrActivationDualScan.js`](lib/qrActivationDualScan.js), wired into
[`components/transactions/activation/QrActivationView.jsx`](components/transactions/activation/QrActivationView.jsx)):

- **Trigger** — identical condition: a Finishing `01`/`02`/`03` department with a QC status
  that is NOT `B Grade` / `C Grade` / `Lab Testing`. The locked PO + size stay as they are; only
  the capture flow changes from "every scan activates" to the two-scan pair.
- **Flow** — Scan 1 captures the **Inner Box QR** (the `InnerBoxQrField` populates, focus
  shifts), Scan 2 on the **Shoe QR** runs the V1-V3 pair checks (above) against the formatted
  activation string `;mqc;po;size;scanned;`, then the `cut_qty` limit guard, then auto-activates.
- **msk status gate** — activation is allowed ONLY when the scanned QR's `msk` row is in the
  `Packed` lifecycle status (`checkActivationMskStatus`, evaluated before anything is written):
  `Active` — the default status of an un-activated floor mapping — any other status, a missing
  row and an unreachable `msk` table all block the scan with *"Activation Blocked — This QR
  code is not in 'Packed' status (Current status: {status})!"* (the unreachable-table case
  blocks fail-safe with its own "could not be verified" message). `Packed` is set
  automatically when the shoe's Packing net count hits +1, so a shoe can be activated exactly
  once, after packing.
- **Data routing** — `data_updates` receives the **full** transaction field set: `qr_code`
  (the formatted org_qr), `inner_qr` (the captured Inner Box QR, `null` for single scans),
  `record_status`, `qc_status`, `department`, `count`, `created_by`, `created_at` — exactly the
  standard-transaction shape. The `msk` duplicate-guard row gets **standard shoe activation data
  only** (`msk_qr` = raw scanned Shoe QR, `org_qr` = formatted string); `inner_qr` is never
  written to `msk`.
- **Global failure reset** — identical to standard transactions: any V1-V3 failure, cut_qty
  block, or duplicate discards the captured Inner Box QR and re-arms focus on the Inner Box
  field for a fresh pair.

## Registration: dynamic Department dropdown

The sign-up form (`components/AuthCard.jsx`) no longer uses a hardcoded department list.
On mount it calls [`lib/departmentsService.js`](lib/departmentsService.js), which runs
`SELECT department FROM departments ORDER BY sequence ASC, department ASC` and feeds the
exact strings from the table into the Department combo box, so what a user registers in
`Loging Table.Department` always matches `departments.department` byte-for-byte (same
casing/format) — exactly what the standard-transaction sequence guards compare against.

- **Loading**: a subtle spinner in the field + "Loading departments from the server..." hint.
- **Failure / offline**: the fetcher never throws; the form shows an amber message with a
  **Retry** button and the combo degrades to free-text typing, so registration never breaks.

## Project structure

```
├── app/
│   ├── globals.css           # Tailwind + base styles
│   ├── layout.js             # Root layout & metadata
│   ├── page.js               # Login / register screen
│   └── (main)/               # Protected post-login area (route group)
│       ├── layout.js         # App shell: sidebar + header + auth gate
│       ├── home/page.js      # Welcome hero + quick links
│       ├── dashboard/        # KPI cards, output chart, activity feed
│       ├── transactions/     # Tabbed module: standard flow + QR activation
│       │   └── activation/   # PO (Supabase-backed) + size locked scanning
│       ├── reports/          # Module scaffold
│       └── stock/            # Module scaffold
├── components/
│   ├── AppShell.jsx          # Auth gate + session context + shell layout
│   ├── Sidebar.jsx           # Collapsible / mobile drawer navigation
│   ├── DashboardHeader.jsx   # Top bar: title, user profile, logout
│   ├── HomeGreeting.jsx      # Gradient welcome hero
│   ├── PageHeader.jsx        # Shared section heading
│   ├── StatCard.jsx          # KPI metric card
│   ├── EmptyState.jsx        # Themed "coming soon" module panel
│   ├── AuthCard.jsx          # Split-screen auth UI, toggle, form state
│   ├── AuthInput.jsx         # Input / select / suggestion-combo field
│   ├── BrandPanel.jsx        # Left gradient panel
│   ├── Notification.jsx      # Toast status notifications
│   ├── icons.jsx             # Inline SVG icons (no extra deps)
│   └── transactions/         # Transactions module components
│       ├── TransactionsTabs.jsx     # Tab switcher: Standard vs QR Activation
│       ├── TransactionsView.jsx     # Scan -> msk lookup -> data_updates record
│       ├── activation/              # QR Activation window
│       │   ├── QrActivationView.jsx # Locked PO+size, auto-activate on scan
│       │   ├── PoSelect.jsx         # PO dropdown + Add modal + Delete (Supabase)
│       │   ├── SizeSelect.jsx       # Size quick-grid 35-50
│       │   └── ActivationSummary.jsx# Locked params + activation log
│       ├── ScanMethodToggle.jsx   # Camera vs scanner-gun selector
│       ├── CameraScanner.jsx      # html5-qrcode live camera wrapper
│       ├── GunScannerInput.jsx    # USB/BT scanner-gun keystroke capture
│       ├── ScanPreview.jsx        # Scanned-code preview card
│       ├── StatusControls.jsx     # IN/OUT + QC status button grid
│       ├── TransactionSummary.jsx # Pending record + session log
│       └── LockIcon.jsx           # Small inline lock glyph
├── lib/
│   ├── supabaseClient.js     # Safe dynamic init from env vars (singleton)
│   ├── authService.js        # loginUser() / registerUser() on "Loging Table"
│   ├── departmentsService.js # departments fetch for the sign-up dropdown (exact values)
│   ├── transactionGuards.js  # 5 strict scan guards (msk Active gate + sequence net counts)
│   ├── transactionsService.js # msk lookup + data_updates insert/queue/read + Packing Inner Box lookup
│   ├── qrActivationService.js # PO fetch/add/delete + activation insert/queue
│   └── session.js            # Client session store + auth cookie
├── tests/                    # Node built-in test runner suites (npm test)
├── middleware.js             # Route protection for the protected sections
├── supabase/schema.sql       # "Loging Table" + RLS policies
├── supabase/departments-schema.sql # departments (id, department, sequence) + RLS + seeds
├── supabase/transactions-schema.sql # msk mapping (status gate) + data_updates (standard tx) + RLS
├── supabase/qr-activation-schema.sql # "PO" + pod MQC + data_updates + RLS
├── .env                      # Supabase credentials (git-ignored)
└── .env.example              # Template for new machines
```

## Security notes (please read)

1. **Plain-text passwords**: as specified, `Password` is stored in `Loging Table` and compared
   client-side. The `select` policy required for this exposes every row to anyone holding the
   publishable key. Fine for a small internal tool — **not** production-grade.
2. Recommended hardening (in order of impact):
   - Migrate to **Supabase Auth** (built-in hashing, sessions, RLS-aware users), or
   - Store **hashes** (`pgcrypto`) and validate through a Postgres **RPC** so passwords are never
     returned to the browser.
3. Never commit `.env`; only the `NEXT_PUBLIC_*` keys (publishable/anon) belong in client code.
   Service-role keys must stay server-side only.
