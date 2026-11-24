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
