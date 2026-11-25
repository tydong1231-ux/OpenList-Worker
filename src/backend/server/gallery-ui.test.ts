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


test("compact album keeps sync in menu, sticky filters, saved five-stage grid and clean thumbnails",()=>{
 assert.match(galleryHtml,/id="menu".*id="albumMenuSync".*id="memorySync"/)
 assert.doesNotMatch(galleryHtml,/<h2>回忆 <span>Memories/)
 assert.match(galleryCss,/\.albumfilters\{position:sticky;top:var\(--gallery-top-height/)
 assert.match(galleryJs,/store\("gallery-media-density",value\)/)
 assert.match(galleryJs,/\[1,2,3,4,6\]/)
 assert.match(galleryJs,/memoryPullDistance>=110/)
 assert.doesNotMatch(galleryJs,/addLiveBadge\(/)
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
 // The legacy gesture cleanup still clears an unused tap field; this must not be mistaken for active tap-to-zoom.
 assert.doesNotMatch(galleryJs.replace(/z\.tap\s*=\s*null/g,""),/\bz\.tap\b/)
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


test("appending across a partial date row never moves already loaded photos",()=>{
 const a=galleryJs.indexOf("function makeRows("),b=galleryJs.indexOf("function renderTimelineWindow(",a)
 assert.ok(a>=0&&b>a)
 const layout=new Function('let memPageItems=[],memSort="new",cols=3;function gridColumns(){return cols};'+galleryJs.slice(a,b)+';return (items,c,width)=>{memPageItems=items;cols=c;return makeRows(width)}')()
 const first=Array.from({length:48},(_,i)=>({id:String(i),day:i<46?"2026-11-24":"2026-11-23"}))
 const next=Array.from({length:48},(_,i)=>({id:String(i+48),day:i<16?"2026-11-23":"2026-11-22"}))
 for(const [cols,width] of [[1,390],[2,390],[3,390],[4,390],[6,390],[16,1440]]){
  const old=layout(first,cols,width),fresh=layout(first.concat(next),cols,width)
  const positions=(p:any)=>Object.fromEntries(p.rows.flatMap((r:any)=>(r.items||[]).map((f:any)=>[f.id,r.top])))
  const previous=positions(old),current=positions(fresh)
  for(const id of Object.keys(previous))assert.equal(current[id],previous[id])
  assert.ok(fresh.height>old.height)
 }
})


test("HEIC embedded motion supports standard mpvd and concatenated MOV, not static HEIC or fake signatures",()=>{
 const a=galleryJs.indexOf("function motionBox("),b=galleryJs.indexOf("let livePartner=",a);
 assert.ok(a>=0&&b>a);
 const inspect=new Function(galleryJs.slice(a,b)+";return inspectEmbeddedMotion")();
 const bytes=(...parts:Buffer[])=>Buffer.concat(parts);
 const box=(type:string,...parts:Buffer[])=>{const payload=bytes(...parts),h=Buffer.alloc(8);h.writeUInt32BE(payload.length+8);h.write(type,4,"ascii");return bytes(h,payload)};
 const ftyp=(brand:string)=>box("ftyp",Buffer.from(brand),Buffer.alloc(4),Buffer.from(brand));
 const hdlr=box("hdlr",Buffer.alloc(8),Buffer.from("vide"),Buffer.alloc(12));
 const movie=bytes(ftyp("qt  "),box("mdat",Buffer.from([1,2,3,4])),box("moov",box("trak",box("mdia",hdlr))));
 const image=bytes(ftyp("heic"),box("meta",Buffer.alloc(12)),box("mdat",Buffer.from([1,2,3,4])));
 const ab=(buf:Buffer)=>Uint8Array.from(buf).buffer;
 const wrapped=bytes(image,box("mpvd",movie));
 let result=inspect(ab(wrapped));
 assert.equal(result.kind,"motion");assert.equal(result.stillEnd,image.length);assert.equal(result.videoStart,image.length+8);assert.equal(result.videoEnd,wrapped.length);assert.equal(result.mime,"video/quicktime");
 assert.deepEqual(wrapped.subarray(result.videoStart,result.videoEnd),movie);
 const appended=bytes(image,movie);
 result=inspect(ab(appended));assert.equal(result.kind,"motion");assert.equal(result.videoStart,image.length);assert.equal(result.stillEnd,image.length);
 assert.deepEqual(inspect(ab(image)),{kind:"static"});
 const fake=bytes(ftyp("heic"),box("meta",Buffer.alloc(12)),box("mdat",movie));
 assert.notEqual(inspect(ab(fake)).kind,"motion","never search compressed primary image payload");
 assert.equal(inspect(ab(bytes(image,box("mpvd",ftyp("qt  "),box("mdat",Buffer.from([1])))))).kind,"unknown");
 assert.equal(inspect(ab(wrapped.subarray(0,wrapped.length-1))).kind,"unknown");
 assert.notEqual(inspect(ab(movie)).kind,"motion");
 const audio=bytes(ftyp("isom"),box("mdat",Buffer.from([1])),box("moov",box("trak",box("mdia",box("hdlr",Buffer.alloc(8),Buffer.from("soun"))))));
 assert.notEqual(inspect(ab(bytes(image,box("mpvd",audio)))).kind,"motion");
 const extended=Buffer.alloc(16);extended.writeUInt32BE(1);extended.write("mpvd",4);extended.writeBigUInt64BE(BigInt(movie.length+16),8);
 const wide=bytes(image,extended,movie);result=inspect(ab(wide));assert.equal(result.kind,"motion");assert.equal(result.videoStart,image.length+16);
 const zero=Buffer.alloc(8);zero.write("mdat",4);
 const zeroStill=bytes(ftyp("heic"),box("meta",Buffer.alloc(12)),zero,Buffer.from([1,2,3,4]));
 result=inspect(ab(bytes(zeroStill,movie)));assert.equal(result.kind,"motion");assert.equal(result.stillEnd,zeroStill.length);
 const idatStill=bytes(ftyp("heic"),box("meta",Buffer.alloc(4),box("idat",Buffer.from([1,2,3]))));
 result=inspect(ab(bytes(idatStill,box("mpvd",movie))));assert.equal(result.kind,"motion");assert.equal(result.stillEnd,idatStill.length)
})

test("HEIC motion detection remains lazy, with LIVE only in the photo viewer",()=>{
 assert.doesNotMatch(galleryJs,/addLiveBadge|motionBadgeState/);
 assert.doesNotMatch(galleryCss,/live-tile-badge/);
 assert.match(galleryHtml,/id="liveButton"/);
 assert.match(galleryJs,/inspectEmbeddedMotion\(original\)/);
 assert.match(galleryJs,/original\.slice\(motion\.videoStart,motion\.videoEnd\)/);
 assert.match(galleryJs,/decodeCompatibleImage\(f,url,compat,signal,preparedBytes\)/);
 assert.match(galleryJs,/\/gallery-codecs\/livephotoskit-1\.5\.6\.js/);
 assert.match(galleryJs,/player\.videoSrc=pair\.bytes/);
 assert.match(galleryJs,/player\.showsNativeControls=false/);
 assert.match(galleryJs,/player\.playbackStyle=kit\.PlaybackStyle\.FULL/);
 assert.match(galleryJs,/if\(photoZoom\.hold&&stop&&livePlaying\)stopLive\(\)/);
 assert.match(galleryJs,/cancelPhotoHold\(\);if\(livePlaying\)stopLive\(\)/);
 assert.match(galleryCss,/\.preview \.stage>\.live-surface\{[^}]*pointer-events:none/);
 assert.match(galleryCss,/\.stage \.live-video\{[^}]*object-fit:cover/);
 assert.doesNotThrow(()=>new Script(galleryJs))
})

test("release invalidates pending native playback and revokes embedded media when switching",async()=>{
 const a=galleryJs.indexOf("let livePartner="),b=galleryJs.indexOf("// Gesture math is independent",a);
 assert.ok(a>=0&&b>a);
 const setup='let selected={name:"a.HEIC"},previewGeneration=1,previewAbort={signal:{aborted:false}},photoZoom={scale:3,x:40,y:-80};const revoked=[],created=[],events=[];const nodes={liveButton:{hidden:true,disabled:false,setAttribute(){}},previewHint:{},stage:{classList:{add(){},remove(){}},append(){}}};const $=k=>nodes[k];const document={addEventListener(){},createElement(){return {canPlayType:()=> "maybe"}}};const window={addEventListener(){}};const URL={createObjectURL:()=>"blob:live-test",revokeObjectURL:v=>revoked.push(v)};const photoGeometry=()=>({w:400,h:800,fw:400,fh:700});const photoTransform=z=>"scale("+z.scale+")";const stopPhotoMotion=()=>{};const renderPhotoZoom=()=>{};function el(tag){return {style:{},setAttribute(){},classList:{add(){},remove(){}},append(n){created.push(n)},pause(){events.push("pause")},removeAttribute(){},load(){},remove(){events.push("remove")},play(){events.push("play");return Promise.resolve()}}}let resolveLink;const resolveMediaLink=()=>new Promise(r=>resolveLink=r);';
 const h=new Function(setup+galleryJs.slice(a,b)+';return {reveal:revealLive,start:startLive,stop:stopLive,reset:resetLive,resolve:v=>resolveLink(v),events,created,revoked}')();
 h.reveal({full_path:"/clip.mov"});h.start(true);h.stop();h.resolve("https://example.test/movie.mov");await Promise.resolve();await Promise.resolve();
 assert.equal(h.created.length,0,"released hold cannot attach stale MOV");
 h.reveal({embedded:true,bytes:new ArrayBuffer(8),mime:"video/mp4"});h.start(true);assert.equal(h.created.length,1);
 h.reset();assert.deepEqual(h.revoked,["blob:live-test"]);assert.ok(h.events.includes("pause"));assert.ok(h.events.includes("remove"))
})


test("Quark actual LIVP layout: little endian uuid header and redundant 12 byte footer",()=>{
 const a=galleryJs.indexOf("function motionBox("),b=galleryJs.indexOf("let livePartner=",a)
 const inspect=new Function(galleryJs.slice(a,b)+";return inspectEmbeddedMotion")()
 const box=(type:string,...parts:Buffer[])=>{const payload=Buffer.concat(parts),h=Buffer.alloc(8);h.writeUInt32BE(payload.length+8);h.write(type,4,"ascii");return Buffer.concat([h,payload])}
 const ftyp=(brand:string)=>box("ftyp",Buffer.from(brand),Buffer.alloc(4),Buffer.from(brand))
 const still=Buffer.concat([ftyp("heic"),box("meta",Buffer.alloc(12)),box("mdat",Buffer.alloc(40,7))])
 const mov=Buffer.concat([ftyp("qt  "),box("wide"),box("mdat",Buffer.alloc(64,2)),box("moov",box("trak",box("mdia",box("hdlr",Buffer.alloc(8),Buffer.from("vide"),Buffer.alloc(12)))))])
 const header=Buffer.alloc(16);header.writeUInt32LE(mov.length+16);header.write("uuid",4)
 const footer=Buffer.alloc(12);footer.write("livp");footer.writeUInt32LE(0x1102,4);footer.writeUInt32LE(mov.length,8)
 const original=Buffer.concat([still,header,mov,footer]),ab=(b:Buffer)=>Uint8Array.from(b).buffer
 const result=inspect(ab(original))
 assert.equal(result.kind,"motion");assert.equal(result.container,"quark-livp")
 assert.equal(result.stillEnd,still.length);assert.equal(result.videoStart,still.length+16);assert.equal(result.videoEnd,original.length-12)
 assert.deepEqual(original.subarray(result.videoStart,result.videoEnd),mov)
 const invalid=Buffer.from(original);invalid.writeUInt32LE(mov.length+1,invalid.length-4);assert.notEqual(inspect(ab(invalid)).kind,"motion")
 const invalid2=Buffer.from(original);invalid2.writeUInt32LE(mov.length+17,still.length);assert.notEqual(inspect(ab(invalid2)).kind,"motion")
 const fake=Buffer.concat([ftyp("heic"),box("meta",Buffer.alloc(12)),box("mdat",Buffer.concat([header,mov])),footer]);assert.notEqual(inspect(ab(fake)).kind,"motion")
})
test("indexed thumbnail recovery is lazy and shared for photos and videos",()=>{
 assert.match(galleryJs,/if\(f.id&&f.folder\)return indexedThumbImage\(f,cls,url\)/)
 assert.match(galleryJs,/\/admin\/gallery-memory\/thumbnail-page/)
 assert.match(galleryJs,/galleryThumbCalls.length>=24/)
 assert.match(galleryJs,/applyGalleryThumbResults\(data\?\.items\)/)
 assert.match(galleryJs,/galleryThumbObserver\.observe\(img\)/)
 assert.match(galleryJs,/if\(!video.videoWidth\|\|!video.videoHeight\)/)
 assert.doesNotThrow(()=>new Script(galleryJs))
})


test("Live surface exactly matches portrait and landscape photo geometry at fit and panned zoom",()=>{
 const l=galleryJs.indexOf("function liveSurfaceLayout("),le=galleryJs.indexOf("function ensureLiveSurface(",l)
 const p=galleryJs.indexOf("function photoTransform("),pe=galleryJs.indexOf("function renderPhotoZoom(",p)
 const k=galleryJs.indexOf("function liveKitMatchesPhoto("),ke=galleryJs.indexOf("function stopLive(",k)
 const math=new Function(galleryJs.slice(l,le)+galleryJs.slice(p,pe)+galleryJs.slice(k,ke)+";return {liveSurfaceLayout,photoTransform,photoContainsPoint,liveKitMatchesPhoto}")()
 for(const [w,h,ratio] of [[390,680,9/16],[390,680,3/4],[390,680,16/9],[800,390,9/16],[800,390,16/9]]){
  const fw=Math.min(w,h*ratio),fh=Math.min(h,w/ratio),g={w,h,fw,fh,cx:w/2,cy:h/2}
  for(const z of [{scale:1,x:0,y:0},{scale:3,x:40,y:-75},{scale:5,x:-130,y:92}]){
   const r=math.liveSurfaceLayout(g,z)
   assert.ok(Math.abs(r.width/r.height-ratio)<1e-8)
   assert.equal(r.left+r.width/2,w/2);assert.equal(r.top+r.height/2,h/2)
   assert.equal(r.transform,math.photoTransform(z))
   assert.ok(math.photoContainsPoint(g,z,{x:g.cx+z.x,y:g.cy+z.y}))
   assert.equal(math.photoContainsPoint(g,z,{x:g.cx+z.x+fw*z.scale/2+1,y:g.cy+z.y}),false)
  }
 }
 const g={fw:300,fh:400}
 assert.ok(math.liveKitMatchesPhoto({videoWidth:1920,videoHeight:1440,videoRotation:270},g))
 assert.ok(math.liveKitMatchesPhoto({videoWidth:1440,videoHeight:1920,videoRotation:0},g))
 assert.equal(math.liveKitMatchesPhoto({videoWidth:1920,videoHeight:1440,videoRotation:0},g),false)
 assert.equal(math.liveKitMatchesPhoto({videoWidth:1440,videoHeight:1920,videoRotation:0},{fw:225,fh:400}),false)
 const start=galleryJs.slice(galleryJs.indexOf("function startLive("),galleryJs.indexOf('$("liveButton").onclick='))
 assert.doesNotMatch(start,/settlePhotoZoom\(1|scale\s*=\s*1/)
 const down=galleryJs.slice(galleryJs.indexOf('photoStage.addEventListener("pointerdown"'),galleryJs.indexOf('photoStage.addEventListener("pointermove"'))
 assert.match(down,/livePartner&&photoContainsPoint/)
 assert.doesNotMatch(down,/scale<=1\.01|scale>1\.01/)
})
