import assert from "node:assert/strict"
import { test } from "node:test"
import { DriverQuarkUcTv } from "./driver"
test("listing primes child FIDs and avoids repeated parent queries", async () => {
  const driver = new DriverQuarkUcTv({ refresh_token:"mock" })
  const calls: string[] = []
  ;(driver as any).client = { getFiles: async (fid: string) => {
    calls.push(fid)
    return fid === "0" ? [{fid:"a", filename:"A", isdir:1}] : fid === "a" ? [{fid:"b", filename:"B", isdir:1}] : []
  } }
  await driver.list("/drive", "/")
  await driver.list("/drive/A", "/A")
  await driver.list("/drive/A/B", "/A/B")
  assert.deepEqual(calls, ["0","a","b"])
  await driver.listByDirectoryId("/A/B","b")
  assert.deepEqual(calls, ["0","a","b","b"])
  await driver.listFresh("/drive/A/B","/A/B")
  assert.deepEqual(calls, ["0","a","b","b","0","a","b"])
})
