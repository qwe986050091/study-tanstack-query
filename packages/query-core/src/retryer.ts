import { focusManager } from './focusManager'
import { onlineManager } from './onlineManager'
import { isServer as isServerEnvironment } from './environmentManager'
import { noop, sleep } from './utils'
import type { CancelOptions, DefaultError, NetworkMode } from './types'

// TYPES

interface RetryerConfig<TData = unknown, TError = DefaultError> {
  fn: () => TData | Promise<TData>
  initialPromise?: Promise<TData>
  onCancel?: (error: TError) => void
  onFail?: (failureCount: number, error: TError) => void
  onPause?: () => void
  onContinue?: () => void
  retry?: RetryValue<TError>
  retryDelay?: RetryDelayValue<TError>
  networkMode: NetworkMode | undefined
  canRun: () => boolean
}

/**
 * Runs a function with retries, and can pause, continue, or cancel it. Queries and mutations use
 * one for each fetch or execution.
 */
export interface Retryer<TData = unknown> {
  /**
   * The promise that resolves with the data, or rejects once retries are exhausted or it is
   * cancelled.
   */
  promise: Promise<TData>
  /**
   * Cancels the run, rejecting `promise` with a `CancelledError`.
   */
  cancel: (cancelOptions?: CancelOptions) => void
  /**
   * Resumes a paused run, and returns `promise`.
   */
  continue: () => Promise<unknown>
  /**
   * Stops further retries. The current attempt still finishes.
   */
  cancelRetry: () => void
  /**
   * Allows retries again after `cancelRetry`.
   */
  continueRetry: () => void
  /**
   * Returns whether the run can start now, based on the network mode and `canRun`.
   */
  canStart: () => boolean
  /**
   * Starts the run, or waits until it can start, and returns `promise`.
   */
  start: () => Promise<TData>
  /**
   * Returns whether `promise` is still pending, resolved, or rejected.
   */
  status: () => 'pending' | 'resolved' | 'rejected'
}

type RetryerStatus = 'pending' | 'resolved' | 'rejected'

/** @inline */
export type RetryValue<TError> = boolean | number | ShouldRetryFunction<TError>

/** @inline */
type ShouldRetryFunction<TError = DefaultError> = (
  failureCount: number,
  error: TError,
) => boolean

/** @inline */
export type RetryDelayValue<TError> = number | RetryDelayFunction<TError>

/** @inline */
type RetryDelayFunction<TError = DefaultError> = (
  failureCount: number,
  error: TError,
) => number

/**
 * The default `retryDelay`: doubles with every failure, starting at 1 second, up to 30 seconds.
 * @param failureCount - The number of failures so far.
 * @returns The delay before the next retry, in milliseconds.
 */
function defaultRetryDelay(failureCount: number) {
  return Math.min(1000 * 2 ** failureCount, 30000)
}

/**
 * Checks whether a fetch can run for the given network mode.
 * @param networkMode - The `networkMode` option. Defaults to `'online'`.
 * @returns `true` if the network mode is not `'online'`, or if it is and the client is online.
 */
export function canFetch(networkMode: NetworkMode | undefined): boolean {
  return (networkMode ?? 'online') === 'online'
    ? onlineManager.isOnline()
    : true
}

/**
 * The error thrown by a `Retryer` (and surfaced to `query.promise`/`mutation`) when a fetch is cancelled, e.g. via
 * `query.cancel()`. `revert`, if `true`, tells the caller to restore the state the query was in before the fetch
 * started instead of surfacing the error. `silent`, if `true`, tells the caller to suppress this error and instead
 * resolve with the promise of the fetch that triggered the cancellation.
 * @example
 * ```ts
 * query.cancel()
 *
 * try {
 *   await query.promise
 * } catch (error) {
 *   if (error instanceof CancelledError) {
 *     // the fetch was cancelled, e.g. via `query.cancel()`
 *   }
 * }
 * ```
 */
export class CancelledError extends Error {
  revert?: boolean
  silent?: boolean
  constructor(options?: CancelOptions) {
    super('CancelledError')
    this.revert = options?.revert
    this.silent = options?.silent
  }
}

/**
 * Checks whether a value is a `CancelledError`.
 * @param value - The value to check.
 * @returns `true` if `value` is a `CancelledError`.
 * @deprecated Use instanceof `CancelledError` instead.
 */
export function isCancelledError(value: any): value is CancelledError {
  return value instanceof CancelledError
}

/**
 * Creates a retryer, which runs a function and retries it on failure according to the `retry` and
 * `retryDelay` options. It pauses while the network mode doesn't allow fetching or `canRun` returns
 * `false`, and can be cancelled. Queries and mutations use it to run their `queryFn` and
 * `mutationFn`.
 * @param config - The function to run, the retry options, and the callbacks for failures, pausing,
 * continuing, and cancellation.
 * @returns The retryer, whose `promise` settles with the result of the function.
 */
// ═══ 中文注释导读 ═══
// retryer 是「一次 fetch 的执行器」：重试、退避、暂停/恢复、取消全都集中在这里。
// Query.fetch 与 Mutation.execute 各自 new 一个，然后把这个 retryer 的 promise 当作对外承诺。
// 读这个文件只需抓住三个状态：
//   status: pending → resolved/rejected（只能走一次，cancel 也走 reject）
//   pause: 用一个「等待继续」的 promise 挂住 run 循环，等待 continueFn 被调用
//   retry: 失败后 sleep(delay) → 检查 canContinue → 递归 run()
// 最容易读错的两点：
//   1) promise 在 createRetryer 时就建好，但 fn 要等 start() 才执行；
//   2) cancel 不只是「不再重试」，它会立刻 reject 当前 promise（并触发 onCancel）。
// ──────────────────────
export function createRetryer<TData = unknown, TError = DefaultError>(
  config: RetryerConfig<TData, TError>,
): Retryer<TData> {
  // 与「取消整个 promise」区分开：cancelRetry 只是不让下一次重试发生，当前尝试仍会跑完。
  // Query.removeObserver 在「没人读 signal」时就用它：让请求跑完、结果仍写进缓存。
  let isRetryCancelled = false
  let failureCount = 0
  let continueFn: ((value?: unknown) => void) | undefined
  let status: RetryerStatus = 'pending'
  let promiseResolve: (data: TData) => void
  let promiseReject: (error: TError) => void

  // 立刻挂一个 catch(noop)：这个 promise 对外暴露（query.promise），
  // 使用者可能不 await；没有这个兜底会在 Node 里触发 unhandledRejection。
  const promise = new Promise<TData>((resolve, reject) => {
    promiseResolve = resolve
    promiseReject = reject
  })
  promise.catch(noop)

  const isResolved = () => status !== 'pending'

  // cancel → reject(CancelledError) + onCancel(同步回调，Query 在这里 abort AbortController)。
  // 注意 reject() 内部会先 continueFn?.()：如果此刻正卡在 pause，必须先唤醒它，
  // 否则 run 循环永远挂住，promise 虽然 rejected 但闭包与定时器泄漏。
  const cancel = (cancelOptions?: CancelOptions): void => {
    if (!isResolved()) {
      const error = new CancelledError(cancelOptions) as TError
      reject(error)

      config.onCancel?.(error)
    }
  }
  const cancelRetry = () => {
    isRetryCancelled = true
  }

  const continueRetry = () => {
    isRetryCancelled = false
  }

  // 恢复条件比启动条件更严格：多要求 focusManager.isFocused()。
  // 也就是说「后台标签页里失败的重试」会暂停，等用户回到页面再继续（networkMode 'always' 除外）。
  const canContinue = () =>
    focusManager.isFocused() &&
    (config.networkMode === 'always' || onlineManager.isOnline()) &&
    config.canRun()

  // 启动不检查 focus：首次加载即使用户在别的标签页也应该发出请求。
  // 这个不对称是刻意的，改的时候要同时看 start() 与 run() 里的两处调用。
  const canStart = () => canFetch(config.networkMode) && config.canRun()

  const resolve = (value: any) => {
    if (!isResolved()) {
      continueFn?.()
      status = 'resolved'
      promiseResolve(value)
    }
  }

  const reject = (value: any) => {
    if (!isResolved()) {
      continueFn?.()
      status = 'rejected'
      promiseReject(value)
    }
  }

  // 用一个手动 resolve 的 promise 实现「暂停」：
  // continueFn 只有在「已结束」或「canResume() 成立」时才真正放行，
  // 否则这次 continue 调用被吞掉，等待下一次。
  // 恢复后如果还没结束，回调 onContinue（Query 用它把 fetchStatus 改回 'fetching'）。
  const pause = (canResume: () => boolean) => {
    return new Promise((continueResolve) => {
      continueFn = (value) => {
        if (isResolved() || canResume()) {
          continueResolve(value)
        }
      }
      config.onPause?.()
    }).then(() => {
      continueFn = undefined
      if (!isResolved()) {
        config.onContinue?.()
      }
    })
  }

  // Create loop function
  // 每次尝试的入口。递归调用点只有一个：sleep 之后的 .then(() => run())。
  const run = () => {
    // Do nothing if already resolved
    if (isResolved()) {
      return
    }

    let promiseOrValue: any

    // we can re-use config.initialPromise on the first call of run()
    // initialPromise 只在第一次尝试生效。它来自 hydration：
    // 服务端已经发出去的请求，其 promise 被序列化到客户端，这里直接 await 它而不是重发。
    // 重试时不能再用它，否则会一直等同一个已失败的 promise。
    const initialPromise =
      failureCount === 0 ? config.initialPromise : undefined

    // Execute query
    try {
      // 同步 throw 也要转成 reject，否则会跳出整个 run 调用栈，promise 永远 pending。
      promiseOrValue = initialPromise ?? config.fn()
    } catch (error) {
      promiseOrValue = Promise.reject(error)
    }

    Promise.resolve(promiseOrValue)
      .then(resolve)
      .catch((error) => {
        // Stop if the fetch is already resolved
        if (isResolved()) {
          return
        }

        // Do we need to retry the request?
        // 默认值分环境：服务端 0 次（SSR 不该阻塞重试），客户端 3 次。
        // shouldRetry 的三种写法语义：true = 无限重试；number = 剩余次数比较；function = 逐错判断。
        const retry = config.retry ?? (isServerEnvironment() ? 0 : 3)
        const retryDelay = config.retryDelay ?? defaultRetryDelay
        const delay =
          typeof retryDelay === 'function'
            ? retryDelay(failureCount, error)
            : retryDelay
        const shouldRetry =
          retry === true ||
          (typeof retry === 'number' && failureCount < retry) ||
          (typeof retry === 'function' && retry(failureCount, error))

        // 这里才真正 settle 失败：reject 之后 run 不会再被调度。
        if (isRetryCancelled || !shouldRetry) {
          // We are done if the query does not need to be retried
          reject(error)
          return
        }

        failureCount++

        // Notify on fail
        config.onFail?.(failureCount, error)

        // Delay
        // 退避顺序固定为：sleep → 检查能否继续（focus+online+canRun）→ 继续或 pause → run。
        // 注意 pause 的判断放在 sleep 之后：先等退避时长，再看当时是否允许继续。
        sleep(delay)
          // Pause if the document is not visible or when the device is offline
          .then(() => {
            return isResolved() || canContinue()
              ? undefined
              : pause(canContinue)
          })
          .then(() => {
            if (isRetryCancelled) {
              reject(error)
            } else {
              run()
            }
          })
      })
  }

  return {
    promise,
    status: () => status,
    cancel,
    continue: () => {
      continueFn?.()
      return promise
    },
    cancelRetry,
    continueRetry,
    canStart,
    // start 可能同步执行 run，也可能先 pause 等条件满足（例如 networkMode 'online' 且当前离线）。
    // 返回的是同一个 promise，所以调用方拿到的一定是最终结果，而不是「是否已启动」。
    start: () => {
      // Start loop
      if (canStart()) {
        run()
      } else {
        // Waiting to start (e.g. queued behind a scope) does not depend on focus,
        // only on the same conditions that allow starting in the first place
        pause(canStart).then(run)
      }
      return promise
    },
  }
}
