// 夸克/UC TV 版网盘 API 客户端（只读）
import { md5, sha256 } from "../../pkg/crypto"
import {
  DriverQuarkUcTvAddition,
  QuarkTvFile,
  QuarkTvCommonResp,
  QuarkTvFilesData,
  QuarkTvDownloadData,
  QuarkTvStreamingData,
} from "./types"

const UA =
  "Mozilla/5.0 (Linux; U; Android 13; zh-cn; M2004J7AC Build/UKQ1.231108.001) AppleWebKit/533.1 (KHTML, like Gecko) Mobile Safari/533.1"
const DeviceBrand = "Xiaomi"
const Platform = "tv"
const DeviceName = "M2004J7AC"
const DeviceModel = "M2004J7AC"
const BuildDevice = "M2004J7AC"
const BuildProduct = "M2004J7AC"
const DeviceGpu = "Adreno (TM) 550"
const ActivityRect = "{}"

interface Conf {
  api: string
  clientID: string
  signKey: string
  appVer: string
  channel: string
  codeApi: string
}

// 说明：clientID 与 signKey 是夸克/UC 服务端固定的协议参数（签名密钥），
// 并非可申请替换的 OAuth 凭据，删除会导致请求签名失败、驱动不可用，请保持默认值。
const CONFS: Record<"quark" | "uc", Conf> = {
  quark: {
    api: "https://open-api-drive.quark.cn",
    clientID: "d3194e61504e493eb6222857bccfed94",
    signKey: "kw2dvtd7p4t3pjl2d9ed9yc8yej8kw2d",
    appVer: "1.8.2.2",
    channel: "GENERAL",
    codeApi: "https://api.extscreen.com/quarkdrive",
  },
  uc: {
    api: "https://open-api-drive.uc.cn",
    clientID: "5acf882d27b74502b7040b0c65519aa7",
    signKey: "l3srvtd7p42l0d0x1u8d7yc8ye9kki4d",
    appVer: "1.7.2.2",
    channel: "UCTVOFFICIALWEB",
    codeApi: "https://api.extscreen.com/ucdrive",
  },
}

// Safe diagnostic codes contain no upstream URLs, bodies, QR data or credentials.
export class QuarkTvError extends Error {
  constructor(public readonly diagnostic: string, message: string) {
    super(message)
    this.name = "QuarkTvError"
  }
}
// Runtime exception messages may contain URLs or credential values. Return
// only fixed diagnostic categories, never the original exception text.
export function tokenTransportError(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string } }
  const detail = String(err?.name || "") + " " + String(err?.message || "") + " " + String(err?.cause?.code || "")
  if (/TimeoutError|AbortError|timed?\s*out|ETIMEDOUT/i.test(detail)) return "TIMEOUT"
  if (/DNS|ENOTFOUND|EAI_AGAIN|resolve host|name resolution/i.test(detail)) return "DNS"
  if (/TLS|SSL|certificate|handshake|CERT_/i.test(detail)) return "TLS"
  if (/redirect/i.test(detail)) return "REDIRECT"
  if (/ECONNREFUSED|connection refused/i.test(detail)) return "REFUSED"
  if (/ECONNRESET|connection reset|network connection lost/i.test(detail)) return "CONNECTION_LOST"
  if (/disallowed|not allowed|private address|prohibited|blocked/i.test(detail)) return "BLOCKED"
  return "NETWORK"
}
function numericStatus(v: unknown): string {
  return (typeof v === "number" || typeof v === "string") && /^-?\d{1,9}$/.test(String(v)) ? String(v) : "unknown"
}
function objectData(v: any): Record<string, any> {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {}
}

// Accept only explicit account identifiers from the authenticated user-info
// response; never infer identity from a nickname, device, token or file count.
// An unknown response format must fail closed when linking an existing index.
export async function quarkTvAccountFingerprint(response:any,variant:string):Promise<string|null>{
  const data=objectData(response?.data),profile=objectData(data.user_info)
  const sources=[data,profile,objectData(response?.user_info),objectData(response)]
  for(const key of ["user_id","uid","account_id"]){
    const candidates=new Set<string>()
    for(const source of sources){
      const value=source[key]
      const id=typeof value==="string"?value.trim():typeof value==="number"&&Number.isSafeInteger(value)&&value>0?String(value):""
      if(id&&/^[A-Za-z0-9_-]{1,256}$/.test(id)&&!/^0+$/.test(id)&&!/^(null|undefined|unknown|anonymous)$/i.test(id))candidates.add(id)
    }
    if(candidates.size>1)return null
    if(candidates.size===1)return sha256(JSON.stringify(["quark-tv-account-v1",variant,key,[...candidates][0]]))
  }
  return null
}
export interface QuarkListTiming { calls: number; upstream_ms: number }

export class ClientQuarkUcTv {
  private conf: Conf
  private addition: DriverQuarkUcTvAddition
  private accessToken = ""
  private deviceId: string
  private refreshInFlight?: Promise<void>

  constructor(
    addition: DriverQuarkUcTvAddition,
    private readonly onTokenUpdate?: (state: Pick<DriverQuarkUcTvAddition, "refresh_token" | "access_token" | "device_id">) => Promise<void>,
  ) {
    this.addition = addition
    this.accessToken = addition.access_token || ""
    // UI 下拉传入的是 "Quark"/"UC"（首字母大写），协议端固定小写键
    const variantKey = (addition.variant || "quark").toLowerCase()
    this.conf =
      (variantKey === "uc" || variantKey === "quark" ? CONFS[variantKey] : null) ||
      CONFS.quark
    this.deviceId = addition.device_id || crypto.randomUUID().replace(/-/g, "")
    this.addition.device_id = this.deviceId
  }

  async init(): Promise<void> {
    if (!this.addition.refresh_token) {
      throw new Error("[QuarkTV] refresh_token is required")
    }
    // Reuse the persisted access token across isolate restarts. Refresh only
    // when necessary, and save rotated credentials before using them.
    if (!this.accessToken) await this.refreshToken()
    else if (this.onTokenUpdate) await this.onTokenUpdate({ refresh_token: this.addition.refresh_token, access_token: this.accessToken, device_id: this.deviceId })
  }

  private async generateSign(
    method: string,
    pathname: string,
  ): Promise<{ tm: string; token: string; reqId: string }> {
    const tm = String(Date.now())
    const reqId = md5(this.deviceId + tm)
    const token = await sha256(
      `${method}&${pathname}&${tm}&${this.conf.signKey}`,
    )
    return { tm, token, reqId }
  }

  private deviceQuery(): Record<string, string> {
    return {
      app_ver: this.conf.appVer,
      device_id: this.deviceId,
      device_brand: DeviceBrand,
      platform: Platform,
      device_name: DeviceName,
      device_model: DeviceModel,
      build_device: BuildDevice,
      build_product: BuildProduct,
      device_gpu: DeviceGpu,
      activity_rect: ActivityRect,
      channel: this.conf.channel,
    }
  }

  private async request<T = any>(
    pathname: string,
    method: string,
    extraQuery: Record<string, string> = {},
    retried = false,
    allowRefresh = true,
  ): Promise<T> {
    const { tm, token, reqId } = await this.generateSign(method, pathname)
    const qs = new URLSearchParams({
      req_id: reqId,
      access_token: this.accessToken,
      ...this.deviceQuery(),
      ...extraQuery,
    })
    let resp: Response
    try {
      resp = await fetch(`${this.conf.api}${pathname}?${qs.toString()}`, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(12000),
        headers: {
          Accept: "application/json, text/plain, */*",
          "User-Agent": UA,
          "x-pan-tm": tm,
          "x-pan-token": token,
          "x-pan-client-id": this.conf.clientID,
        },
      })
    } catch (e: any) {
      const timeout = e?.name === "TimeoutError" || e?.name === "AbortError"
      throw new QuarkTvError(timeout ? "UPSTREAM_TIMEOUT" : "UPSTREAM_NETWORK", timeout ? "夸克接口请求超时" : "无法连接夸克接口")
    }
    if (resp.status >= 300 && resp.status < 400) {
      // Do not follow redirects containing authentication query parameters.
      throw new QuarkTvError("UPSTREAM_REDIRECT_" + resp.status, "夸克接口返回重定向")
    }
    let data: QuarkTvCommonResp
    try {
      const parsed = await resp.json()
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid JSON")
      data = parsed as QuarkTvCommonResp
    } catch {
      throw new QuarkTvError("UPSTREAM_NON_JSON_" + resp.status, "夸克接口未返回 JSON")
    }
    const errInfo = String(data.error_info || "").toLowerCase()
    const tokenInvalid =
      (data.status === -1 && (data.errno === 10001 || data.errno === 11001)) ||
      errInfo.includes("access token") ||
      errInfo.includes("access_token") ||
      errInfo.includes("token无效") ||
      errInfo.includes("token 无效")
    if (tokenInvalid && allowRefresh) {
      if (retried) throw new Error("[QuarkTV] Authorization expired; please re-authorize the Quark TV mount.")
      await this.refreshToken()
      return this.request<T>(pathname, method, extraQuery, true)
    }
    const status = numericStatus(data.status)
    const errno = numericStatus(data.errno)
    if (!resp.ok || Number(data.status) >= 400 || Number(data.status) < 0 || (data.errno !== undefined && Number(data.errno) !== 0)) {
      const detail = [data.error_info, (data as any).agent_msg].filter(v => typeof v === "string").join(" ").toLowerCase()
      // Only classify recognized upstream descriptions, never echo credentials or raw response bodies.
      if (pathname === "/oauth/code") {
        if (/过期|已失效|expired|expiration/.test(detail)) {
          throw new QuarkTvError("QR_EXPIRED", "夸克授权二维码已过期，请生成新二维码")
        }
        if (/未扫码|未扫描|等待扫码|未确认|等待确认|未授权|pending|not scanned|not confirmed|waiting for/.test(detail)) {
          throw new QuarkTvError("SCAN_PENDING", "等待手机夸克 App 扫码并确认授权")
        }
      }
      const hint = /签名|signature/.test(detail) ? "（签名校验失败）" : /二维码|qrcode|qr code/.test(detail) ? "（二维码会话异常）" : /query.?token|查询令牌/.test(detail) ? "（查询令牌异常）" : /access.?token|访问令牌/.test(detail) ? "（访问令牌异常）" : ""
      throw new QuarkTvError("UPSTREAM_HTTP_" + resp.status + "_STATUS_" + status + "_ERRNO_" + errno, "夸克接口拒绝请求" + hint)
    }
    return data as T
  }

  // Port of OpenList Go quark_uc_tv/getLoginCode and getCode.
  // QR login must not try refreshing an empty access token.
  async startLogin(): Promise<{ qrData: string; queryToken: string; deviceId: string }> {
    const r = await this.request<any>("/oauth/authorize", "GET", {
      auth_type: "code", client_id: this.conf.clientID, scope: "netdisk",
      qrcode: "1", qr_width: "460", qr_height: "460",
    }, false, false)
    // Go's protocol returns the fields at the root; tolerate nested data too.
    const nested = objectData(r.data)
    const qrData = r.qr_data ?? nested.qr_data
    const queryToken = r.query_token ?? nested.query_token
    if (typeof qrData !== "string" || !qrData || typeof queryToken !== "string" || !queryToken) {
      throw new QuarkTvError("QR_FIELDS_MISSING", "夸克接口未返回二维码或授权会话")
    }
    return { qrData, queryToken, deviceId: this.deviceId }
  }

  async completeLogin(queryToken: string): Promise<void> {
    let r: any
    try {
      r = await this.request<any>("/oauth/code", "GET", {
        client_id: this.conf.clientID, scope: "netdisk", query_token: queryToken,
      }, false, false)
    } catch (e) {
      if (e instanceof QuarkTvError && e.diagnostic !== "SCAN_PENDING" && e.diagnostic !== "QR_EXPIRED") {
        throw new QuarkTvError("GET_CODE_" + e.diagnostic, "获取扫码授权码失败：" + e.message)
      }
      throw e
    }
    const code = typeof r.code === "string" ? r.code : objectData(r.data).code
    if (typeof code !== "string" || !code) {
      throw new QuarkTvError("SCAN_PENDING", "请先扫码并确认授权")
    }
    try {
      await this.exchangeToken({ code })
    } catch (e) {
      if (e instanceof QuarkTvError) throw new QuarkTvError("EXCHANGE_" + e.diagnostic, "交换授权凭证失败：" + e.message)
      throw e
    }
  }

  async verifyLogin(): Promise<string|null> {
    try {
      const response=await this.request("/user", "GET", { method: "user_info" })
      return quarkTvAccountFingerprint(response,this.conf===CONFS.uc?"uc":"quark")
    } catch (e) {
      if (e instanceof QuarkTvError) throw new QuarkTvError("VERIFY_" + e.diagnostic, "验证夸克账号失败：" + e.message)
      throw e
    }
  }

  private async refreshToken(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight
    const pending = this.doRefreshToken()
    this.refreshInFlight = pending
    try { await pending } finally { if (this.refreshInFlight === pending) this.refreshInFlight = undefined }
  }

  private async doRefreshToken(): Promise<void> {
    if (!this.addition.refresh_token) throw new Error("[QuarkTV] Missing refresh token.")
    await this.exchangeToken({ refresh_token: this.addition.refresh_token })
  }

  private async exchangeToken(credential: { code: string } | { refresh_token: string }): Promise<void> {
    const { reqId } = await this.generateSign("POST", "/token")
    let resp: Response
    // The upstream Go driver uses HTTP. Only use it with explicit per-mount
    // consent. Never downgrade HTTPS automatically or forward to other hosts.
    const insecure = this.addition.allow_insecure_token_http === true
    const endpoint = new URL(this.conf.codeApi + "/token")
    if (endpoint.hostname !== "api.extscreen.com") throw new QuarkTvError("TOKEN_INVALID_ENDPOINT", "授权服务地址异常")
    if (insecure) endpoint.protocol = "http:"
    try {
      resp = await fetch(endpoint.toString(), {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(12000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ req_id: reqId, ...this.deviceQuery(), ...credential }),
      })
    } catch (e) {
      throw new QuarkTvError("TOKEN_" + (insecure ? "HTTP_" : "HTTPS_") + tokenTransportError(e), "授权服务连接失败，请先使用页面的连接检测，无需重复扫码")
    }
    if (resp.status >= 300 && resp.status < 400) {
      await resp.body?.cancel().catch(() => {})
      throw new QuarkTvError("TOKEN_REDIRECT_" + resp.status, "授权服务返回重定向；为保护凭证，不自动转发")
    }
    const data: any = await resp.json().catch(() => ({}))
    if (!resp.ok || data?.code !== 200)
      throw new QuarkTvError("TOKEN_HTTP_" + resp.status + "_CODE_" + numericStatus(data?.code), "授权服务拒绝交换凭证")
    const d = data.data || {}
    if (!d.access_token || (!d.refresh_token && !this.addition.refresh_token)) {
      throw new QuarkTvError("TOKEN_FIELDS_MISSING", "授权服务未返回完整凭证")
    }
    const next = { access_token: String(d.access_token), refresh_token: String(d.refresh_token || this.addition.refresh_token), device_id: this.deviceId }
    Object.assign(this.addition, next)
    if (this.onTokenUpdate) await this.onTokenUpdate(next)
    this.accessToken = next.access_token
  }

  // One bounded page for the resumable private media index. No binary downloads.
  async getIndexPage(parentFid: string, pageIndex: number, recent = false): Promise<{ files: QuarkTvFile[]; done: boolean; total?:number }> {
    const pageSize = 100
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex > 10000) throw new Error("Invalid page")
    const resp = await this.request<QuarkTvCommonResp>("/file", "GET", {
      method: "list", parent_fid: parentFid, order_by: recent ? "3" : "1",
      desc: recent ? "1" : "0", category: "", source: "", ex_source: "", list_all: "0",
      page_size: String(pageSize), page_index: String(pageIndex),
    })
    const data = resp.data as QuarkTvFilesData | undefined
    if (!Array.isArray(data?.files) || data.files.length > pageSize) throw new Error("Invalid listing")
    const total = Number(data.total_count)
    const hasTotal = data.total_count != null && Number.isSafeInteger(total) && total >= 0
    return { files: data.files, done: data.files.length === 0 || (hasTotal ? pageIndex * pageSize + data.files.length >= total : data.files.length < pageSize),total:hasTotal?total:undefined }
  }

  async getFiles(parentFid: string, timing?: QuarkListTiming): Promise<QuarkTvFile[]> {
    const all: QuarkTvFile[] = []
    let pageIndex = 0
    const pageSize = 100
    const desc = this.addition.order_direction === "asc" ? "0" : "1"
    const orderBy = this.addition.order_by === "file_name" ? "1" : "3"
    while (true) {
      const started = Date.now()
      if (timing) timing.calls++
      const resp = await this.request<QuarkTvCommonResp>("/file", "GET", {
        method: "list",
        parent_fid: parentFid,
        order_by: orderBy,
        desc,
        category: "",
        source: "",
        ex_source: "",
        list_all: "0",
        page_size: String(pageSize),
        page_index: String(pageIndex),
      }).finally(() => { if (timing) timing.upstream_ms += Date.now() - started })
      const data = resp.data as QuarkTvFilesData | undefined
      const files = data?.files || []
      all.push(...files)
      const total = data?.total_count
      if (!files.length || (typeof total === "number" && all.length >= total) || (typeof total !== "number" && files.length < pageSize)) break
      pageIndex++
    }
    return all
  }

  async getDownloadUrl(fid: string, isVideo = false, preferStream = false): Promise<string> {
    if ((preferStream || this.addition.link_method === "streaming") && isVideo) {
      const resp = await this.request<QuarkTvCommonResp>("/file", "GET", {
        method: "streaming",
        group_by: "source",
        fid,
        resolution: "low,normal,high,super,2k,4k",
        support: "dolby_vision",
      })
      const data = resp.data as QuarkTvStreamingData | undefined
      const variants = data?.video_info || []
      const url = (preferStream ? variants.find(v => v.url && ["normal","high"].includes(String(v.resolution)))?.url : undefined) || variants.find(v => v.url)?.url || ""
      if (!url) throw new Error("[QuarkTV] no streaming link found")
      return url
    }
    const resp = await this.request<QuarkTvCommonResp>("/file", "GET", {
      method: "download",
      group_by: "source",
      fid,
      resolution: "low,normal,high,super,2k,4k",
      support: "dolby_vision",
    })
    const data = resp.data as QuarkTvDownloadData | undefined
    if (!data?.download_url) throw new Error("[QuarkTV] empty download url")
    return data.download_url
  }
}
