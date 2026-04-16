# THREEFOLD — Setup Guide

Three files make up the project:
- `index.html` — Public-facing website
- `staff.html` — Staff panel (login-gated)
- `supabase.js` — Shared database config (edit this first)

---

## Step 1 — Create a Supabase Project

1. Go to https://supabase.com and sign up (free)
2. Click **New Project**, give it a name (e.g. "threefold"), set a strong database password
3. Wait ~2 minutes for it to spin up
4. Go to **Settings → API** in your Supabase dashboard
5. Copy:
   - **Project URL** (looks like `https://xyzxyz.supabase.co`)
   - **anon / public** key (long JWT string)

Open `supabase.js` and paste them in:

```js
const SUPABASE_URL  = 'https://your-project.supabase.co';
const SUPABASE_ANON = 'your-anon-key-here';
```

---

## Step 2 — Run the Database Schema

In Supabase dashboard → **SQL Editor** → **New Query**, paste and run this entire block:

```sql
-- Applications table
CREATE TABLE applications (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  seq         SERIAL,
  type        TEXT NOT NULL CHECK (type IN ('lore','staff','gm')),
  form_data   JSONB NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','review','approved','denied')),
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Positions table (open/closed per application type)
CREATE TABLE positions (
  type     TEXT PRIMARY KEY CHECK (type IN ('lore','staff','gm')),
  is_open  BOOLEAN NOT NULL DEFAULT false
);

-- Pre-populate positions (all closed by default)
INSERT INTO positions (type, is_open) VALUES ('lore', false), ('staff', false), ('gm', false);

-- Profiles table (extends Supabase auth.users)
CREATE TABLE profiles (
  id               UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  display_name     TEXT,
  discord_username TEXT,
  role             TEXT DEFAULT 'trial_mod' CHECK (role IN ('owner','admin','head_lore','lore','trial_lore','mod','trial_mod'))
);

-- Auto-create profile when a user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id)
  VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Sequence rebalancing function (renumbers seq after deletion)
-- This is called automatically by the deletion trigger
CREATE OR REPLACE FUNCTION rebalance_seq()
RETURNS TRIGGER AS $$
BEGIN
  -- Update all seq values to be contiguous after a deletion
  WITH ordered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) AS new_seq
    FROM applications
  )
  UPDATE applications a
  SET seq = o.new_seq
  FROM ordered o
  WHERE a.id = o.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER after_app_delete
  AFTER DELETE ON applications
  FOR EACH ROW EXECUTE FUNCTION rebalance_seq();
```

---

## Step 3 — Row Level Security (RLS)

Still in SQL Editor, run this block to lock down who can access what:

```sql
-- Enable RLS on all tables
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions    ENABLE ROW LEVEL SECURITY;

-- APPLICATIONS --
-- Anyone can submit (insert)
CREATE POLICY "Anyone can submit applications"
  ON applications FOR INSERT
  WITH CHECK (true);

-- Authenticated staff can read all applications
CREATE POLICY "Staff can view applications"
  ON applications FOR SELECT
  USING (auth.role() = 'authenticated');

-- Only admins/owners can update status
CREATE POLICY "Managers can update applications"
  ON applications FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role IN ('owner', 'admin')
    )
  );

-- Only admins/owners can delete
CREATE POLICY "Managers can delete applications"
  ON applications FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role IN ('owner', 'admin')
    )
  );

-- PROFILES --
-- Users can read all profiles (needed for staff list)
CREATE POLICY "Staff can view profiles"
  ON profiles FOR SELECT
  USING (auth.role() = 'authenticated');

-- Only owner can update roles
CREATE POLICY "Owner can update roles"
  ON profiles FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role = 'owner'
    )
  );

-- POSITIONS --
-- Anyone can read positions (needed to show open/closed on public site)
CREATE POLICY "Anyone can view positions"
  ON positions FOR SELECT
  USING (true);

-- Only admins/owners can toggle
CREATE POLICY "Managers can update positions"
  ON positions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role IN ('owner', 'admin')
    )
  );

CREATE POLICY "Managers can upsert positions"
  ON positions FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role IN ('owner', 'admin')
    )
  );
```

---

## Step 4 — Create Your Owner Account

1. In Supabase dashboard → **Authentication → Users → Invite User**
2. Enter your email address and click Invite
3. Check your email and set a password via the link
4. Back in Supabase → **SQL Editor**, run this to set yourself as Owner:

```sql
-- Replace with your actual email
UPDATE profiles
SET role = 'owner', display_name = 'Your Name', discord_username = 'yourdiscord'
WHERE id = (
  SELECT id FROM auth.users WHERE email = 'your@email.com'
);
```

---

## Step 5 — Add Staff Accounts

For each staff member:

1. Supabase → **Authentication → Users → Invite User**
2. Enter their email, click Invite
3. They set their password via the email link
4. You then go to **SQL Editor** and assign their role:

```sql
UPDATE profiles
SET role = 'mod',           -- change this to the right role
    display_name = 'Their Name',
    discord_username = 'theirdiscord'
WHERE id = (
  SELECT id FROM auth.users WHERE email = 'staffmember@email.com'
);
```

### Available roles:
| Role value  | Who it's for |
|-------------|---|
| `owner`     | Server owner — full access |
| `admin`     | Head admins — can manage apps and positions |
| `head_lore` | Head of Lore — can view applications |
| `lore`      | Lore Team — can view applications |
| `trial_lore`| Trial Lore — can view applications |
| `mod`       | Moderators — can view applications |
| `trial_mod` | Trial Mods — can view applications |

---

## Step 6 — Deploy the Site

### Option A — Just open the files locally
Open `index.html` directly in Chrome/Firefox. Everything works locally since Supabase is a remote API.

### Option B — Host on GitHub Pages (free)
1. Create a new GitHub repo
2. Upload all three files (`index.html`, `staff.html`, `supabase.js`)
3. Go to **Settings → Pages → Deploy from branch → main**
4. Your site will be live at `https://yourusername.github.io/reponame/`
5. Staff panel will be at `https://yourusername.github.io/reponame/staff.html`

### Option C — Netlify / Vercel (free, custom domain support)
Drag and drop your folder onto https://app.netlify.com/drop

---

## How the Application Numbers Work

When an application is deleted, a database trigger (`after_app_delete`) automatically renumbers all remaining applications sequentially based on submission date. So if applications 1, 2, 3 exist and you delete #1, applications 2 and 3 automatically become 1 and 2. No manual work required.

---

## Opening / Closing Applications

Log into the staff panel (`staff.html`) as Owner or Admin, go to **Open / Close Positions**, and toggle the switches. Changes take effect on the public site immediately — the Apply page will show the button as greyed out or active accordingly.

---

## Updating Staff Cards on the Public Site

The staff cards on the public `index.html` are still static HTML placeholders. To update them:
1. Open `index.html` in VS Code
2. Search for `staff-card`
3. Swap in real names, initials, roles, and bios for each card

A future improvement would be to pull these from the `profiles` table automatically — that's possible with a small script addition if you want it later.

---

## Adding Your Discord Link

In `index.html`, search for `discord-pending` and replace the placeholder block with:

```html
<a href="https://discord.gg/your-invite-here" class="btn btn-fill" target="_blank">Join the Discord</a>
```
