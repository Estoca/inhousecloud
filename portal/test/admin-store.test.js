import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deactivatePortalAdmin,
  isPortalAdmin,
  listPortalAdmins,
  upsertPortalAdmin,
  validatePortalAdmin,
} from '../src/admin-store.js';

test('validatePortalAdmin normalizes email and role', () => {
  const result = validatePortalAdmin({
    email: ' ANA@EXAMPLE.COM ',
    name: 'Ana',
    role: 'super_admin',
  });

  assert.equal(result.valid, true);
  assert.equal(result.admin.email, 'ana@example.com');
  assert.equal(result.admin.role, 'super_admin');
});

test('listPortalAdmins merges bootstrap admins without duplicates', async () => {
  const result = await listPortalAdmins({
    bootstrapAdmins: ['ana@example.com'],
    pool: {
      query: async () => ({
        rows: [
          {
            id: 'admin-1',
            email: 'ops@example.com',
            name: 'Ops',
            role: 'admin',
            active: true,
            source: 'portal',
            created_at: null,
            modified_at: null,
            deactivated_at: null,
          },
        ],
      }),
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.admins.length, 2);
  assert.equal(result.admins[0].source, 'env');
});

test('isPortalAdmin falls back to bootstrap admins', async () => {
  const result = await isPortalAdmin('ana@example.com', {
    bootstrapAdmins: ['ana@example.com'],
  });

  assert.equal(result.allowed, true);
  assert.equal(result.admin.role, 'super_admin');
});

test('upsertPortalAdmin writes active admin records', async () => {
  const result = await upsertPortalAdmin({
    email: 'ana@example.com',
    role: 'admin',
  }, {
    actorEmail: 'ana@example.com',
    pool: {
      query: async (_text, params) => ({
        rows: [{
          id: 'admin-1',
          email: params[0],
          name: params[1],
          role: params[2],
          active: true,
          source: 'portal',
          created_at: null,
          modified_at: null,
          deactivated_at: null,
        }],
      }),
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.admin.email, 'ana@example.com');
});

test('deactivatePortalAdmin never deactivates env admins', async () => {
  const result = await deactivatePortalAdmin('ana@example.com', {
    bootstrapAdmins: ['ana@example.com'],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['env_admin_cannot_be_deactivated']);
});
