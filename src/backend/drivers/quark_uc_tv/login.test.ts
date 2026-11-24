import assert from "node:assert/strict"
import { test } from "node:test"
import { ClientQuarkUcTv } from "./util"
import type { DriverQuarkUcTvAddition } from "./types"

test("TV authorization exchanges code using the same device and persists rotation", async () => {
  const addition: DriverQuarkUcTvAddition = { variant: "quark", refresh_token: "", device_id: "0123456789abcdef0123456789abcdef", link_method: "streaming" }
  const persisted: any[] = []
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input))
    assert.equal(url.protocol, "https:")
    if (url.pathname === "/token") {
      const body = JSON.parse(String(init?.body))
      assert.equal(body.device_id, addition.device_id)
      calls.push(body.code ? "code" : "refresh")
      if (body.code) assert.equal(body.code, "test-code")
      else assert.equal(body.refresh_token, "refresh-one")
      return Response.json({ code: 200, data: { access_token: body.code ? "access-one" : "access-two", refresh_token: body.code ? "refresh-one" : "refresh-two" } })
    }
    assert.equal(url.searchParams.get("device_id"), addition.device_id)
    if (url.pathname === "/oauth/authorize") {
      assert.equal(url.searchParams.get("qrcode"), "1")
      return Response.json({ status: 200, qr_data: "aGVsbG8=", query_token: "test-query" })
    }
    if (url.pathname === "/oauth/code") {
      assert.equal(url.searchParams.get("query_token"), "test-query")
      return Response.json({ status: 200, code: "test-code" })
    }
    if (url.pathname === "/user") {
      assert.equal(url.searchParams.get("access_token"), "access-one")
      return Response.json({ status: 200, errno: 0 })
    }
    if (url.pathname === "/file") {
      const method = url.searchParams.get("method")
      calls.push(String(method))
      if (method === "download") return Response.json({ status: 200, errno: 0, data: { download_url: "https://example.com/file.pdf" } })
      return Response.json({ status: 200, errno: 0, data: { video_info: [{ url: "https://example.com/video" }] } })
    }
    throw new Error("Unexpected test request")
  }) as typeof fetch
  try {
    const client = new ClientQuarkUcTv(addition, async state => { persisted.push(state) })
    const qr = await client.startLogin()
    assert.equal(qr.queryToken, "test-query")
    assert.equal(qr.deviceId, addition.device_id)
    await client.completeLogin(qr.queryToken)
    await client.verifyLogin()
    assert.equal(addition.refresh_token, "refresh-one")
    assert.equal(persisted[0].access_token, "access-one")
    assert.equal(await client.getDownloadUrl("pdf", false), "https://example.com/file.pdf")
    assert.equal(await client.getDownloadUrl("video", true), "https://example.com/video")
    assert.deepEqual(calls, ["code", "download", "streaming"])
    const restored = new ClientQuarkUcTv(addition)
    await restored.init()
    assert.deepEqual(calls, ["code", "download", "streaming"])
  } finally { globalThis.fetch = original }
})


test("TV authorization tolerates a nested response and reports sanitized upstream errors", async () => {
  const original = globalThis.fetch
  const client = new ClientQuarkUcTv({ variant: "quark", refresh_token: "" })
  try {
    globalThis.fetch = (async () => Response.json({ status: 200, errno: "0", data: { qr_data: "aGVsbG8=", query_token: "nested-test" } })) as typeof fetch
    assert.equal((await client.startLogin()).queryToken, "nested-test")
    globalThis.fetch = (async () => new Response("<html>private upstream payload</html>", { status: 403 })) as typeof fetch
    await assert.rejects(client.startLogin(), (e: any) => e.diagnostic === "UPSTREAM_NON_JSON_403" && !e.message.includes("payload"))
    globalThis.fetch = (async () => { throw new Error("private signed URL") }) as typeof fetch
    await assert.rejects(client.startLogin(), (e: any) => e.diagnostic === "UPSTREAM_NETWORK" && !e.message.includes("private"))
  } finally { globalThis.fetch = original }
})
