/** The calendar summary and detail the Kalender page reads. */

import { describe, expect, test } from 'bun:test';
import { detail, summarize } from './item-view.ts';
import type { ItemKind, StoredItem } from './storage.ts';

const item = (kind: ItemKind, data: unknown, id = '1'): StoredItem => ({
  kind,
  id,
  childId: null,
  occurredAt: 100,
  firstSeenAt: 100,
  updatedAt: 100,
  data,
});

describe('calendar events', () => {
  const event = {
    id: 5,
    title: 'Forældremøde 3.B',
    type: 'parental_meeting',
    startDateTime: '2026-11-24T17:00:00+01:00',
    endDateTime: '2026-11-24T18:30:00+01:00',
    allDay: false,
    primaryResourceText: 'Aula 2',
    belongsToProfiles: [11, '12', 'x'],
    responseRequired: true,
    responseStatus: 'accepted',
    responseDeadline: '2026-11-22T12:00:00+01:00',
    creatorName: 'Lærer Lis',
    invitedGroups: [{ name: '3.B' }, 'Forældre'],
    institutionName: 'Skolen',
  };

  test('the summary has what the calendar places and badges', () => {
    const s = summarize(item('calendar_event', event));
    expect(s.subtitle).toBe('17:00 til 18:30 · Aula 2');
    expect(s.event).toEqual({
      type: 'parental_meeting',
      typeLabel: 'Forældremøde',
      start: '2026-11-24T17:00:00+01:00',
      end: '2026-11-24T18:30:00+01:00',
      allDay: false,
      place: 'Aula 2',
      profiles: [11, 12],
      responseRequired: true,
      response: 'Deltager',
      responseDeadline: '2026-11-22T12:00:00+01:00',
    });
  });

  test('the detail lists the event in Danish', () => {
    const fields = Object.fromEntries(detail(item('calendar_event', event)).fields);
    expect(fields).toMatchObject({
      Type: 'Forældremøde',
      Sted: 'Aula 2',
      'Oprettet af': 'Lærer Lis',
      Inviterede: '3.B, Forældre',
      Svar: 'Deltager',
      Institution: 'Skolen',
    });
  });

  test('a bare event still gets a summary', () => {
    const s = summarize(item('calendar_event', { type: 'something_new' }));
    expect(s.title).toBe('Begivenhed');
    expect(s.event).toMatchObject({ typeLabel: 'something_new', profiles: [], allDay: false });
  });
});
