import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import esbuild from "esbuild"

// Build-time exact Apple npm release, no lifecycle scripts and no runtime CDN.
async function buildLivePhotosKit(out){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),"gallery-livephotoskit-"))
  try{
    const result=JSON.parse(execFileSync("npm",["pack","livephotoskit@1.5.6","--ignore-scripts","--json","--pack-destination",temp],{cwd:temp,encoding:"utf8",timeout:60000,env:{...process.env,npm_config_fetch_retries:"1"}}))
    if(result[0]?.name!=="livephotoskit"||result[0]?.version!=="1.5.6"||result[0]?.filename!=="livephotoskit-1.5.6.tgz")throw Error("Unexpected Apple LivePhotosKit package")
    execFileSync("tar",["-xzf",path.join(temp,"livephotoskit-1.5.6.tgz"),"-C",temp],{timeout:10000})
    const pkg=path.join(temp,"package"),manifest=JSON.parse(fs.readFileSync(path.join(pkg,"package.json"),"utf8"))
    if(manifest.name!=="livephotoskit"||manifest.version!=="1.5.6")throw Error("Unexpected LivePhotosKit manifest")
    const entry=path.resolve(pkg,manifest.main||"index.js")
    if(!entry.startsWith(pkg+path.sep)||!fs.existsSync(entry))throw Error("LivePhotosKit entry not found")
    await esbuild.build({stdin:{contents:"import * as kit from "+JSON.stringify(entry)+";window.LivePhotosKit=kit.Player?kit:kit.default;",resolveDir:pkg,sourcefile:"livephotoskit-entry.js"},outfile:path.join(out,"livephotoskit-1.5.6.js"),bundle:true,platform:"browser",format:"iife",target:"es2020",minify:true,legalComments:"eof"})
    const license=["LICENSE.md","LICENSE","LICENSE.txt"].map(n=>path.join(pkg,n)).find(p=>fs.existsSync(p))
    if(license)fs.copyFileSync(license,path.join(out,"livephotoskit-LICENSE.txt"))
    console.log("[gallery] Apple LivePhotosKit 1.5.6 ready (local static asset)")
  }finally{fs.rmSync(temp,{recursive:true,force:true})}
}

// Installed, lockfile-verified image codecs; no runtime dependency on a public CDN.
export async function buildGalleryCodecs(root, dist) {
  const out=path.join(dist,"gallery-codecs")
  fs.mkdirSync(out,{recursive:true})
  const modules=path.join(root,"node_modules")
  const heifRoot=path.join(modules,"libheif-js")
  const heif=path.join(heifRoot,"libheif-wasm","libheif-bundle.js")
  if(!fs.existsSync(heif))throw Error("Pinned libheif browser WASM bundle missing")
  fs.copyFileSync(heif,path.join(out,"libheif-1.19.8.js"))
  fs.copyFileSync(path.join(modules,"hls.js","dist","hls.min.js"),path.join(out,"hls-1.6.16.min.js"))
  await buildLivePhotosKit(out)
  await esbuild.build({entryPoints:[path.join(root,"src/gallery-codecs/image-worker.js")],outfile:path.join(out,"image-worker-v1.js"),bundle:true,platform:"browser",format:"iife",target:"es2020",minify:true,legalComments:"eof"})
  for(const [name,dir] of [["libheif",heifRoot],["utif",path.join(modules,"utif")],["hls",path.join(modules,"hls.js")],["pako",path.join(modules,".pnpm","pako@1.0.11","node_modules","pako")]]){
    const file=["LICENSE","LICENSE.md","LICENSE.txt","license"].map(n=>path.join(dir,n)).find(p=>fs.existsSync(p))
    if(file)fs.copyFileSync(file,path.join(out,name+"-LICENSE.txt"))
  }
  fs.writeFileSync(path.join(out,"NOTICE.txt"),"libheif-js 1.19.8: https://github.com/catdad-experiments/libheif-js (LGPL-3.0)\nUTIF 3.1.0: https://github.com/photopea/UTIF.js (MIT)\nHLS.js 1.6.16: https://github.com/video-dev/hls.js (Apache-2.0)\n")
  console.log("[gallery] Local image and video compatibility assets ready")
}
