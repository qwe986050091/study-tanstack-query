/**
 * {@link TimeoutManager} does not support passing arguments to the callback.
 *
 * `(_: void)` is the argument type inferred by TypeScript's default typings for
 * `setTimeout(cb, number)`.
 * If we don't accept a single void argument, then
 * `new Promise(resolve => timeoutManager.setTimeout(resolve, N))` is a type error.
 */
export type TimeoutCallback = (_: void) => void

/**
 * Wrapping `setTimeout` is awkward from a typing perspective because platform
 * typings may extend the return type of `setTimeout`. For example, NodeJS
 * typings add `NodeJS.Timeout`; but a non-default `timeoutManager` may not be
 * able to return such a type.
 */
// 定时器 id 允许是对象：自定义 provider（如 Node 的 Timeout）返回的是对象。
// 统一成「能隐式转成 number」的联合类型，是为了让业务侧可以 Number(id) 之后落日志。
export type ManagedTimerId = number | { [Symbol.toPrimitive]: () => number }

/**
 * Backend for timer functions.
 *
 * Timers are performance-sensitive: short-lived timers (delays under a few seconds) tend to be
 * latency-sensitive, while long-lived ones may benefit more from coalescing — batching timers
 * with similar deadlines together — which the default provider (backed by the platform's global
 * `setTimeout`/`setInterval`) does not do. A custom provider can implement coalescing, and can
 * also support delays longer than the ~24-day maximum of the global `setTimeout`.
 */
export type TimeoutProvider<TTimerId extends ManagedTimerId = ManagedTimerId> =
  {
    /**
     * Schedules `callback` to run once after `delay` milliseconds, like the global `setTimeout`.
     */
    readonly setTimeout: (callback: TimeoutCallback, delay: number) => TTimerId
    /**
     * Cancels a timeout scheduled with `setTimeout`.
     */
    readonly clearTimeout: (timeoutId: TTimerId | undefined) => void

    /**
     * Schedules `callback` to run every `delay` milliseconds, like the global `setInterval`.
     */
    readonly setInterval: (callback: TimeoutCallback, delay: number) => TTimerId
    /**
     * Cancels an interval scheduled with `setInterval`.
     */
    readonly clearInterval: (intervalId: TTimerId | undefined) => void
  }

type SystemTimerId = ReturnType<typeof setTimeout>

// ═══ 中文注释导读 ═══
// 全库所有 gcTime / staleTime / refetchInterval / 重试退避的定时器都走这里，
// 而不是直接调全局 setTimeout。这样做换来两个能力：
//   1) 自定义 provider 可以把成千上万个长定时器做成「合并触发」，或支持超过 24 天的延迟；
//   2) 测试里可以整体替换，不用 mock 全局。
// 下面的 defaultTimeoutProvider 刻意用箭头函数包一层而不是直接引用全局函数，见注释。
// ──────────────────────
export const defaultTimeoutProvider: TimeoutProvider = {
  // We need the wrapper function syntax below instead of direct references to
  // global setTimeout etc.
  //
  // BAD: `setTimeout: setTimeout`
  // GOOD: `setTimeout: (cb, delay) => setTimeout(cb, delay)`
  //
  // If we use direct references here, then anything that wants to spy on or
  // replace the global setTimeout (like tests) won't work since we'll already
  // have a hard reference to the original implementation at the time when this
  // file was imported.
  // 必须是包装函数，不能写成 `setTimeout: setTimeout`。
  // 直接引用会在 import 时把当时那份全局实现钉死，之后测试再替换全局 setTimeout 就不生效。
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timeoutId) =>
    clearTimeout(timeoutId as SystemTimerId | undefined),

  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (intervalId) =>
    clearInterval(intervalId as SystemTimerId | undefined),
}

/**
 * Allows customization of how timeouts are created.
 *
 * `@tanstack/query-core` makes liberal use of timeouts to implement `staleTime`
 * and `gcTime`. The default TimeoutManager provider uses the platform's global
 * `setTimeout` implementation, which is known to have scalability issues with
 * thousands of timeouts on the event loop.
 *
 * If you hit this limitation, consider providing a custom TimeoutProvider that
 * coalesces timeouts.
 */
export class TimeoutManager implements Omit<TimeoutProvider, 'name'> {
  // We cannot have TimeoutManager<T> as we must instantiate it with a concrete
  // type at app boot; and if we leave that type, then any new timer provider
  // would need to support the default provider's concrete timer ID, which is
  // infeasible across environments.
  //
  // We settle for type safety for the TimeoutProvider type, and accept that
  // this class is unsafe internally to allow for extension.
  #provider: TimeoutProvider<any> = defaultTimeoutProvider
  #providerCalled = false

  /**
   * `setTimeoutProvider` can be used to set a custom implementation of the
   * `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval` functions,
   * called a `TimeoutProvider`.
   *
   * This may be useful if you notice event loop performance issues with
   * thousands of queries. A custom TimeoutProvider could also support timer
   * delays longer than the global `setTimeout` maximum delay value of about
   * 24 days.
   *
   * It is important to call `setTimeoutProvider` before creating a
   * QueryClient or queries, so that the same provider is used consistently
   * for all timers in the application, since different TimeoutProviders
   * cannot cancel each others' timers.
   * @param provider - The `TimeoutProvider` to use for all timers from now on.
   * @example
   * ```ts
   * import { timeoutManager, QueryClient } from '@tanstack/query-core'
   * import { CustomTimeoutProvider } from './CustomTimeoutProvider'
   *
   * timeoutManager.setTimeoutProvider(new CustomTimeoutProvider())
   *
   * export const queryClient = new QueryClient()
   * ```
   */
  // 切换 provider 是全局且不可逆的：不同 provider 的 id 空间不互通，
  // 旧 provider 已排的定时器无法被新 provider 的 clearTimeout 正确取消（id 可能撞车，
  // 于是变成取消掉别的定时器）。所以开发环境只在「切换前已用过 provider」时报警。
  setTimeoutProvider<TTimerId extends ManagedTimerId>(
    provider: TimeoutProvider<TTimerId>,
  ): void {
    if (process.env.NODE_ENV !== 'production') {
      if (this.#providerCalled && provider !== this.#provider) {
        // After changing providers, `clearTimeout` will not work as expected for
        // timeouts from the previous provider.
        //
        // Since they may allocate the same timeout ID, clearTimeout may cancel an
        // arbitrary different timeout, or unexpected no-op.
        //
        // We could protect against this by mixing the timeout ID bits
        // deterministically with some per-provider bits.
        //
        // We could internally queue `setTimeout` calls to `TimeoutManager` until
        // some API call to set the initial provider.
        console.error(
          `[timeoutManager]: Switching provider after calls to previous provider might result in unexpected behavior.`,
          { previous: this.#provider, provider },
        )
      }
    }

    this.#provider = provider
    if (process.env.NODE_ENV !== 'production') {
      this.#providerCalled = false
    }
  }

  /**
   * `setTimeout` schedules a callback to run after approximately `delay`
   * milliseconds, like the global `setTimeout` function. The callback can be
   * canceled with `clearTimeout`.
   *
   * It returns a timer ID, which may be a number or an object that can be
   * coerced to a number via `Symbol.toPrimitive`.
   * @param callback - The function to call when the timeout elapses.
   * @param delay - The time to wait before calling `callback`, in milliseconds.
   * @returns The timer ID, to pass to {@link TimeoutManager#clearTimeout}.
   * @example
   * ```ts
   * import { timeoutManager } from '@tanstack/query-core'
   *
   * const timeoutId = timeoutManager.setTimeout(
   *   () => console.log('ran at:', new Date()),
   *   1000,
   * )
   *
   * const timeoutIdNumber: number = Number(timeoutId)
   * ```
   */
  // 这里只做转发；#providerCalled 仅用于开发环境的误用检测。
  setTimeout(callback: TimeoutCallback, delay: number): ManagedTimerId {
    if (process.env.NODE_ENV !== 'production') {
      this.#providerCalled = true
    }
    return this.#provider.setTimeout(callback, delay)
  }

  /**
   * `clearTimeout` cancels a timeout callback scheduled with `setTimeout`,
   * like the global `clearTimeout` function. It should be called with a
   * timer ID returned by `setTimeout`.
   * @param timeoutId - The timer ID returned by `setTimeout`, or `undefined`.
   * @example
   * ```ts
   * import { timeoutManager } from '@tanstack/query-core'
   *
   * const timeoutId = timeoutManager.setTimeout(
   *   () => console.log('ran at:', new Date()),
   *   1000,
   * )
   *
   * timeoutManager.clearTimeout(timeoutId)
   * ```
   */
  clearTimeout(timeoutId: ManagedTimerId | undefined): void {
    this.#provider.clearTimeout(timeoutId)
  }

  /**
   * `setInterval` schedules a callback to be called approximately every
   * `delay` milliseconds, like the global `setInterval` function.
   *
   * Like `setTimeout`, it returns a timer ID, which may be a number or an
   * object that can be coerced to a number via `Symbol.toPrimitive`.
   * @param callback - The function to call on every interval.
   * @param delay - The time between calls, in milliseconds.
   * @returns The timer ID, to pass to {@link TimeoutManager#clearInterval}.
   * @example
   * ```ts
   * import { timeoutManager } from '@tanstack/query-core'
   *
   * const intervalId = timeoutManager.setInterval(
   *   () => console.log('ran at:', new Date()),
   *   1000,
   * )
   * ```
   */
  setInterval(callback: TimeoutCallback, delay: number): ManagedTimerId {
    if (process.env.NODE_ENV !== 'production') {
      this.#providerCalled = true
    }
    return this.#provider.setInterval(callback, delay)
  }

  /**
   * `clearInterval` can be used to cancel an interval, like the global
   * `clearInterval` function. It should be called with an interval ID
   * returned by `setInterval`.
   * @param intervalId - The timer ID returned by `setInterval`, or `undefined`.
   * @example
   * ```ts
   * import { timeoutManager } from '@tanstack/query-core'
   *
   * const intervalId = timeoutManager.setInterval(
   *   () => console.log('ran at:', new Date()),
   *   1000,
   * )
   *
   * timeoutManager.clearInterval(intervalId)
   * ```
   */
  clearInterval(intervalId: ManagedTimerId | undefined): void {
    this.#provider.clearInterval(intervalId)
  }
}

/**
 * Singleton instance of {@link TimeoutManager}, used throughout TanStack Query to schedule and cancel timers.
 */
// 单例：Removable、QueryObserver、retryer.sleep 共享同一个实例。
export const timeoutManager = new TimeoutManager()

/**
 * In many cases code wants to delay to the next event loop tick; this is not
 * mediated by {@link timeoutManager}.
 *
 * This function is provided to make auditing the `tanstack/query-core` for
 * incorrect use of system `setTimeout` easier.
 * @param callback - The function to call on the next event loop tick.
 */
// 只给 notifyManager.defaultScheduler 用：「推到下一个宏任务」是调度语义，
// 不属于「业务定时器」，所以故意绕过 timeoutManager，避免被自定义 provider 的合并策略改变顺序。
export function systemSetTimeoutZero(callback: TimeoutCallback): void {
  setTimeout(callback, 0)
}
