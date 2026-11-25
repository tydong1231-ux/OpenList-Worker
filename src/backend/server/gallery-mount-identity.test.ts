import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { sha256 } from "../pkg/crypto"
import { quarkTvAccountFingerprint } from "../drivers/quark_uc_tv/util"
import { galleryScopeForMount, pinGalleryMountIdentity, linkGalleryMountIdentity, readGalleryMountIdentity } from "./gallery-mount-identity"

function fixture(){
  const sqlite=new DatabaseSync(":memory:")
  const db={prepare(sql:string){let values:any[]=[];const statement=()=>sqlite.prepare(sql);return {bind(...args:any[]){values=args;return this},async first(){return statement().get(...values)||null},async run(){return {meta:{changes:statement().run(...values).changes}}}}}}
  return {sqlite,db}
}
test("legacy scope is pinned in place and survives two QR credential rotations",async()=>{
  const {sqlite,db}=fixture()
  try{
    const old={id:7,modified:"2026-11-24T00:00:00.000Z"}
    const next={id:7,modified:"2026-11-25T00:00:00.000Z"},again={id:7,modified:"2026-12-25T00:00:00.000Z"}
    const root="/夸克网盘",excluded=[root+"/private"],account="a".repeat(64)
    const legacy=await sha256(JSON.stringify(["private-gallery-v1",1,old.id,old.modified,root,excluded]))
    assert.equal((await galleryScopeForMount(db,1,old,root,excluded)).scope,legacy)
    sqlite.exec("CREATE TABLE media(scope TEXT,fid TEXT,tag TEXT,PRIMARY KEY(scope,fid)); CREATE TABLE queue(scope TEXT PRIMARY KEY,page INTEGER); CREATE TABLE stats(scope TEXT PRIMARY KEY,n INTEGER);")
    sqlite.prepare("INSERT INTO media VALUES(?,?,?)").run(legacy,"photo-1","tag-kept")
    sqlite.prepare("INSERT INTO queue VALUES(?,?)").run(legacy,201)
    sqlite.prepare("INSERT INTO stats VALUES(?,?)").run(legacy,17281)
    await pinGalleryMountIdentity(db,old,account)
    assert.equal((await galleryScopeForMount(db,1,old,root,excluded)).scope,legacy)
    await linkGalleryMountIdentity(db,old,next,account)
    await linkGalleryMountIdentity(db,next,again,account)
    for(const s of [next,again]){
      const {scope}=await galleryScopeForMount(db,1,s,root,excluded)
      assert.equal(scope,legacy)
      assert.equal(sqlite.prepare("SELECT tag FROM media WHERE scope=?").get(scope)?.tag,"tag-kept")
      assert.equal(sqlite.prepare("SELECT page FROM queue WHERE scope=?").get(scope)?.page,201)
      assert.equal(sqlite.prepare("SELECT n FROM stats WHERE scope=?").get(scope)?.n,17281)
    }
    assert.notEqual((await galleryScopeForMount(db,2,again,root,excluded)).scope,legacy)
    assert.notEqual((await galleryScopeForMount(db,1,again,root,[])).scope,legacy)
    assert.notEqual((await galleryScopeForMount(db,1,{id:8,modified:again.modified},root,excluded)).scope,legacy)
    assert.notEqual((await galleryScopeForMount(db,1,{id:7,modified:"unverified-config-edit"},root,excluded)).scope,legacy)
  }finally{sqlite.close()}
})
test("unknown identity, changed account or mount cannot inherit an index",async()=>{
  const {sqlite,db}=fixture()
  try{
    const old={id:1,modified:"old"},next={id:1,modified:"next"},a="a".repeat(64),b="b".repeat(64)
    await assert.rejects(linkGalleryMountIdentity(db,old,next,a),/UNVERIFIED/)
    await pinGalleryMountIdentity(db,old,a)
    await assert.rejects(linkGalleryMountIdentity(db,old,next,b),/MISMATCH/)
    await assert.rejects(linkGalleryMountIdentity(db,old,next,""),/INVALID/)
    await assert.rejects(linkGalleryMountIdentity(db,old,{id:2,modified:"next"},a),/INVALID/)
    assert.equal(await readGalleryMountIdentity(db,next),null)
    await linkGalleryMountIdentity(db,old,next,a)
    await linkGalleryMountIdentity(db,old,next,a)
    await assert.rejects(pinGalleryMountIdentity(db,next,b),/MISMATCH/)
    assert.equal((await readGalleryMountIdentity(db,next))?.scope_seed,"old")
  }finally{sqlite.close()}
})
test("account fingerprint comes from explicit authenticated ID, never device or nickname",async()=>{
  const q=(v:any)=>quarkTvAccountFingerprint(v,"quark")
  const a=await q({data:{user_id:"123456",nickname:"old",device_id:"device-1"}})
  assert.match(a!,/^[a-f0-9]{64}$/)
  assert.equal(a,await q({data:{user_id:123456,nickname:"new",device_id:"device-2"}}))
  assert.notEqual(a,await q({data:{user_id:"654321"}}))
  assert.notEqual(a,await quarkTvAccountFingerprint({data:{user_id:"123456"}},"uc"))
  assert.equal(await q({data:{nickname:"same name",device_id:"device-1",access_token:"token"}}),null)
  assert.equal(await q({data:{user_id:"0"}}),null)
  assert.equal(await q({data:{user_id:"123456",user_info:{user_id:"654321"}}}),null)
  assert.equal(await q({data:{user_id:9007199254740992}}),null)
  assert.equal(await q({data:{user_info:{uid:"account_1"}}}),await q({data:{uid:"account_1"}}))
})
