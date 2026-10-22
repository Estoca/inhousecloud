import test from 'node:test';
import assert from 'node:assert/strict';
import { isAdminRole, parseGroups, roleFromGroups, strongerRole } from '../src/roles.js';

const groups = { adminGroup: 'ihc-admins', userGroup: 'ihc-users' };

test('ihc-admins is admin, ihc-users is viewer, anything else is nobody', () => {
  assert.equal(roleFromGroups(['ihc-admins'], groups), 'admin');
  assert.equal(roleFromGroups(['ihc-users'], groups), 'viewer');
  assert.equal(roleFromGroups(['ihc-users', 'ihc-admins'], groups), 'admin');
  assert.equal(roleFromGroups(['outro'], groups), null);
  assert.equal(roleFromGroups([], groups), null);
  // exact names only
  assert.equal(roleFromGroups(['ihc-admins-old', 'IHC-USERS'], groups), null);
  // the header string as the outpost sends it
  assert.equal(roleFromGroups('ihc-users|ihc-admins', groups), 'admin');
  assert.equal(roleFromGroups('ihc-users', groups), 'viewer');
  // an unset group never matches
  assert.equal(roleFromGroups(['ihc-users'], { adminGroup: 'ihc-admins' }), null);
});

test('parseGroups splits on | and , and drops blanks', () => {
  assert.deepEqual(parseGroups(' a | b ,c,, '), ['a', 'b', 'c']);
  assert.deepEqual(parseGroups(undefined), []);
});

test('the stronger role wins; admin and super_admin are admin', () => {
  assert.equal(strongerRole('viewer', 'admin'), 'admin');
  assert.equal(strongerRole('super_admin', 'admin'), 'super_admin');
  assert.equal(strongerRole(null, 'viewer'), 'viewer');
  assert.equal(strongerRole(null, null), null);
  assert.equal(isAdminRole('admin'), true);
  assert.equal(isAdminRole('super_admin'), true);
  assert.equal(isAdminRole('viewer'), false);
  assert.equal(isAdminRole(null), false);
});
