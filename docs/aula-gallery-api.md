# Aula gallery API (wire notes)

Measured on 2026-11-21 against one live guardian account (2 children, 14
albums, 189 media checked). Only shapes, enums and sizes were recorded, never
content. Typed in `packages/aula-client/src/aula-types.ts` (`Gallery*`), read
with `AulaClient.getAlbums` and `AulaClient.getAlbumMedia`.

## gallery.getAlbums

`GET /api/v<N>/?method=gallery.getAlbums&index=0&limit=100&sortOn=createdAt&orderDirection=desc&filterBy=all&filterInstProfileIds[0]=<id>&…`

- `filterInstProfileIds[i]` takes the family ids (guardian + children), the
  same set `posts.getAllPosts` needs.
- `filterBy=all` includes media the children are not tagged in.
- Returns the album array directly (after the envelope's `data`).
- Paging: `index` is an offset. `index=100` returned an empty array on an
  account with 14 albums, so stop at the first short page.
- `creationDate`: ISO 8601 with offset (`2026-11-18T09:12:00+01:00`).
- Creators seen: role `employee` only.

## gallery.getMedia

Same query plus `albumId`, with `sortOn=uploadedAt`. Without `albumId` Aula
answers 400 (envelope code 40).

Returns `{ album, mediaCount, totalSize, startIndex, limit, results[] }`.
`mediaCount` equalled `totalSize` on every album. A `limit` of 50 returned 50
of 51, so page by `index` until `startIndex + results.length >= totalSize`.

Per media item:

| Field | Seen |
| --- | --- |
| `mediaType` | `image` (no videos on the account, so `video` is unverified) |
| `conversionStatus` | `completed` |
| `file.scanningStatus` | `bypassed` |
| `file.name` | original name, `.jpeg` seen |
| `duration` | `null` for images |
| `tags[]` | institution profiles; 23 of 189 items were tagged |

## File and thumbnail URLs

- Host `media-prod.aula.dk`, signed CloudFront URLs (`Expires`, `Signature`,
  `Key-Pair-Id`, `response-content-disposition=attachment;filename=…`).
- Valid for about 27–30 minutes after the listing call, so a download queue
  must list again to get fresh URLs rather than store them.
- Fetchable without the Aula access token. They support `Range` (206) and send
  an `ETag`. `content-type` is always `application/octet-stream`, so the file
  type has to come from `file.name` or the bytes.
- Sizes for one photo: `extraSmallThumbnailUrl` 19 KB, `smallThumbnailUrl`
  52 KB, `mediumThumbnailUrl` and `thumbnailUrl` 170 KB (same file),
  `largeThumbnailUrl` 351 KB, original 599 KB.
- Never log these URLs: the signature grants access to the file until it
  expires.
