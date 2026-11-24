import assert from "node:assert/strict"
import {test} from "node:test"
import {GALLERY_CRON} from "./gallery-memory"
test("one cron covers 09:00-00:30 CST only",()=>{
 assert.equal(GALLERY_CRON,"0,30 1-16 * * *")
})
