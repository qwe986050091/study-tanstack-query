import { Subscribable } from './subscribable'

type Listener = (online: boolean) => void
type SetupFn = (setOnline: Listener) => (() => void) | undefined

/**
 * The `OnlineManager` manages the online state within TanStack Query. It can
 * be used to change the default event listeners or to manually change the
 * online state.
 *
 * By default, the `onlineManager` assumes an active network connection, and
 * listens to the `online` and `offline` events on the `window` object to
 * detect changes.
 */
// ═══ 中文注释导读 ═══
// 与 FocusManager 同构的全局单例，维护「是否在线」，是 networkMode 与断网暂停/恢复的输入。
// 三个使用方（读的时候按这三条线去对照）：
//   1) retryer.canFetch / canContinue → 决定 fetch 是 'fetching' 还是 'paused'；
//   2) QueryClient.mount 的 online 订阅 → 恢复暂停的 mutation + queryCache.onOnline() 触发重取；
//   3) QueryClient.resumePausedMutations 的前置判断。
// 注意 #online 初始为 true：未收到任何事件前一律当在线，避免首屏不发请求。
// ──────────────────────
export class OnlineManager extends Subscribable<Listener> {
  #online = true
  #cleanup?: () => void

  #setup: SetupFn

  constructor() {
    super()
    this.#setup = (onOnline) => {
      // addEventListener does not exist in React Native, but window does
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (typeof window !== 'undefined' && window.addEventListener) {
        const onlineListener = () => onOnline(true)
        const offlineListener = () => onOnline(false)
        // Listen to online
        window.addEventListener('online', onlineListener, false)
        window.addEventListener('offline', offlineListener, false)

        return () => {
          // Be sure to unsubscribe if a new handler is set
          window.removeEventListener('online', onlineListener)
          window.removeEventListener('offline', offlineListener)
        }
      }

      return
    }
  }

  protected override onSubscribe(): void {
    if (!this.#cleanup) {
      this.setEventListener(this.#setup)
    }
  }

  protected override onUnsubscribe() {
    if (!this.hasListeners()) {
      this.#cleanup?.()
      this.#cleanup = undefined
    }
  }

  /**
   * `setEventListener` can be used to set a custom event listener that will
   * be used to determine the online state. The provided `setup` function
   * receives a `setOnline` callback that should be called with a `boolean`
   * whenever the online state changes.
   * @param setup - Receives the `setOnline` callback, registers the event listener, and may return
   * a cleanup function that is called when the listener is replaced or no longer needed.
   * @example
   * ```ts
   * import NetInfo from '@react-native-community/netinfo'
   * import { onlineManager } from '@tanstack/query-core'
   *
   * onlineManager.setEventListener((setOnline) => {
   *   return NetInfo.addEventListener((state) => {
   *     setOnline(!!state.isConnected)
   *   })
   * })
   * ```
   */
  setEventListener(setup: SetupFn): void {
    this.#setup = setup
    this.#cleanup?.()
    this.#cleanup = setup(this.setOnline.bind(this))
  }

  /**
   * `setOnline` can be used to manually set the online state.
   * @param online - The online state.
   * @example
   * ```ts
   * import { onlineManager } from '@tanstack/query-core'
   *
   * // Set to online
   * onlineManager.setOnline(true)
   *
   * // Set to offline
   * onlineManager.setOnline(false)
   * ```
   */
  // 同样只在值变化时广播；浏览器 online/offline 事件可能重复触发。
  setOnline(online: boolean): void {
    const changed = this.#online !== online

    if (changed) {
      this.#online = online
      this.listeners.forEach((listener) => {
        listener(online)
      })
    }
  }

  /**
   * `isOnline` can be used to get the current online state.
   * @returns `true` if online.
   */
  // 纯内存标记，不主动探测网络；真正的探测交给 navigator.onLine 驱动事件。
  isOnline(): boolean {
    return this.#online
  }
}

/**
 * Singleton instance of {@link OnlineManager}, used to manage and observe the online state within TanStack Query.
 */
export const onlineManager = new OnlineManager()
