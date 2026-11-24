// Metadata only. Never read bytes, infer faces, or treat a category code as a semantic tag.
export const GALLERY_ROOT = "/夸克网盘"
export const safeName = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512 && !v.startsWith(".") && !/[\x00-\x1f\x7f\\/%]/.test(v)
export const safeFid = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v)
export function mediaKind(name: string) {
  if (/\.(jpe?g|png|gif|webp|avif|bmp|heic|heif|tiff?|ico)$/i.test(name)) return "image"
  if (/\.(mp4|m4v|mov|webm|mkv|avi|flv|wmv|ts|m2ts|mpeg|mpg|3gp|ogv|mts|rmvb)$/i.test(name)) return "video"
  return ""
}
function validDay(s: string) {
  if (!/^(19|20)\d{2}-\d{2}-\d{2}$/.test(s)) return ""
  const t = Date.parse(s + "T00:00:00Z")
  return Number.isFinite(t) && new Date(t).toISOString().slice(0,10) === s ? s : ""
}
function dateFromText(value: string): string {
  const m = value.match(/(?:^|[^\d])((?:19|20)\d{2})[-_.年:/ ]?(\d{2})[-_.月:/ ]?(\d{2})(?:日|[^\d]|$)/)
  return m ? validDay(m[1]+"-"+m[2]+"-"+m[3]) : ""
}
function explicitDay(v: unknown): string {
  if (typeof v === "number" || (typeof v === "string" && /^\d{10,13}$/.test(v))) {
    const n = Number(v), ms = n < 1e12 ? n * 1000 : n
    if (!Number.isFinite(ms) || ms < 0 || ms > 4102444800000) return ""
    return validDay(new Date(ms).toISOString().slice(0,10))
  }
  if (typeof v === "string") return dateFromText(v)
  return ""
}
export function mediaDate(f: any, folder: string) {
  for (const v of [f.taken_at, f.capture_time, f.photo_taken_at, f.image_info?.taken_at, f.media_info?.capture_time, f.exif?.DateTimeOriginal]) {
    const day = explicitDay(v); if (day) return { day, date_source:"capture" }
  }
  const named = dateFromText(f.filename || "") || dateFromText(folder)
  if (named) return { day:named, date_source:"name" }
  const cloud = explicitDay(f.created_at) || explicitDay(f.updated_at)
  return { day:cloud || "0000-00-00", date_source:cloud ? "cloud" : "unknown" }
}
export function mediaTags(f: any): string[] {
  const out: string[] = []
  // No documented guarantee that TV listing contains these. Only explicit labels, not arbitrary fields.
  for (const v of [f.tags, f.labels, f.tag_list, f.label_list, f.ai_tags, f.scene_tags, f.photo_tags, f.image_info?.tags, f.image_info?.labels, f.media_info?.tags]) {
    const entries = Array.isArray(v) ? v.slice(0,12) : typeof v === "string" ? [v] : []
    for (const raw of entries) {
      const name = typeof raw === "string" ? raw : typeof raw?.name === "string" ? raw.name : typeof raw?.label === "string" ? raw.label : typeof raw?.tag === "string" ? raw.tag : ""
      const s = name.trim().replace(/[\x00-\x1f\x7f]/g,"").slice(0,48)
      if (s && !/^\d+$/.test(s) && !/^https?:/i.test(s) && !out.includes(s)) out.push(s)
      if (out.length >= 5) return out
    }
  }
  return out
}
export function safeThumb(v: unknown) {
  if (typeof v !== "string" || v.length > 4096) return ""
  try {
    const u = new URL(v)
    return u.protocol === "https:" && !u.username && !u.password ? u.href : ""
  } catch { return "" }
}
export function stableHash(s: string) {
  let h = 2166136261
  for (let i=0;i<s.length;i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
export interface IndexedMedia {
  fid: string; full_path: string; folder: string; name: string; kind: string; day: string; date_source: string; size: number; tag: string; thumb_enc: string; shuffle: number
}
export interface MemoryGroup { id: string; title: string; subtitle: string; items: IndexedMedia[] }
const distinct = (rows: IndexedMedia[]) => [...new Map(rows.map(x=>[x.fid,x])).values()]
export function buildMemoryGroups(recent: IndexedMedia[], sample: IndexedMedia[], anniversary: IndexedMedia[], seed: string): MemoryGroup[] {
  const used = new Set<string>(), groups: MemoryGroup[] = []
  const ordered = (rows: IndexedMedia[]) => distinct(rows).sort((a,b)=>Number(!!b.thumb_enc)-Number(!!a.thumb_enc) || stableHash(seed+a.fid)-stableHash(seed+b.fid))
  const add = (id:string,title:string,subtitle:string,rows:IndexedMedia[],min=2) => {
    const fresh = ordered(rows).filter(x=>!used.has(x.fid)).slice(0,8)
    if (fresh.length < min) return
    for (const x of fresh) used.add(x.fid)
    groups.push({id,title,subtitle,items:fresh})
  }
  add("anniversary","那年此时","历史同月同日 · 按已有日期",anniversary,2)
  const pool=distinct(sample.concat(recent)), tags=new Map<string,IndexedMedia[]>(), folders=new Map<string,IndexedMedia[]>(), months=new Map<string,IndexedMedia[]>()
  for (const f of pool) {
    for (const [key,map] of [[f.tag,tags],[f.folder,folders],[f.day==="0000-00-00"?"":f.day.slice(0,7),months]] as [string,Map<string,IndexedMedia[]>][]) {
      if (!key) continue
      const a=map.get(key)||[];a.push(f);map.set(key,a)
    }
  }
  const choose=(map:Map<string,IndexedMedia[]>,min:number) => [...map].filter(([,v])=>v.filter(x=>!used.has(x.fid)).length>=min).sort((a,b)=>stableHash(seed+a[0])-stableHash(seed+b[0]))[0]
  const tag=choose(tags,3);if(tag)add("tag",tag[0],"夸克返回的标签",tag[1],3)
  const folder=choose(folders,3);if(folder)add("album",folder[0].split("/").filter(Boolean).pop()||"相册精选","同一文件夹",folder[1],3)
  const month=choose(months,3);if(month)add("month",month[0].replace("-"," 年 ")+" 月","一个月份的回忆",month[1],3)
  add("video","动态回忆","视频精选",pool.filter(x=>x.kind==="video"),2)
  add("random","随机发现","跨相册 · 今日精选",sample,1)
  add("recent","最近的片段","按已有媒体日期排序",recent,1)
  return groups.slice(0,5)
}
