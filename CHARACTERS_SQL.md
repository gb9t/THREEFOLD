# Characters — SQL Setup

Run these in Supabase → SQL Editor → New Query in order.

---

## Step 1 — Characters Table

```sql
CREATE TABLE characters (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  seq            SERIAL,
  type           TEXT NOT NULL CHECK (type IN ('foundation','scp','unaffiliated')),
  method         TEXT NOT NULL CHECK (method IN ('website','googledoc')),
  discord_username TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','review','approved','denied')),
  staff_reason   TEXT,
  reviewed_by    TEXT,
  character_data JSONB NOT NULL DEFAULT '{}',
  gdoc_url       TEXT,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ DEFAULT now()
);

-- Auto-renumber seq when a character is deleted
CREATE OR REPLACE FUNCTION rebalance_character_seq()
RETURNS TRIGGER AS $$
BEGIN
  WITH ordered AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) AS new_seq
    FROM characters
  )
  UPDATE characters c
  SET seq = o.new_seq
  FROM ordered o
  WHERE c.id = o.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER after_char_delete
  AFTER DELETE ON characters
  FOR EACH ROW EXECUTE FUNCTION rebalance_character_seq();
```

---

## Step 2 — Row Level Security

```sql
ALTER TABLE characters ENABLE ROW LEVEL SECURITY;

-- Anyone can submit a character
CREATE POLICY "Anyone can submit characters"
  ON characters FOR INSERT
  WITH CHECK (true);

-- Anyone can read characters
-- (app logic controls what data is shown — public sees approved only,
--  tracker shows status by discord_username without exposing character_data)
CREATE POLICY "Anyone can read characters"
  ON characters FOR SELECT
  USING (true);

-- Authenticated staff can update status and reason
CREATE POLICY "Staff can update character status"
  ON characters FOR UPDATE
  USING (auth.role() = 'authenticated');

-- Only owner, admin, head_lore can delete
CREATE POLICY "Senior staff can delete characters"
  ON characters FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role IN ('owner','admin','head_lore')
    )
  );
```

---

## Step 3 — Image Storage Bucket

This is done in the Supabase **dashboard UI**, not SQL.

1. Go to **Storage** in the left sidebar
2. Click **New bucket**
3. Name it exactly: `character-images`
4. Check **"Public bucket"** (images need to be publicly readable)
5. Click **Create bucket**

Then set the upload policy in **SQL Editor**:

```sql
-- Allow anyone to upload to character-images
CREATE POLICY "Anyone can upload character images"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'character-images');

-- Allow anyone to read character images
CREATE POLICY "Anyone can view character images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'character-images');

-- Only authenticated staff can delete images
CREATE POLICY "Staff can delete character images"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'character-images'
    AND auth.role() = 'authenticated'
  );
```

---

## Staff Panel Quick-Reference SQL

### Approve a character
```sql
UPDATE characters
SET status = 'approved',
    staff_reason = 'Approved — welcome to the server.',
    reviewed_by = 'YourName',
    updated_at = now()
WHERE id = 'CHARACTER_UUID_HERE';
```

### Deny a character
```sql
UPDATE characters
SET status = 'denied',
    staff_reason = 'Please revise: [your reason here]',
    reviewed_by = 'YourName',
    updated_at = now()
WHERE id = 'CHARACTER_UUID_HERE';
```

### View all pending characters
```sql
SELECT seq, type, discord_username, status, created_at
FROM characters
WHERE status = 'pending'
ORDER BY seq;
```

---

## Notes

- The `seq` column auto-renumbers when a character is deleted — if you delete #3 out of 5, #4 becomes #3 and #5 becomes #4.
- `character_data` stores all the character sheet content as JSON.
- `gdoc_url` is set for Google Doc submissions; `character_data` is empty `{}` for those.
- Staff approval/denial and all editing of approved characters is done through the staff panel (`staff.html`).
