import assert from "node:assert/strict"
import { test } from "node:test"
import { mediaDate, mediaTags, mediaKind, safeName, safeFid, safeThumb, buildMemoryGroups, type IndexedMedia } from "./gallery-memory-model"
test("date provenance and invalid dates",()=>{
  assert.deepEqual(mediaDate({filename:"IMG_20240102.jpg"},"/drive"),{day:"2024-01-02",date_source:"name"})
  assert.deepEqual(mediaDate({filename:"IMG_20240231.jpg"},"/drive"),{day:"0000-00-00",date_source:"unknown"})
  assert.equal(mediaDate({filename:"IMG_20240102.jpg",taken_at:"2023-11-21"},"/drive").day,"2023-11-21")
  assert.equal(mediaDate({filename:"a.jpg",created_at:1704067200},"/drive").date_source,"cloud")
})
test("uses only real tag fields and safe paths",()=>{
  assert.deepEqual(mediaTags({category:1,labels:[{name:"旅行"},"海边"],ai_tags:["旅行"]}),["旅行","海边"])
  assert.deepEqual(mediaTags({category:1,filename:"travel.jpg"}),[])
  assert.equal(safeName("../a"),false);assert.equal(safeName("%2e%2e"),false);assert.equal(safeFid("a/b"),false)
  assert.equal(safeThumb("http://example.com/a"),"")
  assert.equal(mediaKind("a.mp4"),"video")
})
test("memory groups deduplicate and prefer existing tags, dates and thumbnails",()=>{
  const rows=Array.from({length:24},(_,i)=>({fid:"f"+i,full_path:"/drive/a/"+i+".jpg",folder:"/drive/a",name:i+".jpg",kind:"image",day:"2024-11-24",date_source:"name",size:1,tag:"旅行",thumb_enc:"x",shuffle:i} as IndexedMedia))
  const cards=buildMemoryGroups(rows.slice(0,10),rows,[], "day")
  assert.ok(cards.some(c=>c.title==="旅行"&&c.subtitle.includes("标签")))
  const fids=cards.flatMap(c=>c.items.map(x=>x.fid));assert.equal(new Set(fids).size,fids.length)
  assert.deepEqual(cards,buildMemoryGroups(rows.slice(0,10),rows,[],"day"))
})
