# Threefold Discord Bot

A Discord bot that watches your Supabase database and reacts to new submissions
and applications in real time. Staff still approve/deny on your website dashboard;
the bot mirrors the result back into Discord automatically.

## What it does

**Character submissions** (Foundation / SCP / Unaffiliated / Equipment):
- Creates a new forum post in `#submissions` (`1495553048536154313`)
- Names it `TYPE︲username` (e.g. `FOUNDATION︲johndoe`)
- Posts the document link in the opening message
- Applies the **Under Review** tag
- When staff approves on the website → posts a green `APPROVED` embed, swaps tag to **Approved**
- When staff denies on the website → posts a red `DENIED` embed, swaps tag to **Denied**, pings the user and tells them to hit **Re-submit**
- If no reason is given, the embed shows just the status title

**Applications**:
- **Lore Team** → channel `1495813385294581861`
- **GM** → channel `1496251685322887228`
- **Staff/Moderation** → currently routed to the Lore channel; change `APP_CONFIG.staff.channelId` in `bot.js` if you want a different one
- Posts an embed with every question and the applicant's answer

---

## Setup

### 1. Create the Discord bot
1. Go to https://discord.com/developers/applications
2. Create a new application → **Bot** tab → reset token, copy it
3. Under **Privileged Gateway Intents**: none are required (the bot doesn't read messages)
4. Under **Installation** / **OAuth2 URL Generator**, select scopes `bot` and `applications.commands`, and these bot permissions:
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Create Public Threads
   - Manage Threads *(required to apply tags)*
   - Embed Links
   - Read Message History
5. Invite it to your server with the generated URL

### 2. Prepare the submissions forum
The channel `1495553048536154313` must be a **Forum Channel**. It needs three tags:
- `Under Review`
- `Approved`
- `Denied`

The bot detects them by name (case-insensitive, substring match on "review" / "approve" / "den"), so exact naming isn't critical as long as those words appear.

### 3. Enable Supabase Realtime on your tables
In the Supabase dashboard:
1. **Database** → **Replication** → turn on **Realtime** for `characters` and `applications`
2. Make sure both tables have a primary key (they do — `id`)

### 4. Install and run
```bash
cd threefold-bot
npm install
cp .env.example .env
# edit .env with your tokens
npm start
```

You should see:
```
[bot] Logged in as YourBot#1234
[bot] Forum tags: { under_review: '...', approved: '...', denied: '...' }
[bot] Rebuilt thread cache with N entries.
[realtime] characters: SUBSCRIBED
[realtime] applications: SUBSCRIBED
[bot] Ready and listening.
```

### 5. Host it
The bot needs to run 24/7. Easy options:
- **Railway** / **Render** / **Fly.io** — all have free tiers, deploy straight from a Git repo
- **A VPS** running `pm2 start bot.js` or a systemd service
- **Your own machine** if you don't mind it being offline when you're offline

---

## How it survives restarts

When the bot starts up, it scans the last ~100 archived + all active forum threads looking for a hidden `[CHAR:<uuid>]` marker in the opening message. That lets it rebuild its internal map of `character id → thread id` without needing a database. Threads created before the bot existed won't be known to it — but any new submissions and any status changes on recently-created threads will work fine.

If you want bulletproof cross-restart mapping, add a `discord_thread_id` column to the `characters` table and store it after creating the thread — a two-line change in `handleCharacterInsert`.

---

## Common gotchas

- **Bot creates threads but doesn't post the result when staff approves/denies.** You're using the anon key in `.env`. Switch to the service role key — the anon key can't subscribe to realtime updates on RLS-protected tables.
- **Tags don't apply.** The bot doesn't have **Manage Threads** permission, or the tag names don't include "review" / "approve" / "den".
- **Re-submit mention shows the username instead of pinging.** The bot couldn't find the user in the guild (they left, or the username changed). This is a fallback, not an error.
