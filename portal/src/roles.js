// Papel no portal a partir dos grupos do Authentik (header X-authentik-groups).
// Puro, sem I/O: auth.js usa, e scripts/tests/portal-roles.sh e test/roles.test.js
// provam a tabela.
//
//   ADMIN_GROUP (ihc-admins)  -> admin   (tudo, menos o que e de super_admin)
//   USER_GROUP  (ihc-users)   -> viewer  (catalogo, saude e deploys dos apps)
//   nenhum dos dois           -> null    (o portal nao reconhece a pessoa)
//
// Quem esta nos dois grupos e admin. Grupo com nome parecido nao conta: a
// comparacao e exata (ihc-admins-old nao e ihc-admins).

export const ROLE_RANK = Object.freeze({ viewer: 1, admin: 2, super_admin: 3 });

// X-authentik-groups: o outpost separa os grupos por `|`; aceita `,` tambem.
export function parseGroups(value) {
  return String(value ?? '')
    .split(/[|,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function roleFromGroups(groups, { adminGroup, userGroup } = {}) {
  const list = Array.isArray(groups) ? groups : parseGroups(groups);
  if (adminGroup && list.includes(adminGroup)) return 'admin';
  if (userGroup && list.includes(userGroup)) return 'viewer';
  return null;
}

// O maior de dois papeis (null perde de qualquer papel).
export function strongerRole(a, b) {
  return (ROLE_RANK[a] ?? 0) >= (ROLE_RANK[b] ?? 0) ? a : b;
}

export function isAdminRole(role) {
  return (ROLE_RANK[role] ?? 0) >= ROLE_RANK.admin;
}
