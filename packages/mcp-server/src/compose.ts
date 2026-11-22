/**
 * Writing a new message from the dashboard: who the parent can pick as a
 * recipient, and which of the parent's own mailboxes sends it.
 *
 * Recent contacts come from the parent's stored threads, whose `recipients`
 * and `creator` carry Aula's mailbox objects as they are. Search hits come
 * from `search.findRecipients` and are turned into the same shape. Every
 * contact names its institution, because a thread is started from the
 * parent's own mailbox at that institution (`thread.mailBoxOwner`).
 */

import type { MailBoxOwner, RecipientSearchItem } from '@aula-mcp/aula-client';
import type { StoredItem } from './storage.ts';

export interface Contact {
  /** `<mailBoxOwnerType>:<id>`, unique per mailbox. */
  key: string;
  name: string;
  role: string | null;
  institutionCode: string | null;
  institutionName?: string;
  /** Extra text Aula shows by the name, e.g. the child a parent belongs to. */
  note?: string;
  mailbox: MailBoxOwner;
}

type Raw = Record<string, unknown>;

const asRecord = (v: unknown): Raw | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/** A mailbox object as Aula sends it, or null when it lacks what a send needs. */
export function mailboxOf(v: unknown): MailBoxOwner | null {
  const m = asRecord(v);
  if (!m) return null;
  const id = m.id;
  const type = m.mailBoxOwnerType;
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null;
  if (typeof type !== 'string' || !/^[A-Za-z]{1,40}$/.test(type)) return null;
  const out: MailBoxOwner = { id, mailBoxOwnerType: type };
  if (typeof m.profileId === 'number' && Number.isInteger(m.profileId)) out.profileId = m.profileId;
  if (typeof m.portalRole === 'string' && /^[a-z]{1,20}$/i.test(m.portalRole)) {
    out.portalRole = m.portalRole.toLowerCase();
  }
  return out;
}

const keyOf = (m: MailBoxOwner) => `${m.mailBoxOwnerType}:${m.id}`;

/**
 * The parent's own mailboxes by institution code, and everyone else seen in
 * the stored threads, newest thread first. Deactivated mailboxes are left out.
 */
export function contactsFrom(threads: StoredItem[]): {
  contacts: Contact[];
  own: Map<string, MailBoxOwner>;
} {
  const own = new Map<string, MailBoxOwner>();
  const ownKeys = new Set<string>();
  for (const t of threads) {
    const d = asRecord(t.data);
    const mine = mailboxOf(d?.mailBoxOwner);
    const inst = str(d?.institutionCode);
    if (!mine) continue;
    ownKeys.add(keyOf(mine));
    if (inst && !own.has(inst)) own.set(inst, mine);
  }
  const sorted = [...threads].sort((a, b) => (b.occurredAt ?? 0) - (a.occurredAt ?? 0));
  const seen = new Map<string, Contact>();
  for (const t of sorted) {
    const d = asRecord(t.data);
    const inst = str(d?.institutionCode) ?? null;
    const people = [...(Array.isArray(d?.recipients) ? d.recipients : []), d?.creator];
    for (const p of people) {
      const r = asRecord(p);
      const owner = asRecord(r?.mailBoxOwner);
      const mailbox = mailboxOf(owner);
      const name = str(r?.fullName);
      if (!mailbox || !name || owner?.isDeactivated === true) continue;
      const key = keyOf(mailbox);
      if (ownKeys.has(key) || seen.has(key)) continue;
      const note = str(r?.metadata);
      seen.set(key, {
        key,
        name,
        role: mailbox.portalRole ?? null,
        institutionCode: inst,
        ...(note ? { note } : {}),
        mailbox,
      });
    }
  }
  return { contacts: [...seen.values()], own };
}

/**
 * Search hits that are people, as contacts. Groups and anything without an
 * institution profile id are left out: their mailbox shape is not known.
 */
export function contactsFromSearch(results: RecipientSearchItem[] | undefined): Contact[] {
  const out: Contact[] = [];
  for (const r of results ?? []) {
    if (typeof r.id !== 'number' || !Number.isInteger(r.id) || r.id <= 0) continue;
    if (r.docType && !/profile/i.test(r.docType)) continue;
    const name = str(r.name);
    if (!name) continue;
    const mailbox: MailBoxOwner = { id: r.id, mailBoxOwnerType: 'institutionProfile' };
    if (typeof r.profileId === 'number') mailbox.profileId = r.profileId;
    const role = str(r.portalRole)?.toLowerCase();
    if (role) mailbox.portalRole = role;
    const note = str(r.description);
    const institutionName = str(r.institutionName);
    out.push({
      key: keyOf(mailbox),
      name,
      role: role ?? null,
      institutionCode: str(r.institutionCode) ?? null,
      ...(institutionName ? { institutionName } : {}),
      ...(note ? { note } : {}),
      mailbox,
    });
  }
  return out;
}
