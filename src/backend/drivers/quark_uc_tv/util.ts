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
    const resp = await fetch(`${this.conf.api}${pathname}?${qs.toString()}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(12000),
      headers: {
        Accept: "application/json, text/plain, */*",
        "User-Agent": UA,
        "x-pan-tm": tm,
        "x-pan-token": token,
        "x-pan-client-id": this.conf.clientID,
      },
    })
    const data: QuarkTvCommonResp = await resp
      .json()
      .catch(() => ({ status: -1, errno: -1 }) as any)
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
    if (!resp.ok || data.status >= 400 || (data.errno !== undefined && data.errno !== 0)) {
      throw new Error(`[QuarkTV] upstream request failed (HTTP ${resp.status}, errno ${Number(data.errno) || 0})`)
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
    if (typeof r.qr_data !== "string" || !r.qr_data || typeof r.query_token !== "string" || !r.query_token) {
      throw new Error("[QuarkTV] Authorization response did not contain a QR code.")
    }
    return { qrData: r.qr_data, queryToken: r.query_token, deviceId: this.deviceId }
  }

  async completeLogin(queryToken: string): Promise<void> {
    const r = await this.request<any>("/oauth/code", "GET", {
      client_id: this.conf.clientID, scope: "netdisk", query_token: queryToken,
    }, false, false)
    if (typeof r.code !== "string" || !r.code) {
      throw new Error("[QuarkTV] Scan and confirm before retrying.")
    }
    await this.exchangeToken({ code: r.code })
  }

  async verifyLogin(): Promise<void> {
    await this.request("/user", "GET", { method: "user_info" })
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
    try {
      // No plaintext fallback for authorization credentials.
      resp = await fetch(`${this.conf.codeApi}/token`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(12000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ req_id: reqId, ...this.deviceQuery(), ...credential }),
      })
    } catch {
      throw new Error("[QuarkTV] Secure token exchange endpoint unavailable; please retry.")
    }
    const data: any = await resp.json().catch(() => ({}))
    if (!resp.ok || data?.code !== 200)
      throw new Error("[QuarkTV] Token exchange failed; scan again if authorization expired.")
    const d = data.data || {}
    if (!d.access_token || (!d.refresh_token && !this.addition.refresh_token)) {
      throw new Error("[QuarkTV] Token exchange returned incomplete credentials.")
    }
    const next = { access_token: String(d.access_token), refresh_token: String(d.refresh_token || this.addition.refresh_token), device_id: this.deviceId }
    Object.assign(this.addition, next)
    if (this.onTokenUpdate) await this.onTokenUpdate(next)
    this.accessToken = next.access_token
  }

  async getFiles(parentFid: string): Promise<QuarkTvFile[]> {
    const all: QuarkTvFile[] = []
    let pageIndex = 0
    const pageSize = 100
    const desc = this.addition.order_direction === "asc" ? "0" : "1"
    const orderBy = this.addition.order_by === "file_name" ? "1" : "3"
    while (true) {
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
      })
      const data = resp.data as QuarkTvFilesData | undefined
      const files = data?.files || []
      all.push(...files)
      const total = data?.total_count
      if (!files.length || (typeof total === "number" && all.length >= total) || (typeof total !== "number" && files.length < pageSize)) break
      pageIndex++
    }
    return all
  }

  async getDownloadUrl(fid: string, isVideo = false): Promise<string> {
    if (this.addition.link_method === "streaming" && isVideo) {
      const resp = await this.request<QuarkTvCommonResp>("/file", "GET", {
        method: "streaming",
        group_by: "source",
        fid,
        resolution: "low,normal,high,super,2k,4k",
        support: "dolby_vision",
      })
      const data = resp.data as QuarkTvStreamingData | undefined
      const url = data?.video_info?.find((v) => v.url)?.url || ""
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
