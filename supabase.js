/* ============================================================
   supabase.js — shared config + helpers
   Replace SUPABASE_URL and SUPABASE_ANON_KEY with your own.
   You get these from: Supabase dashboard → Settings → API
   ============================================================ */

const SUPABASE_URL  = 'https://gcyrfrbkqxnkdbsbcppa.supabase.co';   // e.g. https://xyzxyz.supabase.co
const SUPABASE_ANON = 'sb_publishable_NrC_oU2QqkS5YLrG0W5u-A_eP4lRni_';       // long JWT string

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

/* Roles that can MANAGE (approve/deny/delete) applications */
const CAN_MANAGE = [ROLES.OWNER, ROLES.ADMIN];

/* Roles that can VIEW applications */
const CAN_VIEW = [
  ROLES.OWNER, ROLES.ADMIN,
  ROLES.HEAD_LORE, ROLES.LORE, ROLES.TRIAL_LORE,
  ROLES.MOD, ROLES.TRIAL_MOD,
];

/* Roles that can change another user's role (owner only in practice) */
const CAN_MANAGE_STAFF = [ROLES.OWNER];

/* ------- Auth helpers ------- */
async function getSession() {
  const { data } = await db.auth.getSession();
  return data.session;
}

async function getProfile(userId) {
  const { data } = await db
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
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

/* ------- Application helpers ------- */
async function submitApplication(type, formData) {
  const { data, error } = await db
    .from('applications')
    .insert([{ type, form_data: formData, status: 'pending' }])
    .select()
    .single();
  return { data, error };
}

async function getApplications(type = null) {
  let q = db
    .from('applications')
    .select('*')
    .order('seq', { ascending: true });
  if (type) q = q.eq('type', type);
  const { data, error } = await q;
  return { data, error };
}

async function updateApplicationStatus(id, status) {
  const { error } = await db
    .from('applications')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);
  return { error };
}

async function deleteApplication(id) {
  const { error } = await db
    .from('applications')
    .delete()
    .eq('id', id);
  return { error };
}

async function getStaffMembers() {
  const { data, error } = await db
    .from('profiles')
    .select('id, display_name, role, discord_username')
    .order('role');
  return { data, error };
}

async function updateStaffRole(userId, role) {
  const { error } = await db
    .from('profiles')
    .update({ role })
    .eq('id', userId);
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
