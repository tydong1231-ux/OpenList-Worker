import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { adminRouter } from "./admin"
import { saveDb, getDb } from "../internal/model/db"

test("QR setup requires admin and does not overwrite unrelated mounts", async () => {
  const env: any = { JWT_SECRET: "test-only-secret-not-for-production" }
  await saveDb({ settings: [{ key: "token", value: "test-admin" }], users: [], storages: [{ id: 1, driver: "Quark", mount_path: "/existing", addition: "{}" }], shares: [], metas: [] }, env)
  const app = new Hono()
  app.route("/api/admin", adminRouter)
  const anonymous = await app.request("/api/admin/quark-tv/ready", {}, env)
  assert.equal((await anonymous.json() as any).code, 401)
  const headers = { Authorization: "test-admin", "Content-Type": "application/json" }
  const conflict = await app.request("/api/admin/quark-tv/start", { method: "POST", headers, body: JSON.stringify({ mount_path: "/existing", reauthorize: true }) }, env)
  assert.equal(conflict.status, 409)
  const invalid = await app.request("/api/admin/quark-tv/finish", { method: "POST", headers, body: JSON.stringify({ state: "invalid" }) }, env)
  assert.equal(invalid.status, 400)
  assert.equal((await getDb(env)).storages[0].driver, "Quark")
})
