/* ============================================================
   supabase.js — shared config + helpers
   ============================================================ */

const SUPABASE_URL  = 'https://ejzhpwcxsqmxqshcqmwg.supabase.co';
const SUPABASE_ANON = 'sb_publishable_twCTVIseleRSKRZoobqpNg_lSs0A7yq';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON);

/* ------- Role hierarchy ------- */
const ROLES = {
  OWNER:      'owner',
  ADMIN:      'admin',
  HEAD_LORE:  'head_lore',
  LORE:       'lore',
  TRIAL_LORE: 'trial_lore',
  MOD:        'mod',
  TRIAL_MOD:  'trial_mod',
};

const CAN_MANAGE       = [ROLES.OWNER, ROLES.ADMIN, ROLES.HEAD_LORE];
const CAN_REVIEW_CHARS = [ROLES.OWNER, ROLES.ADMIN, ROLES.HEAD_LORE, ROLES.LORE, ROLES.TRIAL_LORE];
const CAN_VIEW         = [ROLES.OWNER, ROLES.ADMIN, ROLES.HEAD_LORE, ROLES.LORE, ROLES.TRIAL_LORE, ROLES.MOD, ROLES.TRIAL_MOD];
const CAN_MANAGE_STAFF = [ROLES.OWNER];

/* ------- Auth helpers ------- */
async function getSession() {
  const { data } = await db.auth.getSession();
  return data.session;
}

async function getProfile(userId) {
  const { data, error } = await db.from('profiles').select('*').eq('id', userId).single();
  if (error) console.error('[supabase] getProfile:', error);
  return data;
}

async function getCurrentProfile() {
  const session = await getSession();
  if (!session) return null;
  return getProfile(session.user.id);
}

function hasRole(profile, allowedRoles) {
  return profile && allowedRoles.includes(profile.role);
}

/* ------- Character helpers ------- */
async function submitCharacter(type, method, discord, data, gdocUrl) {
  const { data: r, error } = await db
    .from('characters')
    .insert([{
      type, method,
      discord_username: discord,
      character_data: data || {},
      gdoc_url: gdocUrl || null,
      status: 'pending',
    }])
    .select()
    .single();
  return { data: r, error };
}

async function getCharacters(filters = {}) {
  let q = db
    .from('characters')
    .select('id, seq, type, method, discord_username, status, staff_reason, created_at, character_data, gdoc_url, denied_at')
    .order('seq', { ascending: true });
  if (filters.status) q = q.eq('status', filters.status);
  if (filters.type)   q = q.eq('type', filters.type);
  const { data, error } = await q;
  if (error) console.error('[supabase] getCharacters:', error);
  return { data, error };
}

async function getCharacterById(id) {
  const { data, error } = await db.from('characters').select('*').eq('id', id).single();
  if (error) console.error('[supabase] getCharacterById:', error);
  return { data, error };
}

async function getCharactersByDiscord(username) {
  const { data, error } = await db
    .from('characters')
    .select('id, seq, type, method, discord_username, status, staff_reason, created_at, character_data, gdoc_url, denied_at')
    .eq('discord_username', username)
    .order('seq');
  if (error) console.error('[supabase] getCharactersByDiscord:', error);
  return { data, error };
}

async function updateCharacterStatus(id, status, reason, reviewer) {
  // When status flips to 'denied', stamp denied_at — this starts the 48h
  // resubmit window. For any other status, clear it (so if a denied submission
  // is later approved, the clock doesn't keep running).
  const patch = {
    status,
    staff_reason: reason || null,
    reviewed_by: reviewer || null,
    updated_at: new Date().toISOString(),
  };
  if (status === 'denied') {
    patch.denied_at = new Date().toISOString();
  } else {
    patch.denied_at = null;
  }
  const { error } = await db.from('characters').update(patch).eq('id', id);
  if (error) console.error('[supabase] updateCharacterStatus:', error);
  return { error };
}

// Re-submit a denied character. Flips status back to 'pending' on the SAME row
// (same seq, same #) and clears denied_at / staff_reason so it looks fresh.
async function resubmitCharacter(id) {
  const { error } = await db.from('characters').update({
    status: 'pending',
    denied_at: null,
    staff_reason: null,
    reviewed_by: null,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) console.error('[supabase] resubmitCharacter:', error);
  return { error };
}

// Soft-delete a character: snapshot the row into deleted_items with a 14-day
// expiration, then remove from the characters table. Returns the deleted_items
// row so the caller can show confirmation. Uses the user's profile for
// deleted_by if available.
async function deleteCharacter(id, actorName) {
  // 1. Grab the full row to snapshot.
  const { data: char, error: fetchErr } = await db
    .from('characters').select('*').eq('id', id).single();
  if (fetchErr) { console.error('[supabase] deleteCharacter fetch:', fetchErr); return { error: fetchErr }; }
  if (!char) return { error: new Error('Character not found') };

  // 2. Insert into deleted_items.
  const { error: insErr } = await db.from('deleted_items').insert([{
    item_type: 'character',
    original_id: char.id,
    original_seq: char.seq,
    payload: char,
    deleted_by: actorName || null,
  }]);
  if (insErr) { console.error('[supabase] deleteCharacter archive:', insErr); return { error: insErr }; }

  // 3. Delete the original.
  const { error: delErr } = await db.from('characters').delete().eq('id', id);
  if (delErr) console.error('[supabase] deleteCharacter:', delErr);
  return { error: delErr };
}

// Permanent delete (owner only on the UI side; RLS also enforces). Skips the
// recycle bin. Used when an owner force-purges something.
async function purgeCharacter(id) {
  const { error } = await db.from('characters').delete().eq('id', id);
  if (error) console.error('[supabase] purgeCharacter:', error);
  return { error };
}

async function uploadCharacterImage(file) {
  const ext  = file.name.split('.').pop().toLowerCase();
  const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { error } = await db.storage
    .from('character-images')
    .upload(name, file, { cacheControl: '3600', upsert: false });
  if (error) throw error;
  const { data } = db.storage.from('character-images').getPublicUrl(name);
  return data.publicUrl;
}

/* ------- Application helpers (Lore / Staff / GM) ------- */
async function submitApplication(type, formData) {
  const { data, error } = await db
    .from('applications')
    .insert([{ type, form_data: formData, status: 'pending' }])
    .select()
    .single();
  if (error) console.error('[supabase] submitApplication:', error);
  return { data, error };
}

async function getApplications(filters = {}) {
  let q = db
    .from('applications')
    .select('*')
    .order('seq', { ascending: true });
  if (filters.status) q = q.eq('status', filters.status);
  if (filters.type)   q = q.eq('type', filters.type);
  const { data, error } = await q;
  if (error) console.error('[supabase] getApplications:', error);
  return { data, error };
}

async function updateApplicationStatus(id, status, reason, reviewer) {
  const { error } = await db.from('applications').update({
    status,
    staff_reason: reason || null,
    reviewed_by: reviewer || null,
    updated_at: new Date().toISOString(),
  }).eq('id', id);
  if (error) console.error('[supabase] updateApplicationStatus:', error);
  return { error };
}

async function deleteApplication(id, actorName) {
  const { data: app, error: fetchErr } = await db
    .from('applications').select('*').eq('id', id).single();
  if (fetchErr) { console.error('[supabase] deleteApplication fetch:', fetchErr); return { error: fetchErr }; }
  if (!app) return { error: new Error('Application not found') };

  const { error: insErr } = await db.from('deleted_items').insert([{
    item_type: 'application',
    original_id: app.id,
    original_seq: app.seq,
    payload: app,
    deleted_by: actorName || null,
  }]);
  if (insErr) { console.error('[supabase] deleteApplication archive:', insErr); return { error: insErr }; }

  const { error: delErr } = await db.from('applications').delete().eq('id', id);
  if (delErr) console.error('[supabase] deleteApplication:', delErr);
  return { error: delErr };
}

async function purgeApplication(id) {
  const { error } = await db.from('applications').delete().eq('id', id);
  if (error) console.error('[supabase] purgeApplication:', error);
  return { error };
}

/* ------- Staff / profile helpers ------- */
async function getStaffMembers() {
  // Only return rows with an assigned role (filter out 'none')
  const { data, error } = await db
    .from('profiles')
    .select('id, display_name, role, discord_username')
    .neq('role', 'none')
    .order('role');
  if (error) console.error('[supabase] getStaffMembers:', error);
  return { data, error };
}

async function getAllProfiles() {
  const { data, error } = await db
    .from('profiles')
    .select('id, display_name, role, discord_username')
    .order('role');
  if (error) console.error('[supabase] getAllProfiles:', error);
  return { data, error };
}

async function updateStaffRole(userId, role) {
  const { error } = await db.from('profiles').update({ role }).eq('id', userId);
  if (error) console.error('[supabase] updateStaffRole:', error);
  return { error };
}

async function updateProfileInfo(userId, fields) {
  const { error } = await db.from('profiles').update(fields).eq('id', userId);
  if (error) console.error('[supabase] updateProfileInfo:', error);
  return { error };
}

/* ------- Positions helpers ------- */
async function getPositions() {
  const { data, error } = await db.from('positions').select('*');
  if (error) console.error('[supabase] getPositions:', error);
  return data || [];
}

async function setPositionOpen(type, isOpen) {
  const { error } = await db.from('positions').upsert({
    type,
    is_open: isOpen,
    updated_at: new Date().toISOString(),
  });
  if (error) console.error('[supabase] setPositionOpen:', error);
  return { error };
}

/* ============================================================
   Recycle Bin (deleted_items) helpers
   ============================================================
   These back the staff-panel recycle bin. All rows expire
   14 days after deletion; owners may purge at any time.
*/

async function getDeletedItems(filters = {}) {
  let q = db
    .from('deleted_items')
    .select('*')
    .order('deleted_at', { ascending: false });
  if (filters.item_type) q = q.eq('item_type', filters.item_type);
  const { data, error } = await q;
  if (error) console.error('[supabase] getDeletedItems:', error);
  return { data, error };
}

// Restore a deleted item back to its source table. Re-inserts the full payload,
// preserving the original id and original seq when possible. If the seq slot
// is already taken (another submission got created in the interim), the DB
// will allocate a fresh seq and the caller receives { restoredSeq, originalSeq }
// so the UI can display "restored as #X (originally #Y)".
async function restoreDeletedItem(id) {
  // 1. Fetch the recycle-bin row.
  const { data: item, error: fetchErr } = await db
    .from('deleted_items').select('*').eq('id', id).single();
  if (fetchErr) { console.error('[supabase] restoreDeletedItem fetch:', fetchErr); return { error: fetchErr }; }
  if (!item) return { error: new Error('Deleted item not found') };

  const table = item.item_type === 'character' ? 'characters' : 'applications';
  const payload = { ...item.payload };
  const originalSeq = item.original_seq;

  // We try twice: first with the original seq to put it back in its slot,
  // and if that hits a unique-constraint collision, we retry without seq so
  // the DB default assigns a fresh one.
  let restoredSeq = originalSeq;
  let usedFallback = false;

  // First attempt — include seq.
  let { data: inserted, error: insErr } = await db
    .from(table).insert([payload]).select().single();

  if (insErr) {
    // Check if it's a collision (code 23505 = unique_violation). Any other
    // error is fatal and we return it as-is.
    const msg = (insErr.message || '').toLowerCase();
    const isCollision = insErr.code === '23505'
      || msg.includes('duplicate')
      || msg.includes('unique');
    if (!isCollision) {
      console.error('[supabase] restoreDeletedItem insert:', insErr);
      return { error: insErr };
    }
    // Retry without seq (and without id too, since id could also collide in
    // rare cases though it's unlikely).
    usedFallback = true;
    const retryPayload = { ...payload };
    delete retryPayload.seq;
    delete retryPayload.id;
    const retry = await db.from(table).insert([retryPayload]).select().single();
    if (retry.error) {
      console.error('[supabase] restoreDeletedItem retry insert:', retry.error);
      return { error: retry.error };
    }
    inserted = retry.data;
    restoredSeq = inserted?.seq;
  }

  // 2. Remove the recycle-bin row so we don't duplicate.
  const { error: delErr } = await db.from('deleted_items').delete().eq('id', id);
  if (delErr) {
    // Non-fatal — the restore worked; log the cleanup failure.
    console.warn('[supabase] restoreDeletedItem cleanup:', delErr);
  }

  return {
    error: null,
    data: {
      restoredId: inserted?.id,
      restoredSeq,
      originalSeq,
      usedFallback,
      itemType: item.item_type,
    },
  };
}

// Force-purge a recycle-bin row immediately. Owner-only (enforced by RLS +
// the UI gate in staff.html).
async function purgeDeletedItem(id) {
  const { error } = await db.from('deleted_items').delete().eq('id', id);
  if (error) console.error('[supabase] purgeDeletedItem:', error);
  return { error };
}

// Run both server-side purge routines (denied 48h + recycle bin 14d). Called
// opportunistically on page load as a fallback if pg_cron isn't scheduled. It
// is idempotent and cheap — just runs DELETEs with date predicates.
async function runExpirationPurges() {
  const { data, error } = await db.rpc('run_all_purges');
  if (error) {
    // Not fatal — the RPC might not exist yet (migration not run). Just log
    // and move on; the UI still works.
    console.warn('[supabase] runExpirationPurges:', error.message || error);
    return { data: null, error };
  }
  return { data, error: null };
}

