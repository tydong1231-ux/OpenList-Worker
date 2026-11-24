# Private gallery frontend

The root route and /@gallery render a lightweight, media-first gallery; original OpenList management, login, file URLs, share and WebDAV routes are preserved. The default directory is /夸克网盘. Use the menu to open the original file manager.

Design reference and attribution: [Foldergram FolderGrid](https://github.com/foldergram/foldergram/blob/main/client/src/components/FolderGrid.vue), AGPL-3.0; [Immich GalleryViewer](https://github.com/immich-app/immich/blob/main/web/src/lib/components/shared-components/gallery-viewer/GalleryViewer.svelte), AGPL-3.0. The gallery adapts the fixed-ratio media-grid pattern and viewport-window approach to OpenList's existing file API rather than importing their server-specific Vue/Svelte applications.

Uses /api/me, /api/auth/login, /api/auth/logout, /api/fs/list and /api/fs/get with the original session token. Signed file links use the existing /api/d route. Thumbnail URLs are taken from the existing directory listing; small images without a thumbnail can use the signed original URL; video originals are never fetched to generate grid thumbnails. No server-side media indexing, background jobs, R2 or paid media services are introduced. Directory cache lives in the browser's memory and is cleared at logout.

Browser native media support determines compatible formats and seek support. Unsupported types and password-protected directories retain the original OpenList viewer/file manager as fallback.
