import assert from "node:assert/strict"
import { test } from "node:test"
import { galleryHintKey, signGalleryHint, verifyGalleryHint } from "./gallery-hint"
test("directory hint is bound to authenticated owner, path, mount and expiry", async () => {
  const key = await galleryHintKey("test-only-key")
  const storage = { id: 1, modified: "one", mount_path: "/drive", driver: "QuarkUcTv" }
  const now = 1000000
  const hint = await signGalleryHint(key, storage, "/drive/a", "1", "fid_123", now)
  assert.equal(await verifyGalleryHint(key, storage, "/drive/a", "1", hint, now), "fid_123")
  assert.equal(await verifyGalleryHint(key, storage, "/drive/b", "1", hint, now), undefined)
  assert.equal(await verifyGalleryHint(key, storage, "/drive/a", "2", hint, now), undefined)
  assert.equal(await verifyGalleryHint(key, {...storage, modified:"two"}, "/drive/a", "1", hint, now), undefined)
  assert.equal(await verifyGalleryHint(key, storage, "/drive/a", "1", hint.replace("fid_123","fid_456"), now), undefined)
  assert.equal(await verifyGalleryHint(key, storage, "/drive/a", "1", hint, now + 181000), undefined)
})
