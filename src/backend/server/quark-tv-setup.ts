import { Hono } from "hono"
import type { Context } from "hono"
import { ClientQuarkUcTv } from "../drivers/quark_uc_tv/util"
import type { DriverQuarkUcTvAddition } from "../drivers/quark_uc_tv/types"
import { getDb, saveDb, isEncryptionReady } from "../internal/model/db"
import { getJwtSecret } from "./middlewares"
import { sha256 } from "../pkg/crypto"

type State = { path: string; deviceId: string; queryToken: string; exp: number; owner: string; existingId?: number; existingModified?: string }
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
export const quarkTvSetupRouter = new Hono()
quarkTvSetupRouter.use("*", async (c, next) => {
  await next()
  c.header("Cache-Control", "no-store, private")
  c.header("Pragma", "no-cache")
})
quarkTvSetupRouter.get("/ready", (c) => c.json({ code: 200, message: "success" }))
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
  try {
    const client = new ClientQuarkUcTv({ variant: "quark", refresh_token: "" })
    const result = await client.startLogin()
    const qr = result.qrData.replace(/^data:image\/(?:jpeg|png);base64,/, "").replace(/\s/g, "")
    if (!/^[A-Za-z0-9+/=]+$/.test(qr) || qr.length > 1000000) throw new Error("Invalid QR image")
    const state = await sealState(c, {
      path, deviceId: result.deviceId, queryToken: result.queryToken, exp: Date.now() + 180000, owner: await owner(c),
      ...(existing ? { existingId: existing.id, existingModified: String(existing.modified || "") } : {}),
    })
    return c.json({ code: 200, data: { qr: "data:image/" + (qr.startsWith("iVBOR") ? "png" : "jpeg") + ";base64," + qr, state, expires_in: 180 } })
  } catch {
    return c.json({ code: 502, message: "夸克 TV 二维码请求失败，请重试。上游接口可能暂时不可用。" }, 502)
  }
})
quarkTvSetupRouter.post("/finish", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  let state: State
  try { state = await openState(c, body.state) } catch { return c.json({ code: 400, message: "二维码已过期或登录状态变化，请重新生成。" }, 400) }
  if (!(await isEncryptionReady(c.env))) return c.json({ code: 503, message: "数据库加密密钥未配置" }, 503)
  const before = await getDb(c.env)
  if (!allowed(matches(before, state.path), state)) return c.json({ code: 409, message: "挂载配置已变化，请重新生成二维码。" }, 409)
  const addition: DriverQuarkUcTvAddition = { variant: "quark", refresh_token: "", device_id: state.deviceId, order_by: "file_name", order_direction: "asc", link_method: "download" }
  const client = new ClientQuarkUcTv(addition)
  try {
    await client.completeLogin(state.queryToken)
    await client.verifyLogin()
  } catch (e: any) {
    const msg = String(e?.message || "")
    return c.json({ code: 400, message: msg.includes("Secure token exchange") ? "授权服务 HTTPS 连接失败。为保护登录凭证，不会降级到明文 HTTP。" : "请确认已用夸克 App 扫码并允许授权；如果失败请重新生成二维码。" }, 400)
  }
  const db = await getDb(c.env)
  const existing = matches(db, state.path)
  if (!allowed(existing, state)) return c.json({ code: 409, message: "挂载配置已变化，请重新授权。" }, 409)
  const storage = {
    ...(existing || { id: Math.max(0, ...(db.storages || []).map((s: any) => Number(s.id) || 0)) + 1, order: 0, remark: "", disable_index: false, enable_sign: true }),
    mount_path: state.path, driver: "QuarkUcTv", addition: JSON.stringify(addition),
    modified: new Date().toISOString(), status: "work", disabled: false,
    web_proxy: false, webdav_policy: "302_redirect", down_proxy_url: "", disable_proxy_sign: false, seed_policy: "off",
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
  return c.json({ code: 200, message: "挂载成功", data: { mount_path: storage.mount_path, id: storage.id } })
})
