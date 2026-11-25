// Exercise real Service Worker + Cache Storage with CORS and opaque images.
// The local upstream uses HTTPS; no production photos, network or account.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import https from "node:https"
import { spawn,execFileSync } from "node:child_process"
import { galleryJs,galleryCss } from "../src/backend/server/gallery-ui.ts"
import { galleryServiceWorker } from "../src/backend/server/gallery-pwa.ts"
const chrome=[process.env.CHROME_BIN,"/usr/bin/google-chrome","/usr/bin/google-chrome-stable","/usr/bin/chromium","/usr/bin/chromium-browser"].find(p=>p&&fs.existsSync(p))
if(!chrome)throw Error("Chrome/Chromium required")
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gallery-thumb-browser-"))
const servers=[]
const listen=server=>new Promise((resolve,reject)=>{servers.push(server);server.once("error",reject);server.listen(0,"127.0.0.1",()=>resolve(server.address().port))})
const pause=ms=>new Promise(r=>setTimeout(r,ms))
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOuoAAAAASUVORK5CYII=","base64")
const counts={cors:0,opaque:0}
try{
 const keyFile=path.join(dir,"key.pem"),certFile=path.join(dir,"cert.pem")
 execFileSync("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",keyFile,"-out",certFile,"-days","1","-subj","/CN=127.0.0.1"],{stdio:"ignore"})
 const tls={key:fs.readFileSync(keyFile),cert:fs.readFileSync(certFile)}
 const upstream=async kind=>{
  const port=await listen(https.createServer(tls,(req,res)=>{
   counts[kind]++;
   if(kind==="cors")res.setHeader("Access-Control-Allow-Origin","*")
   res.setHeader("Cache-Control","no-store");
   if(req.url.includes("expired")){res.writeHead(403,{"Content-Type":"text/plain"});res.end("expired");return}
   res.writeHead(200,{"Content-Type":"image/png","Content-Length":png.length});res.end(png)
  }))
  return "https://127.0.0.1:"+port
 }
 const cors=await upstream("cors"),opaque=await upstream("opaque")
 const a=galleryJs.indexOf("// Thumbnail pixels are cached locally"),b=galleryJs.indexOf("function fileTile(",a)
 if(a<0||b<=a)throw Error("Missing production thumbnail helpers")
 const helpers=galleryJs.slice(a,b)
 const fixture='const token="test-session-one",path="/photos",child=(p,n)=>p+"/"+n;const originalThumbObserver=null,galleryThumbObserver=null;function el(tag,cls){const n=document.createElement(tag);n.className=cls||"";return n}'
 const assertions=
 'const verify=(v,m)=>{if(!v)throw Error(m)},delay=ms=>new Promise(r=>setTimeout(r,ms));'+
 'async function until(fn,m){for(let i=0;i<120;i++){if(await fn())return;await delay(100)}throw Error(m)}'+
 'async function ready(){await navigator.serviceWorker.register("/@gallery-sw.js",{scope:"/"});await navigator.serviceWorker.ready;await until(()=>navigator.serviceWorker.controller,"no service worker controller")}'+
 'async function image(id,url){const img=makeThumbImage({id,name:id+".jpg",size:123,day:"2026-01-01"},"","/photos/"+id+".jpg",()=>img.dataset.failed="1");document.querySelector("#timelineGrid").append(img);await setThumbSource(img,url);await until(()=>img.classList.contains("loaded")||img.dataset.failed,"image not settled");return img}'+
 'async function count(name){return(await(await caches.open(name)).keys()).length}'+
 'const phase=new URLSearchParams(location.search).get("phase"),cors='+JSON.stringify(cors)+',opaque='+JSON.stringify(opaque)+';'+
 '(async()=>{await ready();const suffix=phase==="1"?"/valid":"/expired";const c=await image("readable",cors+suffix),o=await image("opaque",opaque+suffix);verify(c.classList.contains("loaded")&&o.classList.contains("loaded"),"readable/opaque thumbnail must decode");verify(c._thumbRoute&&o._thumbRoute,"must use mapped thumbnail route");'+
 'if(phase==="1"){await until(async()=>await count("gallery-thumb-readable-v1")===1&&await count("gallery-thumb-opaque-v1")===1,"cache writes missing");const keys=await(await caches.open("gallery-thumb-readable-v1")).keys();verify(new URL(keys[0].url).searchParams.get("p")==="1","launch image not prioritized");verify(!keys[0].url.includes("valid")&&!keys[0].url.includes("test-session"),"signed URL/session must not be a cache key")}'+
 'else{const broken=await image("missing",cors+"/expired");verify(!broken.classList.contains("loaded")&&getComputedStyle(broken).opacity==="0","failed image glyph is visible");clearLocalThumbCache();await until(async()=>await count("gallery-thumb-readable-v1")===0&&await count("gallery-thumb-opaque-v1")===0,"logout cache not cleared")}document.body.dataset.test="pass";await fetch("/@test-result",{method:"POST",body:"pass"})})().catch(e=>{document.body.dataset.test="fail";fetch("/@test-result",{method:"POST",body:String(e.stack||e)})});'
 let report=null;
 const port=await listen(http.createServer((req,res)=>{
  const url=new URL(req.url,"http://localhost")
  if(url.pathname==="/@test-result"&&req.method==="POST"){
   let body="";req.on("data",b=>body+=b);req.on("end",()=>{res.writeHead(200);res.end("ok");report?.(body)});return
  }
  if(url.pathname==="/@gallery-sw.js"){res.writeHead(200,{"Content-Type":"application/javascript","Cache-Control":"no-store","Service-Worker-Allowed":"/"});res.end(galleryServiceWorker);return}
  if(url.pathname==="/"){res.writeHead(200,{"Content-Type":"text/html","Cache-Control":"no-store"});res.end("<!doctype html><style>"+galleryCss+"</style><body><div id='timelineGrid'></div><script>"+fixture+helpers+assertions+"</script></body>");return}
  res.writeHead(404);res.end()
 }))
 async function browser(phase){
  // A virtual-time dump can finish before the service worker's real network
  // events fire. Keep Chromium alive and wait for the in-page assertion report.
  const profile=path.join(dir,"profile"),args=["--headless","--no-sandbox","--disable-dev-shm-usage","--ignore-certificate-errors","--disable-gpu","--no-first-run","--window-size=900,900","--remote-debugging-port=0","--user-data-dir="+profile,"http://127.0.0.1:"+port+"/?phase="+phase];
  let stderr="",timer,p;
  try{
   const result=await new Promise((resolve,reject)=>{
    report=resolve;p=spawn(chrome,args);
    p.stderr.on("data",b=>{stderr=(stderr+b).slice(-6000)});p.stdout.resume();
    timer=setTimeout(()=>reject(Error("Browser phase "+phase+" report timeout")),35000);
    p.once("error",reject);p.once("exit",code=>reject(Error("Chrome exited before report: "+code)))
   });
   if(result!=="pass")throw Error("Browser phase "+phase+" failed: "+result);
  }catch(e){throw Error(String(e)+"\n"+stderr)}
  finally{
   clearTimeout(timer);report=null;
   if(p&&p.exitCode===null&&p.signalCode===null){
    // SIGTERM lets Chromium flush its persistent storage before restart.
    p.kill("SIGTERM");
    await new Promise(resolve=>{const kill=setTimeout(()=>{p.kill("SIGKILL")},5000);p.once("close",()=>{clearTimeout(kill);resolve()});if(p.exitCode!==null||p.signalCode!==null){clearTimeout(kill);resolve()}})
   }
  }
 }
 await browser(1);const first={...counts};
 if(first.cors!==1||first.opaque<1||first.opaque>2)throw Error("Unexpected first load requests: "+JSON.stringify(first))
 await pause(300);await browser(2);
 // One intentionally missing image can retry the same expired URL directly.
 // Neither cached thumbnail may re-fetch its now-expired signature.
 if(counts.opaque!==first.opaque||counts.cors-first.cors<1||counts.cors-first.cors>2)throw Error("Unexpected repeat requests: "+JSON.stringify({first,counts}))
 console.log("PASS: real readable and opaque cache survive browser restart; expired URL never needed, launch priority, hidden broken image, logout purge")
}finally{
 for(const server of servers)server.closeAllConnections?.();
 await Promise.all(servers.map(server=>new Promise(r=>server.close(r))))
 fs.rmSync(dir,{recursive:true,force:true})
}
