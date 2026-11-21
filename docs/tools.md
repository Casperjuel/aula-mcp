# aula-mcp tools

<!-- Generated from tool-catalog.ts by `bun run docs:tools`. Do not edit by hand. -->

Every MCP tool the server offers. Read tools are always on; write tools need
`AULA_MCP_WRITE=1` and the raw escape hatch needs `AULA_MCP_RAW=1`. With
`AULA_MCP_TOOL_NAMES=underscore` the dots become underscores (`aula_discover`).

| Tool | Access | What it does |
| --- | --- | --- |
| [`aula.sync.status`](#aulasyncstatus) | read | Sync status |
| [`aula.sync.run`](#aulasyncrun) | read | Run sync now |
| [`aula.gallery.status`](#aulagallerystatus) | read | Gallery download status |
| [`aula.gallery.albums`](#aulagalleryalbums) | read | Gallery albums |
| [`aula.gallery.media`](#aulagallerymedia) | read | Media in an album |
| [`aula.gallery.thumbnail`](#aulagallerythumbnail) | read | Show a thumbnail |
| [`aula.discover`](#auladiscover) | read | Discover Aula context |
| [`aula.profiles.list`](#aulaprofileslist) | read | List Aula profiles |
| [`aula.presence.today`](#aulapresencetoday) | read | Daily presence overview |
| [`aula.presence.templates`](#aulapresencetemplates) | read | Komme/gå templates (drop-off & pickup schedule) |
| [`aula.calendar.events`](#aulacalendarevents) | read | Calendar events (school schedule) |
| [`aula.notifications.list`](#aulanotificationslist) | read | Aula notifications |
| [`aula.groups.list`](#aulagroupslist) | read | Aula groups (classes) |
| [`aula.contacts.list`](#aulacontactslist) | read | Aula contact list (group members) |
| [`aula.posts.list`](#aulapostslist) | read | Aula posts (class news feed) |
| [`aula.messages.list_threads`](#aulamessageslist_threads) | read | List Aula message threads |
| [`aula.ugeplan.easyiq`](#aulaugeplaneasyiq) | read | EasyIQ weekly plan |
| [`aula.ugeplan.meebook`](#aulaugeplanmeebook) | read | Meebook weekly plan |
| [`aula.ugeplan.easyiq_skoleportal`](#aulaugeplaneasyiq_skoleportal) | read | EasyIQ SkolePortal weekly plan |
| [`aula.lektier.easyiq`](#aulalektiereasyiq) | read | EasyIQ Lektier (homework) |
| [`aula.opgaver.minuddannelse`](#aulaopgaverminuddannelse) | read | Min Uddannelse opgaveliste |
| [`aula.ugebrev.minuddannelse`](#aulaugebrevminuddannelse) | read | Min Uddannelse ugebrev |
| [`aula.huskelisten.systematic`](#aulahuskelistensystematic) | read | Systematic Huskelisten reminders |
| [`aula.messages.get_thread`](#aulamessagesget_thread) | read | Read a single thread |
| [`aula.messages.get_attachment`](#aulamessagesget_attachment) | read | Download a thread attachment to local disk |
| [`aula.posts.get_attachment`](#aulapostsget_attachment) | read | Download a post attachment to local disk |
| [`aula.utils.extract_pdf_text`](#aulautilsextract_pdf_text) | read | Extract text from a local PDF file |
| [`aula.presence.set_template`](#aulapresenceset_template) | write (`AULA_MCP_WRITE=1`) | Set a komme/gå template (drop-off & pickup time) |
| [`aula.presence.report_sick`](#aulapresencereport_sick) | write (`AULA_MCP_WRITE=1`) | Report a child sick (or well again) |
| [`aula.messages.mark_read`](#aulamessagesmark_read) | write (`AULA_MCP_WRITE=1`) | Mark a message thread as read |
| [`aula.messages.reply`](#aulamessagesreply) | write (`AULA_MCP_WRITE=1`) | Reply in a message thread |
| [`aula.raw_request`](#aularaw_request) | raw (`AULA_MCP_RAW=1`) | Raw Aula API call (escape hatch) |

## `aula.sync.status`

**Sync status** · read

Where the background sync of the caller's own Aula data into the local database stands, one entry per job: when it last ran and succeeded, when it runs next, whether the last run failed and why, and how many items it fetched and changed. Jobs: `messages` (every 15 min): Message threads and the messages in threads that changed. `notifications` (every 15 min): Notifications. `posts` (every 30 min): Posts from schools and clubs. `presence` (every 30 min): Today's presence (check-in, pick-up) per child. `calendar` (every 1 h): Calendar events from a week back to eight weeks ahead, plus Aula's important dates. `directory` (every 24 h): The children's groups and their contact lists. `gallery` (every 6 h): Photo albums and their photos and videos, downloaded in original quality with a thumbnail, up to 300 files per run. Sync only reads from Aula: it never marks anything read and never writes to Aula. Parents without an Aula login are skipped until they log in.

No parameters.

## `aula.sync.run`

**Run sync now** · read

Fetch the caller's own Aula data into the local database right now instead of waiting for the schedule, and return what each job fetched and changed. Waits for a sync that is already running. Takes from seconds to a minute or two (messages and the contact directory are the slow ones). Read-only towards Aula: nothing is marked read. Omit `jobs` to run all of them.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `jobs` | array | no | Which jobs to run: messages, notifications, posts, presence, calendar, directory, gallery. Defaults to all. |

## `aula.gallery.status`

**Gallery download status** · read

How far the download of the caller's own Aula photo albums has come: albums and media known, how many are downloaded, waiting or failed, bytes stored (each file counted once, the same photo in two albums is stored once), a split per child, the disk use of the gallery volume and the level at which downloads pause, and the last run of the `gallery` sync job. Files are kept in original quality with a thumbnail, under <child>/<year>/<date album title>/. Albums shared with more than one child are filed under "Fælles". To download now, call aula.sync.run with jobs ["gallery"]; it fetches up to a few hundred files per run and runs again soon while more are waiting.

No parameters.

## `aula.gallery.albums`

**Gallery albums** · read

The caller's Aula photo albums from the local copy, newest first: id, title, child folder, year and date, who made it, the groups it is shared with, media count, how many are downloaded and their size. Filter by `child` (the folder name, as aula.gallery.status lists it, or "Fælles") and `year`. Use the id with aula.gallery.media. Reads local storage only, so it shows what the last sync saw.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `child` | string | no | Child folder name, or "Fælles". |
| `year` | string | no | Year the album was made, e.g. "2026". |
| `limit` | integer | no | Default 50. |
| `offset` | integer | no | Default 0. |

## `aula.gallery.media`

**Media in an album** · read

The photos and videos of one album from the local copy, oldest first: id, type (image or video), original file name, title, upload time, size, whether the original and the thumbnail are downloaded, the stored path relative to the parent's gallery folder, the names of people tagged, and the last download error if any. Take `albumId` from aula.gallery.albums. Use aula.gallery.thumbnail to look at one.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `albumId` | integer | yes | Album id from aula.gallery.albums. |
| `limit` | integer | no | Default 100. |
| `offset` | integer | no | Default 0. |

## `aula.gallery.thumbnail`

**Show a thumbnail** · read

Returns the stored thumbnail (about 170 KB, JPEG) of one photo or video as an image, so it can be looked at or described. Needs `albumId` and `mediaId` from aula.gallery.media; answers with an error when that thumbnail is not downloaded yet. Never returns the original file.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `albumId` | integer | yes | Album id. |
| `mediaId` | integer | yes | Media id from aula.gallery.media. |

## `aula.discover`

**Discover Aula context** · read

Returns a typed manifest of the logged-in guardian: children (with names + ids), institutions, API version, detected widgets, and which subordinate aula.* tools to call. Includes a `usage` block with name-resolution and tool-selection rules. Call ONCE per session and reuse the result — do not re-call mid-session.

No parameters.

## `aula.profiles.list`

**List Aula profiles** · read

Raw profiles.getProfilesByLogin response — every child + institution.

No parameters.

## `aula.presence.today`

**Daily presence overview** · read

Returns presence/check-in/check-out info for the given child IDs. Status codes: 0=IKKE_KOMMET (not arrived), 1=SYG (reported sick), 2=FERIE_FRI (holiday/not enrolled), 3=KOMMET (arrived/present), 4=PAA_TUR (on a trip), 5=SOVER (sleeping), 6=FRITIDSAKTIVITET, 7=FYSISK_PLACERING, 8=GAAET (picked up/left).

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `childIds` | array | yes | Aula child IDs (from aula.discover.children[].id) |

## `aula.presence.templates`

**Komme/gå templates (drop-off & pickup schedule)** · read

Recurring komme/gå (presence) templates for the given children — the drop-off and pickup times a guardian has registered per day. Pass the same child IDs as `aula.presence.today`. `from`/`to` bound the window (YYYY-MM-DD); they default to the current week. Each returned template carries the `institutionProfile.id` that `aula.presence.set_template` needs. Read this before changing a schedule.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `childIds` | array | yes | Aula child IDs (from aula.discover.children[].id) |
| `from` | string | no | Window start YYYY-MM-DD. Defaults to this Monday. |
| `to` | string | no | Window end YYYY-MM-DD. Defaults to this Sunday. |

## `aula.calendar.events`

**Calendar events (school schedule)** · read

The lesson timetable (skoleskema): subjects, times, rooms — not the weekly letter a teacher writes (that is aula.ugeplan.* / aula.ugebrev.*). Lessons + events for the given child institution-profile IDs. Call aula.discover first and pass children[].id as profileIds. Pass `range` for a preset window (today/tomorrow/this_week/next_week) OR `start`+`end` for a specific window. Timestamps are formatted as Aula expects: "YYYY-MM-DD HH:MM:SS.0000+ZZZZ". Aula uses Europe/Copenhagen.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `profileIds` | array | yes | Child institution-profile IDs from aula.discover children[].id. Do not use children[].userId. |
| `range` | string | no |  |
| `start` | string | no |  |
| `end` | string | no |  |
| `resourceIds` | array | no |  |

## `aula.notifications.list`

**Aula notifications** · read

Unread items + activity for the active guardian profile. `webUrl` is set on shared-post notifications only; it is an in-app route (`#/...` on www.aula.dk) that opens in a browser with a logged-in Aula session, not in the Aula app.

No parameters.

## `aula.groups.list`

**Aula groups (classes)** · read

Classes and groups the family’s children belong to. Use the returned group ids with aula.contacts.list.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `childInstitutionProfileIds` | array | no | Optional. Omit to cover every child in the family. |

## `aula.contacts.list`

**Aula contact list (group members)** · read

Members of one group or class, from aula.groups.list. Contains other families’ personal data (names, birthdays) — only surface what the user asked for.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `groupId` | integer | yes |  |
| `filter` | string | no | Aula role filter. Defaults to "child"; other values are untested. |
| `page` | integer | no | 1-based page. Defaults to 1. |

## `aula.posts.list`

**Aula posts (class news feed)** · read

Teacher posts and class-level updates, across every institution the family belongs to (school and club). Each item has a `webUrl`: an in-app route (`#/...` on www.aula.dk) that opens in a browser with a logged-in Aula session, not in the Aula app.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer | no |  |
| `index` | integer | no |  |
| `profileIds` | array | no | Optional. Omit to cover the whole family across all institutions automatically — recommended, and the only way to guarantee club posts appear. Set this only to deliberately narrow the feed. |
| `onlyUnread` | boolean | no | Only return unread posts. Defaults to false (all posts). |

## `aula.messages.list_threads`

**List Aula message threads** · read

One page of threads, most recent first. Aula serves 20 per page and IGNORES `pageSize` — asking for 50 still returns 20. Returns `{ threads, page, hasMorePages }`: when `hasMorePages` is true there are older threads you have not seen, so keep calling with `page` + 1 before concluding anything about the mailbox as a whole (e.g. "no unread messages"). A single call answers "what arrived recently", never "what does the mailbox contain". By default each unread thread also carries `latest`: sender, time, attachment flag and the newest message — whole in `text` when short, otherwise an `excerpt` with `needsSummary: true`. For those, fetch aula.messages.get_thread if you need more and summarise it for the user rather than pasting it. A thread whose content cannot be read gets `latest: { readable: false, error, message, action, retryable }` and, for sensitive threads, `sensitive: true`; its subject and sender are still listed. Show those rows as "needs MitID approval" and relay `action` once, not per thread. Each item has a `webUrl`: an in-app route (`#/...` on www.aula.dk) that opens in a browser with a logged-in Aula session, not in the Aula app.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page` | integer | no |  |
| `includeContent` | string | no | Which threads get `latest` (one extra Aula call per thread). Default "unread". Use "all" only when you need to summarise read threads too; use "none" for a cheap "anything new?" check, since each thread already has `lastMessage` sender and time. |
| `pageSize` | integer | no | Sent through to Aula, which ignores it. Kept in case that changes. |

## `aula.ugeplan.easyiq`

**EasyIQ weekly plan** · read

Weekly plan from EasyIQ for the given children. Use when the school is on EasyIQ.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `childIds` | array | yes |  |
| `institutionCodes` | array | yes |  |
| `isoWeek` | string | no | ISO week, e.g. "2026-W18". Defaults to the current week. |

## `aula.ugeplan.meebook`

**Meebook weekly plan** · read

Weekly plan from Meebook for the given children. Use when the school is on Meebook.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `childIds` | array | yes |  |
| `institutionCodes` | array | yes |  |
| `isoWeek` | string | no | ISO week, e.g. "2026-W18". Defaults to the current week. |

## `aula.ugeplan.easyiq_skoleportal`

**EasyIQ SkolePortal weekly plan** · read

Weekly plan from EasyIQ SkolePortal (widget 0128) — a different EasyIQ product than `aula.ugeplan.easyiq` (widget 0001). Use when discover.detectedWidgets contains "0128".

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `childIds` | array | yes |  |
| `institutionCodes` | array | yes |  |
| `isoWeek` | string | no | ISO week, e.g. "2026-W18". Defaults to the current week. |

## `aula.lektier.easyiq`

**EasyIQ Lektier (homework)** · read

Homework items from EasyIQ Lektier (widget 0142) — same vendor as `aula.ugeplan.easyiq_skoleportal` but a separate "Lektier" product. Use when discover.detectedWidgets contains "0142".

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `childIds` | array | yes |  |
| `institutionCodes` | array | yes |  |
| `isoWeek` | string | no | ISO week, e.g. "2026-W18". Defaults to the current week. |

## `aula.opgaver.minuddannelse`

**Min Uddannelse opgaveliste** · read

Homework / task list from Min Uddannelse for the given children. `content` holds the forløb name plus the teacher's description as plain text, fetched through a minuddannelse.net session; if that fails the items come back title-only with a warning.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `childIds` | array | yes |  |
| `institutionCodes` | array | yes |  |
| `isoWeek` | string | no | ISO week, e.g. "2026-W18". Defaults to the current week. |

## `aula.ugebrev.minuddannelse`

**Min Uddannelse ugebrev** · read

Weekly newsletter (ugebrev) from Min Uddannelse.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `childIds` | array | yes |  |
| `institutionCodes` | array | yes |  |
| `isoWeek` | string | no | ISO week, e.g. "2026-W18". Defaults to the current week. |

## `aula.huskelisten.systematic`

**Systematic Huskelisten reminders** · read

Homework reminders from Systematic. Args may include `from`/`to` ISO YYYY-MM-DD dates.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `childIds` | array | yes |  |
| `institutionCodes` | array | yes |  |
| `isoWeek` | string | no | ISO week, e.g. "2026-W18". Defaults to the current week. |
| `fromDate` | string | no |  |
| `toDate` | string | no |  |

## `aula.messages.get_thread`

**Read a single thread** · read

Returns subject + every message in the thread. If the thread is sensitive, this tool does not throw: it returns `{ readable: false, error, message, action, retryable }`. `error: "step_up_required"` means the user must approve a MitID step-up (`aula login`); relay `action` to them.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `threadId` | integer | yes |  |
| `page` | integer | no |  |

## `aula.messages.get_attachment`

**Download a thread attachment to local disk** · read

Download an attachment from a thread message and write it to a local temporary file, returning the file path. Prefer this over passing Aula attachment URLs through the model — CloudFront presigned URLs are long opaque blobs that LLMs often mangle when echoing into tool calls (MalformedSignature / AccessDenied 403). `attachmentIndex` is zero-based across all attachments in the thread, flattened message-by-message in the order returned by `aula.messages.get_thread`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `threadId` | integer | yes |  |
| `attachmentIndex` | integer | yes |  |

## `aula.posts.get_attachment`

**Download a post attachment to local disk** · read

Download an attachment from a news feed post and write it to a local temporary file, returning the path. Pass `url` and `name` exactly as they appear in the attachments array from `aula.posts.list` — the CloudFront signature is part of the URL, so altering a single character produces a MalformedSignature 403.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `postId` | integer | yes | The post the attachment belongs to (names the file). |
| `url` | string | yes | The exact presigned URL from the posts feed. |
| `filename` | string | yes | e.g. 'Kostplan_juni_2026.pdf' |

## `aula.utils.extract_pdf_text`

**Extract text from a local PDF file** · read

Read a PDF from a local absolute path — typically one returned by aula.posts.get_attachment or aula.messages.get_attachment — and return its text so it can be read or summarised.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | string | yes | Absolute local path to the PDF. |

## `aula.presence.set_template`

**Set a komme/gå template (drop-off & pickup time)** · write (`AULA_MCP_WRITE=1`)

Register or overwrite a child's komme/gå template for one day. WRITES to Aula — enabled when AULA_MCP_WRITE=1. Covers one child and one date per call; call once per day to fill a week. Read `aula.presence.templates` first to see the current schedule and confirm the child id. `activityType` picks how the child leaves: picked_up_by ("Hentes af", a named person collects), self_decider ("Selvbestemmer", may leave alone between two times), send_home ("Sendes hjem", leaves alone at exitTime), go_home_with ("Går hjem med", leaves with a named person). Set `repeat` to make it recur on that weekday until `repeatUntil`.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `institutionProfileId` | integer | yes | Child institution-profile id — the same id passed to aula.presence.today as childIds, and the institutionProfile.id from aula.presence.templates. |
| `date` | string | yes | Day the template applies to (YYYY-MM-DD). With repeat set, this is the first occurrence and fixes the weekday. |
| `activityType` | string | yes | How the child leaves the institution. |
| `entryTime` | string | no | Drop-off time, HH:mm. |
| `exitTime` | string | no | Pickup / go-home time, HH:mm. Used by picked_up_by, send_home, go_home_with. |
| `pickedUpBy` | string | no | Name of the person collecting the child. Required for picked_up_by and go_home_with. |
| `selfDeciderStartTime` | string | no | Earliest the child may leave, HH:mm. Required for self_decider. |
| `selfDeciderEndTime` | string | no | Latest the child may leave, HH:mm. Required for self_decider. |
| `comment` | string | no | Free-text note shown to staff. |
| `repeat` | string | no | Repeat cadence. Defaults to never (the single day only). |
| `repeatUntil` | string | no | Last date the repeat applies (YYYY-MM-DD). Required when repeat is weekly or every_2_weeks. |

## `aula.presence.report_sick`

**Report a child sick (or well again)** · write (`AULA_MCP_WRITE=1`)

Mark a child as sick for today, or take the report back. WRITES to Aula — enabled when AULA_MCP_WRITE=1. The institution is notified. Applies to today; Aula has no future-dated sick report — use aula.presence.set_template or a vacation registration for a planned absence. An institution can withhold this from guardians, in which case Aula rejects the call.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `institutionProfileIds` | array | yes | Child institution-profile ids — the same ids passed to aula.presence.today as childIds, i.e. aula.discover children[].id. Must belong to the logged-in guardian; anything else is rejected. Confirm the child with the user before calling. |
| `sick` | boolean | yes | true reports the child sick. false takes the report back, which sets the child to "ikke kommet" (not arrived) — so it is rejected unless Aula currently reports that child as sick. |

## `aula.messages.mark_read`

**Mark a message thread as read** · write (`AULA_MCP_WRITE=1`)

Move the read marker in a thread to its newest message, clearing the unread badge. WRITES to Aula — enabled when AULA_MCP_WRITE=1. Pass `messageId` from `aula.messages.list_threads` (thread.latestMessage.id); omit it to mark the thread read up to whatever its newest message is right now. Marking read is not reversible through this API — Aula offers no way to set a thread back to unread, so only call this for threads the user has actually seen.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `threadId` | integer | yes | Thread id from aula.messages.list_threads. |
| `messageId` | string | no | Aula's opaque message id (e.g. "6a3d2467304484.24549709"), NOT a number. Defaults to the thread's newest message. |

## `aula.messages.reply`

**Reply in a message thread** · write (`AULA_MCP_WRITE=1`)

Reply to an existing Aula thread. WRITES to Aula — enabled when AULA_MCP_WRITE=1. Two steps: call WITHOUT `send` first to get a preview, show the user the exact text, and only call again with `send: true` after they explicitly approve it. A sent message cannot be recalled and goes to the thread's other participants (e.g. the child's teacher). Replies only; it cannot start a new thread.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `threadId` | integer | yes | Thread id from aula.messages.list_threads. |
| `text` | string | yes | Plain-text reply body. |
| `send` | boolean | no | Must be true to actually send. Omit to get a preview only. |

## `aula.raw_request`

**Raw Aula API call (escape hatch)** · raw (`AULA_MCP_RAW=1`)

Call any Aula API method directly. Enabled when AULA_MCP_RAW=1. The CSRF token + access_token are added automatically; the response envelope is unwrapped to its `data` field. Use sparingly — most needs have a typed tool.

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `method` | string | yes | e.g. "profiles.getProfileContext" |
| `query` | object | no |  |
| `body` | any | no |  |
