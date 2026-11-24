const enc = new TextEncoder()
const hex = (data: ArrayBuffer) => Array.from(new Uint8Array(data), n => n.toString(16).padStart(2, "0")).join("")
const bytes = (value: string) => Uint8Array.from(value.match(/../g) || [], n => parseInt(n, 16))
export interface GalleryHintBinding { id: string | number; modified?: string; mount_path?: string; driver?: string }
function payload(storage: GalleryHintBinding, path: string, owner: string, fid: string, exp: number) {
  return enc.encode(JSON.stringify(["openlist-gallery-dir-v1", String(storage.id), String(storage.modified || ""), String(storage.mount_path || ""), String(storage.driver || ""), owner, path, fid, exp]))
}
const validFid = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v)
export async function galleryHintKey(secret: string) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
}
export async function signGalleryHint(key: CryptoKey, storage: GalleryHintBinding, path: string, owner: string, fid: unknown, now = Date.now()): Promise<string> {
  if (!validFid(fid) || !owner || !path.startsWith("/")) return ""
  const exp = Math.floor(now / 1000) + 180
  return exp + "." + fid + "." + hex(await crypto.subtle.sign("HMAC", key, payload(storage, path, owner, fid, exp)))
}
export async function verifyGalleryHint(key: CryptoKey, storage: GalleryHintBinding, path: string, owner: string, hint: unknown, now = Date.now()): Promise<string | undefined> {
  if (typeof hint !== "string" || hint.length > 220 || !owner) return
  const parts = hint.split(".")
  if (parts.length !== 3 || !/^\d{1,12}$/.test(parts[0]) || !validFid(parts[1]) || !/^[0-9a-f]{64}$/.test(parts[2])) return
  const exp = Number(parts[0]), current = Math.floor(now / 1000)
  if (exp < current || exp > current + 180) return
  return await crypto.subtle.verify("HMAC", key, bytes(parts[2]), payload(storage, path, owner, parts[1], exp)) ? parts[1] : undefined
}
