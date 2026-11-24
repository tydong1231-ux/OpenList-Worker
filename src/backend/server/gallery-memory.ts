import { Hono } from "hono"
import { getDb } from "../internal/model/db"
import { getDriver } from "../internal/op/storage"
import { DriverQuarkUcTv } from "../drivers/quark_uc_tv/driver"
import { getDisableIndex } from "../internal/driver/storageopts"
import { getUserFromContext, getJwtSecret } from "./middlewares"
import { deriveConfigEncryptionKey, encryptConfigValue, decryptConfigValue, sha256 } from "../pkg/crypto"
import { signDownloadPath } from "../pkg/sign"
import { GALLERY_ROOT, safeName, safeFid, mediaKind, mediaDate, mediaTags, safeThumb, stableHash, buildMemoryGroups, type IndexedMedia } from "./gallery-memory-model"

export const galleryMemoryRouter = new Hono()
// Only one Quark page per step. No timers/cron or image/video downloads on the server.
const DAILY_PAGES = 120, MAX_PAGES = 1000, PAGE_SIZE = 40, LEASE_MS = 90000
const S="private_gallery_state", Q="private_gallery_queue", I="private_gallery_items"
const schema = [
  "CREATE TABLE IF NOT EXISTS "+S+" (scope TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 1, pages INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, day TEXT NOT NULL DEFAULT '', day_pages INTEGER NOT NULL DEFAULT 0, lease TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '')",
  "CREATE TABLE IF NOT EXISTS "+Q+" (scope TEXT NOT NULL, epoch INTEGER NOT NULL, fid TEXT NOT NULL, path TEXT NOT NULL, depth INTEGER NOT NULL, page INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(scope,epoch,fid))",
  "CREATE INDEX IF NOT EXISTS private_gallery_queue_next ON "+Q+"(scope,epoch,done,depth,fid)",
  "CREATE TABLE IF NOT EXISTS "+I+" (scope TEXT NOT NULL, epoch INTEGER NOT NULL, fid TEXT NOT NULL, full_path TEXT NOT NULL, folder TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, day TEXT NOT NULL, date_source TEXT NOT NULL, size INTEGER NOT NULL, tag TEXT NOT NULL, thumb_enc TEXT NOT NULL, shuffle INTEGER NOT NULL, PRIMARY KEY(scope,fid))",
  "CREATE INDEX IF NOT EXISTS private_gallery_date ON "+I+"(scope,epoch,day DESC,fid)",
  "CREATE INDEX IF NOT EXISTS private_gallery_shuffle ON "+I+"(scope,epoch,shuffle,fid)",
]
const ok=(c:any,data:any)=>c.json({code:200,message:"success",data})
const fail=(c:any,msg:string,status:400|401|403|409|429|500|503=400)=>c.json({code:status,message:msg,data:null},status)
const norm=(p:any)=>"/"+String(p||"").split("/").filter(Boolean).join("/")
const under=(p:string,root:string)=>root==="/"||p===root||p.startsWith(root+"/")
const utcDay=()=>new Date().toISOString().slice(0,10)
const query=(db:any,sql:string,...params:any[])=>db.prepare(sql).bind(...params)
const rows=async(db:any,sql:string,...params:any[])=>((await query(db,sql,...params).all()).results||[]) as any[]
const first=async(db:any,sql:string,...params:any[])=>await query(db,sql,...params).first() as any

// The ordinary list API lets admins ignore password/read_users; the discovery index
// deliberately excludes *any* protected or hidden subtree so Memory cannot surface it.
// Recompute policy on every request. Changing ACLs or the mount makes old rows unreachable.
async function context(c:any) {
  const user=await getUserFromContext(c)
  if(!user||user.disabled||user.role!==2||user.id==null||norm(user.base_path)!=="/") return null
  const db=c.env?.DB
  if(!db||typeof db.prepare!=="function") return null
  const config=await getDb(c.env)
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
  return {db,storage,scope,allowed,secret:await getJwtSecret(c)}
}
type GalleryCtx=NonNullable<Awaited<ReturnType<typeof context>>>
async function getState(g:GalleryCtx) {return await first(g.db,"SELECT * FROM "+S+" WHERE scope=?",g.scope)}
async function ensure(g:GalleryCtx) {
  let state:any
  try {state=await getState(g)}catch(e:any){if(!/no such table/i.test(String(e?.message||e)))throw e;await g.db.batch(schema.map(sql=>g.db.prepare(sql)));state=await getState(g)}
  if(!state){
    await g.db.batch([
      query(g.db,"INSERT OR IGNORE INTO "+S+"(scope) VALUES(?)",g.scope),
      query(g.db,"INSERT OR IGNORE INTO "+Q+"(scope,epoch,fid,path,depth) SELECT scope,epoch,'0',?,0 FROM "+S+" WHERE scope=? AND pages=0",GALLERY_ROOT,g.scope)
    ])
    state=await getState(g)
  }
  if(state && !state.done && Number(state.pages)===0) await query(g.db,"INSERT OR IGNORE INTO "+Q+"(scope,epoch,fid,path,depth) VALUES(?,?,'0',?,0)",g.scope,state.epoch,GALLERY_ROOT).run()
  return state
}
function publicState(s:any) {
  const remaining=Math.max(0,DAILY_PAGES-(s.day===utcDay()?Number(s.day_pages):0))
  return {pages:Number(s.pages),done:!!s.done,remaining_today:remaining,limited:remaining===0||Number(s.pages)>=MAX_PAGES,error:String(s.error||"")}
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
galleryMemoryRouter.post("/step",async(c)=>{
  const g=await context(c);if(!g)return fail(c,"此相册索引仅支持已授权的私人夸克 TV 根目录。",403)
  const s=await ensure(g)
  if(s.done||publicState(s).limited)return ok(c,{...publicState(s),worked:false})
  const lease=crypto.randomUUID(),now=Date.now(),day=utcDay()
  const claim=await query(g.db,"UPDATE "+S+" SET lease=?,lease_until=?,day_pages=CASE WHEN day=? THEN day_pages+1 ELSE 1 END,day=?,error='' WHERE scope=? AND epoch=? AND done=0 AND pages<? AND (day<>? OR day_pages<?) AND (lease='' OR lease_until<?)",lease,now+LEASE_MS,day,day,g.scope,s.epoch,MAX_PAGES,day,DAILY_PAGES,now).run()
  if(!claim.meta?.changes)return ok(c,{...publicState(await getState(g)),worked:false,busy:true})
  try{
    const task=await first(g.db,"SELECT * FROM "+Q+" WHERE scope=? AND epoch=? AND done=0 ORDER BY depth,fid LIMIT 1",g.scope,s.epoch)
    if(!task){
      await query(g.db,"UPDATE "+S+" SET done=1,lease='',lease_until=0 WHERE scope=? AND lease=?",g.scope,lease).run()
      return ok(c,{...publicState(await getState(g)),worked:false})
    }
    if(!safeFid(task.fid)||!g.allowed(task.path))throw new Error("INDEX_SCOPE")
    const driver=await getDriver(g.storage.driver,g.storage)
    if(!(driver instanceof DriverQuarkUcTv))throw new Error("INDEX_DRIVER")
    const result=await driver.getIndexPage(task.fid,Number(task.page))
    const key=await deriveConfigEncryptionKey("private-gallery-v1:"+g.secret)
    const children:any[][]=[],media:any[][]=[]
    const found=await Promise.all(result.files.map(async(f:any)=>{
      if(!safeName(f.filename)||!safeFid(f.fid))return null
      const path=task.path+"/"+f.filename
      if(!g.allowed(path))return null
      if(Number(f.isdir)===1)return {dir:[g.scope,s.epoch,f.fid,path,Number(task.depth)+1]}
      const kind=mediaKind(f.filename);if(!kind)return null
      const date=mediaDate(f,task.path),tag=mediaTags(f)[0]||"",thumb=safeThumb(f.thumbnail_url)
      const encrypted=thumb?await encryptConfigValue(thumb,key):""
      return {media:[g.scope,s.epoch,f.fid,path,task.path,f.filename,kind,date.day,date.date_source,Math.max(0,Math.floor(Number(f.size)||0)),tag,encrypted,stableHash(f.fid)]}
    }))
    for(const v of found){if(v?.dir&&Number(task.depth)<24)children.push(v.dir);if(v?.media)media.push(v.media)}
    const batch=[
      ...bulk(g.db,Q,["scope","epoch","fid","path","depth"],children,"ON CONFLICT(scope,epoch,fid) DO NOTHING",g.scope,lease),
      ...bulk(g.db,I,["scope","epoch","fid","full_path","folder","name","kind","day","date_source","size","tag","thumb_enc","shuffle"],media,"ON CONFLICT(scope,fid) DO UPDATE SET epoch=excluded.epoch,full_path=excluded.full_path,folder=excluded.folder,name=excluded.name,kind=excluded.kind,day=excluded.day,date_source=excluded.date_source,size=excluded.size,tag=excluded.tag,thumb_enc=excluded.thumb_enc,shuffle=excluded.shuffle",g.scope,lease),
      query(g.db,"UPDATE "+Q+" SET page=page+1,done=? WHERE scope=? AND epoch=? AND fid=? AND "+guard,result.done?1:0,g.scope,s.epoch,task.fid,g.scope,lease),
      query(g.db,"UPDATE "+S+" SET pages=pages+1,done=CASE WHEN EXISTS(SELECT 1 FROM "+Q+" WHERE scope=? AND epoch=? AND done=0) THEN 0 ELSE 1 END,lease='',lease_until=0,error='' WHERE scope=? AND lease=?",g.scope,s.epoch,g.scope,lease)
    ]
    await g.db.batch(batch)
    return ok(c,{...publicState(await getState(g)),worked:true,found:media.length})
  }catch(e:any){
    // Never log URL, token, filename, or raw upstream body.
    await query(g.db,"UPDATE "+S+" SET lease='',lease_until=0,error='SCAN_RETRY' WHERE scope=? AND lease=?",g.scope,lease).run().catch(()=>{})
    return fail(c,"索引暂时中断，进度已保留。点击继续重试。",503)
  }
})
galleryMemoryRouter.post("/rescan",async(c)=>{
  const g=await context(c);if(!g)return fail(c,"无权操作相册索引。",403)
  const s=await ensure(g)
  if(!s.done)return fail(c,"请先完成或继续当前扫描。",409)
  const result=await query(g.db,"UPDATE "+S+" SET epoch=epoch+1,pages=0,done=0,error='',lease='',lease_until=0 WHERE scope=? AND epoch=? AND done=1 AND (lease='' OR lease_until<?)",g.scope,s.epoch,Date.now()).run()
  if(!result.meta?.changes)return fail(c,"已有同步任务。",409)
  // Root insertion is also repaired by ensure() if this request is interrupted.
  await query(g.db,"INSERT OR IGNORE INTO "+Q+"(scope,epoch,fid,path,depth) SELECT scope,epoch,'0',?,0 FROM "+S+" WHERE scope=? AND pages=0",GALLERY_ROOT,g.scope).run()
  return ok(c,publicState(await getState(g)))
})
async function serialize(c:any,g:GalleryCtx,items:IndexedMedia[]) {
  const key=await deriveConfigEncryptionKey("private-gallery-v1:"+g.secret)
  return Promise.all(items.filter(f=>g.allowed(f.full_path)).map(async f=>({
    id:f.fid, name:f.name, full_path:f.full_path, folder:f.folder, kind:f.kind, size:f.size,
    day:f.day,date_source:f.date_source,tag:f.tag,is_dir:false,
    thumb:f.thumb_enc?await decryptConfigValue(f.thumb_enc,key).then(safeThumb).catch(()=>""):"",
    sign:await signDownloadPath(c,f.full_path,900),
  })))
}
galleryMemoryRouter.get("/feed",async(c)=>{
  try{
    const g=await context(c);if(!g)return fail(c,"此相册索引仅支持已授权的私人夸克 TV 根目录。",403)
    const s=await ensure(g)
    const day=String(c.req.query("day")||"").match(/^(19|20)\d{2}-\d{2}-\d{2}$/)?.[0]||utcDay()
    const nonce=String(c.req.query("seed")||"0").slice(0,32),seed=day+":"+nonce
    const pivot=stableHash(seed)
    const year=Number(day.slice(0,4)),ann=[1,2,3,4,5].map(i=>String(year-i)+day.slice(4))
    const [recent,after,before,anniversary,count]=await Promise.all([
      rows(g.db,"SELECT * FROM "+I+" WHERE scope=? AND epoch=? ORDER BY day DESC,fid LIMIT 40",g.scope,s.epoch),
      rows(g.db,"SELECT * FROM "+I+" WHERE scope=? AND epoch=? AND shuffle>=? ORDER BY shuffle,fid LIMIT 48",g.scope,s.epoch,pivot),
      rows(g.db,"SELECT * FROM "+I+" WHERE scope=? AND epoch=? AND shuffle<? ORDER BY shuffle,fid LIMIT 16",g.scope,s.epoch,pivot),
      rows(g.db,"SELECT * FROM "+I+" WHERE scope=? AND epoch=? AND day IN (?,?,?,?,?) ORDER BY day DESC,fid LIMIT 24",g.scope,s.epoch,...ann),
      first(g.db,"SELECT COUNT(*) AS n,COALESCE(SUM(CASE WHEN tag<>'' THEN 1 ELSE 0 END),0) AS tagged FROM "+I+" WHERE scope=? AND epoch=?",g.scope,s.epoch)
    ])
    const groups=buildMemoryGroups(recent,after.concat(before),anniversary,seed)
    // Dedup across groups; no original media fetch.
    const cards=await Promise.all(groups.map(async group=>({id:group.id,title:group.title,subtitle:group.subtitle,items:await serialize(c,g,group.items)})))
    return ok(c,{...publicState(s),total:Number(count?.n||0),tagged:Number(count?.tagged||0),cards})
  }catch{return fail(c,"暂时无法读取相册索引，请稍后重试。",503)}
})
galleryMemoryRouter.get("/timeline",async(c)=>{
  try{
    const g=await context(c);if(!g)return fail(c,"无权访问相册索引。",403)
    const s=await ensure(g)
    const cursorDay=String(c.req.query("day")||""),fid=String(c.req.query("fid")||"")
    const hasCursor=/^\d{4}-\d{2}-\d{2}$/.test(cursorDay)&&safeFid(fid)
    const items=await rows(g.db,"SELECT * FROM "+I+" WHERE scope=? AND epoch=? "+(hasCursor?"AND (day<? OR (day=? AND fid>?)) ":"")+"ORDER BY day DESC,fid LIMIT "+(PAGE_SIZE+1),g.scope,s.epoch,...(hasCursor?[cursorDay,cursorDay,fid]:[]))
    const page=items.slice(0,PAGE_SIZE),last=page[page.length-1]
    return ok(c,{items:await serialize(c,g,page),next:items.length>PAGE_SIZE&&last?{day:last.day,fid:last.fid}:null})
  }catch{return fail(c,"暂时无法读取照片，请稍后重试。",503)}
})
