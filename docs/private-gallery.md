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

HEIC/HEIF tiles show a provisional Live badge without downloading originals or making extra D1 queries. Only the selected image is inspected using bounded ISO-BMFF boxes. Standard mpvd and concatenated HEIC + MOV/MP4 at a valid box boundary are supported; a real video track and media data are required. Ordinary HEIC and unsupported vendor containers remain viewable as still images. Unknown layouts are not falsely claimed to be supported. Detected state is remembered in a bounded browser-session map. The existing 32 MiB compatible image limit remains in effect; no media data is persisted in D1.

The selected image bytes are reused by the existing local HEIC decoder, with the original embedded video passed to Apple's LivePhotosKit JS 1.5.6, built as a same-origin static asset from the exact npm release. The existing gesture controller owns long-press, release, swipe and pinch; the Apple player performs FULL playback when ready. Native inline video remains a fallback for missing key-frame metadata, unsupported SDK or browser playback policies. A click on LIVE requests sound where the browser allows it; touch-hold is muted to satisfy browser gesture policies. Original download is unchanged. No real Quark sample file was supplied to the implementation, so proprietary packaging and iPhone device playback require user verification.
