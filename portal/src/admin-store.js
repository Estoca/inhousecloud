import { query } from './db.js';

const VALID_ROLES = new Set(['super_admin', 'admin', 'viewer']);

function cleanEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  return email && email.includes('@') ? email : null;
}

function cleanText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanRole(value) {
  const role = cleanText(value) || 'admin';
  return VALID_ROLES.has(role) ? role : null;
}

export function validatePortalAdmin(input = {}) {
  const email = cleanEmail(input.email);
  const role = cleanRole(input.role);
  const errors = [];

  if (!email) errors.push('email_required');
  if (!role) errors.push('role_invalid');

  return {
    valid: errors.length === 0,
    errors,
    admin: {
      email,
      name: cleanText(input.name),
      role,
      active: input.active !== false,
    },
  };
}

function normalizeAdmin(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    active: row.active,
    source: row.source,
    created_at: row.created_at,
    modified_at: row.modified_at,
    deactivated_at: row.deactivated_at,
  };
}

export async function listPortalAdmins({ bootstrapAdmins = [], ...options } = {}) {
  const result = await query(`
    SELECT id, email, name, role, active, source, created_at, modified_at, deactivated_at
    FROM deploy_platform.portal_admins
    ORDER BY active DESC, lower(email)
  `, [], options);

  const bootstrap = bootstrapAdmins.map((email) => ({
    id: `env:${email}`,
    email,
    name: null,
    role: 'super_admin',
    active: true,
    source: 'env',
    created_at: null,
    modified_at: null,
    deactivated_at: null,
  }));

  if (!result.available) {
    return {
      available: false,
      error: result.error,
      admins: bootstrap,
    };
  }

  const seen = new Set();
  const admins = [...bootstrap, ...result.rows.map(normalizeAdmin)]
    .filter((admin) => {
      const key = admin.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return {
    available: true,
    admins,
  };
}

export async function isPortalAdmin(email, { bootstrapAdmins = [], ...options } = {}) {
  const normalizedEmail = cleanEmail(email);
  if (!normalizedEmail) return { available: true, allowed: false, admin: null };

  if (bootstrapAdmins.includes(normalizedEmail)) {
    return {
      available: true,
      allowed: true,
      admin: {
        email: normalizedEmail,
        name: null,
        role: 'super_admin',
        source: 'env',
      },
    };
  }

  const result = await query(`
    SELECT id, email, name, role, active, source, created_at, modified_at, deactivated_at
    FROM deploy_platform.portal_admins
    WHERE lower(email) = $1
      AND active = true
    LIMIT 1
  `, [normalizedEmail], options);

  if (!result.available) {
    return { available: false, allowed: false, error: result.error, admin: null };
  }

  return {
    available: true,
    allowed: result.rows.length > 0,
    admin: result.rows[0] ? normalizeAdmin(result.rows[0]) : null,
  };
}

export async function upsertPortalAdmin(input, { actorEmail, ...options } = {}) {
  const validation = validatePortalAdmin(input);
  if (!validation.valid) {
    return {
      available: true,
      ok: false,
      errors: validation.errors,
      admin: null,
    };
  }

  const admin = validation.admin;
  const result = await query(`
    INSERT INTO deploy_platform.portal_admins (
      email,
      name,
      role,
      active,
      source,
      created_by,
      modified_by,
      deactivated_at,
      deactivated_at_epoch
    )
    VALUES ($1, $2, $3, true, 'portal', $4, $4, NULL, NULL)
    ON CONFLICT (email) DO UPDATE SET
      name = EXCLUDED.name,
      role = EXCLUDED.role,
      active = true,
      modified_at = now(),
      modified_at_epoch = extract(epoch from now())::bigint,
      modified_by = EXCLUDED.modified_by,
      deactivated_at = NULL,
      deactivated_at_epoch = NULL
    RETURNING id, email, name, role, active, source, created_at, modified_at, deactivated_at
  `, [admin.email, admin.name, admin.role, actorEmail], options);

  if (!result.available) {
    return {
      available: false,
      ok: false,
      error: result.error,
      admin: null,
    };
  }

  return {
    available: true,
    ok: true,
    admin: normalizeAdmin(result.rows[0]),
  };
}

export async function deactivatePortalAdmin(email, { actorEmail, bootstrapAdmins = [], ...options } = {}) {
  const normalizedEmail = cleanEmail(email);
  if (!normalizedEmail) {
    return {
      available: true,
      ok: false,
      errors: ['email_required'],
      admin: null,
    };
  }

  if (bootstrapAdmins.includes(normalizedEmail)) {
    return {
      available: true,
      ok: false,
      errors: ['env_admin_cannot_be_deactivated'],
      admin: null,
    };
  }

  const result = await query(`
    UPDATE deploy_platform.portal_admins
    SET
      active = false,
      modified_at = now(),
      modified_at_epoch = extract(epoch from now())::bigint,
      modified_by = $2,
      deactivated_at = now(),
      deactivated_at_epoch = extract(epoch from now())::bigint
    WHERE lower(email) = $1
    RETURNING id, email, name, role, active, source, created_at, modified_at, deactivated_at
  `, [normalizedEmail, actorEmail], options);

  if (!result.available) {
    return {
      available: false,
      ok: false,
      error: result.error,
      admin: null,
    };
  }

  if (result.rows.length === 0) {
    return {
      available: true,
      ok: false,
      errors: ['admin_not_found'],
      admin: null,
    };
  }

  return {
    available: true,
    ok: true,
    admin: normalizeAdmin(result.rows[0]),
  };
}
