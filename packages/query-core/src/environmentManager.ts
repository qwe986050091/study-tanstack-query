import { isServer as defaultIsServer } from './utils'

/**
 * A function that returns whether the code is running on the server.
 */
export type IsServerValue = () => boolean

// 默认实现来自 utils.ts 的 `typeof window === 'undefined' || 'Deno' in globalThis`。
// 这个开关在 query-core 里影响三处默认行为，读代码时可以把它当成「是否按服务端对待」的总闸：
//   1) Removable.updateGcTime → gcTime 默认 Infinity；
//   2) retryer 默认 retry 次数 → 0（客户端是 3）；
//   3) QueryObserver.#shouldScheduleTimer → 服务端不排 stale/refetch 定时器。
// 用 let + 闭包函数导出，是为了让 setIsServer 能在运行时整体改写判断（例如 Service Worker）。
let isServerFn: IsServerValue = () => defaultIsServer

/**
 * Returns whether the current runtime should be treated as a server environment.
 * @returns `true` if the runtime is treated as a server.
 */
export const isServer = (): boolean => isServerFn()

/**
 * Manages how TanStack Query detects whether the current runtime should be treated as
 * server-side, which disables scheduling refetch timers and changes the default `retry` count
 * and `gcTime`. By default, the detection treats a missing `window` (or the presence of a
 * `Deno` global) as server.
 *
 * Override this for runtimes where that default detection would give the wrong answer — for
 * example, a Service Worker, where `window` is undefined even though the environment should
 * behave like a client.
 * @example
 * ```ts
 * import { environmentManager } from '@tanstack/query-core'
 *
 * environmentManager.setIsServer(() => false)
 * ```
 */
export const environmentManager = {
  isServer,
  /**
   * Overrides the server check globally.
   * @param isServerValue - A function that returns whether the runtime should be treated as a
   * server.
   */
  // 注意这里没有通知机制：改完之后不会重算已经创建的 query 的 gcTime / 定时器，
  // 因此只能在应用启动、创建 QueryClient 之前调用。
  setIsServer(isServerValue: IsServerValue): void {
    isServerFn = isServerValue
  },
}
