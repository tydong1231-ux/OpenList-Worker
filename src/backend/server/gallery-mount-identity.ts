import { sha256 } from "../pkg/crypto"

// Version bindings are server-owned D1 rows, not user-editable mount fields.
// The seed of a legacy installation is its ORIGINAL modified timestamp.
// Keeping it byte-for-byte preserves all existing scope hashes (including ACLs).
export const GALLERY_MOUNT_IDENTITY_TABLE="private_gallery_mount_identity"
export const GALLERY_MOUNT_IDENTITY_SCHEMA="CREATE TABLE IF NOT EXISTS "+GALLERY_MOUNT_IDENTITY_TABLE+" (storage_id INTEGER NOT NULL, modified TEXT NOT NULL, scope_seed TEXT NOT NULL, account_hash TEXT NOT NULL, PRIMARY KEY(storage_id,modified))"
export type GalleryMountIdentity={scope_seed:string;account_hash:string}
type MountVersion={id:number;modified:string}
const validHash=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v)
function validMount(s:MountVersion){
  return Number.isSafeInteger(s.id)&&s.id>0&&typeof s.modified==="string"&&s.modified.length>0&&s.modified.length<128
}
export async function readGalleryMountIdentity(db:any,storage:MountVersion):Promise<GalleryMountIdentity|null>{
  if(!validMount(storage))return null
  try{
    const row=await db.prepare("SELECT scope_seed,account_hash FROM "+GALLERY_MOUNT_IDENTITY_TABLE+" WHERE storage_id=? AND modified=?").bind(storage.id,storage.modified).first()
    if(!row)return null
    if(typeof row.scope_seed!=="string"||!row.scope_seed||!validHash(row.account_hash))throw Error("GALLERY_IDENTITY_INVALID")
    return {scope_seed:row.scope_seed,account_hash:row.account_hash}
  }catch(e){
    if(/no such table/i.test(String((e as any)?.message||e)))return null
    throw e
  }
}
async function insertBinding(db:any,storage:MountVersion,identity:GalleryMountIdentity){
  if(!validMount(storage)||!identity.scope_seed||!validHash(identity.account_hash))throw Error("GALLERY_IDENTITY_INVALID")
  await db.prepare(GALLERY_MOUNT_IDENTITY_SCHEMA).run()
  await db.prepare("INSERT OR IGNORE INTO "+GALLERY_MOUNT_IDENTITY_TABLE+"(storage_id,modified,scope_seed,account_hash) VALUES(?,?,?,?)").bind(storage.id,storage.modified,identity.scope_seed,identity.account_hash).run()
  const saved=await readGalleryMountIdentity(db,storage)
  if(!saved||saved.scope_seed!==identity.scope_seed||saved.account_hash!==identity.account_hash)throw Error("GALLERY_IDENTITY_CONFLICT")
  return saved
}
// The caller has just verified the currently configured account with its live TV API.
export async function pinGalleryMountIdentity(db:any,storage:MountVersion,accountHash:string){
  const existing=await readGalleryMountIdentity(db,storage)
  if(existing){
    if(existing.account_hash!==accountHash)throw Error("GALLERY_ACCOUNT_MISMATCH")
    return existing
  }
  return insertBinding(db,storage,{scope_seed:storage.modified,account_hash:accountHash})
}
// A new credential generation may inherit the OLD namespace only after a fresh
// verified account ID matches. No media, queue, stats or state rows are rewritten.
export async function linkGalleryMountIdentity(db:any,previous:MountVersion,next:MountVersion,verifiedAccountHash:string){
  if(previous.id!==next.id||previous.modified===next.modified||!validHash(verifiedAccountHash))throw Error("GALLERY_IDENTITY_INVALID")
  const identity=await readGalleryMountIdentity(db,previous)
  if(!identity)throw Error("GALLERY_IDENTITY_UNVERIFIED")
  if(identity.account_hash!==verifiedAccountHash)throw Error("GALLERY_ACCOUNT_MISMATCH")
  return insertBinding(db,next,identity)
}
export async function galleryScopeForMount(db:any,ownerId:unknown,storage:MountVersion,root:string,excluded:string[]){
  const binding=await readGalleryMountIdentity(db,storage)
  const seed=binding?.scope_seed??storage.modified
  return {scope:await sha256(JSON.stringify(["private-gallery-v1",ownerId,storage.id,seed,root,excluded])),binding}
}
