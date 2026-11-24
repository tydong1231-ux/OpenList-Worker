import { test } from "node:test"
import assert from "node:assert/strict"
import { Script } from "node:vm"
import { galleryHtml, galleryCss, galleryJs } from "./gallery-ui"

test("gallery client script parses and uses existing authenticated APIs", () => {
  assert.doesNotThrow(() => new Script(galleryJs))
  assert.match(galleryHtml, /\/@gallery\.js/)
  assert.match(galleryHtml, /\/@manage/)
  assert.match(galleryJs, /ROOT="\/夸克网盘"/)
  assert.match(galleryJs, /headers\.Authorization=token/)
  assert.match(galleryJs, /"\/fs\/list"/)
  assert.match(galleryJs, /"\/fs\/get"/)
  assert.match(galleryJs, /class VirtualGrid/)
  assert.match(galleryJs, /media\.preload="metadata"/)
  assert.match(galleryCss, /prefers-reduced-motion/)
})


test("compact header has one shared toolbar and no duplicate hero", () => {
  assert.match(galleryHtml, /id="compactBar"/)
  assert.match(galleryHtml, /id="browseToolbar"/)
  assert.equal((galleryHtml.match(/id="searchToggle"/g) || []).length, 1)
  assert.doesNotMatch(galleryHtml, /YOUR COLLECTION/)
  assert.match(galleryCss, /grid-template-areas:"back home crumbs toolbar actions"/)
  assert.match(galleryCss, /grid-template-areas:"back home actions" "toolbar toolbar toolbar"/)
  assert.match(galleryCss, /min-height:44px/)
  assert.doesNotThrow(() => new Script(galleryJs))
})


test("memory and timeline keep original gallery navigation and metadata-only APIs", () => {
  assert.match(galleryHtml, /id="memorySection"/)
  assert.match(galleryHtml, /id="timelineSection"/)
  assert.match(galleryJs, /\/admin\/gallery-memory\/step/)
  assert.match(galleryJs, /\/admin\/gallery-memory\/feed/)
  assert.match(galleryJs, /selected.full_path/)
  assert.doesNotThrow(() => new Script(galleryJs))
})


test("album defaults to indexed feed and renders a virtual continuous timeline",()=>{
 assert.match(galleryHtml,/id="albumTab"/)
 assert.match(galleryHtml,/id="folderTab"/)
 assert.match(galleryHtml,/id="mediaMonth"/)
 assert.match(galleryJs,/if\(location.hash\)showFiles/)
 assert.match(galleryJs,/renderTimelineWindow/)
 assert.match(galleryJs,/Cron owns all automatic sync/)
 assert.match(galleryJs,/memNext/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})


test("browser does not automatically invoke scan steps",()=>{
 assert.match(galleryJs,/memTurbo&&memActive/)
 assert.match(galleryJs,/memorySync"\)\.onclick/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})


test("memory cards navigate to a thumbnail-only virtual folder",()=>{
 assert.match(galleryHtml,/id="memoryFolder"/)
 assert.match(galleryJs,/openMemoryFolder\(card\)/)
 assert.match(galleryJs,/\/admin\/gallery-memory\/memory-items/)
 assert.match(galleryJs,/card\.ids\.slice\(0,32\)/)
 assert.match(galleryJs,/memoryImg\(f,"",false\)/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})


test("preview fits whole photos and videos in a bounded viewport",()=>{
 assert.match(galleryCss,/grid-template-columns:minmax\(0,1fr\);grid-template-rows:minmax\(0,1fr\)/)
 assert.match(galleryCss,/\.preview \.stage>img:not\(\.zoomed\),\.preview \.stage>video:not\(\.live-video\)\{[^}]*object-fit:contain/)
 assert.match(galleryCss,/\.preview \.stage\.zoom-active\{overflow:auto/)
 assert.match(galleryJs,/stage\.classList\.toggle\("zoom-active",zoomed\)/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})


test("gallery install assets use dedicated same-origin manifest and network-only service worker",()=>{
 assert.match(galleryHtml,/rel="manifest" href="\/@gallery.webmanifest"/)
 assert.match(galleryHtml,/apple-mobile-web-app-capable/)
 assert.match(galleryJs,/beforeinstallprompt/)
 assert.match(galleryJs,/serviceWorker.register/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})


test("compact album keeps sync in menu, sticky filters, saved five-stage grid and live badges",()=>{
 assert.match(galleryHtml,/id="menu".*id="albumMenuSync".*id="memorySync"/)
 assert.doesNotMatch(galleryHtml,/<h2>回忆 <span>Memories/)
 assert.match(galleryCss,/\.albumfilters\{position:sticky;top:var\(--gallery-top-height/)
 assert.match(galleryJs,/store\("gallery-media-density",value\)/)
 assert.match(galleryJs,/\[1,2,3,4,6\]/)
 assert.match(galleryJs,/memoryPullDistance>=110/)
 assert.match(galleryJs,/if\(f.live\)addLiveBadge/)
 assert.doesNotMatch(galleryJs,/已加载 "\+memPageItems/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})
