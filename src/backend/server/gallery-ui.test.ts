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
 assert.doesNotMatch(galleryJs,/setTimeout\(memoryStep/)
 assert.match(galleryJs,/memorySync"\)\.onclick/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})
