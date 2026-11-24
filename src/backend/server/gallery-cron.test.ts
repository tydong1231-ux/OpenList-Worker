import assert from "node:assert/strict"
import { test } from "node:test"
import { DatabaseSync } from "node:sqlite"
import { GALLERY_CRON, shouldRunGalleryCron, galleryFidLookupSql, galleryLiveLookupSql, galleryRecentSql, galleryTaskCas, galleryStatsRefreshSql } from "./gallery-memory"

test("cron runs every five minutes for incomplete generations, half hourly otherwise",()=>{
  const at=(h:number,m:number)=>Date.UTC(2026,10,25,h,m)
  assert.equal(GALLERY_CRON,"*/5 1-16 * * *")
  for(const h of [1,5,16]){
    assert.equal(shouldRunGalleryCron(at(h,0),false),true)
    assert.equal(shouldRunGalleryCron(at(h,30),false),true)
    assert.equal(shouldRunGalleryCron(at(h,5),false),false)
    assert.equal(shouldRunGalleryCron(at(h,5),true),true)
    assert.equal(shouldRunGalleryCron(at(h,1),true),false)
  }
  assert.equal(shouldRunGalleryCron(at(0,0),true),false)
  assert.equal(shouldRunGalleryCron(at(17,0),true),false)
})

test("gallery lookup plans use bounded index seeks even after ANALYZE",()=>{
  const db=new DatabaseSync(":memory:")
  try{
    db.exec(`CREATE TABLE private_gallery_items(scope TEXT NOT NULL,epoch INTEGER NOT NULL,fid TEXT NOT NULL,folder TEXT NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL,day TEXT NOT NULL,size INTEGER NOT NULL,tag TEXT NOT NULL,shuffle INTEGER NOT NULL,PRIMARY KEY(scope,fid));
    CREATE INDEX private_gallery_date ON private_gallery_items(scope,epoch,day DESC,fid);
    CREATE INDEX private_gallery_shuffle ON private_gallery_items(scope,epoch,shuffle,fid);
    CREATE INDEX private_gallery_stream ON private_gallery_items(scope,day DESC,fid);
    CREATE INDEX private_gallery_stream_kind ON private_gallery_items(scope,kind,day DESC,fid);
    CREATE INDEX private_gallery_live_mov ON private_gallery_items(scope,folder,name COLLATE NOCASE) WHERE kind='video';
    CREATE TABLE private_gallery_stats(scope TEXT PRIMARY KEY,signature TEXT NOT NULL,updated_at INTEGER NOT NULL,payload TEXT NOT NULL);`)
    const insert=db.prepare("INSERT INTO private_gallery_items VALUES(?,?,?,?,?,?,?,?,?,?)")
    db.exec("BEGIN")
    for(let i=0;i<30000;i++)insert.run("s",i%3===0?2:1,"f"+i,"/folder"+(i%100),"p"+i+".heic","image","2026-11-24",1000,"",i)
    insert.run("s",2,"mov","/folder1","p1.MOV","video","2026-11-24",1000,"",30000)
    db.exec("COMMIT; ANALYZE")
    const plan=(sql:string,...args:(string|number)[])=>db.prepare("EXPLAIN QUERY PLAN "+sql).all(...args).map(r=>String(r.detail)).join("\n")
    const fid=galleryFidLookupSql(2)
    assert.match(plan(fid,"f1","f2","s",1),/scope=\? AND fid=\?/)
    assert.equal(db.prepare(fid).all("f1","f2","s",1).length,2)
    assert.equal(db.prepare(fid).all("f1","f2","s",2).length,0)
    const recent=galleryRecentSql("fid,day")
    const rp=plan(recent,"s",1)
    assert.match(rp,/private_gallery_stream/)
    assert.doesNotMatch(rp,/TEMP B-TREE/)
    assert.equal(db.prepare(recent).all("s",1).length,64)
    const live=galleryLiveLookupSql(2),args=["f1","/folder1","p1.mov","2026-11-24","f2","/folder2","p2.mov","2026-11-24","s",1] as const
    assert.match(plan(live,...args),/folder=\? AND name=\?/)
    assert.deepEqual(db.prepare(live).all(...args).map(r=>r.fid),["f1"])
    insert.run("s",2,"mov2","/folder1","p1.mov","video","2026-11-24",1000,"",30001)
    assert.equal(db.prepare(live).all(...args).length,0)
    const refresh=db.prepare(galleryStatsRefreshSql)
    refresh.run("s","first",1000,"s",1,"s","first",0)
    const stats=()=>db.prepare("SELECT signature,payload FROM private_gallery_stats WHERE scope='s'").get()!
    assert.equal(JSON.parse(String(stats().payload)).reduce((n:number,m:any)=>n+m.n,0),30002)
    assert.equal(refresh.run("s","second",2000,"s",1,"s","second",0).changes,0)
    assert.equal(stats().signature,"first")
    assert.equal(refresh.run("s","second",3000,"s",2,"s","second",2000).changes,1)
    assert.equal(stats().signature,"second")
    assert.equal(JSON.parse(String(stats().payload)).reduce((n:number,m:any)=>n+m.n,0),10002)
  }finally{db.close()}
})

test("stale queue cursor cannot acquire a released lease or advance a page twice",()=>{
  const db=new DatabaseSync(":memory:")
  try{
    db.exec(`CREATE TABLE private_gallery_state(scope TEXT PRIMARY KEY,epoch INTEGER,done INTEGER,lease TEXT,lease_until INTEGER);
    CREATE TABLE private_gallery_queue(scope TEXT,epoch INTEGER,fid TEXT,path TEXT,done INTEGER,page INTEGER,recent_page INTEGER,next_check INTEGER,PRIMARY KEY(scope,epoch,fid));
    INSERT INTO private_gallery_state VALUES('s',2,0,'',0);
    INSERT INTO private_gallery_queue VALUES('s',2,'dir','/dir',0,0,0,0);`)
    const claim=db.prepare("UPDATE private_gallery_state SET lease=?,lease_until=? WHERE scope=? AND epoch=? AND done=? AND (lease='' OR lease_until<?) AND "+galleryTaskCas)
    const take=(lease:string,page:number)=>claim.run(lease,200,"s",2,0,100,"s",2,"dir","/dir",0,page,0,0).changes
    assert.equal(take("first",0),1)
    assert.equal(take("concurrent",0),0)
    db.exec("UPDATE private_gallery_queue SET page=1 WHERE scope='s'; UPDATE private_gallery_state SET lease='',lease_until=0 WHERE scope='s'")
    assert.equal(take("stale",0),0)
    assert.equal(take("next",1),1)
  }finally{db.close()}
})
