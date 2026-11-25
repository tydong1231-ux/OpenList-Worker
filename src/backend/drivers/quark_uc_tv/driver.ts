import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { DriverQuarkUcTvAddition, QuarkTvFile } from "./types"
import { ClientQuarkUcTv, type QuarkListTiming } from "./util"

const DEFAULT_ROOT = "0"

/** 只读驱动：仅 list + get（下载） */
export class DriverQuarkUcTv implements StorageDriver {
  private client: ClientQuarkUcTv
  private pathCache = new Map<string, { fid: string; until: number }>()

  constructor(
    addition: DriverQuarkUcTvAddition,
    onTokenUpdate?: ConstructorParameters<typeof ClientQuarkUcTv>[1],
  ) {
    this.client = new ClientQuarkUcTv(addition, onTokenUpdate)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async verifyAccountIdentity():Promise<string|null>{return this.client.verifyLogin()}

  private fileToItem(f: QuarkTvFile): FileItem {
    const isDir = f.isdir === 1
    return {
      name: f.filename,
      size: f.size || 0,
      is_dir: isDir,
      modified: f.updated_at
        ? new Date(f.updated_at).toISOString()
        : new Date().toISOString(),
      sign: "",
      type: calcFileType(f.filename, isDir),
      thumb: f.thumbnail_url || "",
      ...(isDir ? { quark_tv_dir_id: f.fid } : {}),
      raw_url: "",
    }
  }

  async list(_virtualPath: string, physicalPath: string, timing?: QuarkListTiming): Promise<FileItem[]> {
    const fid = await this.resolveDirId(physicalPath, timing)
    return this.listByDirectoryId(physicalPath, fid, timing)
  }

  /** Metadata-only index uses a FID from the server-owned scan queue. */
  async getIndexPage(fid: string, page: number, recent = false) { return this.client.getIndexPage(fid, page, recent) }

  /** Only called by the authenticated gallery after a scoped database lookup. */
  async getIndexedMediaUrl(fid: string, isVideo: boolean, preferStream=false) { return this.client.getDownloadUrl(fid,isVideo,preferStream) }

  /** Called only with a server-verified, mount-scoped directory locator. */
  async listByDirectoryId(physicalPath: string, fid: string, timing?: QuarkListTiming): Promise<FileItem[]> {
    const files = await this.client.getFiles(fid, timing)
    const clean = this.cleanPath(physicalPath)
    this.rememberPath(clean, fid)
    for (const f of files) if (f.isdir === 1 && f.fid && f.filename) this.rememberPath(clean ? clean + "/" + f.filename : f.filename, f.fid)
    return files.map((f) => this.fileToItem(f))
  }

  async listFresh(virtualPath: string, physicalPath: string, timing?: QuarkListTiming): Promise<FileItem[]> {
    this.pathCache.clear()
    return this.list(virtualPath, physicalPath, timing)
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    const rawName = parts[parts.length - 1] || "root"
    const parentPath = "/" + parts.slice(0, -1).join("/")
    try {
      const parentId = await this.resolveDirId(parentPath)
      const files = await this.client.getFiles(parentId)
      const file = files.find((f) => f.filename === rawName)
      if (file) {
        const item = this.fileToItem(file)
        if (!item.is_dir) {
          try {
            item.raw_url = await this.client.getDownloadUrl(file.fid, Number(file.category) === 1 && file.size > 0)
          } catch (e: any) {
            item.raw_url_error = e.message
          }
        }
        return item
      }
    } catch {}

    // Fallback: 目录
    try {
      await this.resolveDirId(physicalPath)
      return {
        name: rawName,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    } catch {
      return {
        name: rawName,
        size: 0,
        is_dir: false,
        modified: new Date().toISOString(),
        sign: "",
        type: 0,
        raw_url: "",
      }
    }
  }

  async mkdir(): Promise<void> {
    throw new Error("[QuarkTV] read-only storage")
  }

  async rename(): Promise<void> {
    throw new Error("[QuarkTV] read-only storage")
  }

  async remove(): Promise<void> {
    throw new Error("[QuarkTV] read-only storage")
  }

  async move(): Promise<void> {
    throw new Error("[QuarkTV] read-only storage")
  }

  async copy(): Promise<void> {
    throw new Error("[QuarkTV] read-only storage")
  }

  async put(): Promise<void> {
    throw new Error("[QuarkTV] read-only storage")
  }

  private cleanPath(path: string): string {
    return path.split("/").filter(Boolean).join("/")
  }

  private cachedPath(path: string): string | undefined {
    const entry = this.pathCache.get(path)
    if (!entry) return undefined
    if (entry.until <= Date.now()) { this.pathCache.delete(path); return undefined }
    return entry.fid
  }

  private rememberPath(path: string, fid: string) {
    if (!path || !fid) return
    this.pathCache.delete(path)
    this.pathCache.set(path, { fid, until: Date.now() + 60000 })
    while (this.pathCache.size > 4096) this.pathCache.delete(this.pathCache.keys().next().value!)
  }

  private async resolveDirId(physicalPath: string, timing?: QuarkListTiming): Promise<string> {
    const clean = this.cleanPath(physicalPath)
    if (!clean) return DEFAULT_ROOT
    const hit = this.cachedPath(clean)
    if (hit) return hit
    const parts = clean.split("/")
    let currentId = DEFAULT_ROOT
    // Reuse the longest known ancestor instead of always walking from the root.
    let start = 0
    for (let i = parts.length - 1; i > 0; i--) {
      const prefix = this.cachedPath(parts.slice(0, i).join("/"))
      if (prefix) { currentId = prefix; start = i; break }
    }
    for (let i = start; i < parts.length; i++) {
      const files = await this.client.getFiles(currentId, timing)
      const prefix = parts.slice(0, i).join("/")
      for (const f of files) if (f.isdir === 1 && f.fid && f.filename) this.rememberPath(prefix ? prefix + "/" + f.filename : f.filename, f.fid)
      const target = files.find((f) => f.isdir === 1 && f.filename === parts[i])
      if (!target) throw new Error("[QuarkTV] Directory not found")
      currentId = target.fid
    }
    return currentId
  }
}
