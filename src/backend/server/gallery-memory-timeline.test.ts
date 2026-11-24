import assert from "node:assert/strict"
import {test} from "node:test"
import {timelineQuery} from "./gallery-memory"
test("bounded keyset filters, sorting and month rollover",()=>{
 const p=timelineQuery({sort:"new",kind:"video",month:"2026-12",q:"a%' OR 1=1",key:"2026-12-02",fid:"f_1"})
 assert.deepEqual(p.args,["video","2026-12-01","2027-01-01","a%' OR 1=1","a%' OR 1=1","a%' OR 1=1","2026-12-02","2026-12-02","f_1"])
 assert.equal(p.order,"day DESC,fid ASC")
 assert.ok(!p.where.includes("OR 1=1"))
 assert.match(timelineQuery({sort:"old",key:"9999-99-99",fid:"x"}).order,/CASE WHEN/)
 assert.equal(timelineQuery({sort:"size",key:"10",fid:"x"}).args[0],10)
 assert.equal(timelineQuery({sort:"name",key:"a",fid:"x"}).order,"name COLLATE NOCASE ASC,fid ASC")
 assert.equal(timelineQuery({sort:";drop table",month:"2026-13"}).where,"")
})
