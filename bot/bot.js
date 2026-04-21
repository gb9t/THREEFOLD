/* ============================================================
   Threefold Discord Bot
   - Listens to Supabase Realtime for new submissions/applications
   - Creates forum posts / embeds in the right channels
   - Tracks status changes (approved/denied) and posts result embeds
   ============================================================ */

require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder, ChannelType,
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

/* ---------- Config ---------- */
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY; // service role key - required for realtime on tables

// Channels
const SUBMISSIONS_FORUM_ID = '1495553048536154313'; // forum channel for character submissions
const LORE_APP_CHANNEL_ID  = '1495813385294581861'; // channel for Lore Team applications
const GM_APP_CHANNEL_ID    = '1496251685322887228'; // channel for GM applications
// Staff/Mod apps weren't given a channel in the spec - adding one is easy (see handleApplicationInsert)

// Forum tag IDs - filled in on startup via fetchForumTagIds()
const TAG_IDS = {
  under_review: null,
  approved:     null,
  denied:       null,
};

/* ---------- Type → label map for submissions ---------- */
const TYPE_LABELS = {
  foundation:   'FOUNDATION',
  scp:          'SCP',
  unaffiliated: 'UNAFFILIATED',
  equipment:    'EQUIPMENT',
};

const TYPE_COLORS = {
  foundation:   0x6050c0,
  scp:          0xc02020,
  unaffiliated: 0x1a4a90,
  equipment:    0x8a7a2a,
};

/* Pull the character/equipment/SCP name out of a submission row, regardless
   of type. Falls back to a sensible placeholder if somehow nothing is set. */
function extractCharacterName(row) {
  const d = row.character_data || {};
  const raw =
    d.full_name        // foundation / unaffiliated
    || d.item_number   // SCP
    || d.equipment_name // equipment
    || d.name           // just in case
    || `Unnamed ${row.type}`;
  return String(raw).trim() || `Unnamed ${row.type}`;
}

/* ---------- Clients ---------- */
const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

const supa = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { params: { eventsPerSecond: 10 } },
});

/* ---------- In-memory cache: character id -> forum thread id ---------- */
/* Reloaded on startup from existing forum threads so we survive restarts. */
const threadCache = new Map(); // characterId (string) -> threadId (string)

/* ============================================================
   STARTUP
   ============================================================ */
discord.once('ready', async () => {
  console.log(`[bot] Logged in as ${discord.user.tag}`);
  await fetchForumTagIds();
  await rebuildThreadCache();
  subscribeRealtime();
  console.log('[bot] Ready and listening.');
});

async function fetchForumTagIds() {
  try {
    const forum = await discord.channels.fetch(SUBMISSIONS_FORUM_ID);
    if (!forum || forum.type !== ChannelType.GuildForum) {
      console.error('[bot] Submissions channel is not a forum channel.');
      return;
    }
    for (const tag of forum.availableTags) {
      const n = tag.name.toLowerCase();
      if (n.includes('review'))       TAG_IDS.under_review = tag.id;
      else if (n.includes('approve')) TAG_IDS.approved     = tag.id;
      else if (n.includes('den'))     TAG_IDS.denied       = tag.id;
    }
    console.log('[bot] Forum tags:', TAG_IDS);
    if (!TAG_IDS.under_review || !TAG_IDS.approved || !TAG_IDS.denied) {
      console.warn('[bot] WARNING: Not all expected tags were found. Create tags named "Under Review", "Approved", and "Denied" on the forum.');
    }
  } catch (e) {
    console.error('[bot] fetchForumTagIds failed:', e);
  }
}

/* Scan existing forum threads for "[CHAR:<id>]" markers to rebuild the
   character_id -> thread_id cache. Keeps the bot working across restarts. */
async function rebuildThreadCache() {
  try {
    const forum = await discord.channels.fetch(SUBMISSIONS_FORUM_ID);
    if (!forum) return;

    const active   = await forum.threads.fetchActive();
    const archived = await forum.threads.fetchArchived({ limit: 100 });
    const all = [...active.threads.values(), ...archived.threads.values()];

    for (const thread of all) {
      try {
        const msgs = await thread.messages.fetch({ limit: 5 });
        for (const msg of msgs.values()) {
          // New format: marker lives in the embed footer
          for (const emb of msg.embeds || []) {
            const footer = emb.footer?.text || '';
            const m = footer.match(/CHAR:([0-9a-f-]{36})/i);
            if (m) { threadCache.set(m[1], thread.id); break; }
          }
          if (threadCache.has(thread.id)) break;
          // Fallback: legacy format with marker in message content
          const legacy = msg.content?.match(/\[CHAR:([0-9a-f-]+)\]/i);
          if (legacy) { threadCache.set(legacy[1], thread.id); break; }
        }
      } catch { /* ignore */ }
    }
    console.log(`[bot] Rebuilt thread cache with ${threadCache.size} entries.`);
  } catch (e) {
    console.error('[bot] rebuildThreadCache failed:', e);
  }
}

/* ============================================================
   REALTIME SUBSCRIPTIONS
   ============================================================ */
function subscribeRealtime() {
  // Character submissions
  supa
    .channel('characters-changes')
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'characters' },
        (payload) => handleCharacterInsert(payload.new).catch(console.error))
    .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'characters' },
        (payload) => handleCharacterUpdate(payload.old, payload.new).catch(console.error))
    .subscribe((status) => console.log('[realtime] characters:', status));

  // Applications (lore / staff / gm)
  supa
    .channel('applications-changes')
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'applications' },
        (payload) => handleApplicationInsert(payload.new).catch(console.error))
    .subscribe((status) => console.log('[realtime] applications:', status));
}

/* ============================================================
   CHARACTER SUBMISSIONS
   ============================================================ */
async function handleCharacterInsert(row) {
  console.log(`[submission] new #${row.seq} (${row.type}) from ${row.discord_username}`);

  const forum = await discord.channels.fetch(SUBMISSIONS_FORUM_ID);
  if (!forum) { console.error('[submission] forum channel not found'); return; }

  const typeLabel     = TYPE_LABELS[row.type] || row.type.toUpperCase();
  const characterName = extractCharacterName(row);
  const threadName    = `${characterName}︲${row.discord_username}`;

  const link        = row.gdoc_url || '(no document URL provided)';
  const methodLabel = row.method === 'googledoc' ? 'Google Doc'
                    : row.method === 'wikidot'   ? 'Wikidot'
                    : row.method === 'website'   ? 'Website Form'
                    : row.method;

  // Opening embed — white outline, all fields consistent (︲ separators, no em-dashes)
  const openingEmbed = new EmbedBuilder()
    .setColor(0xffffff)
    .setTitle(`New ${typeLabel} Submission ︲ #${row.seq}`)
    .addFields(
      { name: 'Name',      value: characterName,                  inline: true  },
      { name: 'Type',      value: typeLabel,                      inline: true  },
      { name: 'Method',    value: methodLabel,                    inline: true  },
      { name: 'Submitted By', value: mentionOrName(row),          inline: false },
      { name: 'Document',  value: link,                           inline: false },
      { name: 'Status',    value: '`Under Review`',               inline: false },
    )
    .setFooter({ text: `CHAR:${row.id}` }) // keeps the thread-recovery marker, discreetly
    .setTimestamp(new Date(row.created_at || Date.now()));

  // Ping line pinned to the message so the submitter gets notified
  const pingContent = row.discord_user_id
    ? `<@${row.discord_user_id}> ︲ your submission has been received and is now under review.`
    : `**${row.discord_username}** ︲ your submission has been received and is now under review.`;

  const appliedTags = TAG_IDS.under_review ? [TAG_IDS.under_review] : [];

  try {
    const thread = await forum.threads.create({
      name: threadName.slice(0, 100),
      appliedTags,
      message: {
        content: pingContent,
        embeds: [openingEmbed],
        allowedMentions: { users: row.discord_user_id ? [row.discord_user_id] : [] },
      },
    });
    threadCache.set(row.id, thread.id);
    console.log(`[submission] created thread ${thread.id} for character ${row.id}`);
  } catch (e) {
    console.error('[submission] failed to create thread:', e);
  }
}

/* Returns a Discord mention if we have a user ID, else just the username. */
function mentionOrName(row) {
  if (row.discord_user_id) return `<@${row.discord_user_id}> (${row.discord_username})`;
  return `**${row.discord_username}**`;
}

async function handleCharacterUpdate(oldRow, newRow) {
  // Only act on relevant status transitions
  if (oldRow.status === newRow.status) return;

  const isApproval    = newRow.status === 'approved';
  const isDenial      = newRow.status === 'denied';
  const isResubmit    = oldRow.status === 'denied' && newRow.status === 'pending';
  if (!isApproval && !isDenial && !isResubmit) return;

  console.log(`[submission] #${newRow.seq} ${oldRow.status} -> ${newRow.status}`);

  const threadId = threadCache.get(newRow.id);
  if (!threadId) {
    console.warn(`[submission] no thread cached for character ${newRow.id}`);
    return;
  }

  let thread;
  try {
    thread = await discord.channels.fetch(threadId);
  } catch {
    console.warn(`[submission] thread ${threadId} no longer accessible`);
    return;
  }
  if (!thread) return;

  // ===== Resubmission =====
  if (isResubmit) {
    const yellowEmbed = new EmbedBuilder()
      .setColor(0xf1c40f)
      .setTitle('RESUBMITTED')
      .setDescription(
        `${mentionOrName(newRow)} has re-submitted this character for review.\n\n` +
        `**Updated Document:** ${newRow.gdoc_url || '_(no URL on file)_'}`
      )
      .setTimestamp(new Date());

    try {
      await thread.send({
        embeds: [yellowEmbed],
        allowedMentions: { users: newRow.discord_user_id ? [newRow.discord_user_id] : [] },
      });
    } catch (e) {
      console.error('[submission] failed to send resubmit embed:', e);
    }

    // Swap tag back to Under Review
    try {
      if (TAG_IDS.under_review) await thread.setAppliedTags([TAG_IDS.under_review]);
      if (thread.archived) await thread.setArchived(false);
    } catch (e) {
      console.error('[submission] failed to reset tag on resubmit:', e);
    }
    return;
  }

  // ===== Approved / Denied =====
  const reason   = (newRow.staff_reason || '').trim();
  const approved = isApproval;

  // Primary result embed
  const resultEmbed = new EmbedBuilder()
    .setColor(approved ? 0x2ecc71 : 0xe74c3c)
    .setTitle(approved ? 'APPROVED' : 'DENIED')
    .setTimestamp(new Date());

  if (reason) {
    resultEmbed.setDescription(reason);
  } else if (!approved) {
    resultEmbed.setDescription('_No reason provided._');
  }

  const embeds = [resultEmbed];

  // For denials, add the resubmit-notice embed in the same message
  if (!approved) {
    const noticeEmbed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('Next Steps')
      .setDescription(
        'Once you\'ve made the necessary fixes to your document, head back to the ' +
        '**website**, open the **Submission Tracker**, and hit **Re-Submit** on this entry ' +
        'to send the updated version through again.'
      );
    embeds.push(noticeEmbed);
  }

  // Ping content — pings the submitter so they see the result
  const pingContent = newRow.discord_user_id
    ? `<@${newRow.discord_user_id}>`
    : `**${newRow.discord_username}**`;

  try {
    await thread.send({
      content: pingContent,
      embeds, // single message, both embeds
      allowedMentions: { users: newRow.discord_user_id ? [newRow.discord_user_id] : [] },
    });
  } catch (e) {
    console.error('[submission] failed to send result message:', e);
  }

  // Update tags
  try {
    const newTags = [];
    if (approved && TAG_IDS.approved) newTags.push(TAG_IDS.approved);
    if (!approved && TAG_IDS.denied)  newTags.push(TAG_IDS.denied);
    if (newTags.length) await thread.setAppliedTags(newTags);
  } catch (e) {
    console.error('[submission] failed to update tags:', e);
  }
}

/* ============================================================
   APPLICATIONS (Lore / Staff / GM)
   ============================================================ */
const APP_CONFIG = {
  lore: {
    channelId: LORE_APP_CHANNEL_ID,
    title:     'Lore Team Application',
    color:     0x8050ff,
    questions: [
      { id: 'writing_sample',      label: 'Writing Sample' },
      { id: 'scp_knowledge',       label: 'Familiarity with the SCP Wiki' },
      { id: 'canon_philosophy',    label: 'On Threefold not following any one wiki canon' },
      { id: 'scenario_derail',     label: 'Scenario: Unestablished ability mid-event' },
      { id: 'scenario_submission', label: 'Scenario: Submission close to an existing character' },
      { id: 'player_led_lore',     label: 'Player-led lore' },
      { id: 'availability',        label: 'Weekly availability' },
      { id: 'why_lore',            label: 'Why Lore Team?' },
    ],
  },
  staff: {
    channelId: LORE_APP_CHANNEL_ID, // spec didn't give a staff-mod channel; route to same as lore. Change if you want.
    title:     'Staff / Moderation Application',
    color:     0x3498db,
    questions: [
      { id: 'mod_experience',    label: 'Previous moderation experience' },
      { id: 'scenario_argument', label: 'Scenario: Two members arguing in OOC' },
      { id: 'scenario_rule',     label: 'Scenario: Well-liked member breaks a rule' },
      { id: 'scenario_bias',     label: 'Scenario: Prior OOC disagreement, later report' },
      { id: 'community_health',  label: 'What a healthy RP community looks like' },
      { id: 'availability',      label: 'Weekly availability' },
      { id: 'why_mod',           label: 'Why moderate on Threefold?' },
    ],
  },
  gm: {
    channelId: GM_APP_CHANNEL_ID,
    title:     'Gamemaster Application',
    color:     0xe67e22,
    questions: [
      { id: 'gm_experience',     label: 'Previous GM / RP experience' },
      { id: 'gm_style',          label: 'Preferred GM style' },
      { id: 'story_types',       label: 'Types of stories they want to tell' },
      { id: 'event_idea',        label: 'Pitched event idea' },
      { id: 'scenario_derail',   label: 'Scenario: Players ignoring the hook' },
      { id: 'lore_coordination', label: 'Working under Lore Team supervision' },
      { id: 'availability',      label: 'Weekly availability' },
      { id: 'why_gm',            label: 'Why GM over Lore Team?' },
    ],
  },
};

async function handleApplicationInsert(row) {
  const cfg = APP_CONFIG[row.type];
  if (!cfg) { console.warn('[application] unknown type:', row.type); return; }

  console.log(`[application] new ${row.type} app #${row.seq}`);

  const channel = await discord.channels.fetch(cfg.channelId).catch(() => null);
  if (!channel) { console.error(`[application] channel ${cfg.channelId} not found`); return; }

  const data = row.form_data || {};

  // Header embed - user info + meta
  const header = new EmbedBuilder()
    .setColor(cfg.color)
    .setTitle(`${cfg.title} — #${row.seq}`)
    .addFields(
      { name: 'Discord Username', value: safe(data.discord_username), inline: true },
      { name: 'Discord User ID',  value: safe(data.discord_user_id),  inline: true },
      { name: 'Timezone',         value: safe(data.timezone),         inline: true },
    )
    .setTimestamp(new Date(row.created_at || Date.now()));

  // Body embeds - one field per question (chunked across embeds to respect Discord limits)
  // Discord: max 25 fields per embed, max 1024 chars per field value, max 6000 chars per embed total.
  const bodyEmbeds = [];
  let current = new EmbedBuilder().setColor(cfg.color);
  let runningChars = 0;
  let fieldCount = 0;

  for (const q of cfg.questions) {
    const raw = data[q.id];
    const value = safe(raw);
    // truncate to 1024 for a field
    const clipped = value.length > 1024 ? value.slice(0, 1021) + '...' : value;

    const projected = runningChars + q.label.length + clipped.length;
    if (fieldCount >= 25 || projected > 5500) {
      bodyEmbeds.push(current);
      current = new EmbedBuilder().setColor(cfg.color);
      runningChars = 0;
      fieldCount = 0;
    }
    current.addFields({ name: q.label, value: clipped });
    runningChars += q.label.length + clipped.length;
    fieldCount++;
  }
  if (fieldCount > 0) bodyEmbeds.push(current);

  try {
    // Discord allows up to 10 embeds per message
    const allEmbeds = [header, ...bodyEmbeds];
    for (let i = 0; i < allEmbeds.length; i += 10) {
      await channel.send({ embeds: allEmbeds.slice(i, i + 10) });
    }
  } catch (e) {
    console.error('[application] failed to send embed(s):', e);
  }
}

function safe(v) {
  if (v === null || v === undefined || v === '') return '_—_';
  return String(v);
}

/* ============================================================
   BOOT
   ============================================================ */
discord.login(DISCORD_TOKEN).catch(err => {
  console.error('[bot] login failed:', err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
