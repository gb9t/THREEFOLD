/* ============================================================
   supabase.js — shared config + helpers
   ============================================================ */

const SUPABASE_URL  = 'https://gcyrfrbkqxnkdbsbcppa.supabase.co';
const SUPABASE_ANON = 'sb_publishable_NrC_oU2QqkS5YLrG0W5u-A_eP4lRni_';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON);

/* ------- Role hierarchy (stored in profiles.role) ------- */
const ROLES = {
  OWNER:          'owner',
  ADMIN:          'admin',
  HEAD_LORE:      'head_lore',
  LORE:           'lore',
  TRIAL_LORE:     'trial_lore',
  MOD:            'mod',
  TRIAL_MOD:      'trial_mod',
};

const CAN_MANAGE       = [ROLES.OWNER, ROLES.ADMIN];
const CAN_VIEW         = [ROLES.OWNER, ROLES.ADMIN, ROLES.HEAD_LORE, ROLES.LORE, ROLES.TRIAL_LORE, ROLES.MOD, ROLES.TRIAL_MOD];
const CAN_MANAGE_STAFF = [ROLES.OWNER];

/* ------- Auth helpers ------- */
async function getSession() {
  const { data } = await db.auth.getSession();
  return data.session;
}

async function getProfile(userId) {
  const { data } = await db.from('profiles').select('*').eq('id', userId).single();
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

/* ------- Character helpers (used by submission.html) ------- */
async function submitCharacter(type, method, discord, data, gdocUrl) {
  const { data: r, error } = await db
    .from('characters')
    .insert([{
      type,
      method,
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
    .select('id, seq, type, method, discord_username, status, staff_reason, created_at, character_data, gdoc_url')
    .order('seq', { ascending: true });
  if (filters.status) q = q.eq('status', filters.status);
  if (filters.type)   q = q.eq('type', filters.type);
  const { data, error } = await q;
  return { data, error };
}

async function getCharacterById(id) {
  const { data, error } = await db.from('characters').select('*').eq('id', id).single();
  return { data, error };
}

async function getCharactersByDiscord(username) {
  const { data, error } = await db
    .from('characters')
    .select('id, seq, type, method, discord_username, status, staff_reason, created_at, character_data, gdoc_url')
    .eq('discord_username', username)
    .order('seq');
  return { data, error };
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

/* ------- Staff / profile helpers ------- */
async function getStaffMembers() {
  const { data, error } = await db
    .from('profiles')
    .select('id, display_name, role, discord_username')
    .order('role');
  return { data, error };
}

async function updateStaffRole(userId, role) {
  const { error } = await db.from('profiles').update({ role }).eq('id', userId);
  return { error };
}

/* ------- Position open/closed helpers ------- */
async function getPositions() {
  const { data } = await db.from('positions').select('*');
  return data || [];
}

async function setPositionOpen(type, isOpen) {
  await db.from('positions').upsert({ type, is_open: isOpen });
}
