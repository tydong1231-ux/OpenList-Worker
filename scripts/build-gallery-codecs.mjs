import fs from "node:fs"
import path from "node:path"
import esbuild from "esbuild"

// Installed, lockfile-verified packages; no runtime dependency on a public CDN.
export async function buildGalleryCodecs(root, dist) {
  const out=path.join(dist,"gallery-codecs")
  fs.mkdirSync(out,{recursive:true})
  const modules=path.join(root,"node_modules")
  const heifRoot=path.join(modules,"libheif-js")
  const heif=path.join(heifRoot,"libheif-wasm","libheif-bundle.js")
  if(!fs.existsSync(heif))throw Error("Pinned libheif browser WASM bundle missing")
  fs.copyFileSync(heif,path.join(out,"libheif-1.19.8.js"))
  fs.copyFileSync(path.join(modules,"hls.js","dist","hls.min.js"),path.join(out,"hls-1.6.16.min.js"))
  await esbuild.build({entryPoints:[path.join(root,"src/gallery-codecs/image-worker.js")],outfile:path.join(out,"image-worker-v1.js"),bundle:true,platform:"browser",format:"iife",target:"es2020",minify:true,legalComments:"eof"})
  for(const [name,dir] of [["libheif",heifRoot],["utif",path.join(modules,"utif")],["hls",path.join(modules,"hls.js")],["pako",path.join(modules,".pnpm","pako@1.0.11","node_modules","pako")]]){
    const file=["LICENSE","LICENSE.md","LICENSE.txt","license"].map(n=>path.join(dir,n)).find(p=>fs.existsSync(p))
    if(file)fs.copyFileSync(file,path.join(out,name+"-LICENSE.txt"))
  }
  fs.writeFileSync(path.join(out,"NOTICE.txt"),"libheif-js 1.19.8: https://github.com/catdad-experiments/libheif-js (LGPL-3.0)\nUTIF 3.1.0: https://github.com/photopea/UTIF.js (MIT)\nHLS.js 1.6.16: https://github.com/video-dev/hls.js (Apache-2.0)\n")
  console.log("[gallery] Local image and video compatibility assets ready")
}
