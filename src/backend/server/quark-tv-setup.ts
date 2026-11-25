import { Hono } from "hono"
import type { Context } from "hono"
import { ClientQuarkUcTv, QuarkTvError, tokenTransportError } from "../drivers/quark_uc_tv/util"
import type { DriverQuarkUcTvAddition } from "../drivers/quark_uc_tv/types"
import { getDb, saveDb, isEncryptionReady } from "../internal/model/db"
import { getJwtSecret } from "./middlewares"
import { sha256 } from "../pkg/crypto"
import { getDriver } from "../internal/op/storage"
import { DriverQuarkUcTv } from "../drivers/quark_uc_tv/driver"
import { GALLERY_ROOT } from "./gallery-memory-model"
import { readGalleryMountIdentity, pinGalleryMountIdentity, linkGalleryMountIdentity } from "./gallery-mount-identity"

type State = { path: string; deviceId: string; queryToken: string; exp: number; allowInsecureTokenHttp?: boolean; owner: string; existingId?: number; existingModified?: string }
const enc = new TextEncoder()
const dec = new TextDecoder()
async function stateKey(c: Context) {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode("openlist-quark-tv-qr-v1:" + await getJwtSecret(c)))
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"])
}
const b64 = (a: Uint8Array) => btoa(Array.from(a, n => String.fromCharCode(n)).join(""))
const unb64 = (s: string) => Uint8Array.from(atob(s), ch => ch.charCodeAt(0))
async function sealState(c: Context, state: State): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await stateKey(c), enc.encode(JSON.stringify(state)))
  return b64(iv) + "." + b64(new Uint8Array(encrypted))
}
async function owner(c: Context) { return sha256(c.req.header("Authorization") || "") }
async function openState(c: Context, value: unknown): Promise<State> {
  if (typeof value !== "string" || value.length > 16384) throw new Error("Invalid QR state")
  const parts = value.split(".")
  if (parts.length !== 2) throw new Error("Invalid QR state")
  const state = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(parts[0]) }, await stateKey(c), unb64(parts[1])))) as State
  if (!state.exp || state.exp < Date.now() || state.owner !== await owner(c)) throw new Error("Expired QR state")
  return state
}
function mountPath(value: unknown): string {
  const path = String(value || "/夸克网盘").trim()
  const segments = path.split("/").filter(Boolean)
  if (!segments.length || path.length > 200 || /[\\\u0000-\u001f]/.test(path) || segments.some(s => s === "." || s === "..")) throw new Error("Invalid mount path")
  return "/" + segments.join("/")
}
function isTv(s: any): boolean {
  return ["quarkuctv", "quarktv", "quark_uc_tv"].includes(String(s.driver || "").toLowerCase())
}
function matches(db: any, path: string) {
  return (db.storages || []).find((s: any) => "/" + String(s.mount_path || "").split("/").filter(Boolean).join("/") === path)
}
function allowed(s: any, state: State) {
  return state.existingId === undefined ? !s : s && isTv(s) && s.id === state.existingId && String(s.modified || "") === state.existingModified
}
// Only accept raster QR images; never reflect arbitrary upstream content or URLs.
export function normalizeQrImage(value: string): string {
  let base = value.trim().replace(/^data:image\/(?:jpeg|jpg|png);base64,/i, "").replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/")
  if (!base || base.length > 1000000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base)) throw new QuarkTvError("QR_FORMAT", "二维码图片格式无法识别")
  base = base.replace(/=+$/, "")
  if (base.length % 4 === 1) throw new QuarkTvError("QR_FORMAT", "二维码图片编码无效")
  base += "=".repeat((4 - base.length % 4) % 4)
  const format = base.startsWith("iVBORw0KGgo") ? "png" : base.startsWith("/9j/") ? "jpeg" : ""
  if (!format) throw new QuarkTvError("QR_FORMAT", "二维码图片不是 PNG 或 JPEG")
  return "data:image/" + format + ";base64," + base
}
function diagnostic(e: unknown, fallback: string) {
  return e instanceof QuarkTvError ? e.diagnostic : fallback
}
export const quarkTvSetupRouter = new Hono()
quarkTvSetupRouter.use("*", async (c, next) => {
  await next()
  c.header("Cache-Control", "no-store, private")
  c.header("Pragma", "no-cache")
})
quarkTvSetupRouter.get("/ready", (c) => c.json({ code: 200, message: "success" }))
// Administrator-only fixed-host diagnostics. No QR code, authorization
// code, cookie or refresh/access token is used or returned.
quarkTvSetupRouter.post("/probe", async (c) => {
  const results = await Promise.all(["https", "http"].map(async scheme => {
    const started = Date.now()
    try {
      const response = await fetch(scheme + "://api.extscreen.com/quarkdrive/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      })
      const status = response.status
      // Expose only the protocol and whether the destination is the same host.
      let redirect: string | undefined
      if (status >= 300 && status < 400) {
        try {
          const url = new URL(response.headers.get("Location") || "", scheme + "://api.extscreen.com/quarkdrive/token")
          redirect = url.protocol + (url.hostname === "api.extscreen.com" ? " same-host" : " other-host")
        } catch { redirect = "unknown" }
      }
      await response.body?.cancel().catch(() => {})
      return { protocol: scheme, status, result: status >= 300 && status < 400 ? "REDIRECT" : "REACHABLE", elapsed_ms: Date.now() - started, ...(redirect ? { redirect } : {}) }
    } catch (e) {
      return { protocol: scheme, result: tokenTransportError(e), elapsed_ms: Date.now() - started }
    }
  }))
  return c.json({ code: 200, data: results })
})
quarkTvSetupRouter.post("/start", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  let path: string
  try { path = mountPath(body.mount_path) } catch { return c.json({ code: 400, message: "挂载路径无效" }, 400) }
  if (!(await isEncryptionReady(c.env))) return c.json({ code: 503, message: "数据库加密密钥未配置" }, 503)
  const db = await getDb(c.env)
  const existing = matches(db, path)
  if (existing && (!isTv(existing) || body.reauthorize !== true)) {
    return c.json({ code: 409, message: "挂载路径已存在，请换一个路径；仅夸克 TV 挂载可以重新授权。" }, 409)
  }
  // Only the dedicated same-account QR flow can inherit a gallery namespace.
  // Establish the old identity BEFORE asking for a new authorization.
  if(existing&&path===GALLERY_ROOT&&c.env?.DB){
    try{
      let binding=await readGalleryMountIdentity(c.env.DB,existing)
      if(!binding){
        const driver=await getDriver(existing.driver,existing)
        if(driver instanceof DriverQuarkUcTv){
          const accountHash=await driver.verifyAccountIdentity()
          if(accountHash)binding=await pinGalleryMountIdentity(c.env.DB,existing,accountHash)
        }
      }
      if(!binding)return c.json({code:409,message:"无法验证原夸克账号身份，旧相册索引已保留。为避免串号，不会覆盖授权。请联系维护者。"},409)
    }catch{
      return c.json({code:409,message:"暂时无法确认原相册账号，索引仍保留；请勿删除挂载，稍后重试。"},409)
    }
  }
  let stage = "QR_REQUEST"
  try {
    const client = new ClientQuarkUcTv({ variant: "quark", refresh_token: "" })
    const result = await client.startLogin()
    stage = "QR_FORMAT"
    const qr = normalizeQrImage(result.qrData)
    stage = "QR_STATE_ENCRYPTION"
    const state = await sealState(c, {
      path, deviceId: result.deviceId, queryToken: result.queryToken, exp: Date.now() + 180000, owner: await owner(c), allowInsecureTokenHttp: body.allow_insecure_token_http === true,
      ...(existing ? { existingId: existing.id, existingModified: String(existing.modified || "") } : {}),
    })
    return c.json({ code: 200, data: { qr, state, expires_in: 180 } })
  } catch (e) {
    const reason = diagnostic(e, stage)
    console.warn("[QuarkTV] QR start failed", reason)
    return c.json({ code: 502, message: (e instanceof QuarkTvError ? e.message : "二维码准备失败") + " [" + reason + "]", data: { diagnostic: reason } }, 502)
  }
})
quarkTvSetupRouter.post("/finish", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  let state: State
  try { state = await openState(c, body.state) } catch { return c.json({ code: 400, message: "二维码已过期或登录状态变化，请重新生成。" }, 400) }
  if (!(await isEncryptionReady(c.env))) return c.json({ code: 503, message: "数据库加密密钥未配置" }, 503)
  const before = await getDb(c.env)
  if (!allowed(matches(before, state.path), state)) return c.json({ code: 409, message: "挂载配置已变化，请重新生成二维码。" }, 409)
  const addition: DriverQuarkUcTvAddition = { variant: "quark", refresh_token: "", device_id: state.deviceId, order_by: "file_name", order_direction: "asc", link_method: "download", allow_insecure_token_http: state.allowInsecureTokenHttp === true }
  const client = new ClientQuarkUcTv(addition)
  let verifiedAccountHash:string|null=null
  try {
    await client.completeLogin(state.queryToken)
    verifiedAccountHash=await client.verifyLogin()
  } catch (e: any) {
    const reason = diagnostic(e, "QR_COMPLETE_FAILED")
    if (reason === "SCAN_PENDING") {
      return c.json({ code: 202, message: "等待手机扫码确认", data: { diagnostic: reason } }, 202)
    }
    console.warn("[QuarkTV] QR completion failed", reason)
    const message = e instanceof QuarkTvError ? e.message : "授权未完成，请确认扫码并重试"
    return c.json({ code: 400, message: message + " [" + reason + "]", data: { diagnostic: reason } }, 400)
  }
  const db = await getDb(c.env)
  const existing = matches(db, state.path)
  if (!allowed(existing, state)) return c.json({ code: 409, message: "挂载配置已变化，请重新授权。" }, 409)
  const previousModified=Date.parse(String(existing?.modified||""))
  const modified=new Date(Math.max(Date.now(),Number.isFinite(previousModified)?previousModified+1:0)).toISOString()
  // Preserve mount options on reauthorization; rotate only auth/device fields.
  let savedAddition=addition
  if(existing){
    try{
      const previous=typeof existing.addition==="string"?JSON.parse(existing.addition):existing.addition||{}
      savedAddition={...previous,variant:"quark",refresh_token:addition.refresh_token,access_token:addition.access_token,device_id:addition.device_id,allow_insecure_token_http:addition.allow_insecure_token_http}
    }catch{return c.json({code:409,message:"原挂载配置无法读取，未修改索引或授权。"},409)}
  }
  const storage = {
    ...(existing || { id: Math.max(0, ...(db.storages || []).map((s: any) => Number(s.id) || 0)) + 1, order: 0, remark: "", disable_index: false, enable_sign: true,web_proxy:false,webdav_policy:"302_redirect",down_proxy_url:"",disable_proxy_sign:false,seed_policy:"off" }),
    mount_path: state.path, driver: "QuarkUcTv", addition: JSON.stringify(savedAddition),
    modified, status: "work", disabled: false,
  }
  let indexPreserved=false
  if(state.path===GALLERY_ROOT&&c.env?.DB){
    // Write the version binding before publishing new credentials. A failed
    // config save leaves only an unreachable binding, never a partially moved index.
    try{
      if(existing){
        if(!verifiedAccountHash)return c.json({code:409,message:"夸克未返回可验证的账号 ID，未覆盖旧授权或索引。"},409)
        await linkGalleryMountIdentity(c.env.DB,existing,storage,verifiedAccountHash)
        indexPreserved=true
      }else if(verifiedAccountHash)await pinGalleryMountIdentity(c.env.DB,storage,verifiedAccountHash)
    }catch(e){
      const mismatch=String((e as any)?.message||e).includes("GALLERY_ACCOUNT_MISMATCH")
      return c.json({code:409,message:mismatch?"扫码账号与原相册账号不同，旧授权和索引均未修改。请使用原夸克账号。":"无法安全关联旧索引，授权未覆盖，数据仍然保留。"},409)
    }
  }
  const old = [...(db.storages || [])]
  db.storages = existing ? old.map(s => s.id === existing.id ? storage : s) : [...old, storage]
  try {
    if (!(await saveDb(db, c.env))) throw new Error("save failed")
  } catch {
    db.storages = old
    return c.json({ code: 500, message: "授权成功但数据库保存失败，请重新扫码。" }, 500)
  }
  // No access or refresh token returned to the browser.
  return c.json({ code: 200, message: "挂载成功", data: { mount_path: storage.mount_path, id: storage.id, index_preserved:indexPreserved } })
})
