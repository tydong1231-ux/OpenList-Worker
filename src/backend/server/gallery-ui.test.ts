import { test } from "node:test"
import assert from "node:assert/strict"
import { Script } from "node:vm"
import { galleryHtml, galleryCss, galleryJs } from "./gallery-ui"

test("gallery client script parses and uses existing authenticated APIs", () => {
  assert.doesNotThrow(() => new Script(galleryJs))
  assert.match(galleryHtml, /\/@gallery\.js/)
  assert.match(galleryHtml, /\/@manage/)
  assert.match(galleryJs, /ROOT="\/夸克网盘"/)
  assert.match(galleryJs, /headers\.Authorization=token/)
  assert.match(galleryJs, /"\/fs\/list"/)
  assert.match(galleryJs, /"\/fs\/get"/)
  assert.match(galleryJs, /class VirtualGrid/)
  assert.match(galleryJs, /media\.preload="metadata"/)
  assert.match(galleryCss, /prefers-reduced-motion/)
})


test("compact header has one shared toolbar and no duplicate hero", () => {
  assert.match(galleryHtml, /id="compactBar"/)
  assert.match(galleryHtml, /id="browseToolbar"/)
  assert.equal((galleryHtml.match(/id="searchToggle"/g) || []).length, 1)
  assert.doesNotMatch(galleryHtml, /YOUR COLLECTION/)
  assert.match(galleryCss, /grid-template-areas:"back home crumbs toolbar actions"/)
  assert.match(galleryCss, /grid-template-areas:"back home actions" "toolbar toolbar toolbar"/)
  assert.match(galleryCss, /min-height:44px/)
  assert.doesNotThrow(() => new Script(galleryJs))
})


test("memory and timeline keep original gallery navigation and metadata-only APIs", () => {
  assert.match(galleryHtml, /id="memorySection"/)
  assert.match(galleryHtml, /id="timelineSection"/)
  assert.match(galleryJs, /\/admin\/gallery-memory\/step/)
  assert.match(galleryJs, /\/admin\/gallery-memory\/feed/)
  assert.match(galleryJs, /selected.full_path/)
  assert.doesNotThrow(() => new Script(galleryJs))
})


test("album defaults to indexed feed and renders a virtual continuous timeline",()=>{
 assert.match(galleryHtml,/id="albumTab"/)
 assert.match(galleryHtml,/id="folderTab"/)
 assert.match(galleryHtml,/id="mediaMonth"/)
 assert.match(galleryJs,/if\(location.hash\)showFiles/)
 assert.match(galleryJs,/renderTimelineWindow/)
 assert.match(galleryJs,/Cron owns all automatic sync/)
 assert.match(galleryJs,/memNext/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})


test("browser does not automatically invoke scan steps",()=>{
 assert.match(galleryJs,/memTurbo&&memActive/)
 assert.match(galleryJs,/memorySync"\)\.onclick/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})


test("memory cards navigate to a thumbnail-only virtual folder",()=>{
 assert.match(galleryHtml,/id="memoryFolder"/)
 assert.match(galleryJs,/openMemoryFolder\(card\)/)
 assert.match(galleryJs,/\/admin\/gallery-memory\/memory-items/)
 assert.match(galleryJs,/card\.ids\.slice\(0,32\)/)
 assert.match(galleryJs,/memoryImg\(f,"",false\)/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})


test("preview fits whole photos and videos in a bounded viewport",()=>{
 assert.match(galleryCss,/grid-template-columns:minmax\(0,1fr\);grid-template-rows:minmax\(0,1fr\)/)
 assert.match(galleryCss,/\.preview \.stage>img,\.preview \.stage>video:not\(\.live-video\)\{[^}]*object-fit:contain/)
 assert.match(galleryCss,/\.preview \.stage\.photo-gesture\{overflow:hidden;touch-action:none/)
 assert.match(galleryJs,/photoStage\.classList\.toggle\("zoom-active",z.scale>1.01\)/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})


test("gallery install assets use dedicated same-origin manifest and network-only service worker",()=>{
 assert.match(galleryHtml,/rel="manifest" href="\/@gallery.webmanifest"/)
 assert.match(galleryHtml,/apple-mobile-web-app-capable/)
 assert.match(galleryJs,/beforeinstallprompt/)
 assert.match(galleryJs,/serviceWorker.register/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})


test("compact album keeps sync in menu, sticky filters, saved five-stage grid and live badges",()=>{
 assert.match(galleryHtml,/id="menu".*id="albumMenuSync".*id="memorySync"/)
 assert.doesNotMatch(galleryHtml,/<h2>回忆 <span>Memories/)
 assert.match(galleryCss,/\.albumfilters\{position:sticky;top:var\(--gallery-top-height/)
 assert.match(galleryJs,/store\("gallery-media-density",value\)/)
 assert.match(galleryJs,/\[1,2,3,4,6\]/)
 assert.match(galleryJs,/memoryPullDistance>=110/)
 assert.match(galleryJs,/if\(f.live\)addLiveBadge/)
 assert.doesNotMatch(galleryJs,/已加载 "\+memPageItems/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})


test("album chrome docks filters and media preview uses progressive direct links",()=>{
 assert.match(galleryHtml,/id="albumDock"/)
 assert.doesNotMatch(galleryHtml,/<h2>照片与视频<\/h2>/)
 assert.match(galleryJs,/function setAlbumDock/)
 assert.match(galleryCss,/backdrop-filter:saturate\(165%\) blur\(16px\)/)
 assert.match(galleryJs,/\/admin\/gallery-memory\/media-link/)
 assert.match(galleryJs,/media\.onloadedmetadata/)
 assert.match(galleryJs,/function formatDuration/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})


test("gallery decodes unsupported HEIC and TIFF only on explicit preview",()=>{
 assert.match(galleryJs,/function imageCompatFormat/)
 assert.match(galleryJs,/new Worker\("\/gallery-codecs\/image-worker-v1.js"\)/)
 assert.match(galleryJs,/mode:"image-bytes"/)
 assert.match(galleryJs,/credentials:"omit"/)
 assert.match(galleryJs,/URL.revokeObjectURL/)
 assert.match(galleryJs,/function setVideoSource/)
 assert.match(galleryJs,/RAW 原件请下载查看/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})


test("focal point zoom math and bounded panning",()=>{
 const a=galleryJs.indexOf("function photoClamp("),b=galleryJs.indexOf("const photoStage=",a)
 const math=new Function(galleryJs.slice(a,b)+";return {photoAnchor,photoPose,photoBounds}")()
 const start={s:1,x:0,y:0,cx:80,cy:-40}
 assert.deepEqual(math.photoAnchor(start,2,80,-40),{x:-80,y:40})
 assert.deepEqual(math.photoAnchor(start,2,100,-30),{x:-60,y:50})
 const g={w:400,h:800,fw:400,fh:300}
 assert.deepEqual(math.photoBounds(g,2),{x:200,y:0})
 assert.deepEqual(math.photoPose(g,2,400,120),{s:2,x:200,y:0})
 assert.match(galleryJs,/setPointerCapture/)
 assert.match(galleryJs,/pointercancel/)
 assert.match(galleryJs,/requestAnimationFrame\(renderPhotoZoom\)/)
 assert.doesNotMatch(galleryJs,/img\.ondblclick=/)
 assert.doesNotMatch(galleryJs,/liveSwipeBlockUntil/)
 assert.match(galleryJs,/stats_rev/)
 assert.match(galleryJs,/DB_LIMIT/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})




test("pinch is the only touch zoom; scale always returns continuously to fit",()=>{
 assert.ok(!galleryJs.includes("togglePhotoZoomAt"))
 assert.ok(!galleryJs.includes("z.tap"))
 assert.ok(!galleryJs.includes("img.ondblclick"))
 assert.ok(galleryJs.includes("photoPinchScale(a.s,a.distance,distance)"))
 assert.doesNotThrow(()=>new Script(galleryJs))
 const a=galleryJs.indexOf("function photoClamp("),b=galleryJs.indexOf("const photoStage=",a)
 const math=new Function(galleryJs.slice(a,b)+";return {photoPinchScale,photoPose,photoAnchor}")()
 assert.equal(math.photoPinchScale(1,100,200),2)
 assert.equal(math.photoPinchScale(2.6,200,60),1)
 assert.equal(math.photoPinchScale(1,100,80),1)
 assert.equal(math.photoPinchScale(2,100,200),4)
 const g={w:400,h:800,fw:400,fh:800}
 assert.deepEqual(math.photoPose(g,1,120,-80,true),{s:1,x:0,y:0})
 assert.deepEqual(math.photoAnchor({s:1,x:0,y:0,cx:50,cy:20},2,50,20),{x:-50,y:-20})
})


test("timeline auto paging requires fresh downward movement, never render or completion",()=>{
 const a=galleryJs.indexOf("function createTimelinePagingGate("),b=galleryJs.indexOf("const timelinePagingGate=",a)
 assert.ok(a>=0&&b>a)
 const gate=new Function(galleryJs.slice(a,b)+";return createTimelinePagingGate()")()
 gate.reset(1000)
 assert.equal(gate.advance(1000,-5,true),false,"stationary footer must not load")
 assert.equal(gate.advance(1008,50,true),false,"tiny scroll must not load")
 assert.equal(gate.advance(1020,600,true),false,"new bottom is far away")
 assert.equal(gate.advance(1450,130,true),true,"scrolling to new bottom loads one page")
 gate.reset(1450)
 for(let i=0;i<100;i++)assert.equal(gate.advance(1450,0,true),false,"no cascade with visible footer")
 assert.equal(gate.advance(1400,120,true),false,"upward scroll does not load")
 assert.equal(gate.advance(1420,130,true),true,"fresh downward scroll can re-enter the threshold")
 gate.reset(2000)
 assert.equal(gate.advance(2100,10,false),false,"not eligible while loading or hidden")
 assert.equal(gate.advance(2100,10,true),false,"no stale scroll movement after loading")
 assert.equal(gate.advance(2120,10,true),true)
 assert.match(galleryCss,/html\.gallery-album,html\.gallery-album body\{overflow-anchor:none\}/)
 assert.match(galleryJs,/addEventListener\("scroll",timelineOnScroll,\{passive:true\}\)/)
 assert.doesNotMatch(galleryJs,/maybeMore\(/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})

test("timeline append keeps the existing rows and viewport while a new page is in flight", async()=>{
 const a=galleryJs.indexOf("async function timelineLoad()"),b=galleryJs.indexOf("function mediaTile",a)
 assert.ok(a>=0&&b>a)
 const setup=`
 let memActive=true,memLoading=false,memDone=false,memError=false,memLastError="",memAbort=null;
 let memTimelineGen=1,memNext={key:"2026-11-24",fid:"a"},memPageItems=[{id:"a"}],memSeen=new Set(["a"]),memDataVersion=1;
 let albumMode=true,memFolderActive=false,resolve,rendered=0,resets=0,scheduled=0;
 const calls=[];
 const window={scrollY:600,scrollTo(x,y){calls.push(y);this.scrollY=y}};
 const $=()=>({open:false});
 const timelineParams=()=>({toString:()=>""}),timelineStatus=()=>{},authFailure=()=>false;
 const timelineScrollY=()=>window.scrollY,resetTimelinePaging=()=>{resets++},schedule=()=>{scheduled++};
 const galleryRead=()=>new Promise(r=>resolve=r);
 function renderTimelineWindow(){rendered++;window.scrollY+=700}
 `
 const h=new Function(setup+galleryJs.slice(a,b)+`;return {
  load:timelineLoad,finish:(d)=>resolve(d),scroll:y=>window.scrollY=y,
  snapshot:()=>({ids:memPageItems.map(f=>f.id),next:memNext,loading:memLoading,scroll:window.scrollY,rendered,resets,scheduled,calls})
 }`)()
 const pending=h.load()
 h.scroll(850)
 await h.load() // in-flight lock must reject a second call
 h.finish({items:[{id:"a"},{id:"b"},{id:"c"}],next:{key:"2026-11-23",fid:"c"}})
 await pending
 assert.deepEqual(h.snapshot(),{ids:["a","b","c"],next:{key:"2026-11-23",fid:"c"},loading:false,scroll:850,rendered:1,resets:1,scheduled:1,calls:[850]})
})
