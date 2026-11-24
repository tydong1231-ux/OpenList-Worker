import assert from "node:assert/strict"
import {test} from "node:test"
import {GALLERY_CRON} from "./gallery-memory"
test("initial cron covers 09:00-00:59 CST only",()=>{
 assert.equal(GALLERY_CRON,"* 1-16 * * *")
})
