import app from "./index"
import { GALLERY_CRON, runGalleryCron } from "./server/gallery-memory"
import { OpenListDB } from "./durable-objects/OpenListDB"

// Durable Object 类（DB_DRIVER=do 时使用），需在 wrangler.toml 声明
// new_sqlite_classes = ["OpenListDB"] 与对应的 binding。
export { OpenListDB }

export default {
  fetch: app.fetch,
  async scheduled(controller: { cron: string; scheduledTime: number; noRetry?: () => void }, env: any) {
    if (controller.cron !== GALLERY_CRON) return
    controller.noRetry?.()
    try { await runGalleryCron(env, controller.scheduledTime) }
    catch { console.warn("[GalleryCron] sync paused; next scheduled run resumes") }
  },
}
