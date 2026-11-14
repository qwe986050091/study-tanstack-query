import { Subscribable } from './subscribable'

type Listener = (focused: boolean) => void

type SetupFn = (
  setFocused: (focused?: boolean) => void,
) => (() => void) | undefined

/**
 * The `FocusManager` manages the focus state within TanStack Query.
 *
 * It can be used to change the default event listeners or to manually change the focus state.
 */
// ═══ 中文注释导读 ═══
// 全局单例，维护「页面/窗口是否聚焦」这一位状态，是 refetchOnWindowFocus 的触发源。
// 调用链：浏览器 visibilitychange → setup 里的 listener → onFocus() → 通知监听者
//        → QueryClient.mount 注册的回调 → queryCache.onFocus() → 每个 Query.onFocus()。
// 注意 QueryClient 只在 mount 之后才订阅它，所以「没有 Provider 就没有聚焦重取」不是 bug。
// ──────────────────────
export class FocusManager extends Subscribable<Listener> {
  // undefined 表示「没有手动指定」，此时 isFocused 回退到读 document.visibilityState。
  // 手动 setFocused(true/false) 会把判断短路掉，测试与 React Native 就靠这个入口。
  #focused?: boolean
  #cleanup?: () => void

  #setup: SetupFn

  constructor() {
    super()
    this.#setup = (onFocus) => {
      // addEventListener does not exist in React Native, but window does
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (typeof window !== 'undefined' && window.addEventListener) {
        const listener = () => onFocus()
        // Listen to visibilitychange
        window.addEventListener('visibilitychange', listener, false)

        return () => {
          // Be sure to unsubscribe if a new handler is set
          window.removeEventListener('visibilitychange', listener)
        }
      }
      return
    }
  }

  // 懒启动：第一个监听者到来时才真正 addEventListener。
  // 这样即使 focusManager 被 import，没有 QueryClient.mount 也不会挂全局事件。
  protected override onSubscribe(): void {
    if (!this.#cleanup) {
      this.setEventListener(this.#setup)
    }
  }

  // 最后一个监听者离开时移除 DOM 监听并把 cleanup 置空，
  // 下次 onSubscribe 会重新 setEventListener，可重入。
  protected override onUnsubscribe() {
    if (!this.hasListeners()) {
      this.#cleanup?.()
      this.#cleanup = undefined
    }
  }

  /**
   * `setEventListener` can be used to set a custom event listener that will
   * be used to determine the focus state. The provided `setup` function
   * receives a `setFocused` callback: call it with a `boolean` to manually
   * set the focus state, or with no arguments to re-evaluate the current
   * focus state and notify subscribers.
   * @param setup - Receives the `setFocused` callback, registers the event listener, and may return
   * a cleanup function that is called when the listener is replaced or no longer needed.
   * @example
   * ```ts
   * import { focusManager } from '@tanstack/query-core'
   *
   * focusManager.setEventListener((handleFocus) => {
   *   const listener = () => handleFocus()
   *   // Listen to visibilitychange
   *   if (typeof window !== 'undefined' && window.addEventListener) {
   *     window.addEventListener('visibilitychange', listener, false)
   *   }
   *
   *   return () => {
   *     // Be sure to unsubscribe if a new handler is set
   *     window.removeEventListener('visibilitychange', listener)
   *   }
   * })
   * ```
   */
  // setup 收到的是一个「可选参数」的回调：传 boolean = 直接设定状态；
  // 不传 = 让 manager 自己重算（走 isFocused 的默认判断）。
  // 默认 setup 在 visibilitychange 时不传参，也就是「按当前 visibilityState 重算」。
  setEventListener(setup: SetupFn): void {
    this.#setup = setup
    this.#cleanup?.()
    this.#cleanup = setup((focused) => {
      if (typeof focused === 'boolean') {
        this.setFocused(focused)
      } else {
        this.onFocus()
      }
    })
  }

  /**
   * `setFocused` can be used to manually set the focus state. Set `undefined`
   * to fall back to the default focus check.
   * @param focused - The focus state, or `undefined` to use the default focus check.
   * @example
   * ```ts
   * import { focusManager } from '@tanstack/query-core'
   *
   * // Set focused
   * focusManager.setFocused(true)
   *
   * // Set unfocused
   * focusManager.setFocused(false)
   *
   * // Fallback to the default focus check
   * focusManager.setFocused(undefined)
   * ```
   */
  // 只有状态真的变化才广播，避免重复 refetch。
  setFocused(focused?: boolean): void {
    const changed = this.#focused !== focused
    if (changed) {
      this.#focused = focused
      this.onFocus()
    }
  }

  /**
   * `onFocus` notifies all subscribed listeners with the current focus state.
   */
  onFocus(): void {
    const isFocused = this.isFocused()
    this.listeners.forEach((listener) => {
      listener(isFocused)
    })
  }

  /**
   * `isFocused` can be used to get the current focus state.
   * @returns The focus state set with `setFocused`, or otherwise whether the document is visible.
   */
  // `!== 'hidden'` 而不是 `=== 'visible'`：
  // 隐藏 iframe、prerender 等状态下 visibilityState 可能是 'prerender'，按「没隐藏就算聚焦」处理。
  isFocused(): boolean {
    if (typeof this.#focused === 'boolean') {
      return this.#focused
    }

    // document global can be unavailable in react native
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    return globalThis.document?.visibilityState !== 'hidden'
  }
}

/**
 * Singleton instance of {@link FocusManager}, used to manage and observe the focus state within TanStack Query.
 */
export const focusManager = new FocusManager()
