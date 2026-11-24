import app from "./index"
import { AsyncLocalStorage } from "node:async_hooks"
import { setDbRequestScopeProvider } from "./internal/model/db"
import { runGalleryCron } from "./server/gallery-memory"
import { OpenListDB } from "./durable-objects/OpenListDB"

// Durable Object 类（DB_DRIVER=do 时使用），需在 wrangler.toml 声明
// new_sqlite_classes = ["OpenListDB"] 与对应的 binding。
export { OpenListDB }

const requestScope=new AsyncLocalStorage<{env:any;pending:WeakMap<object,Promise<any>>}>()
setDbRequestScopeProvider(()=>requestScope.getStore())

export default {
  fetch(request:Request,env:any,ctx:any) { return requestScope.run({env,pending:new WeakMap()},()=>app.fetch(request,env,ctx)) },
  async scheduled(controller: { cron: string; scheduledTime: number; noRetry?: () => void }, env: any) {
    // There is one registered schedule. Cloudflare can deliver an older or normalized
    // cron string during propagation; runGalleryCron enforces the time window itself.
    controller.noRetry?.()
    try { await requestScope.run({env,pending:new WeakMap()},()=>runGalleryCron(env, controller.scheduledTime)) }
    catch { console.warn("[GalleryCron] sync paused; next scheduled run resumes") }
  },
}
