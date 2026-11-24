import {test} from "node:test"
import assert from "node:assert/strict"
import {Script} from "node:vm"
import {galleryManifest,galleryServiceWorker,galleryIcon} from "./gallery-pwa"
test("manifest and app artwork",()=>{
 const m=JSON.parse(galleryManifest);assert.equal(m.start_url,"/");assert.equal(m.display,"standalone")
 for(const n of [180,192,512]){const bytes=galleryIcon(String(n))!;assert.deepEqual([...bytes.slice(0,8)],[137,80,78,71,13,10,26,10]);const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);assert.equal(d.getUint32(16),n);assert.equal(d.getUint32(20),n)}
 assert.doesNotThrow(()=>new Script(galleryServiceWorker));assert.doesNotMatch(galleryServiceWorker,/\bcaches\./)
})
