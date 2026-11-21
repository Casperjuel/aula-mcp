// The setup UI and dashboard with made-up sample data, for screenshots and
// trying the pages without an Aula login. Nothing here talks to Aula: the
// children, events, messages and photos are invented, and every write the
// pages offer is refused by the fake client.
//
//   bun scripts/web-ui-demo.ts          serves it on http://127.0.0.1:8765/
//   bun scripts/web-ui-screenshots.ts   takes the screenshots in docs/web-ui/
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { PRESENCE_STATUS_CODE } from '../packages/aula-client/src/index.ts';
import { startOfDayCopenhagen } from '../packages/mcp-server/src/calendar-range.ts';
import { GalleryFiles, GalleryView } from '../packages/mcp-server/src/gallery.ts';
import { createSetupApp } from '../packages/mcp-server/src/setup-ui.ts';
import { createStorage, type ItemInput } from '../packages/mcp-server/src/storage.ts';
import { sqliteDriver } from '../packages/mcp-server/src/storage-sql.ts';
import {
  SYNC_INTERVALS_MS,
  SYNC_JOB_DESCRIPTIONS,
  SYNC_JOBS,
} from '../packages/mcp-server/src/sync.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const SCHOOL = 'Solsikkeskolen';
const PARENT = 'Maria Jensen';
const ALMA = { id: 101, name: 'Alma Jensen', first: 'Alma', klasse: '2.A' };
const THEO = { id: 102, name: 'Theo Jensen', first: 'Theo', klasse: '5.B' };
const CHILDREN = [ALMA, THEO];

/** A small PNG: sky, a hill and a sun, coloured by `seed`. */
function png(w: number, h: number, seed: number): Buffer {
  const hsl = (hue: number, s: number, l: number) => {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + hue / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  };
  const hue = (seed * 47) % 360;
  const sunX = w * (0.25 + ((seed * 13) % 50) / 100);
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      const hill = h * (0.62 + 0.08 * Math.sin(x / (w / 3) + seed));
      let c: number[];
      if (y > hill) c = hsl((hue + 100) % 360, 0.45, 0.32 + 0.1 * ((y - hill) / h));
      else if ((x - sunX) ** 2 + (y - h * 0.3) ** 2 < (h * 0.09) ** 2) c = [250, 230, 160];
      else c = hsl(hue, 0.55, 0.55 + 0.3 * (y / h));
      row[1 + x * 3] = c[0] ?? 0;
      row[2 + x * 3] = c[1] ?? 0;
      row[3 + x * 3] = c[2] ?? 0;
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = ~0;
    for (const b of body) {
      crc ^= b;
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(~crc >>> 0);
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export async function startDemo(port = 8765): Promise<{ url: string; stop: () => void }> {
  const now = Date.now();
  const today = startOfDayCopenhagen(new Date(now)).getTime();
  /** `days` from today at hh:mm Copenhagen time (close enough across DST for a demo). */
  const at = (days: number, hh = 0, mm = 0) =>
    new Date(today + days * DAY + (hh * 60 + mm) * MINUTE).toISOString();
  const ymd = (days: number) =>
    new Date(today + days * DAY + 12 * 60 * MINUTE).toLocaleDateString('sv-SE', {
      timeZone: 'Europe/Copenhagen',
    });
  const secs = (iso: string) => Date.parse(iso) / 1000;
  const weekend = (days: number) =>
    [0, 6].includes(new Date(today + days * DAY + 12 * 60 * MINUTE).getUTCDay());
  /** Days from today to the n-th school day after it. */
  const wd = (n: number) => {
    let days = 0;
    for (let left = n; left > 0; ) if (!weekend(++days)) left--;
    return days;
  };
  /** An all-day span's end: the last minute of its last day. */
  const lastDay = (days: number) => at(days, 23, 59);

  const dir = await mkdtemp(join(tmpdir(), 'aula-web-ui-demo-'));
  const storage = await createStorage(sqliteDriver(':memory:'), Buffer.alloc(32, 7), {
    type: 'sqlite',
    location: '/data/aula-mcp.db',
  });
  const mine = storage.forParent('default');
  const files = new GalleryFiles({ dir, downloads: true, stopAt: 0.9 });
  const parentFiles = files.forParent('default');
  const root = (parentFiles as unknown as { root: string }).root;
  const items: ItemInput[] = [];

  // --- calendar ---
  let eventId = 5000;
  const event = (e: {
    title: string;
    type: string;
    start: string;
    end: string;
    child?: typeof ALMA;
    allDay?: boolean;
    place?: string;
    by?: string;
    response?: string;
    deadline?: string;
    text?: string;
    id?: number;
  }) => {
    const id = e.id ?? eventId++;
    items.push({
      kind: 'calendar_event',
      id: String(id),
      occurredAt: e.start,
      data: {
        id,
        title: e.title,
        type: e.type,
        startDateTime: e.start,
        endDateTime: e.end,
        allDay: e.allDay === true,
        primaryResourceText: e.place ?? null,
        belongsToProfiles: (e.child ? [e.child] : CHILDREN).map((c) => c.id),
        creatorName: e.by ?? 'Skolens kontor',
        institutionName: SCHOOL,
        responseRequired: e.response !== undefined,
        responseStatus: e.response ?? null,
        responseDeadline: e.deadline ?? null,
        description: e.text ?? null,
        private: false,
      },
    });
  };
  const LESSONS: Array<[number, number, string, string]> = [
    [8, 0, 'Dansk', 'Lis Holm'],
    [9, 45, 'Matematik', 'Jens Bak'],
    [11, 30, 'Natur/teknologi', 'Mette Lund'],
  ];
  for (let d = -7; d <= 14; d++) {
    if (weekend(d)) continue;
    for (const [hh, mm, subject, teacher] of LESSONS) {
      for (const child of CHILDREN) {
        event({
          title: `${subject} ${child.klasse}`,
          type: 'lesson',
          start: at(d, hh, mm),
          end: at(d, hh, mm + 90),
          child,
          place: `Lokale ${child.klasse}`,
          by: teacher,
        });
      }
    }
  }
  event({
    title: 'Forældremøde i 2.A',
    type: 'parental_meeting',
    start: at(wd(2), 19),
    end: at(wd(2), 20, 30),
    child: ALMA,
    place: 'Klasselokale 2.A',
    by: 'Lis Holm',
    response: 'waiting',
    deadline: at(wd(1), 12),
    text: 'Vi taler om trivsel, lejrskole og årets plan. Der er kaffe og kage.',
  });
  event({
    title: 'Tur til Experimentarium',
    type: 'excursion',
    start: at(wd(4), 8, 30),
    end: at(wd(4), 14),
    child: THEO,
    place: 'Experimentarium, Hellerup',
    by: 'Mette Lund',
    text: 'Husk madpakke, drikkedunk og busbillet.',
  });
  event({
    title: 'Skole-hjem-samtale, Theo',
    type: 'school_home_meeting',
    start: at(wd(6), 17, 40),
    end: at(wd(6), 18),
    child: THEO,
    place: 'Lærerværelset',
    by: 'Mette Lund',
    response: 'accepted',
  });
  event({
    title: 'Juleklip i SFO',
    type: 'event',
    start: at(wd(9), 13),
    end: at(wd(9), 16),
    child: ALMA,
    place: 'SFO Myretuen',
    by: 'Peter Krogh',
  });
  event({
    title: 'Alma fylder 8',
    type: 'birthday',
    start: at(15),
    end: lastDay(15),
    allDay: true,
    child: ALMA,
  });
  event({
    title: 'Ferieregistrering: vinterferie',
    type: 'vacation_registration',
    start: at(wd(16)),
    end: lastDay(wd(20)),
    allDay: true,
    child: ALMA,
    by: 'SFO Myretuen',
    response: 'waiting',
    deadline: at(wd(7), 12),
  });
  event({
    title: 'Juleferie',
    type: 'holiday',
    start: at(31),
    end: lastDay(44),
    allDay: true,
  });
  // Ferie/fri: one the parent registered (it is in their announcements below),
  // one someone else made, and one in the past.
  const OWN_FERIE = 7001;
  const ownFrom = wd(12);
  const ownTo = wd(14);
  let pastFerie = -4;
  while (weekend(pastFerie)) pastFerie--;
  event({
    id: OWN_FERIE,
    title: 'Ferie/fri',
    type: 'presence_holiday',
    start: at(ownFrom),
    end: lastDay(ownTo),
    allDay: true,
    child: THEO,
    by: THEO.name,
  });
  event({
    id: 7002,
    title: 'Ferie/fri',
    type: 'presence_holiday',
    start: at(wd(5)),
    end: lastDay(wd(5)),
    allDay: true,
    child: ALMA,
    by: ALMA.name,
  });
  event({
    id: 7003,
    title: 'Ferie/fri',
    type: 'presence_holiday',
    start: at(pastFerie),
    end: lastDay(pastFerie),
    allDay: true,
    child: ALMA,
    by: ALMA.name,
  });

  // --- messages ---
  const people = {
    lis: { fullName: 'Lis Holm', portalRole: 'employee' },
    mette: { fullName: 'Mette Lund', portalRole: 'employee' },
    peter: { fullName: 'Peter Krogh', portalRole: 'employee' },
    maria: { fullName: PARENT, portalRole: 'guardian' },
    sofie: { fullName: 'Sofie Madsen', portalRole: 'guardian' },
  };
  const threads: Array<{
    id: number;
    subject: string;
    read: boolean;
    messages: Array<[keyof typeof people, number, string]>;
  }> = [
    {
      id: 301,
      subject: 'Tur til Experimentarium på fredag',
      read: false,
      messages: [
        [
          'mette',
          -0.2,
          'Hej alle. Vi tager bussen kl. 8.45 fra skolen. Husk madpakke og drikkedunk.',
        ],
      ],
    },
    {
      id: 302,
      subject: 'Glemt jakke i SFO',
      read: true,
      messages: [
        ['peter', -1.3, 'Alma har glemt sin blå jakke. Den hænger ved indgangen.'],
        ['maria', -1.2, 'Tak, vi henter den i morgen.'],
      ],
    },
    {
      id: 303,
      subject: 'Legeaftale torsdag?',
      read: true,
      messages: [
        ['sofie', -3, 'Vil Alma lege med Freja torsdag efter SFO?'],
        ['maria', -2.9, 'Ja, gerne. Vi henter kl. 16.30.'],
        ['sofie', -2.8, 'Super, vi ses.'],
      ],
    },
    {
      id: 304,
      subject: 'Trivselsundersøgelse i 5.B',
      read: true,
      messages: [
        ['mette', -6, 'I næste uge laver vi trivselsundersøgelse. Den tager cirka 20 minutter.'],
      ],
    },
  ];
  for (const t of threads) {
    const last = t.messages.at(-1) as [keyof typeof people, number, string];
    items.push({
      kind: 'message_thread',
      id: String(t.id),
      occurredAt: now / 1000 + last[1] * 86400,
      data: {
        id: t.id,
        subject: t.subject,
        read: t.read,
        lastMessage: { sender: people[last[0]] },
      },
    });
    t.messages.forEach(([who, daysAgo, text], i) => {
      items.push({
        kind: 'message',
        id: `${t.id}:${t.id * 10 + i}`,
        occurredAt: now / 1000 + daysAgo * 86400,
        data: { sender: people[who], text: { html: `<p>${text}</p>` } },
      });
    });
  }

  // --- posts and notifications ---
  const posts: Array<[string, string, number, string, boolean]> = [
    [
      'Motionsløb fredag',
      'Mette Lund',
      -0.5,
      'Alle elever løber 5 km. Husk løbesko og tøj efter vejret.',
      true,
    ],
    [
      'Nyt fra SFO Myretuen',
      'Peter Krogh',
      -2,
      'I denne måned bygger vi huler, bager boller og går tur i skoven.',
      false,
    ],
    ['Lus i 2.A', 'Lis Holm', -4, 'Tjek venligst jeres børns hår i weekenden.', false],
    [
      'Skolebestyrelsen søger medlemmer',
      'Skolens kontor',
      -9,
      'Valget er i næste måned. Skriv til kontoret, hvis du vil stille op.',
      false,
    ],
  ];
  posts.forEach(([title, owner, daysAgo, text, important], i) => {
    items.push({
      kind: 'post',
      id: String(400 + i),
      occurredAt: now / 1000 + daysAgo * 86400,
      data: {
        title,
        ownerProfile: { fullName: owner, institution: { institutionName: SCHOOL } },
        content: { html: `<p>${text}</p>` },
        isImportant: important,
      },
    });
  });
  const notifications: Array<[string, string, number]> = [
    ['Ny besked: Tur til Experimentarium på fredag', 'Beskeder', -0.2],
    ['Nyt opslag: Motionsløb fredag', 'Opslag', -0.5],
    ['Svar på invitation: Forældremøde i 2.A', 'Kalender', -1],
  ];
  notifications.forEach(([title, area, daysAgo], i) => {
    items.push({
      kind: 'notification',
      id: String(500 + i),
      occurredAt: now / 1000 + daysAgo * 86400,
      data: { title, notificationArea: area },
    });
  });

  // --- presence, groups ---
  const presence: Array<[typeof ALMA, number, string | null]> = [
    [ALMA, PRESENCE_STATUS_CODE.PRESENT, '07:52'],
    [THEO, PRESENCE_STATUS_CODE.PRESENT, '07:58'],
  ];
  for (const [child, status, checkIn] of presence) {
    items.push({
      kind: 'presence',
      id: `${child.id}:${ymd(0)}`,
      childId: String(child.id),
      occurredAt: `${ymd(0)}T00:00:00Z`,
      data: {
        institutionProfile: { id: child.id, name: child.name },
        status,
        checkInTime: checkIn,
        entryTime: '08:00',
        exitTime: '15:30',
        date: ymd(0),
      },
    });
  }
  for (const [i, name] of ['2.A', '5.B', 'SFO Myretuen', 'Hele skolen'].entries()) {
    items.push({ kind: 'group', id: String(600 + i), data: { name, institutionName: SCHOOL } });
  }

  // --- gallery ---
  const ALBUMS = [
    {
      id: 901,
      title: 'Skovtur',
      child: ALMA.first,
      days: -3,
      n: 9,
      done: 8,
      fail: 1,
      video: 1,
      by: 'Lis Holm',
      groups: ['2.A'],
    },
    {
      id: 902,
      title: 'Halloween i SFO',
      child: ALMA.first,
      days: -21,
      n: 6,
      done: 6,
      fail: 0,
      video: 0,
      by: 'Peter Krogh',
      groups: ['SFO Myretuen'],
    },
    {
      id: 903,
      title: 'Motionsløb',
      child: THEO.first,
      days: -40,
      n: 8,
      done: 8,
      fail: 0,
      video: 1,
      by: 'Mette Lund',
      groups: ['5.B'],
    },
    {
      id: 904,
      title: 'Lejrskole på Bornholm',
      child: THEO.first,
      days: -60,
      n: 12,
      done: 7,
      fail: 0,
      video: 2,
      by: 'Mette Lund',
      groups: ['5.B'],
    },
    {
      id: 905,
      title: 'Første skoledag',
      child: ALMA.first,
      days: -100,
      n: 5,
      done: 5,
      fail: 0,
      video: 0,
      by: 'Lis Holm',
      groups: ['2.A'],
    },
    {
      id: 906,
      title: 'Sommerfest',
      child: 'Fælles',
      days: -150,
      n: 6,
      done: 6,
      fail: 0,
      video: 0,
      by: 'Skolens kontor',
      groups: ['Hele skolen'],
    },
  ];
  let seed = 1;
  for (const a of ALBUMS) {
    const date = at(a.days, 10);
    const folder = `${a.child}/${date.slice(0, 4)}/${ymd(a.days)} ${a.title}`;
    items.push({
      kind: 'gallery_album',
      id: String(a.id),
      occurredAt: date,
      data: {
        album: {
          id: a.id,
          title: a.title,
          creationDate: date,
          creator: { name: a.by },
          sharedWithGroups: a.groups.map((name, i) => ({ id: i, name })),
        },
        child: a.child,
        folder,
        mediaCount: a.n,
      },
    });
    for (let i = 1; i <= a.n; i++) {
      const video = i > a.n - a.video;
      const done = i <= a.done;
      const failed = !done && i <= a.done + a.fail;
      const id = a.id * 100 + i;
      const name = video ? `MOV_${id}.mp4` : `IMG_${id}.png`;
      const rel = `${folder}/${name}`;
      const thumb = `.thumbs/${id}.png`;
      const s = seed++;
      if (done) {
        await mkdir(dirname(join(root, rel)), { recursive: true });
        await mkdir(join(root, '.thumbs'), { recursive: true });
        await writeFile(join(root, rel), video ? Buffer.from('demo') : png(960, 640, s));
        await writeFile(join(root, thumb), png(240, 240, s));
      }
      items.push({
        kind: 'gallery_media',
        id: `${a.id}:${id}`,
        occurredAt: secs(date) + i * 60,
        data: {
          albumId: a.id,
          media: {
            id,
            mediaType: video ? 'video' : 'image',
            title: null,
            tags: [],
            file: { id, name, created: new Date(Date.parse(date) + i * MINUTE).toISOString() },
          },
          path: done ? rel : null,
          thumb: done ? thumb : null,
          sha256: done ? `demo${id}` : null,
          bytes: done
            ? video
              ? 38_000_000 + s * 900_000
              : 2_100_000 + ((s * 37_919) % 2_000_000)
            : 0,
          downloadedAt: done ? now / 1000 - 3600 : null,
          ...(failed ? { error: 'HTTP 403 fra Aula' } : {}),
        },
      });
    }
  }
  await mine.put(items);

  // --- sync state and the log ---
  const ago = (min: number) => new Date(now - min * MINUTE).toISOString();
  const syncStatus = SYNC_JOBS.map((job, i) => {
    const every = Math.round(SYNC_INTERVALS_MS[job] / MINUTE);
    const last = Math.min(every - 1, 4 + i * 3);
    return {
      job,
      description: SYNC_JOB_DESCRIPTIONS[job],
      intervalMinutes: every,
      running: false,
      lastRunAt: ago(last),
      lastSuccessAt: ago(last),
      nextRunAt: new Date(now + (every - last) * MINUTE).toISOString(),
      ok: true,
      lastError: null,
      failuresInARow: 0,
      fetched: [12, 3, 4, 2, 31, 4, 46][i] ?? 0,
      changed: [2, 1, 1, 2, 0, 0, 3][i] ?? 0,
    };
  });
  // Earlier rounds, so the log has more than one page.
  for (let round = 0; round < 8; round++) {
    for (const s of syncStatus) {
      await mine.audit({
        category: 'sync',
        action: s.job,
        ok: !(round === 5 && s.job === 'posts'),
        durationMs: 280 + ((round * 7 + s.fetched) % 9) * 60,
        details:
          round === 5 && s.job === 'posts'
            ? { error: 'Aula svarede 503' }
            : { fetched: (s.fetched + round) % 7, changed: round % 3 === 0 ? 1 : 0 },
      });
    }
  }
  for (const s of syncStatus) {
    await mine.audit({
      category: 'sync',
      action: s.job,
      ok: true,
      durationMs: 300 + s.fetched * 40,
      details: { fetched: s.fetched, changed: s.changed },
    });
  }
  await mine.audit({
    category: 'aula',
    action: 'presence_vacation',
    ok: true,
    details: { children: 1, days: 4 },
  });
  await mine.audit({ category: 'account', action: 'login', ok: true, details: {} });

  // --- a fake Aula behind the live pages ---
  const vacationAnnouncements = [
    {
      child: { id: THEO.id },
      vacationAnnouncements: [
        {
          vacationId: OWN_FERIE,
          startDate: ymd(ownFrom),
          endDate: ymd(ownTo),
          description: 'Besøg hos mormor',
          isEditable: true,
        },
      ],
    },
  ];
  const fakeClient = {
    currentApiVersion: 23,
    getProfilesByLogin: async () => ({
      profiles: [
        {
          id: 1,
          name: PARENT,
          children: CHILDREN.map((c) => ({
            id: c.id,
            name: c.name,
            userId: c.id + 1000,
            institutionProfile: { id: c.id, institutionName: SCHOOL, institutionCode: 'D99999' },
          })),
        },
      ],
    }),
    getProfileContext: async () => ({
      userId: 1,
      pageConfiguration: { widgetConfigurations: [{ widget: { widgetId: '0004' } }] },
    }),
    getDailyOverview: async () =>
      presence.map(([child, status, checkInTime]) => ({
        institutionProfile: { id: child.id, name: child.name },
        status,
        checkInTime,
        entryTime: '08:00',
        exitTime: child === ALMA ? '15:30' : '14:00',
        activityType: child === ALMA ? 0 : 2,
        exitWith: child === ALMA ? 'Mor' : null,
      })),
    getPresenceTemplates: async ({
      institutionProfileIds,
    }: {
      institutionProfileIds: number[];
    }) => ({
      presenceWeekTemplates: institutionProfileIds.map((id) => ({
        institutionProfile: { id },
        dayTemplates: Array.from({ length: 28 }, (_, d) => d)
          .filter((d) => !weekend(d))
          .map((d) => ({
            byDate: ymd(d),
            entryTime: '08:00',
            exitTime: d % 3 === 0 ? '14:00' : '15:30',
            activityType: d % 3 === 0 ? 2 : 0,
            exitWith: d % 3 === 0 ? null : 'Mor',
            isOnVacation: id === THEO.id && d >= ownFrom && d <= ownTo,
          })),
      })),
    }),
    getVacationAnnouncements: async () => vacationAnnouncements,
    getVacationRegistrations: async () => [
      {
        child: { id: ALMA.id },
        vacationRegistrations: [
          {
            vacationRegistrationId: 801,
            responseId: 802,
            title: 'Vinterferie',
            startDate: ymd(wd(16)),
            endDate: ymd(wd(20)),
            responseDeadline: at(wd(7), 12),
            noteToGuardian: 'Skriv, hvilke dage Alma kommer i SFO.',
            isMissingAnswer: true,
            isEditable: true,
            isPresenceTimesRequired: true,
          },
        ],
      },
    ],
  };
  const client = new Proxy(fakeClient, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target];
      if (prop === 'then') return undefined;
      return async () => {
        throw new Error('Demo: nothing is sent to Aula.');
      };
    },
  });
  const record = {
    version: 1 as const,
    username: 'demo',
    identityName: PARENT,
    tokens: {
      access_token: 'demo',
      refresh_token: 'demo',
      token_type: 'Bearer',
      expires_in: 3600,
      expires_at: Math.floor(now / 1000) + 3600,
      obtained_at: Math.floor(now / 1000),
    },
    saved_at: Math.floor(now / 1000) - 2 * 86400,
  };
  const context = { record, getClient: async () => client };
  const app = createSetupApp({
    store: { load: async () => record, save: async () => {}, clear: async () => {} },
    myData: {
      contextFor: () => context,
      storage: { info: storage.info, forParent: () => mine },
      sync: { forParent: () => ({ status: async () => syncStatus, run: async () => [] }) },
      gallery: { forParent: () => new GalleryView(mine, parentFiles) },
    },
  } as never);
  const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: app.fetch });
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const { url } = await startDemo(Number(process.env.PORT) || 8765);
  console.log(`Demo dashboard with sample data: ${url}`);
}
