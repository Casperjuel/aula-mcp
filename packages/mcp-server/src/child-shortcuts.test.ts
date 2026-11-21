/**
 * The dashboard's shortcuts for one child, against a fake Aula client: only
 * the parent's own children, no undo for a child that is not sick, one-day
 * plan changes only, and every write in the parent's audit log.
 */

import { describe, expect, test } from 'bun:test';
import type { StoredTokenRecord, TokenStore } from '@aula-mcp/aula-auth';
import type { AulaClient } from '@aula-mcp/aula-client';
import type { AulaContext } from './aula-context.ts';
import {
  announcedVacations,
  childPlan,
  childrenToday,
  vacationAnswerProblems,
  vacationDays,
  vacationProblems,
  vacationRequests,
} from './child-actions.ts';
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
    // Shaped as nickknissen/aula's fixture for getVacationRegistrationsByChildren.
    getVacationRegistrations: async () => [
      {
        child: { id: 11, name: 'Anna' },
        vacationRegistrations: [
          {
            vacationRegistrationId: 5,
            responseId: 50,
            title: 'Efterårsferie',
            startDate: '2026-10-12T00:00:00',
            endDate: '2026-10-16T00:00:00',
            isEditable: false,
            isMissingAnswer: false,
          },
        ],
      },
      {
        child: { id: 12, name: 'Bo' },
        vacationRegistrations: [
          {
            vacationRegistrationId: 7,
            responseId: 70,
            title: 'Juleferie',
            startDate: '2026-12-21T00:00:00',
            endDate: '2026-12-23T00:00:00',
            responseDeadline: '2026-12-01T00:00:00',
            noteToGuardian: 'Svar venligst',
            isEditable: true,
            isMissingAnswer: true,
            isPresenceTimesRequired: true,
          },
          { title: 'Uden id' },
        ],
      },
      {
        child: { id: 99, name: 'Fremmed' },
        vacationRegistrations: [{ vacationRegistrationId: 9, responseId: 90 }],
      },
    ],
    getVacationAnnouncements: async () => [
      {
        child: { id: 12 },
        vacationAnnouncements: [
          {
            vacationId: 902,
            startDate: '2027-02-15T00:00:00',
            endDate: '2027-02-19T00:00:00',
            description: 'Vinterferie',
            isEditable: true,
          },
          { vacationId: 901, startDate: '2026-12-28', endDate: '2026-12-30', isEditable: false },
          { description: 'Uden id' },
        ],
      },
      { child: { id: 99 }, vacationAnnouncements: [{ vacationId: 999, isEditable: true }] },
    ],
    deleteVacation: async (vacationId: unknown) => {
      calls.push({ method: 'deleteVacation', args: vacationId });
      return {};
    },
    respondToVacationRequest: async (args: unknown) => {
      calls.push({ method: 'respondToVacationRequest', args });
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

describe('ferie requests', () => {
  test('only the parent’s own children, open ones first', async () => {
    const list = await vacationRequests(fakeClient().client);
    expect(list.map((r) => [r.childId, r.responseId])).toEqual([
      [12, 70],
      [11, 50],
    ]);
    expect(list[0]).toMatchObject({
      childName: 'Bo',
      startDate: '2026-12-21',
      endDate: '2026-12-23',
      deadline: '2026-12-01T00:00:00',
      missingAnswer: true,
      editable: true,
      timesRequired: true,
    });
  });

  test('an answer stays in the period and gives times when asked', async () => {
    const [open, closed] = await vacationRequests(fakeClient().client);
    if (!open || !closed) throw new Error('fixture');
    const ok = [
      { date: '2026-12-21', isComing: true, entryTime: '08:00', exitTime: '15:00' },
      { date: '2026-12-22', isComing: false },
    ];
    expect(vacationAnswerProblems(open, ok)).toEqual([]);
    expect(vacationAnswerProblems(closed, [{ date: '2026-10-12', isComing: false }])).toEqual([
      'Aula does not allow answering this request (any more).',
    ]);
    expect(vacationAnswerProblems(open, [])).toEqual(['days must name at least one day.']);
    expect(
      vacationAnswerProblems(open, [
        { date: '2026-12-24', isComing: false },
        { date: '2026-12-21', isComing: true },
        { date: '2026-12-22', isComing: true, entryTime: '15:00', exitTime: '08:00' },
        { date: '2026-12-22', isComing: false },
      ]),
    ).toEqual([
      '2026-12-24: outside the request (2026-12-21 – 2026-12-23).',
      '2026-12-21: the institution asks for entryTime and exitTime.',
      '2026-12-22: entryTime must be before exitTime.',
      '2026-12-22: named twice.',
    ]);
  });

  test('GET and POST /data/children/vacation-requests answer and audit counts only', async () => {
    const { get, post, audit, calls } = await setup();
    const { requests } = (await (await get('/data/children/vacation-requests')).json()) as {
      requests: unknown[];
    };
    expect(requests).toHaveLength(2);

    const days = [
      { date: '2026-12-21', isComing: true, entryTime: '08:00', exitTime: '15:00' },
      { date: '2026-12-22', isComing: false },
    ];
    const answer = (body: Record<string, unknown>) =>
      post('/data/children/vacation-requests/answer', body);
    expect((await answer({ childId: 99, responseId: 90, days })).status).toBe(404);
    expect((await answer({ childId: 11, responseId: 70, days })).status).toBe(404);
    expect((await answer({ childId: 11, responseId: 50, days })).status).toBe(400);
    expect(
      (
        await answer({
          childId: 12,
          responseId: 70,
          days: [{ date: '2026-12-21', isComing: true }],
        })
      ).status,
    ).toBe(400);
    expect((await answer({ childId: 12, responseId: 70, days: [{ date: 1 }] })).status).toBe(400);
    expect(calls).toEqual([]);

    const res = await answer({ childId: 12, responseId: 70, days, comment: ' Hilsen ' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        method: 'respondToVacationRequest',
        args: { childId: 12, responseId: 70, days, comment: 'Hilsen' },
      },
    ]);
    const [entry] = await audit();
    expect(entry).toMatchObject({ action: 'presence_answer_vacation_request', ok: true });
    expect(entry?.details).toEqual({ days: 2, coming: 1, trigger: 'dashboard' });
  });
});

describe('announced ferie/fri', () => {
  test('only the parent’s own children, soonest first', async () => {
    const list = await announcedVacations(fakeClient().client);
    expect(list.map((v) => v.vacationId)).toEqual([901, 902]);
    expect(list[1]).toEqual({
      childId: 12,
      childName: 'Bo',
      vacationId: 902,
      startDate: '2027-02-15',
      endDate: '2027-02-19',
      comment: 'Vinterferie',
      editable: true,
    });
  });

  test('POST /data/children/vacations/delete removes only own, editable ferie', async () => {
    const { get, post, audit, calls } = await setup();
    const { vacations } = (await (await get('/data/children/vacations')).json()) as {
      vacations: unknown[];
    };
    expect(vacations).toHaveLength(2);
    const del = (vacationId: unknown) => post('/data/children/vacations/delete', { vacationId });
    expect((await del('902')).status).toBe(400);
    expect((await del(999)).status).toBe(404);
    expect((await del(901)).status).toBe(409);
    expect(calls).toEqual([]);
    expect((await del(902)).status).toBe(200);
    expect(calls).toEqual([{ method: 'deleteVacation', args: 902 }]);
    const [entry] = await audit();
    expect(entry).toMatchObject({ action: 'presence_delete_vacation', ok: true });
    expect(entry?.details).toEqual({ children: 1, days: 5, trigger: 'dashboard' });
  });
});
