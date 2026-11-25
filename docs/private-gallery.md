# Private gallery frontend

The root route and /@gallery render a lightweight, media-first gallery; original OpenList management, login, file URLs, share and WebDAV routes are preserved. The default directory is /夸克网盘. Use the menu to open the original file manager.

Design reference and attribution: [Foldergram FolderGrid](https://github.com/foldergram/foldergram/blob/main/client/src/components/FolderGrid.vue), AGPL-3.0; [Immich GalleryViewer](https://github.com/immich-app/immich/blob/main/web/src/lib/components/shared-components/gallery-viewer/GalleryViewer.svelte), AGPL-3.0. The gallery adapts the fixed-ratio media-grid pattern and viewport-window approach to OpenList's existing file API rather than importing their server-specific Vue/Svelte applications.

Uses /api/me, /api/auth/login, /api/auth/logout, /api/fs/list and /api/fs/get with the original session token. Signed file links use the existing /api/d route. Thumbnail URLs are taken from the existing directory listing; small images without a thumbnail can use the signed original URL; video originals are never fetched to generate grid thumbnails. No server-side media indexing, background jobs, R2 or paid media services are introduced. Directory cache lives in the browser's memory and is cleared at logout.

Browser native media support determines compatible formats and seek support. Unsupported types and password-protected directories retain the original OpenList viewer/file manager as fallback.


## Gallery D1 usage controls

- Existing media and queue records remain in place. No index rebuild, source-file download, or destructive migration is required by this release.
- Cron runs every five minutes between 01:00 and 16:59 UTC while a complete scan is unfinished; completed galleries check incremental work on :00/:30. Daily gallery scan write allowance is 40,000 estimated D1 rows, with an atomic 1,600-row reservation and reconciliation using D1 metadata.
- The queue cursor and lease are checked together to reject stale concurrent steps. A failed scan preserves its cursor and backs off; the weekly complete pass remains the correctness fallback for moved/deleted files.
- Default chronological browsing, covers, random memories, anniversaries and Live Photo lookup use the existing indexes. Month/count summaries are persisted by scheduled work at most every two hours when the index changes (first summary is populated by a regular scheduled run). The UI marks counts as approximate and indicates when a summary is pending.
- Substring search and non-default sorts can still scan wider ranges. They have a separate shared 500,000-row daily estimated allowance; once depleted, default chronological browsing and month filters remain available. Allowances reset at UTC midnight and are app-level safeguards, not a guarantee against unrelated D1 account activity or unreported D1 metadata.
- The local SQLite regression checks query plans, live-photo uniqueness, stale lease rejection and summary refresh fencing without accessing a production database.


## Durable gallery identity across TV reauthorization

- The gallery namespace is tied to a verified upstream account and the original mount generation, not its refreshed authorization timestamp. Existing data is adopted without copying or rewriting any gallery rows. ACL exclusions and OpenList owner identity remain part of the scope.
- Scheduled work pins the existing account using authenticated TV user information at the next active tick; after pinning, no further identity API calls are needed during ordinary scans. The dedicated QR setup flow also attempts this if the old credentials are still valid. Only explicit upstream account identifiers are accepted; nicknames, device IDs and tokens never establish identity.
- Same-account QR reauthorization creates a small version binding to the original scope before saving new credentials, keeping the state, queue, statistics, tags and thumbnails in place. A different or unverifiable account is rejected without replacing the existing mount. Other mount paths and generic storage edits are not treated as verified reauthorization; use the dedicated QR page for this gallery.
- If upstream stops returning a stable account ID before the first successful pin, the old index remains intact but safe automatic reattachment cannot be guaranteed. Do not delete/recreate the mount. No production sign-out is required to adopt the existing index.


## Single-file HEIC motion photos

HEIC/HEIF tiles show a provisional Live badge without downloading originals or making extra D1 queries. Only the selected image is inspected using bounded ISO-BMFF boxes. Standard mpvd and concatenated HEIC + MOV/MP4 at a valid box boundary are supported, including bounded verification of a standalone trailing MOV after an open-ended mdat; a real video track and media data are required. Ordinary HEIC and unsupported vendor containers remain viewable as still images. Unknown layouts are not falsely claimed to be supported. Detected state is remembered in a bounded browser-session map. The existing 32 MiB compatible image limit remains in effect; no media data is persisted in D1.

The selected image bytes are reused by the existing local HEIC decoder, with the original embedded video passed to Apple's LivePhotosKit JS 1.5.6, built as a same-origin static asset from the exact npm release. The existing gesture controller owns long-press, release, swipe and pinch; the Apple player performs FULL playback when ready. Native inline video remains a fallback for missing key-frame metadata, unsupported SDK or browser playback policies. Both LIVE clicks and touch-holds request sound where supported; browser restrictions may require muted native fallback. No automatic animation of every photo is initiated, preserving scrolling and battery performance. Original download is unchanged. No real Quark sample file was supplied to the implementation, so proprietary packaging and iPhone device playback require user verification.


## Quark LIVP and expiring thumbnails

A real Quark-exported HEIC was inspected: a normal HEIC prefix, 16-byte little-endian uuid wrapper, original MOV, and 12-byte livp trailer. The parser validates the two lengths, primary-image boundary and real video track before extracting the MOV. Tests use synthetic structural fixtures, not private photos. A browser that decodes only audio is treated as unsupported, never as successful motion playback.

Indexed thumbnail URLs are temporary. On a visible tile's missing/failed URL, the browser queues a bounded authenticated refresh. A single Quark list page can recover up to 100 thumbnails for photos and videos; no original downloads, no media-index rewriting. The newest directory page is tried once per session window; older records use a cached approximate filename rank, then a bounded adjacent-page search. Rank plans are derived on demand, cached for 12h, and charged against the existing heavy-read budget. They are hints, not authoritative file locators. Thumbnail results remain in browser memory only. If an upstream filename collation differs or no thumbnail is returned, a specific tile may still need a later retry; no unlimited directory traversal occurs.


## Live Photo viewer geometry (live18)

Live indicators are shown only inside the selected photo viewer, never on the folder, timeline or memories thumbnails. The untransformed motion surface occupies the same fitted rectangle as the static image, with the identical pan/zoom transform. The still remains beneath it; playback/release never resets the pose. A stationary hold works at any zoom; movement and a second finger cancel it, and the existing pinch/swipe rules remain. Apple LivePhotosKit receives an independent intrinsic-size image and explicit untransformed player dimensions. Its rotated movie aspect is checked against the still; for differently cropped videos, native inline playback uses aspect-preserving center cover within the same fitted rectangle. This may crop motion edges rather than stretch a mismatched aspect ratio. No changes to index, thumbnails, upstream auth, Cron, or D1.


## Live Photo direction metadata (live19)

A real Quark LIVP clip uses a 1920x1440 encoded primary picture with a quarter-turn track display matrix and five auxiliary picture tracks. Matching the rotated aspect ratio alone does not ensure that the legacy SDK renders the actual pixels upright. Inspect the ISO-BMFF movie and video-track matrices before selecting the renderer. Only a verified identity movie/track transform, a single enabled primary video and no auxiliary picture tracks can initialize LivePhotosKit; missing, rotated, mirrored, translated or otherwise transformed matrices take the browser's native inline-video path. Native playback uses the unchanged movie bytes and applies the embedded transform once, without CSS rotation or width/height swapping. The previous shared photo pose, cover crop, hold/release and pinch cancellation remain intact. No DB reads/writes, indexing, thumbnail refresh, or upstream auth changes are introduced.


## Device-local thumbnail cache (thumb20)

Visible thumbnail images are loaded through an optional same-origin Service Worker route, keyed by a SHA-256 digest of the current login session and file identity/version. Only the ephemeral client mapping contains the upstream signed URL; the persistent Cache Storage keys contain neither paths nor credentials. Readable image responses are reconstructed and capped at 192 KiB each, 256 entries (at most 48 MiB of image payload). CDNs without CORS use a separately capped 48-entry opaque-response cache (browser-specific privacy padding may count more quota; skipped at high storage usage). Both expire after seven days and evict oldest entries. Opaque response internals may retain CDN URL metadata. Cache access requires a current authorized media item and the per-tab mapping. No API responses, index, full-size media or videos are cached. Cache Storage failures, unsupported browsers and first-install/no-controller conditions fall back to the old direct thumbnail loading and bounded signed URL refresh. Logout/expired session clears local caches; cache eviction and device storage management can remove them. No new server proxy, D1 operations or Cloudflare storage. Subtle theme-aware placeholders and decode-only fade-in suppress broken-image icons, including during retries.
