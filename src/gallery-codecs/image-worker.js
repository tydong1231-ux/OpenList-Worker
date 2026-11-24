import UTIF from "utif"

const MAX_BYTES=32*1024*1024,MAX_PIXELS=32*1024*1024,MAX_EDGE=4096
function dimensions(w,h) {
  if(!Number.isSafeInteger(w)||!Number.isSafeInteger(h)||w<=0||h<=0||w>16384||h>16384||w*h>MAX_PIXELS)throw Error("图像尺寸过大，保留原文件及缩略图")
}
async function heif(bytes) {
  importScripts("./libheif-1.19.8.js")
  let lib=await self.libheif
  if(typeof lib==="function"&&!lib.HeifDecoder)lib=await lib()
  if(lib?.ready)lib=await lib.ready||lib
  if(typeof lib?.HeifDecoder!=="function")throw Error("HEIC 解码器初始化失败")
  const decoder=new lib.HeifDecoder(),images=decoder.decode(new Uint8Array(bytes))
  if(!Array.isArray(images)||!images.length)throw Error("未找到 HEIC 主图像")
  const image=images[0],width=image.get_width(),height=image.get_height()
  dimensions(width,height)
  return await new Promise((resolve,reject)=>image.display({data:new Uint8ClampedArray(width*height*4),width,height},data=>{
    if(!data?.data||data.data.length!==width*height*4)reject(Error("HEIC 解码失败"))
    else resolve({width,height,rgba:new Uint8ClampedArray(data.data.buffer,data.data.byteOffset,data.data.byteLength)})
  }))
}
function tiff(bytes) {
  const data=new Uint8Array(bytes)
  if(data.length<8||!((data[0]===73&&data[1]===73&&data[2]===42&&data[3]===0)||(data[0]===77&&data[1]===77&&data[2]===0&&data[3]===42)))throw Error("仅支持标准 TIFF 图像")
  const pages=UTIF.decode(bytes)
  if(!Array.isArray(pages)||!pages.length)throw Error("TIFF 中没有可用图像")
  const img=pages[0],width=Number(img.t256?.[0]),height=Number(img.t257?.[0])
  dimensions(width,height)
  UTIF.decodeImage(bytes,img)
  const rgba=UTIF.toRGBA8(img)
  if(rgba.length!==width*height*4)throw Error("TIFF 解码失败")
  return {width,height,rgba:new Uint8ClampedArray(rgba.buffer,rgba.byteOffset,rgba.byteLength)}
}
self.onmessage=async e=>{
  try{
    const {format,bytes}=e.data||{}
    if(!(bytes instanceof ArrayBuffer)||!bytes.byteLength||bytes.byteLength>MAX_BYTES)throw Error("原图超过本地预览大小限制")
    const {width,height,rgba}=format==="heif"?await heif(bytes):format==="tiff"?tiff(bytes):(()=>{throw Error("不支持的图片格式")})()
    if(typeof OffscreenCanvas==="function"){
      const c=new OffscreenCanvas(width,height),ctx=c.getContext("2d")
      if(!ctx)throw Error("本地画布不可用")
      ctx.putImageData(new ImageData(rgba,width,height),0,0)
      const scale=Math.min(1,MAX_EDGE/Math.max(width,height))
      let out=c
      if(scale<1){out=new OffscreenCanvas(Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale)));const dst=out.getContext("2d");if(!dst)throw Error("本地画布不可用");dst.imageSmoothingQuality="high";dst.drawImage(c,0,0,out.width,out.height)}
      const blob=await out.convertToBlob({type:"image/webp",quality:.94})
      self.postMessage({blob})
    }else{
      // Older WebKit: main thread only performs a canvas draw, never HEIC decoding.
      const pixels=rgba.slice().buffer
      self.postMessage({width,height,pixels},[pixels])
    }
  }catch(e){self.postMessage({error:String(e?.message||"无法解码图片").slice(0,150)})}
}
