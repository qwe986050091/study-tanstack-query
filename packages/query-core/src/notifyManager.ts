// TYPES

import { systemSetTimeoutZero } from './timeoutManager'

type NotifyCallback = () => void

type NotifyFunction = (callback: () => void) => void

type BatchNotifyFunction = (callback: () => void) => void

type BatchCallsCallback<T extends Array<unknown>> = (...args: T) => void

type ScheduleFunction = (callback: () => void) => void

/**
 * Default scheduling function used by the notify manager.
 * Schedules the callback with the system's `setTimeout(callback, 0)`.
 */
export const defaultScheduler: ScheduleFunction = systemSetTimeoutZero

/**
 * Creates a notify manager, which schedules and batches notifications to subscribers. Query uses a
 * single instance of it, exported as {@link notifyManager}.
 * @returns A new notify manager.
 */
// ═══ 中文注释导读 ═══
// query-core 里所有「通知监听者」都要穿过这个单例，目的是把同步的一串状态变更压成一次渲染。
// 两条路径必须分清（这是最容易读混的地方）：
//   A. batch(cb)：cb 执行期间 schedule() 只入队不派发，最外层 batch 结束时 flush() 一次性派发；
//   B. 直接 listeners.forEach(...)：不走队列，同步调用。
//   Query.#dispatch / QueryCache.notify / QueryObserver.updateResult 用的是 A 包住 B —— 批量边界在内层。
// 因此「一次 fetch 成功」会先同步改 state，然后在 flush 的 setTimeout(0) 里才真正回调 React。
// ──────────────────────
export function createNotifyManager() {
  // 只有在 batch 事务中（transactions > 0）schedule 进来的回调才会进 queue；
  let queue: Array<NotifyCallback> = []
  // 用计数器而不是布尔量，支持嵌套 batch。
  let transactions = 0
  let notifyFn: NotifyFunction = (callback) => {
    callback()
  }
  let batchNotifyFn: BatchNotifyFunction = (callback: () => void) => {
    callback()
  }
  let scheduleFn = defaultScheduler

  // 事务外调用 schedule 是「推迟到下一个 tick」，不是立即执行；
  // 事务内只是入队，等最外层 flush 统一调度。
  const schedule = (callback: NotifyCallback): void => {
    if (transactions) {
      queue.push(callback)
    } else {
      scheduleFn(() => {
        notifyFn(callback)
      })
    }
  }
  // 先把 queue 换空再调度，这样派发过程中新 schedule 的回调会进入「下一批」而不是死循环。
  // 派发本身又包了一层 scheduleFn + batchNotifyFn：
  //   batchNotifyFn 由框架适配层替换（React 用它接 flushSync/act，Solid 用 batch），
  //   保证一批回调在框架同一个更新批次里执行。
  const flush = (): void => {
    const originalQueue = queue
    queue = []
    if (originalQueue.length) {
      scheduleFn(() => {
        batchNotifyFn(() => {
          originalQueue.forEach((callback) => {
            notifyFn(callback)
          })
        })
      })
    }
  }

  return {
    /**
     * Batches all updates scheduled inside the passed callback.
     * This is mainly used internally to optimize query client updating.
     * Batches can be nested; the queue is only flushed once the outermost `batch` call finishes.
     * The return value of `callback` is passed through.
     * @param callback - The function to run in the batch.
     * @returns The return value of `callback`.
     */
    // try/finally 是必须的：callback 抛错时 transactions 也要减回去，否则后续所有通知会被永久挂起。
    batch: <T>(callback: () => T): T => {
      let result
      transactions++
      try {
        result = callback()
      } finally {
        transactions--
        if (!transactions) {
          flush()
        }
      }
      return result
    },
    /**
     * All calls to the wrapped function will be batched.
     * @param callback - The function to wrap.
     * @returns A function that schedules a call to `callback` with the given arguments.
     */
    // 把「订阅回调」再包一层调度。框架适配层用它把 onStoreChange 交给 notifyManager 排队，
    // 于是同一个 query 的多次状态变化只会触发一次 store 变更通知。
    batchCalls: <T extends Array<unknown>>(
      callback: BatchCallsCallback<T>,
    ): BatchCallsCallback<T> => {
      return (...args) => {
        schedule(() => {
          callback(...args)
        })
      }
    },
    /**
     * Schedules a function to be run on the next batch.
     * By default, the batch is run with a `setTimeout`, but this can be configured via `setScheduler`.
     */
    schedule,
    /**
     * Use this method to set a custom notify function.
     * This can be used to for example wrap notifications with `React.act` while running tests.
     * @param fn - Receives each notification callback and must call it.
     */
    // 测试钩子：React 的测试会用 React.act 包住每次通知，避免 act 警告。
    setNotifyFunction: (fn: NotifyFunction) => {
      notifyFn = fn
    },
    /**
     * Use this method to set a custom function to batch notifications together into a single tick.
     * Framework adapters use this to plug in their own batching primitive, so that a single query
     * update only triggers one re-render instead of one per subscriber.
     * @param fn - Receives a function that runs a batch of notifications and must call it.
     * @example
     * ```ts
     * import { notifyManager } from '@tanstack/query-core'
     * import { batch } from 'solid-js'
     *
     * notifyManager.setBatchNotifyFunction(batch)
     * ```
     */
    // 框架批处理入口。search 各适配层可看到 react 传的是 React.unstable_batchedUpdates 类似语义的包装，
    // solid 传的是 solid 的 batch。
    setBatchNotifyFunction: (fn: BatchNotifyFunction) => {
      batchNotifyFn = fn
    },
    /**
     * Configures a custom callback that schedules when the next batch runs.
     * The default behavior is `setTimeout(callback, 0)`.
     * @param fn - Receives a callback that runs the next batch, and schedules it.
     * @example
     * ```ts
     * import { notifyManager } from '@tanstack/query-core'
     *
     * // Schedule batches in the next microtask
     * notifyManager.setScheduler(queueMicrotask)
     *
     * // Schedule batches before the next frame is rendered
     * notifyManager.setScheduler(requestAnimationFrame)
     *
     * // Schedule batches some time in the future
     * notifyManager.setScheduler((cb) => setTimeout(cb, 10))
     * ```
     */
    // 默认 setTimeout(0)；注释里给的替代方案（queueMicrotask / rAF / 延迟）会直接改变
    // 「数据写入缓存」到「组件拿到新结果」之间的时延，调优时只改这里。
    setScheduler: (fn: ScheduleFunction) => {
      scheduleFn = fn
    },
  } as const
}

// SINGLETON

/**
 * Handles scheduling and batching callbacks in TanStack Query.
 */
// 单例。createNotifyManager 只在测试里被再次调用，用于隔离队列状态。
export const notifyManager = createNotifyManager()
