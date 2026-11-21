/**
 * The dashboard's shortcuts for one child, against a fake Aula client: only
 * the parent's own children, no undo for a child that is not sick, one-day
 * plan changes only, and every write in the parent's audit log.
 */

import { describe, expect, test } from 'bun:test';
import type { StoredTokenRecord, TokenStore } from '@aula-mcp/aula-auth';
import type { AulaClient } from '@aula-mcp/aula-client';
import type { AulaContext } from './aula-context.ts';
import { childPlan, childrenToday, vacationDays, vacationProblems } from './child-actions.ts';
import { createSetupApp } from './setup-ui.ts';
import { createStorage } from './storage.ts';
import { sqliteDriver } from './storage-sql.ts';

class MemoryStore implements TokenStore {
  constructor(private record: StoredTokenRecord | null) {}
  async load() {
    return this.record;
  }
  async save(record: StoredTokenRecord) {
    this.record = record;
  }
  async clear() {
    this.record = null;
  }
}

const RECORD = {
  version: 1,
  username: 'demo',
  tokens: {
    access_token: 'AT',
    refresh_token: 'RT',
    token_type: 'Bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    obtained_at: Math.floor(Date.now() / 1000),
  },
  saved_at: Math.floor(Date.now() / 1000),
} as StoredTokenRecord;

/** A guardian with Anna (11, sick) and Bo (12, checked in). */
function fakeClient() {
  const calls: Array<{ method: string; args: unknown }> = [];
  const client = {
    getProfilesByLogin: async () => ({
      profiles: [
        {
          children: [
            { id: 11, name: 'Anna' },
            { id: 12, name: 'Bo' },
          ],
        },
      ],
    }),
    getDailyOverview: async (ids: number[]) =>
      [
        { institutionProfile: { id: 11 }, status: 1 },
        {
          institutionProfile: { id: 12 },
          status: 3,
          entryTime: '08:00',
          exitTime: '15:30',
          checkInTime: '08:04',
          activityType: 0,
          exitWith: 'Mormor',
        },
      ].filter((e) => ids.includes(e.institutionProfile.id)),
    getPresenceTemplates: async () => ({
      presenceWeekTemplates: [
        {
          institutionProfile: { id: 12 },
          dayTemplates: [
            {
              byDate: '2026-11-24T00:00:00',
              entryTime: '08:00',
              exitTime: '14:00',
              activityType: '1',
              selfDeciderStartTime: '13:00',
              selfDeciderEndTime: '14:00',
            },
            {
              byDate: '2026-11-23T00:00:00',
              entryTime: '08:00',
              exitTime: '15:00',
              activityType: null,
              isOnVacation: true,
            },
          ],
        },
      ],
    }),
    updatePresenceStatus: async (args: unknown) => {
      calls.push({ method: 'updatePresenceStatus', args });
      return {};
    },
    updatePresenceTemplate: async (args: unknown) => {
      calls.push({ method: 'updatePresenceTemplate', args });
      return {};
    },
    addVacation: async (args: unknown) => {
      calls.push({ method: 'addVacation', args });
      return {};
    },
  };
  return { client: client as unknown as AulaClient, calls };
}

async function setup(loggedIn = true) {
  const storage = await createStorage(sqliteDriver(':memory:'), Buffer.alloc(32, 3), {
    type: 'sqlite',
    location: 'test',
  });
  const fake = fakeClient();
  const app = createSetupApp({
    store: new MemoryStore(loggedIn ? RECORD : null),
    myData: {
      contextFor: () => ({ getClient: async () => fake.client }) as unknown as AulaContext,
      storage: { info: storage.info, forParent: () => storage.forParent('default') },
    },
  });
  const post = (path: string, body: unknown) =>
    app.fetch(
      new Request(`http://test${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  const get = (path: string) => app.fetch(new Request(`http://test${path}`));
  const audit = () => storage.forParent('default').auditLog({ category: 'aula' });
  return { app, post, get, audit, calls: fake.calls };
}

describe('child-actions', () => {
  test('childrenToday labels the status and names the henteform', async () => {
    const kids = await childrenToday(fakeClient().client);
    expect(kids).toMatchObject([
      { id: 11, name: 'Anna', status: 1, label: 'Syg', activityType: null },
      {
        id: 12,
        name: 'Bo',
        status: 3,
        label: 'Kommet',
        activityType: 'picked_up_by',
        exitWith: 'Mormor',
      },
    ]);
  });

  test('childPlan sorts the days and reads string and missing henteform', async () => {
    const days = await childPlan(fakeClient().client, 12, '2026-11-23', '2026-11-29');
    expect(days.map((d) => d.date)).toEqual(['2026-11-23', '2026-11-24']);
    expect(days[0]).toMatchObject({ onVacation: true, activityType: null });
    expect(days[1]).toMatchObject({ activityType: 'self_decider', selfDeciderStartTime: '13:00' });
  });
});

describe('vacationProblems', () => {
  const today = '2026-11-21';
  test('takes the portal form rules', () => {
    expect(vacationProblems({ startDate: today, endDate: today }, today)).toEqual([]);
    expect(vacationProblems({ startDate: '2026-11-20', endDate: today }, today)).toEqual([
      'startDate must be today or later.',
    ]);
    expect(vacationProblems({ startDate: '2026-11-25', endDate: '2026-11-24' }, today)).toEqual([
      'endDate must not be before startDate.',
    ]);
    expect(vacationProblems({ startDate: '2026-12-01', endDate: '2027-12-01' }, today)).toEqual([]);
    expect(vacationProblems({ startDate: '2026-12-01', endDate: '2027-12-02' }, today)).toEqual([
      'endDate must be within a year of startDate.',
    ]);
    expect(
      vacationProblems({ startDate: today, endDate: today, comment: 'x'.repeat(251) }, today),
    ).toEqual(['comment must be at most 250 characters.']);
    expect(vacationProblems({ startDate: '21-11-2026', endDate: today }, today)).toHaveLength(1);
  });

  test('29 February runs to 28 February of the next year', () => {
    const leap = { startDate: '2028-02-29', endDate: '2029-02-28' };
    expect(vacationProblems(leap, '2028-02-01')).toEqual([]);
    expect(vacationProblems({ ...leap, endDate: '2029-03-01' }, '2028-02-01')).toHaveLength(1);
  });

  test('vacationDays counts both ends', () => {
    expect(vacationDays('2026-12-21', '2026-12-21')).toBe(1);
    expect(vacationDays('2026-12-21', '2027-01-01')).toBe(12);
  });
});

describe('dashboard child shortcuts', () => {
  test('need an Aula login', async () => {
    const { get, post, calls } = await setup(false);
    expect((await get('/data/children')).status).toBe(409);
    expect((await post('/data/children/sick', { child: 12, sick: true })).status).toBe(409);
    expect(calls).toEqual([]);
  });

  test('GET /data/children lists today per own child', async () => {
    const { get } = await setup();
    const body = (await (await get('/data/children')).json()) as {
      children: Array<{ id: number }>;
    };
    expect(body.children.map((k) => k.id)).toEqual([11, 12]);
  });

  test('GET /data/children/plan refuses a child that is not the parent’s own', async () => {
    const { get } = await setup();
    expect((await get('/data/children/plan?child=99')).status).toBe(404);
    expect((await get('/data/children/plan?child=abc')).status).toBe(400);
    const ok = (await (await get('/data/children/plan?child=12')).json()) as { days: unknown[] };
    expect(ok.days).toHaveLength(2);
  });

  test('reporting sick writes to Aula and the audit log', async () => {
    const { post, audit, calls } = await setup();
    const res = await post('/data/children/sick', { child: 12, sick: true });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { method: 'updatePresenceStatus', args: { institutionProfileIds: [12], status: 1 } },
    ]);
    const [entry] = await audit();
    expect(entry).toMatchObject({ action: 'presence_report_sick', ok: true });
    expect(entry?.details).toMatchObject({ children: 1, trigger: 'dashboard' });
  });

  test('refuses someone else’s child and undo for a child that is not sick', async () => {
    const { post, audit, calls } = await setup();
    const other = await post('/data/children/sick', { child: 99, sick: true });
    expect(other.status).toBe(409);
    expect(((await other.json()) as { error: string }).error).toBe('unknown_child');
    const undo = await post('/data/children/sick', { child: 12, sick: false });
    expect(((await undo.json()) as { error: string }).error).toBe('not_reported_sick');
    expect(calls).toEqual([]);
    expect(await audit()).toEqual([]);
    // Anna is sick, so taking it back is allowed and sets "ikke kommet".
    expect((await post('/data/children/sick', { child: 11, sick: false })).status).toBe(200);
    expect(calls[0]?.args).toEqual({ institutionProfileIds: [11], status: 0 });
  });

  test('POST /data/children/plan changes one day only', async () => {
    const { post, audit, calls } = await setup();
    const res = await post('/data/children/plan', {
      child: 12,
      date: '2026-11-24',
      activityType: 'picked_up_by',
      entryTime: '08:00',
      exitTime: '15:00',
      pickedUpBy: ' Mormor ',
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toEqual({
      method: 'updatePresenceTemplate',
      args: {
        institutionProfileId: 12,
        date: '2026-11-24',
        activityType: 'picked_up_by',
        entryTime: '08:00',
        exitTime: '15:00',
        pickedUpBy: 'Mormor',
        repeatPattern: 'never',
      },
    });
    const [entry] = await audit();
    expect(entry).toMatchObject({ action: 'presence_set_template', ok: true });
    expect(entry?.details).toMatchObject({ date: '2026-11-24', activityType: 'picked_up_by' });
  });

  test('POST /data/children/vacation registers ferie/fri and audits no comment', async () => {
    const { post, audit, calls } = await setup();
    const res = await post('/data/children/vacation', {
      child: 12,
      startDate: '2099-01-01',
      endDate: '2099-01-05',
      comment: ' Skiferie ',
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        method: 'addVacation',
        args: {
          childIds: [12],
          startDate: '2099-01-01',
          endDate: '2099-01-05',
          comment: 'Skiferie',
        },
      },
    ]);
    const [entry] = await audit();
    expect(entry).toMatchObject({ action: 'presence_add_vacation', ok: true });
    expect(entry?.details).toEqual({ children: 1, days: 5, trigger: 'dashboard' });
  });

  test('sick and ferie take several children at once, all of them the parent’s own', async () => {
    const { post, audit, calls } = await setup();
    const ferie = { startDate: '2099-01-01', endDate: '2099-01-02' };
    expect((await post('/data/children/vacation', { ...ferie, children: [11, 99] })).status).toBe(
      404,
    );
    expect((await post('/data/children/vacation', { ...ferie, children: [11, 'x'] })).status).toBe(
      400,
    );
    expect((await post('/data/children/sick', { children: [12, 99], sick: true })).status).toBe(
      409,
    );
    expect(calls).toEqual([]);
    expect((await post('/data/children/vacation', { ...ferie, children: [11, 12] })).status).toBe(
      200,
    );
    expect((await post('/data/children/sick', { children: [11, 12], sick: true })).status).toBe(
      200,
    );
    expect(calls.map((x) => x.args)).toMatchObject([
      { childIds: [11, 12] },
      { institutionProfileIds: [11, 12], status: 1 },
    ]);
    expect((await audit()).map((e) => e.details?.children)).toEqual([2, 2]);
  });

  test('POST /data/children/vacation refuses before it reaches Aula', async () => {
    const { post, calls } = await setup();
    const base = { child: 12, startDate: '2099-01-01', endDate: '2099-01-05' };
    expect((await post('/data/children/vacation', { ...base, child: 99 })).status).toBe(404);
    expect(
      (await post('/data/children/vacation', { ...base, startDate: '2020-01-01' })).status,
    ).toBe(400);
    expect((await post('/data/children/vacation', { ...base, endDate: '2098-12-31' })).status).toBe(
      400,
    );
    expect((await post('/data/children/vacation', { child: 12 })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('POST /data/children/plan repeats weekly until a date', async () => {
    const { post, audit, calls } = await setup();
    const res = await post('/data/children/plan', {
      child: 12,
      date: '2026-11-24',
      activityType: 'send_home',
      exitTime: '15:00',
      repeat: 'weekly',
      repeatUntil: '2027-06-30',
    });
    expect(res.status).toBe(200);
    expect(calls[0]?.args).toMatchObject({ repeatPattern: 'weekly', repeatUntil: '2027-06-30' });
    const [entry] = await audit();
    expect(entry?.details).toMatchObject({ repeat: 'weekly', repeatUntil: '2027-06-30' });
  });

  test('POST /data/children/plan refuses a repeat without a sane end', async () => {
    const { post, calls } = await setup();
    const base = {
      child: 12,
      date: '2026-11-24',
      activityType: 'send_home',
      exitTime: '15:00',
      repeat: 'weekly',
    };
    expect((await post('/data/children/plan', base)).status).toBe(400);
    expect((await post('/data/children/plan', { ...base, repeatUntil: '2026-11-23' })).status).toBe(
      400,
    );
    expect((await post('/data/children/plan', { ...base, repeatUntil: '2027-11-25' })).status).toBe(
      400,
    );
    expect((await post('/data/children/plan', { ...base, repeat: 'daily' })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  test('POST /data/children/plan validates before it reaches Aula', async () => {
    const { post, calls } = await setup();
    const base = {
      child: 12,
      date: '2026-11-24',
      activityType: 'picked_up_by',
      entryTime: '08:00',
      exitTime: '15:00',
      pickedUpBy: 'Mormor',
    };
    expect((await post('/data/children/plan', { ...base, date: '24-11-2026' })).status).toBe(400);
    expect((await post('/data/children/plan', { ...base, activityType: 'fly' })).status).toBe(400);
    expect((await post('/data/children/plan', { ...base, exitTime: '3pm' })).status).toBe(400);
    expect((await post('/data/children/plan', { ...base, comment: 'x'.repeat(501) })).status).toBe(
      400,
    );
    expect((await post('/data/children/plan', { ...base, child: 99 })).status).toBe(404);
    expect(calls).toEqual([]);
  });
});
