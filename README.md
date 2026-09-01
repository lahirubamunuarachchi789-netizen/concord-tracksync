# Concord TrackSync

Production Tracking System authentication module for **Concord Footwear (Pvt) Ltd**.
Built with **Next.js 15 (App Router) + Tailwind CSS + Supabase**.

## Features

- Split-screen industrial design: blue-purple gradient brand panel + clean white auth card
- Smooth animated **Sign In / Register** toggle (sliding pill indicator + fade/slide forms)
- **Register**: collects `Username`, `Department`, `Password` and inserts into the Supabase `Loging Table` (duplicate usernames blocked)
- **Login**: queries `Loging Table` to validate credentials, with success/error toast notifications
- Configuration is read **dynamically and safely** from environment variables (no hard-coded credentials)
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

## Project structure

```
├── app/
│   ├── globals.css          # Tailwind + base styles
│   ├── layout.js            # Root layout & metadata
│   └── page.js              # Renders the auth screen
├── components/
│   ├── AuthCard.jsx         # Split-screen auth UI, toggle, form state
│   ├── AuthInput.jsx        # Input / select / suggestion-combo field
│   ├── BrandPanel.jsx       # Left gradient panel
│   ├── Notification.jsx     # Toast status notifications
│   └── icons.jsx            # Inline SVG icons (no extra deps)
├── lib/
│   ├── supabaseClient.js    # Safe dynamic init from env vars (singleton)
│   └── authService.js       # loginUser() / registerUser() on "Loging Table"
├── supabase/schema.sql      # Table + RLS policies
├── .env                     # Supabase credentials (git-ignored)
└── .env.example             # Template for new machines
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
