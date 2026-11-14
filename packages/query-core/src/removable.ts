import { timeoutManager } from './timeoutManager'
import { isServer as isServerEnvironment } from './environmentManager'
import { isValidTimeout } from './utils'
import type { ManagedTimerId } from './timeoutManager'

/**
 * The base class for cache entries that are garbage collected once nothing is using them —
 * `Query` and `Mutation` both extend it. `gcTime` controls how long an unused entry is kept.
 */
// ═══ 中文注释导读 ═══
// GC 基类：Query 与 Mutation 都继承它，用「一个定时器」实现 gcTime。
// 生命周期可以概括成一句话：只要还有人在用就 clearGcTimeout()，一旦没人用了就 scheduleGc()，
//   定时器到点后调子类的 optionalRemove()，由子类决定「真删」还是「继续等」。
// 读 Query 的 40 多个方法时，凡是看到 scheduleGc/clearGcTimeout，都回到这里对照。
// ──────────────────────
export abstract class Removable {
  // 注意是 `!` 断言：gcTime 不在这里初始化，而是由 updateGcTime() 在 setOptions 时写入。
  // 所以任何读 gcTime 的代码，前提都是 setOptions 已经跑过（Query 构造器里就是这个顺序）。
  gcTime!: number
  #gcTimeout?: ManagedTimerId

  /**
   * Clears the pending garbage collection timeout, so the entry is no longer scheduled for removal.
   * A subclass may override this to release what it holds on to as well — `Query` also cancels any
   * in-flight fetch.
   */
  // destroy 只做一件事：撤定时器。
  // Query 覆写了它并额外 this.cancel({ silent: true })，
  // 所以「从缓存里删除一个 query」会顺带取消在途请求——这是读 QueryCache.remove 时必须记住的副作用。
  destroy(): void {
    this.clearGcTimeout()
  }

  /**
   * Schedules the entry to be removed from its cache after `gcTime`, replacing any timeout scheduled
   * before. Nothing is scheduled if `gcTime` is `Infinity`.
   */
  // 每次调度前先清旧定时器，等价于「续期」语义：
  // 比如 removeObserver 时调一次、fetch 结束时 finally 里又调一次，最终只保留最后一次的截止时间。
  // gcTime 为 Infinity 时 isValidTimeout 返回 false，也就是永远不回收（服务端默认值）。
  protected scheduleGc(): void {
    this.clearGcTimeout()

    if (isValidTimeout(this.gcTime)) {
      this.#gcTimeout = timeoutManager.setTimeout(() => {
        this.optionalRemove()
      }, this.gcTime)
    }
  }

  /**
   * Updates `gcTime`, keeping the longest one seen so far. Without a value, it defaults to 5 minutes
   * on the client and `Infinity` on the server.
   * @param newGcTime - The `gcTime` from the latest options, if any.
   */
  // 取「历史最大值」而不是覆盖：同一个 Query 会被不同 observer 用不同 options 反复 setOptions，
  // 若直接覆盖，后到的短 gcTime 会把先到的长 gcTime 顶掉，导致刚缓存的数据被提前回收。
  // 默认值按环境分叉：客户端 5 分钟，服务端 Infinity（服务端不应保留常驻缓存）。
  protected updateGcTime(newGcTime: number | undefined): void {
    // Default to 5 minutes (Infinity for server-side) if no gcTime is set
    this.gcTime = Math.max(
      this.gcTime || 0,
      newGcTime ?? (isServerEnvironment() ? Infinity : 5 * 60 * 1000),
    )
  }

  /**
   * Cancels the scheduled removal, if there is one.
   */
  // 置 undefined 很关键：scheduleGc 会先 clear 再 set，
  // 如果这里不清空 id，后续 clear 会对同一个 id 重复 clear，自定义 provider 下可能误伤别的定时器。
  protected clearGcTimeout() {
    if (this.#gcTimeout !== undefined) {
      timeoutManager.clearTimeout(this.#gcTimeout)
      this.#gcTimeout = undefined
    }
  }

  /**
   * Called when the garbage collection timeout fires. Subclasses remove the entry from its cache
   * unless it is still in use, e.g. because it has observers.
   */
  // 「optional」的含义：到点了也不一定删。
  // Query.optionalRemove 要求 observers 为空且 fetchStatus 为 idle；
  // Mutation.optionalRemove 在 pending 时会重新 scheduleGc 而不是删除。
  protected abstract optionalRemove(): void
}
