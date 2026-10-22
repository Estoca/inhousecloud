#!/usr/bin/env bash
# The portal's role from the Authentik groups (portal/src/roles.js, roleFromGroups),
# without a box, with the group names the installer gives the portal (ADMIN_GROUP and
# USER_GROUP in compose.yml, from AUTHENTIK_PORTAL_GROUP and AUTHENTIK_APP_GROUP):
#
#   scripts/tests/portal-roles.sh
#
# ihc-admins is admin, ihc-users is viewer, both is admin, anything else (a similar name,
# another case, no group) is nobody; the header form the outpost sends (a|b) counts the
# same. Also checks that compose.yml still maps the two groups into the portal. Needs
# node 20 or later. Fails (exit 1) on any surprise.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAILS=0
grep -q 'ADMIN_GROUP: ${AUTHENTIK_PORTAL_GROUP:-ihc-admins}' "$ROOT/docker/compose.yml" \
  && grep -q 'USER_GROUP: ${AUTHENTIK_APP_GROUP:-ihc-users}' "$ROOT/docker/compose.yml" \
  && echo "[ok] compose.yml maps AUTHENTIK_PORTAL_GROUP and AUTHENTIK_APP_GROUP into the portal" \
  || { echo "[xx] compose.yml no longer maps the two groups into the portal"; FAILS=1; }
node --input-type=module - "$ROOT/portal/src/roles.js" <<'JS' || FAILS=1
const { roleFromGroups } = await import(process.argv[2]);
const groups = { adminGroup: 'ihc-admins', userGroup: 'ihc-users' };
const cases = [
  ['ihc-admins only', ['ihc-admins'], 'admin'],
  ['ihc-users only', ['ihc-users'], 'viewer'],
  ['both groups', ['ihc-users', 'ihc-admins'], 'admin'],
  ['the outpost header, both', 'ihc-users|ihc-admins', 'admin'],
  ['the outpost header, users', 'ihc-users', 'viewer'],
  ['another group', ['authentik Admins'], null],
  ['a similar name', ['ihc-admins-old', 'ihc-users2'], null],
  ['another case', ['IHC-ADMINS'], null],
  ['no group', [], null],
  ['empty header', '', null],
];
let bad = 0;
for (const [name, input, want] of cases) {
  const got = roleFromGroups(input, groups);
  console.log(`[${got === want ? 'ok' : 'xx'}] ${name}: ${got}`);
  if (got !== want) bad += 1;
}
process.exit(bad ? 1 : 0);
JS
[ "$FAILS" = 0 ] && echo "portal-roles: all cases pass" || { echo "portal-roles: FAILED"; exit 1; }
