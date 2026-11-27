/**
 * Consent gate for `profiles.getContactlist` rows.
 *
 * Aula sends phone numbers, email and address for every member of a group,
 * also for people who have not consented to show them. Aula's own contacts
 * page hides those fields unless the flags below allow them; this applies the
 * same rules, read from the page's frontend bundle. Everything else in a row
 * passes unchanged.
 */

/** The `filter` values Aula's contacts page offers a guardian. */
export const GATED_CONTACT_FILTERS = ['child', 'guardian', 'employee'] as const;

const CONTACT_FIELDS = [
  'mobilePhoneNumber',
  'homePhoneNumber',
  'workPhoneNumber',
  'email',
  'address',
] as const;

type Row = Record<string, unknown>;

function isRow(v: unknown): v is Row {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Aula's `alias` flag, or the placeholder name the contact list sends for an
 * alias profile without that flag. The shown name is not the person's own, so
 * nothing printed next to it may be either.
 */
function isAlias(r: Row): boolean {
  if (r.alias === true) return true;
  const names = [r.firstName, r.lastName, r.fullName, r.name];
  return names.some((n) => typeof n === 'string' && n.startsWith('Alias-'));
}

/**
 * One row with its contact fields kept only where Aula shows them. A list row
 * (depth 0) needs consent and `currentUserCanViewContactInformation`; a
 * relation row (a child's guardian) needs consent only and never shows a
 * group home's home phone. A child's address, or one on a row without a role,
 * is never shown.
 */
export function gateContactRow(row: unknown, depth = 0): unknown {
  if (!isRow(row)) return row;
  const shown =
    !isAlias(row) &&
    row.userHasGivenConsentToShowContactInformation === true &&
    (depth > 0 || row.currentUserCanViewContactInformation === true);
  const out: Row = { ...row };
  for (const field of CONTACT_FIELDS) delete out[field];
  if (shown) {
    const keep = new Set<string>(['mobilePhoneNumber', 'workPhoneNumber', 'email']);
    if (!(depth > 0 && row.contactType === 'groupHome')) keep.add('homePhoneNumber');
    if (typeof row.role === 'string' && row.role !== '' && row.role !== 'child') {
      keep.add('address');
    }
    for (const field of keep) {
      if (field in row) out[field] = row[field];
    }
  }
  // Relations the gate cannot walk are dropped rather than passed on ungated.
  if (Array.isArray(row.relations)) {
    out.relations = row.relations.map((r) => gateContactRow(r, depth + 1));
  } else {
    delete out.relations;
  }
  return out;
}

/**
 * A contact-list page through the gate, or undefined when Aula's answer is not
 * a list of rows: the gate cannot vouch for a shape it does not know.
 */
export function gateContactList(data: unknown): unknown[] | undefined {
  return Array.isArray(data) ? data.map((r) => gateContactRow(r)) : undefined;
}
