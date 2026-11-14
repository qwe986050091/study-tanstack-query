/**
 * The base class behind everything in Query that you can subscribe to: `QueryCache`, `MutationCache`,
 * the observers, and the `FocusManager`/`OnlineManager` behind `focusManager` and `onlineManager`.
 * Subclasses decide what a listener receives and when it is called.
 */
// ═══ 中文注释导读 ═══
// 这是整个 query-core 的最小基类：一个「监听器集合 + 两个钩子」。
// 继承它的有 QueryCache、MutationCache、QueryObserver、QueriesObserver、
// MutationObserver、FocusManager、OnlineManager。
// 关键点：基类只负责增删监听器，不决定什么时候通知、通知什么；
//        「何时通知」由子类自己调 listeners.forEach；「通知什么」由子类决定参数。
// 因此读任何一个子类时，只要盯住三件事：谁 subscribe、谁触发通知、onUnsubscribe 里销毁了什么。
// ──────────────────────
export class Subscribable<TListener extends Function> {
  // 用 Set 而不是数组：同一个 listener 重复 subscribe 只保留一份，
  // 这样 React 里重复注册（如 StrictMode 双调用）不会导致一次更新被回调两次。
  protected listeners = new Set<TListener>()

  // 构造时就把 subscribe 绑定到实例。原因不是风格问题：
  // QueryObserver/QueriesObserver 的 subscribe 会被框架适配层解构后单独传递
  // （见 react useBaseQuery 里的 observer.subscribe(notifyManager.batchCalls(...))），
  // 不绑定的话 this 会丢。
  constructor() {
    this.subscribe = this.subscribe.bind(this)
  }

  /**
   * Registers a listener to be called on every update this object notifies about. Returns a function
   * that removes the listener again — call it to stop listening. The base class never drops a listener
   * on its own, though some subclasses clear all of theirs in `destroy()`.
   * @param listener - Called on each update, with whatever the subclass passes to its subscribers.
   * @returns A function that removes the listener.
   * @example
   * ```ts
   * const unsubscribe = subscribable.subscribe(() => {
   *   // react to the update
   * })
   *
   * unsubscribe()
   * ```
   */
  // 订阅返回「退订函数」。注意 onSubscribe 在 add 之后调用、onUnsubscribe 在 delete 之后调用：
  // 子类用它们做「首个订阅者到来时开始工作 / 最后一个订阅者离开时清理」的引用计数式副作用。
  // 典型：QueryObserver.onSubscribe 里才把 observer 挂到 Query 上并触发首屏 fetch；
  //       QueryObserver.onUnsubscribe 里 listeners 空了就 destroy。
  subscribe(listener: TListener): () => void {
    // 先加监听器再回调 onSubscribe：子类钩子里如果同步触发一次通知，
    // 新监听器必须已经在集合里，否则会漏掉第一次结果。
    this.listeners.add(listener)

    this.onSubscribe()

    return () => {
      this.listeners.delete(listener)
      this.onUnsubscribe()
    }
  }

  /**
   * Returns `true` while at least one listener is registered, `false` once they have all unsubscribed.
   * @returns `true` if at least one listener is registered.
   */
  // 所有「是否还有人在看」的判断都走这里。
  // Query.isActive / observer 是否该 fetch / 是否该销毁，最终都收敛到 size > 0。
  hasListeners(): boolean {
    return this.listeners.size > 0
  }

  /**
   * Called after a listener is added. Does nothing here; subclasses override it, e.g. to start
   * tracking what they observe once the first listener subscribes.
   */
  protected onSubscribe(): void {
    // Do nothing
  }

  /**
   * Called after a listener is removed. Does nothing here; subclasses override it, e.g. to clean up
   * once the last listener unsubscribes.
   */
  protected onUnsubscribe(): void {
    // Do nothing
  }
}
