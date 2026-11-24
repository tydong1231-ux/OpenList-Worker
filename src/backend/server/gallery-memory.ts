import { Hono } from "hono"
import { getDb } from "../internal/model/db"
import { getDriver } from "../internal/op/storage"
import { DriverQuarkUcTv } from "../drivers/quark_uc_tv/driver"
import { getDisableIndex } from "../internal/driver/storageopts"
import { getUserFromContext, getJwtSecret } from "./middlewares"
import { deriveConfigEncryptionKey, encryptConfigValue, decryptConfigValue, sha256 } from "../pkg/crypto"
import { assertSafeUrl, getTrustedHosts } from "../pkg/http"
import { GALLERY_ROOT, safeName, safeFid, mediaKind, mediaDate, mediaTags, safeThumb, stableHash, buildMemoryGroups, liveStillStem, chooseLivePair, mediaDurationSeconds, galleryErrorCode, type IndexedMedia } from "./gallery-memory-model"

export const galleryMemoryRouter = new Hono()
// Only one Quark page per step. No timers/cron or image/video downloads on the server.
// D1 writes include SQL index maintenance. Reserve a worst-case page, then reconcile with actual D1 metadata.
const DAILY_WRITE_BUDGET = 40000, PAGE_WRITE_RESERVE = 1600, PAGE_SIZE = 48, LEASE_MS = 180000, AUTO_REFRESH_MS = 7 * 24 * 60 * 60 * 1000
export const GALLERY_CRON = "*/5 1-16 * * *"
const HOUR=3600000, THUMB_REFRESH_MS=7*24*HOUR
const S="private_gallery_state", Q="private_gallery_queue", I="private_gallery_items", B="private_gallery_budget"
const A="private_gallery_stats", R="private_gallery_read_budget"
const STATS_INTERVAL=2*HOUR, HEAVY_READ_BUDGET=500000
const statsSchema="CREATE TABLE IF NOT EXISTS "+A+" (scope TEXT PRIMARY KEY, signature TEXT NOT NULL, updated_at INTEGER NOT NULL, payload TEXT NOT NULL)"
const readBudgetSchema="CREATE TABLE IF NOT EXISTS "+R+" (day TEXT PRIMARY KEY, units INTEGER NOT NULL)"
const schema = [
  "CREATE TABLE IF NOT EXISTS "+S+" (scope TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 1, pages INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL DEFAULT '', day_pages INTEGER NOT NULL DEFAULT 0, lease TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', completed_at INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS "+Q+" (scope TEXT NOT NULL, epoch INTEGER NOT NULL, fid TEXT NOT NULL, path TEXT NOT NULL, depth INTEGER NOT NULL, page INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, next_check INTEGER NOT NULL DEFAULT 0, recent_page INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,epoch,fid))",
  "CREATE INDEX IF NOT EXISTS private_gallery_queue_next ON "+Q+"(scope,epoch,done,depth,fid)",
  "CREATE TABLE IF NOT EXISTS "+I+" (scope TEXT NOT NULL, epoch INTEGER NOT NULL, fid TEXT NOT NULL, full_path TEXT NOT NULL, folder TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, date_source TEXT NOT NULL, size INTEGER NOT NULL, tag TEXT NOT NULL, thumb_enc TEXT NOT NULL, shuffle INTEGER NOT NULL, source_updated TEXT NOT NULL DEFAULT '', thumb_checked INTEGER NOT NULL DEFAULT 0, duration_seconds REAL NOT NULL DEFAULT 0, PRIMARY KEY(scope,fid))",
  "CREATE INDEX IF NOT EXISTS private_gallery_date ON "+I+"(scope,epoch,day DESC,fid)",
  "CREATE INDEX IF NOT EXISTS private_gallery_shuffle ON "+I+"(scope,epoch,shuffle,fid)",
  "CREATE INDEX IF NOT EXISTS private_gallery_stream ON "+I+"(scope,day DESC,fid)",
  "CREATE INDEX IF NOT EXISTS private_gallery_stream_kind ON "+I+"(scope,kind,day DESC,fid)",
  "CREATE INDEX IF NOT EXISTS private_gallery_live_mov ON "+I+"(scope,folder,name COLLATE NOCASE) WHERE kind='video'",
  "CREATE TABLE IF NOT EXISTS "+B+" (day TEXT PRIMARY KEY, pages INTEGER NOT NULL DEFAULT 0, write_units INTEGER NOT NULL DEFAULT 0)",
]
const ok=(c:any,data:any)=>c.json({code:200,message:"success",data})
const fail=(c:any,msg:string,status:400|401|403|404|409|429|500|502|503=400)=>c.json({code:status,message:msg,data:null},status)
const galleryFailure=(c:any,e:unknown,message:string)=>{const code=galleryErrorCode(e);console.warn("[GalleryRead] "+code);return c.json({code:503,message:message+" ("+code+")",diagnostic:code,ray:(c.req.header("cf-ray")||"").match(/^[a-zA-Z0-9-]{1,40}$/)?.[0]||"",data:null},503)}
const norm=(p:any)=>"/"+String(p||"").split("/").filter(Boolean).join("/")
const under=(p:string,root:string)=>root==="/"||p===root||p.startsWith(root+"/")
const utcDay=()=>new Date().toISOString().slice(0,10)
const query=(db:any,sql:string,...params:any[])=>db.prepare(sql).bind(...params)
const rows=async(db:any,sql:string,...params:any[])=>((await query(db,sql,...params).all()).results||[]) as any[]
const first=async(db:any,sql:string,...params:any[])=>await query(db,sql,...params).first() as any
const missingTable=(e:unknown)=>/no such table/i.test(String((e as any)?.message||e))
function valuesSql(n:number,width:number){return Array.from({length:n},()=>"("+Array(width).fill("?").join(",")+")").join(",")}
// CROSS JOIN fixes the small input as the outer loop; +epoch is a residual
// filter, preventing SQLite from preferring the much wider epoch index.
export function galleryFidLookupSql(n:number){
  if(!Number.isInteger(n)||n<1||n>32)throw Error("GALLERY_FID_LOOKUP_COUNT")
  return "WITH requested(fid) AS (VALUES "+valuesSql(n,1)+") SELECT i.* FROM requested r CROSS JOIN "+I+" i WHERE i.scope=? AND i.fid=r.fid AND +i.epoch>=?"
}
async function rowsByFids(g:GalleryCtx,epoch:number,fids:string[]){
  const ids=[...new Set(fids)],out:any[]=[]
  for(let i=0;i<ids.length;i+=32){const part=ids.slice(i,i+32);out.push(...await rows(g.db,galleryFidLookupSql(part.length),...part,g.scope,epoch))}
  return out
}
export function galleryLiveLookupSql(n:number){
  if(!Number.isInteger(n)||n<1||n>20)throw Error("GALLERY_LIVE_LOOKUP_COUNT")
  return "WITH requested(fid,folder,mov,day) AS (VALUES "+valuesSql(n,4)+") SELECT r.fid FROM requested r WHERE (SELECT COUNT(*) FROM (SELECT 1 FROM "+I+" AS v INDEXED BY private_gallery_live_mov WHERE v.scope=? AND v.folder=r.folder AND v.kind='video' AND v.name COLLATE NOCASE=r.mov AND v.day=r.day AND +v.epoch>=? AND v.size>0 AND v.size<=104857600 LIMIT 2))=1"
}
export const galleryTaskCas="EXISTS (SELECT 1 FROM "+Q+" WHERE scope=? AND epoch=? AND fid=? AND path=? AND done=? AND page=? AND recent_page=? AND next_check=?)"


// The ordinary list API lets admins ignore password/read_users; the discovery index
// deliberately excludes *any* protected or hidden subtree so Memory cannot surface it.
// Recompute policy on every request. Changing ACLs or the mount makes old rows unreachable.
async function context(c:any) {return contextForOwner(c.env,await getUserFromContext(c))}
async function contextForOwner(env:any,user:any) {
  if(!user||user.disabled||user.role!==2||user.id==null||norm(user.base_path)!=="/") return null
  const db=env?.DB
  if(!db||typeof db.prepare!=="function") return null
  const config=await getDb(env)
  const storage=(config.storages||[]).find((s:any)=>!s.disabled&&norm(s.mount_path)===GALLERY_ROOT&&String(s.driver).toLowerCase().replace(/[^a-z0-9]/g,"")==="quarkuctv")
  if(!storage||getDisableIndex(storage)) return null
  let addition:any
  try{addition=typeof storage.addition==="string"?JSON.parse(storage.addition):storage.addition||{}}catch{return null}
  if(norm(addition.root_folder_path)!=="/") return null
  const blocked=(config.metas||[]).filter((m:any)=>String(m.password||"").trim()||String(m.hide||"").trim()||m.read_users?.length).map((m:any)=>norm(m.path))
  const nested=(config.storages||[]).filter((s:any)=>!s.disabled&&norm(s.mount_path)!==GALLERY_ROOT&&under(norm(s.mount_path),GALLERY_ROOT)).map((s:any)=>norm(s.mount_path))
  const excluded=[...new Set([...blocked,...nested])].sort()
  const allowed=(p:string)=>under(p,GALLERY_ROOT)&&!excluded.some(x=>under(p,x))
  if(!allowed(GALLERY_ROOT)) return null
  const scope=await sha256(JSON.stringify(["private-gallery-v1",user.id,storage.id,storage.modified,GALLERY_ROOT,excluded]))
  return {db,storage,scope,allowed,hasProtectedSubtree:excluded.some(p=>under(p,GALLERY_ROOT)),secret:await getJwtSecret({env})}
}
type GalleryCtx=NonNullable<Awaited<ReturnType<typeof context>>>
async function getState(g:GalleryCtx) {
  const s=await first(g.db,"SELECT * FROM "+S+" WHERE scope=?",g.scope)
  if(!s)return s
  try {
    const budget=await first(g.db,"SELECT write_units FROM "+B+" WHERE day=?",utcDay())
    return {...s,budget_writes:Number(budget?.write_units||0)}
  }catch(e:any){if(!/no such (table|column)/i.test(String(e?.message||e)))throw e;return s}
}
// While refreshing, retain the preceding completed snapshot; hide missing media only after a complete pass.
const visibleEpoch=(s:any)=>Math.max(1,Number(s.epoch)-(s.done?0:1))
async function ensure(g:GalleryCtx) {
  let state:any
  try {state=await getState(g)}catch(e:any){if(!/no such table/i.test(String(e?.message||e)))throw e;await g.db.batch(schema.map(sql=>g.db.prepare(sql)));state=await getState(g)}
  // Upgrade an existing installation without dropping its media index.
  if((state && state.completed_at===undefined)||(!state && !(await rows(g.db,"PRAGMA table_info("+S+")")).some(x=>x.name==="completed_at"))){
    try{await g.db.prepare("ALTER TABLE "+S+" ADD COLUMN completed_at INTEGER NOT NULL DEFAULT 0").run()}catch(e:any){if(!/duplicate column/i.test(String(e?.message||e)))throw e}
    await g.db.batch(schema.filter(sql=>sql.startsWith("CREATE INDEX")||sql.includes("CREATE TABLE IF NOT EXISTS "+B)).map(sql=>g.db.prepare(sql)))
    state=await getState(g)
  }
  // Production is migrated before deployment; fresh installs have the columns.
  // This fallback also handles pre-existing databases of this fork.
  if(!state || state.revision===undefined){
    const additions:[[string,string[]],[string,string[]],[string,string[]]]=[[S,["revision INTEGER NOT NULL DEFAULT 0"]],[Q,["next_check INTEGER NOT NULL DEFAULT 0","recent_page INTEGER NOT NULL DEFAULT 0","checked_at INTEGER NOT NULL DEFAULT 0"]],[I,["source_updated TEXT NOT NULL DEFAULT ''","thumb_checked INTEGER NOT NULL DEFAULT 0"]]]
    for(const [table,cols] of additions){const existing=new Set((await rows(g.db,"PRAGMA table_info("+table+")")).map(x=>x.name));for(const col of cols)if(!existing.has(col.split(" ")[0]))try{await g.db.prepare("ALTER TABLE "+table+" ADD COLUMN "+col).run()}catch(e:any){if(!/duplicate column/i.test(String(e?.message||e)))throw e}}
    await g.db.prepare("CREATE TABLE IF NOT EXISTS "+B+" (day TEXT PRIMARY KEY, pages INTEGER NOT NULL DEFAULT 0)").run()
    state=await getState(g)
  }
  if(state && state.budget_writes===undefined){
    await g.db.prepare("CREATE TABLE IF NOT EXISTS "+B+" (day TEXT PRIMARY KEY, pages INTEGER NOT NULL DEFAULT 0, write_units INTEGER NOT NULL DEFAULT 0)").run()
    const cols=await rows(g.db,"PRAGMA table_info("+B+")")
    if(!cols.some(x=>x.name==="write_units"))try{await g.db.prepare("ALTER TABLE "+B+" ADD COLUMN write_units INTEGER NOT NULL DEFAULT 0").run()}catch(e:any){if(!/duplicate column/i.test(String(e?.message||e)))throw e}
    await g.db.prepare("UPDATE "+B+" SET write_units=pages*650 WHERE write_units=0 AND pages>0").run()
    state=await getState(g)
  }
  if(!state){
    await g.db.batch([
      query(g.db,"INSERT OR IGNORE INTO "+S+"(scope) VALUES(?)",g.scope),
      query(g.db,"INSERT OR IGNORE INTO "+Q+"(scope,epoch,fid,path,depth) SELECT scope,epoch,'0',?,0 FROM "+S+" WHERE scope=? AND pages=0",GALLERY_ROOT,g.scope)
    ])
    state=await getState(g)
  }
  if(state&&!state.done&&Number(state.pages)===0&&!(await first(g.db,"SELECT 1 FROM "+Q+" WHERE scope=? AND epoch=? AND fid='0'",g.scope,state.epoch)))await query(g.db,"INSERT OR IGNORE INTO "+Q+"(scope,epoch,fid,path,depth) VALUES(?,?,'0',?,0)",g.scope,state.epoch,GALLERY_ROOT).run()
  return state
}
function publicState(s:any) {
  const used=Number(s.budget_writes??(s.day===utcDay()?Number(s.day_pages)*650:0))
  const remaining=Math.max(0,Math.floor((DAILY_WRITE_BUDGET-used)/PAGE_WRITE_RESERVE))
  return {pages:Number(s.pages),done:!!s.done,remaining_today:remaining,estimated_writes:used,write_budget:DAILY_WRITE_BUDGET,limited:remaining===0,error:String(s.error||""),completed_at:Number(s.completed_at||0),refresh_due:!!s.done&&remaining>0&&Date.now()-Number(s.completed_at||0)>=AUTO_REFRESH_MS,epoch:Number(s.epoch),revision:Number(s.revision||0),syncing:Number(s.epoch)>1&&!s.done}
}
galleryMemoryRouter.use("*",async(c,next)=>{c.header("Cache-Control","no-store, private");c.header("Referrer-Policy","no-referrer");await next()})
// D1 single-writer lease is acquired before the network call. Every mutation is guarded
// by scope + current lease. A failed/restarted request can resume at the same page.
const guard="EXISTS (SELECT 1 FROM "+S+" WHERE scope=? AND lease=?)"
function bulk(db:any,table:string,cols:string[],values:any[][],tail:string,scope:string,lease:string) {
  const out:any[]=[]
  const n=Math.max(1,Math.floor(96/cols.length))
  for(let start=0;start<values.length;start+=n){
    const chunk=values.slice(start,start+n)
    const sql="WITH v("+cols.join(",")+") AS (VALUES "+chunk.map(()=> "("+cols.map(()=>"?").join(",")+")").join(",")+") INSERT INTO "+table+"("+cols.join(",")+") SELECT "+cols.join(",")+" FROM v WHERE "+guard+" "+tail
    out.push(query(db,sql,...chunk.flat(),scope,lease))
  }
  return out
}
// Full scan is resumable. Between complete reconciliations we visit only due
// folders, newest first, and stop pagination at a page with no changes.
// A periodic complete pass is the correctness fallback for stale timestamps,
// deletions, moves and changes that did not propagate to ancestor folders.
async function beginFull(g:GalleryCtx,s:any) {
  if(!s.done||publicState(s).remaining_today<=0)return s
  await g.db.batch([
    query(g.db,"UPDATE "+S+" SET epoch=epoch+1,pages=0,done=0,error='',lease='',lease_until=0 WHERE scope=? AND epoch=? AND done=1 AND (lease='' OR lease_until<?)",g.scope,s.epoch,Date.now()),
    query(g.db,"INSERT OR IGNORE INTO "+Q+"(scope,epoch,fid,path,depth) SELECT scope,epoch,'0',?,0 FROM "+S+" WHERE scope=? AND pages=0 AND done=0",GALLERY_ROOT,g.scope)
  ])
  return await getState(g)
}
async function scanStep(g:GalleryCtx,force=false) {
  let s=await ensure(g)
  if(publicState(s).limited)return {...publicState(s),worked:false}
  if(publicState(s).refresh_due)s=await beginFull(g,s)
  const recent=!!s.done,now=Date.now(),day=utcDay(),lease=crypto.randomUUID()
  if(s.lease&&Number(s.lease_until)>now)return {...publicState(s),worked:false,busy:true}
  const task=recent
    ?await first(g.db,"SELECT * FROM "+Q+" WHERE scope=? AND epoch=? AND done=1 AND (next_check<=? OR ?=1) ORDER BY CASE WHEN recent_page>0 THEN 0 ELSE 1 END,next_check,depth,fid LIMIT 1",g.scope,s.epoch,now,force?1:0)
    :await first(g.db,"SELECT * FROM "+Q+" WHERE scope=? AND epoch=? AND done=0 AND next_check<=? ORDER BY depth,fid LIMIT 1",g.scope,s.epoch,now)
  if(!task)return {...publicState(s),worked:false}
  // Atomic global budget and per-scope lease: changing mount/owner cannot reset the cap.
  const claims=await g.db.batch([
    query(g.db,"INSERT OR IGNORE INTO "+B+"(day,pages,write_units) SELECT ?,COALESCE(SUM(day_pages),0),650*COALESCE(SUM(day_pages),0) FROM "+S+" WHERE day=?",day,day),
    query(g.db,"UPDATE "+S+" SET lease=?,lease_until=?,day_pages=CASE WHEN day=? THEN day_pages+1 ELSE 1 END,day=?,error='' WHERE scope=? AND epoch=? AND done=? AND (lease='' OR lease_until<?) AND (SELECT write_units FROM "+B+" WHERE day=?)<=? AND "+galleryTaskCas,lease,now+LEASE_MS,day,day,g.scope,s.epoch,recent?1:0,now,day,DAILY_WRITE_BUDGET-PAGE_WRITE_RESERVE,g.scope,s.epoch,task.fid,task.path,Number(task.done),Number(task.page),Number(task.recent_page),Number(task.next_check)),
    query(g.db,"UPDATE "+B+" SET pages=pages+1,write_units=write_units+? WHERE day=? AND "+guard,PAGE_WRITE_RESERVE,day,g.scope,lease)
  ])
  if(!claims[1]?.meta?.changes){
    const state=publicState(await getState(g))
    return {...state,worked:false,busy:!state.limited}
  }
  try{
    if(!safeFid(task.fid)||!g.allowed(task.path))throw new Error("INDEX_SCOPE")
    const driver=await getDriver(g.storage.driver,g.storage)
    if(!(driver instanceof DriverQuarkUcTv))throw new Error("INDEX_DRIVER")
    const page=Number(recent?task.recent_page:task.page)
    const result=await driver.getIndexPage(task.fid,page,recent)
    const fids=result.files.map(f=>f.fid).filter(safeFid)
    const old=new Map<string,any>()
    // D1 bound parameters <100; two indexed lookups for a full 100-record page.
    for(let i=0;i<fids.length;i+=90){const ids=fids.slice(i,i+90);for(const x of await rows(g.db,"SELECT fid,epoch,full_path,folder,name,kind,day,date_source,size,tag,source_updated,thumb_checked,duration_seconds,CASE WHEN thumb_enc<>'' THEN 1 ELSE 0 END AS has_thumb FROM "+I+" WHERE scope=? AND fid IN ("+ids.map(()=>"?").join(",")+")",g.scope,...ids))old.set(x.fid,x)}
    const key=await deriveConfigEncryptionKey("private-gallery-v1:"+g.secret)
    const children:any[][]=[],media:any[][]=[],unchanged:string[]=[]
    let changes=0,newFolders=0
    const found=await Promise.all(result.files.map(async(f:any)=>{
      if(!safeName(f.filename)||!safeFid(f.fid))return null
      const path=task.path+"/"+f.filename
      if(!g.allowed(path))return null
      if(Number(f.isdir)===1)return {dir:[g.scope,s.epoch,f.fid,path,Number(task.depth)+1]}
      const kind=mediaKind(f.filename);if(!kind)return null
      const prev=old.get(f.fid),date=mediaDate(f,task.path),tag=mediaTags(f)[0]||"",thumb=safeThumb(f.thumbnail_url),sz=Math.max(0,Math.floor(Number(f.size)||0))
      const updated=String(f.updated_at??"")+":"+String(f.created_at??"")
      const duration=kind==="video"?(mediaDurationSeconds(f)||Number(prev?.duration_seconds)||0):0
      const same=!!prev&&prev.full_path===path&&prev.kind===kind&&prev.day===date.day&&prev.date_source===date.date_source&&Number(prev.size)===sz&&prev.tag===tag&&prev.source_updated===updated&&Number(prev.duration_seconds||0)===duration
      const refreshThumb=!prev||!same||(!prev.has_thumb&&!!thumb)||(!!thumb&&now-Number(prev.thumb_checked||0)>=THUMB_REFRESH_MS)
      if(same&&!refreshThumb)return {same:f.fid,epoch:Number(prev.epoch)}
      const encrypted=thumb?await encryptConfigValue(thumb,key):""
      return {changed:!same,media:[g.scope,s.epoch,f.fid,path,task.path,f.filename,kind,date.day,date.date_source,sz,tag,encrypted,stableHash(f.fid),updated,now,duration]}
    }))
    const dirs=found.filter(x=>x?.dir).map(x=>x!.dir!)
    if(recent&&dirs.length){
      const ids=dirs.map(x=>String(x[2]))
      for(let i=0;i<ids.length;i+=90){const part=ids.slice(i,i+90);const known=await rows(g.db,"SELECT fid,path FROM "+Q+" WHERE scope=? AND epoch=? AND fid IN ("+part.map(()=>"?").join(",")+")",g.scope,s.epoch,...part);newFolders+=part.length-known.length;const map=new Map(known.map(x=>[x.fid,x.path]));newFolders+=dirs.filter(x=>part.includes(String(x[2]))&&map.has(x[2])&&map.get(x[2])!==x[3]).length}
    }
    for(const v of found){if(v?.dir&&Number(task.depth)<24)children.push(recent?[...v.dir,1,0]:v.dir);if(v?.media){media.push(v.media);if(v.changed)changes++}if(v?.same&&v.epoch!==Number(s.epoch)){unchanged.push(v.same);if(recent)changes++}}
    // A recent first page with no changed items is the stopping boundary, not
    // proof of completeness: the weekly full pass still checks older pages.
    const finished=result.done||(recent&&changes===0&&newFolders===0)
    const due=now+(task.fid==="0"?6*HOUR:changes||newFolders?6*HOUR:72*HOUR)
    const batch=[
      ...bulk(g.db,Q,recent?["scope","epoch","fid","path","depth","done","next_check"]:["scope","epoch","fid","path","depth"],children,recent?"ON CONFLICT(scope,epoch,fid) DO UPDATE SET path=excluded.path,depth=excluded.depth,next_check=0,recent_page=0 WHERE "+Q+".path<>excluded.path":"ON CONFLICT(scope,epoch,fid) DO NOTHING",g.scope,lease),
      ...bulk(g.db,I,["scope","epoch","fid","full_path","folder","name","kind","day","date_source","size","tag","thumb_enc","shuffle","source_updated","thumb_checked","duration_seconds"],media,"ON CONFLICT(scope,fid) DO UPDATE SET epoch=excluded.epoch,full_path=excluded.full_path,folder=excluded.folder,name=excluded.name,kind=excluded.kind,day=excluded.day,date_source=excluded.date_source,size=excluded.size,tag=excluded.tag,thumb_enc=CASE WHEN excluded.thumb_enc='' AND "+I+".full_path=excluded.full_path THEN "+I+".thumb_enc ELSE excluded.thumb_enc END,shuffle=excluded.shuffle,source_updated=excluded.source_updated,thumb_checked=excluded.thumb_checked,duration_seconds=excluded.duration_seconds",g.scope,lease),
    ]
    // Full reconciliation needs only a seen-generation marker for unchanged
    // files; incremental scans do not write those media records at all.
    for(let i=0;i<unchanged.length;i+=85){const ids=unchanged.slice(i,i+85);batch.push(query(g.db,"UPDATE "+I+" SET epoch=? WHERE scope=? AND fid IN ("+ids.map(()=>"?").join(",")+") AND "+guard,s.epoch,g.scope,...ids,g.scope,lease))}
    if(recent){
      batch.push(query(g.db,"UPDATE "+Q+" SET recent_page=?,next_check=?,checked_at=? WHERE scope=? AND epoch=? AND fid=? AND "+guard,finished?0:page+1,finished?due:0,finished?now:Number(task.checked_at||0),g.scope,s.epoch,task.fid,g.scope,lease))
      batch.push(query(g.db,"UPDATE "+S+" SET revision=revision+?,lease='',lease_until=0,error='' WHERE scope=? AND lease=?",media.length||unchanged.length||newFolders?1:0,g.scope,lease))
    }else{
      batch.push(query(g.db,"UPDATE "+Q+" SET page=?,done=?,next_check=? WHERE scope=? AND epoch=? AND fid=? AND "+guard,page+1,result.done?1:0,0,g.scope,s.epoch,task.fid,g.scope,lease))
      batch.push(query(g.db,"UPDATE "+S+" SET pages=pages+1,done=CASE WHEN EXISTS(SELECT 1 FROM "+Q+" WHERE scope=? AND epoch=? AND done=0) THEN 0 ELSE 1 END,completed_at=CASE WHEN EXISTS(SELECT 1 FROM "+Q+" WHERE scope=? AND epoch=? AND done=0) THEN completed_at ELSE ? END,lease='',lease_until=0,error='' WHERE scope=? AND lease=?",g.scope,s.epoch,g.scope,s.epoch,now,g.scope,lease))
    }
    const results=await g.db.batch(batch)
    const metrics=[...claims,...results].map((r:any)=>r?.meta?.rows_written)
    // If accounting is unavailable or an invocation dies, keep the conservative reservation.
    if(metrics.every((n:any)=>typeof n==="number"&&Number.isFinite(n)&&n>=0)){
      const actual=metrics.reduce((n:number,x:number)=>n+x,0)+12
      await query(g.db,"UPDATE "+B+" SET write_units=MAX(0,write_units+?) WHERE day=?",actual-PAGE_WRITE_RESERVE,day).run().catch(()=>{})
    }
    const committed=!!results[results.length-1]?.meta?.changes
    return {...publicState(await getState(g)),worked:committed,found:committed?changes:0,recent}
  }catch(e){
    // Preserve both cursors. A failing directory does not block unrelated work.
    // A hard quota failure cannot always persist a retry marker; the lease
    // expires and the next allowed tick resumes from the committed cursor.
    const code=galleryErrorCode(e)
    const retryAt=code==="DB_LIMIT"?Date.parse(day+"T00:00:00Z")+24*HOUR+5*60000:Date.now()+(recent?30:5)*60000
    await g.db.batch([
      query(g.db,"UPDATE "+Q+" SET next_check=? WHERE scope=? AND epoch=? AND fid=? AND "+guard,retryAt,g.scope,s.epoch,task.fid,g.scope,lease),
      query(g.db,"UPDATE "+S+" SET lease='',lease_until=0,error=? WHERE scope=? AND lease=?",code,g.scope,lease)
    ]).catch(()=>{})
    console.warn("[GalleryScan] "+code)
    throw e
  }
}
galleryMemoryRouter.post("/step",async(c)=>{
  const g=await context(c);if(!g)return fail(c,"此相册索引仅支持已授权的私人夸克 TV 根目录。",403)
  try{return ok(c,await scanStep(g,true))}catch(e){return galleryFailure(c,e,"索引暂时中断，进度已保留。")}
})
galleryMemoryRouter.post("/rescan",async(c)=>{
  const g=await context(c);if(!g)return fail(c,"无权操作相册索引。",403)
  const s=await ensure(g)
  // A manual refresh triggers one incremental page, not a destructive rescan.
  try{return ok(c,s.done?await scanStep(g,true):publicState(s))}catch(e){return galleryFailure(c,e,"同步暂时中断，下次继续。")}
})
// The cron handler never accepts an HTTP credential or user-selected path.
// Only the existing root administrator of this private installation is eligible.
export function shouldRunGalleryCron(scheduledTime:number,fullScan:boolean){
  const t=new Date(scheduledTime),h=t.getUTCHours(),m=t.getUTCMinutes()
  return h>=1&&h<=16&&m%5===0&&(m%30===0||fullScan)
}
export async function runGalleryCron(env:any,scheduledTime:number) {
  if(!shouldRunGalleryCron(scheduledTime,true)||!env?.DB)return
  const regular=new Date(scheduledTime).getUTCMinutes()%30===0
  if(!regular){
    try{
      if(!(await first(env.DB,"SELECT 1 FROM "+S+" WHERE done=0 LIMIT 1")))return
      const b=await first(env.DB,"SELECT write_units FROM "+B+" WHERE day=?",utcDay())
      if(Number(b?.write_units||0)>DAILY_WRITE_BUDGET-PAGE_WRITE_RESERVE)return
    }catch(e){if(missingTable(e))return;throw e}
  }
  const config=await getDb(env)
  const owner=(config.users||[]).find((u:any)=>Number(u.id)===1&&u.role===2&&!u.disabled&&norm(u.base_path)==="/")
  if(!owner)return
  const g=await contextForOwner(env,owner)
  if(!g)return
  // Do not accelerate an unrelated stale scope's unfinished generation.
  if(!regular){const state=await getState(g);if(!state||state.done||publicState(state).limited)return}
  const result=await scanStep(g)
  if(result.worked)console.log("[GalleryCron] indexed page",{pages:result.pages,found:result.found||0,done:result.done})
  // Stats are generated only by scheduled work, never by a page view.
  if(regular){const state=await getState(g);if(state)await refreshGalleryStats(g,state)}
}
async function serialize(c:any,g:GalleryCtx,items:IndexedMedia[],epoch?:number) {
  const visible=items.filter(f=>g.allowed(f.full_path))
  const stills=visible.filter(f=>f.kind==="image"&&f.day!=="0000-00-00"&&liveStillStem(f.name))
  const live=new Set<string>()
  if(typeof epoch==="number"){
    // The stills are already in memory. Only seek possible MOVs by the partial
    // index, and stop after two matches. No outer scan of the media table.
    for(let i=0;i<stills.length;i+=20){
      const part=stills.slice(i,i+20)
      try{for(const f of await rows(g.db,galleryLiveLookupSql(part.length),...part.flatMap(s=>[s.fid,s.folder,liveStillStem(s.name)+".mov",s.day]),g.scope,epoch))live.add(f.fid)}
      catch(e){if(galleryErrorCode(e)==="DB_LIMIT")break}
    }
  }
  const key=await deriveConfigEncryptionKey("private-gallery-v1:"+g.secret)
  return Promise.all(visible.map(async f=>({
    id:f.fid, name:f.name, full_path:f.full_path, folder:f.folder, kind:f.kind, size:f.size,
    day:f.day,date_source:f.date_source,tag:f.tag,is_dir:false,live:live.has(f.fid),duration:Number(f.duration_seconds||0),
    thumb:f.thumb_enc?await decryptConfigValue(f.thumb_enc,key).then(safeThumb).catch(()=>""):"",
    // Obtain short-lived links only for selected files through the authenticated media-link API.
    sign:"",
  })))
}
// Reuse the existing (scope,epoch,shuffle,fid) index with equality on epoch.
// During reconciliation there are at most two visible generations.
async function sampleShuffle(g:GalleryCtx,s:any,cols:string,pivot:number,after:boolean,limit:number){
  const epochs=Array.from(new Set([visibleEpoch(s),Number(s.epoch)]))
  const samples=await Promise.all(epochs.map(epoch=>rows(g.db,"SELECT "+cols+" FROM "+I+" INDEXED BY private_gallery_shuffle WHERE scope=? AND epoch=? AND shuffle"+(after?">=":"<")+"? ORDER BY shuffle,fid LIMIT "+limit,g.scope,epoch,pivot)))
  return samples.flat().sort((a,b)=>Number(a.shuffle)-Number(b.shuffle)||(a.fid<b.fid?-1:a.fid>b.fid?1:0)).slice(0,limit)
}
type GalleryStats={signature:string;updated_at:number;payload:string}
async function readGalleryStats(g:GalleryCtx):Promise<GalleryStats|null>{
  try{return await first(g.db,"SELECT signature,updated_at,payload FROM "+A+" WHERE scope=?",g.scope)||null}
  catch(e){if(missingTable(e))return null;throw e}
}
export const galleryStatsRefreshSql="INSERT INTO "+A+"(scope,signature,updated_at,payload) SELECT ?,?,?,COALESCE((SELECT json_group_array(json_object('month',month,'kind',kind,'n',n,'tagged',tagged)) FROM (SELECT substr(day,1,7) AS month,kind,COUNT(*) AS n,COALESCE(SUM(CASE WHEN tag<>'' THEN 1 ELSE 0 END),0) AS tagged FROM "+I+" WHERE scope=? AND epoch>=? GROUP BY month,kind ORDER BY month DESC)),'[]') WHERE NOT EXISTS (SELECT 1 FROM "+A+" WHERE scope=? AND (signature=? OR updated_at>?)) ON CONFLICT(scope) DO UPDATE SET signature=excluded.signature,updated_at=excluded.updated_at,payload=excluded.payload"
// One atomic SQL statement checks the durable freshness fence before doing
// the aggregate. Concurrent ticks cannot both publish the same refresh.
async function refreshGalleryStats(g:GalleryCtx,s:any){
  const now=Date.now(),signature=[s.epoch,s.pages,s.done,s.revision].join(":")
  const previous=await readGalleryStats(g)
  if(previous&&(previous.signature===signature||now-Number(previous.updated_at)<STATS_INTERVAL))return
  if(!previous)await g.db.prepare(statsSchema).run()
  const sql=galleryStatsRefreshSql
  const result=await query(g.db,sql,g.scope,signature,now,g.scope,visibleEpoch(s),g.scope,signature,now-STATS_INTERVAL).run()
  console.log("[GalleryStats] refreshed",{rows_read:result?.meta?.rows_read||0,rows_written:result?.meta?.rows_written||0})
}
function decodeStats(s:GalleryStats|null):any[]{
  try{const value=JSON.parse(s?.payload||"[]");return Array.isArray(value)?value:[]}catch{return []}
}
async function reserveHeavyRead(g:GalleryCtx){
  const snapshot=await readGalleryStats(g),count=decodeStats(snapshot).reduce((n,m)=>n+Number(m.n||0),0)
  const reserve=Math.max(60000,Math.ceil(count*6)),day=utcDay()
  if(reserve>HEAVY_READ_BUDGET)return null
  const sql="INSERT INTO "+R+"(day,units) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET units=units+excluded.units WHERE units+excluded.units<=?"
  let result:any
  try{result=await query(g.db,sql,day,reserve,HEAVY_READ_BUDGET).run()}
  catch(e){if(!missingTable(e))throw e;await g.db.prepare(readBudgetSchema).run();result=await query(g.db,sql,day,reserve,HEAVY_READ_BUDGET).run()}
  return result?.meta?.changes?{day,reserve}:null
}
async function reconcileHeavyRead(g:GalleryCtx,claim:{day:string;reserve:number},actual:number){
  await query(g.db,"UPDATE "+R+" SET units=MAX(0,units+?) WHERE day=?",actual-claim.reserve,claim.day).run().catch(()=>{})
}
// The stream index serves a single ordered date range; never rely on planner
// selection when epoch and date indexes compete.
export function galleryRecentSql(cols:string){return "SELECT "+cols+" FROM "+I+" INDEXED BY private_gallery_stream WHERE scope=? AND +epoch>=? ORDER BY day DESC,fid ASC LIMIT 64"}
galleryMemoryRouter.get("/feed",async(c)=>{
  try{
    const g=await context(c);if(!g)return fail(c,"此相册索引仅支持已授权的私人夸克 TV 根目录。",403)
    const s=await getState(g)
    if(!s)return ok(c,{pages:0,done:false,remaining_today:0,total:0,tagged:0,months:[],cards:[],epoch:1,revision:0})
    const day=String(c.req.query("day")||"").match(/^(19|20)\d{2}-\d{2}-\d{2}$/)?.[0]||utcDay()
    const nonce=String(c.req.query("seed")||"0").slice(0,32),seed=day+":"+nonce
    const pivot=stableHash(seed)
    const year=Number(day.slice(0,4)),ann=[1,2,3,4,5].map(i=>String(year-i)+day.slice(4))
    const minEpoch=visibleEpoch(s)
    const groupCols="fid,folder,day,kind,tag,shuffle,CASE WHEN thumb_enc<>'' THEN '1' ELSE '' END AS thumb_enc"
    const [recent,after,before,anniversaryParts,snapshot]=await Promise.all([
      rows(g.db,galleryRecentSql(groupCols),g.scope,minEpoch),
      sampleShuffle(g,s,groupCols,pivot,true,112),
      sampleShuffle(g,s,groupCols,pivot,false,64),
      Promise.all(ann.map(day=>rows(g.db,"SELECT "+groupCols+" FROM "+I+" INDEXED BY private_gallery_stream WHERE scope=? AND day=? AND +epoch>=? ORDER BY fid ASC LIMIT 32",g.scope,day,minEpoch))),
      readGalleryStats(g)
    ])
    const anniversary=anniversaryParts.flat().slice(0,32)
    const statsRevision=snapshot?g.scope.slice(0,16)+":"+snapshot.signature:""
    const months=snapshot&&c.req.query("stats_rev")!==statsRevision?decodeStats(snapshot):null
    const groups=buildMemoryGroups(recent,after.concat(before),anniversary,seed)
    // Homepage serializes only one cover per group. Other thumbnails and signed
    // file links are fetched lazily when the virtual memory folder is opened.
    const coverIds=groups.map(group=>group.items[0].fid)
    const covers=coverIds.length?await rowsByFids(g,minEpoch,coverIds):[]
    const coverMap=new Map((await serialize(c,g,covers,minEpoch)).map(f=>[f.id,f]))
    const cards=groups.map(group=>({id:group.id,title:group.title,subtitle:group.subtitle,count:group.items.length,ids:group.items.map(f=>f.fid),cover:coverMap.get(group.items[0].fid)||null}))
    return ok(c,{...publicState(s),stats_revision:statsRevision,stats_ready:!!snapshot,total:months?months.reduce((n,m)=>n+Number(m.n||0),0):null,tagged:months?months.reduce((n,m)=>n+Number(m.tagged||0),0):null,months:months?months.map(m=>({month:m.month,kind:m.kind,count:Number(m.n)})):null,cards})
  }catch(e){return galleryFailure(c,e,"暂时无法读取相册索引，请稍后重试。")}
})
galleryMemoryRouter.post("/memory-items",async(c)=>{
  try{
    const g=await context(c);if(!g)return fail(c,"无权访问回忆。",403)
    const body=await c.req.json().catch(()=>({}))
    if(!Array.isArray(body.ids)||body.ids.length<1||body.ids.length>32||!body.ids.every(safeFid))return fail(c,"无效的回忆文件列表。")
    const ids=[...new Set<string>(body.ids)],s=await getState(g)
    if(!s)return ok(c,{items:[]})
    const items=await rowsByFids(g,visibleEpoch(s),ids)
    const byId=new Map(items.map(f=>[f.fid,f]))
    return ok(c,{items:await serialize(c,g,ids.map(id=>byId.get(id)).filter(Boolean),visibleEpoch(s))})
  }catch(e){return galleryFailure(c,e,"暂时无法读取回忆，请稍后重试。")}
})
// Limited, authenticated byte transport ONLY for compatible image decoding
// when the original CDN disallows browser CORS. Never buffer or store originals
// on the Worker. The URL is produced by the validated Quark driver, not input.
const MAX_COMPAT_BYTES=32*1024*1024
async function compatImageBytes(c:any,initial:string){
  let url=initial
  const signal=AbortSignal.timeout(45000)
  for(let hop=0;hop<4;hop++){
    const secure=safeThumb(url)
    if(!secure)throw Error("IMAGE_URL")
    assertSafeUrl(secure,"Gallery image byte transport")
    const res=await fetch(secure,{method:"GET",redirect:"manual",cache:"no-store",signal,headers:{Accept:"image/*,application/octet-stream"}})
    if(res.status>=300&&res.status<400){
      const next=res.headers.get("location");await res.body?.cancel().catch(()=>{})
      if(!next)throw Error("IMAGE_REDIRECT")
      url=new URL(next,secure).href;continue
    }
    if(!res.ok||res.status!==200||!res.body){await res.body?.cancel().catch(()=>{});return fail(c,"夸克未返回完整图片，请重试。",502)}
    const length=Number(res.headers.get("content-length")||0)
    if(length>MAX_COMPAT_BYTES||/^text\/html/i.test(res.headers.get("content-type")||"")){await res.body.cancel().catch(()=>{});return fail(c,"图片过大或链接返回非图片内容。",400)}
    let sent=0
    const bounded=res.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){sent+=chunk.byteLength;if(sent>MAX_COMPAT_BYTES)controller.error(Error("IMAGE_SIZE_LIMIT"));else controller.enqueue(chunk)}}))
    return c.body(bounded,200,{"Content-Type":"application/octet-stream","Cache-Control":"no-store, private","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"})
  }
  return fail(c,"夸克图片链接重定向过多。",502)
}
// Private, authenticated link resolution by indexed FID. No recursive listing,
// no public token endpoint, no media proxy, and no bypass of protected subtrees.
galleryMemoryRouter.post("/media-link",async(c)=>{
  let stage="INDEX_LOOKUP"
  try{
    const g=await context(c);if(!g)return fail(c,"无权读取相册。",403)
    const body=await c.req.json().catch(()=>({}))
    if(!safeFid(body.fid)||typeof body.path!=="string")return fail(c,"无效的媒体标识。")
    if(g.hasProtectedSubtree||!!Number(g.storage.web_proxy)||String(g.storage.webdav_policy||"302_redirect")!=="302_redirect")return fail(c,"此挂载使用原有路径验证。",409)
    const s=await getState(g);if(!s)return fail(c,"媒体索引尚未建立。",404)
    const f=await first(g.db,"SELECT fid,full_path,name,kind,size,duration_seconds FROM "+I+" WHERE scope=? AND fid=? AND +epoch>=?",g.scope,body.fid,visibleEpoch(s))
    if(!f||!g.allowed(f.full_path)||f.full_path!==body.path)return fail(c,"媒体已移动、删除或需要重新同步。",404)
    const bytesMode=body.mode==="image-bytes",streamMode=body.mode==="stream"
    if(bytesMode&&(f.kind!=="image"||!/\.(heic|heif|hif|tiff?)$/i.test(f.name)||Number(f.size)<=0||Number(f.size)>MAX_COMPAT_BYTES))return fail(c,"图片超过本地兼容预览限制或格式不支持。",400)
    if(streamMode&&f.kind!=="video")return fail(c,"仅视频可请求流媒体。",400)
    stage="QUARK_LINK"
    const driver=await getDriver(g.storage.driver,g.storage)
    if(!(driver instanceof DriverQuarkUcTv))return fail(c,"存储配置已变化。",409)
    const url=await driver.getIndexedMediaUrl(f.fid,f.kind==="video"&&Number(f.size)>0,streamMode)
    const secure=safeThumb(url);if(!secure)return fail(c,"夸克未返回可用的 HTTPS 媒体链接。",502)
    assertSafeUrl(secure,"Gallery media link",getTrustedHosts(g.storage.addition,c.env))
    if(bytesMode){stage="IMAGE_BYTES";return await compatImageBytes(c,secure)}
    return ok(c,{url:secure,duration:Number(f.duration_seconds||0)})
  }catch(e:any){
    const raw=String(e?.diagnostic||"")
    const diagnostic=/^[A-Z0-9_]{1,100}$/.test(raw)?raw:stage==="INDEX_LOOKUP"?"INDEX_UNAVAILABLE":"MEDIA_LINK_UNAVAILABLE"
    console.warn("[GalleryMedia] "+diagnostic)
    return fail(c,stage==="INDEX_LOOKUP"?"索引暂时繁忙，请重试 ("+diagnostic+")":"夸克直链暂时不可用，请重试 ("+diagnostic+")",stage==="INDEX_LOOKUP"?503:502)
  }
})
// Resolve one potential companion only when a still image is opened.
galleryMemoryRouter.post("/live-pair",async(c)=>{
  try{
    const g=await context(c);if(!g)return fail(c,"无权访问实况照片。",403)
    const body=await c.req.json().catch(()=>({}))
    if(!safeFid(body.fid))return fail(c,"无效的照片 ID。")
    const s=await getState(g);if(!s)return ok(c,{item:null})
    const epoch=visibleEpoch(s)
    const still=await first(g.db,"SELECT fid,folder,full_path,name,kind,day FROM "+I+" WHERE scope=? AND fid=? AND +epoch>=?",g.scope,body.fid,epoch)
    if(!still||!g.allowed(still.full_path)||still.kind!=="image"||!liveStillStem(still.name))return ok(c,{item:null})
    const candidates=await rows(g.db,"SELECT * FROM "+I+" INDEXED BY private_gallery_live_mov WHERE scope=? AND folder=? AND kind='video' AND name COLLATE NOCASE=? AND +epoch>=? AND day=? AND size>0 AND size<=104857600 LIMIT 3",g.scope,still.folder,liveStillStem(still.name)+".mov",epoch,still.day)
    const pair=chooseLivePair(still,candidates.filter(f=>g.allowed(f.full_path)))
    return ok(c,{item:pair?(await serialize(c,g,[pair]))[0]:null,match:pair?"same-name-and-day":null})
  }catch(e){return galleryFailure(c,e,"暂时无法检查实况照片。")}
})
// Fixed sort expressions, all client inputs bound; stable keyset cursor avoids OFFSET scans.
export function timelineQuery(params: {sort?:string;kind?:string;month?:string;q?:string;key?:string;fid?:string}) {
  const sort=["new","old","name","size"].includes(params.sort||"")?params.sort:"new"
  const col=sort==="name"?"name COLLATE NOCASE":sort==="size"?"size":sort==="old"?"CASE WHEN day='0000-00-00' THEN '9999-99-99' ELSE day END":"day"
  const desc=sort==="new"||sort==="size"
  const filters:string[]=[],args:any[]=[]
  if(params.kind==="image"||params.kind==="video"){filters.push("kind=?");args.push(params.kind)}
  if(params.month==="0000-00"){filters.push("day='0000-00-00'")}
  else if(/^(19|20)\d{2}-(0[1-9]|1[0-2])$/.test(params.month||"")) {
    const month=params.month!,y=Number(month.slice(0,4)),m=Number(month.slice(5))
    const next=(m===12?y+1:y)+"-"+String(m===12?1:m+1).padStart(2,"0")
    filters.push("day>=? AND day<?");args.push(month+"-01",next+"-01")
  }
  const q=String(params.q||"").trim().slice(0,120)
  if(q){filters.push("(instr(lower(name),lower(?))>0 OR instr(lower(folder),lower(?))>0 OR instr(lower(tag),lower(?))>0)");args.push(q,q,q)}
  const baseWhere=filters.length?" AND "+filters.join(" AND "):"",baseArgs=args.slice()
  const key=params.key
  let cursor:{key:string;fid:string}|null=null
  if(safeFid(params.fid)&&typeof key==="string"&&key.length<=512){
    const valid=sort==="size"?/^\d{1,16}$/.test(key):sort==="name"?key.length>0:/^\d{4}-\d{2}-\d{2}$/.test(key)
    if(valid){cursor={key,fid:params.fid!};const value=sort==="size"?Number(key):key;filters.push("("+col+(desc?"<?":">?")+" OR ("+col+"=? AND fid>?))");args.push(value,value,params.fid)}
  }
  return {sort,baseWhere,baseArgs,cursor,where:filters.length?" AND "+filters.join(" AND "):"",args,order:col+(desc?" DESC":" ASC")+",fid ASC",key:(f:IndexedMedia)=>String(sort==="name"?f.name:sort==="size"?f.size:sort==="old"&&f.day==="0000-00-00"?"9999-99-99":f.day)}
}
galleryMemoryRouter.get("/timeline",async(c)=>{
  try{
    const g=await context(c);if(!g)return fail(c,"无权访问相册索引。",403)
    const s=await getState(g)
    if(!s)return ok(c,{items:[],next:null,epoch:1})
    const plan=timelineQuery({sort:c.req.query("sort"),kind:c.req.query("kind"),month:c.req.query("month"),q:c.req.query("q"),key:c.req.query("key")||c.req.query("day"),fid:c.req.query("fid")})
    const kind=c.req.query("kind")
    const indexed=kind==="image"||kind==="video"?"private_gallery_stream_kind":"private_gallery_stream"
    const limit=PAGE_SIZE+1,minEpoch=visibleEpoch(s)
    let items:any[]
    // Other sorts and substring search cannot use the default ordered index.
    // Reserve account-friendly allowance before a potentially wide scan.
    const expensive=plan.sort!=="new"||!!String(c.req.query("q")||"").trim()
    const claim=expensive?await reserveHeavyRead(g):null
    if(expensive&&!claim)return fail(c,"今日高级排序或搜索读取预算已用完。可继续使用最新优先和月份筛选。",429)
    let actual=0,known=true
    const read=async(sql:string,...args:any[])=>{
      const result=await query(g.db,sql,...args).all()
      if(claim){const n=result?.meta?.rows_read;if(typeof n==="number"&&Number.isFinite(n)&&n>=0)actual+=n;else known=false}
      return (result.results||[]) as any[]
    }
    if(plan.sort==="new"){
      const base="SELECT * FROM "+I+" INDEXED BY "+indexed+" WHERE scope=? AND +epoch>=?"+plan.baseWhere
      const args=[g.scope,minEpoch,...plan.baseArgs],order=" ORDER BY day DESC,fid ASC LIMIT "
      if(plan.cursor){
        const same=await read(base+" AND day=? AND fid>?"+order+limit,...args,plan.cursor.key,plan.cursor.fid)
        const rest=same.length<limit?await read(base+" AND day<?"+order+(limit-same.length),...args,plan.cursor.key):[]
        items=same.concat(rest)
      }else items=await read(base+order+limit,...args)
    }else items=await read("SELECT * FROM "+I+" WHERE scope=? AND epoch>=?"+plan.where+" ORDER BY "+plan.order+" LIMIT "+limit,g.scope,minEpoch,...plan.args)
    if(claim&&known)await reconcileHeavyRead(g,claim,actual)
    const page=items.slice(0,PAGE_SIZE),last=page[page.length-1]
    return ok(c,{items:await serialize(c,g,page,visibleEpoch(s)),next:items.length>PAGE_SIZE&&last?{key:plan.key(last),fid:last.fid}:null,epoch:Number(s.epoch)})
  }catch(e){return galleryFailure(c,e,"暂时无法读取照片，请稍后重试。")}
})
