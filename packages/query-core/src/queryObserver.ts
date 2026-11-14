import { focusManager } from './focusManager'
import { isServer as isServerEnvironment } from './environmentManager'
import { notifyManager } from './notifyManager'
import { fetchState } from './query'
import { Subscribable } from './subscribable'
import {
  isValidTimeout,
  noop,
  replaceData,
  resolveQueryValue,
  shallowEqualObjects,
  timeUntilStale,
} from './utils'
import { timeoutManager } from './timeoutManager'
import type { ManagedTimerId } from './timeoutManager'
import type { FetchOptions, Query, QueryState } from './query'
import type { QueryClient } from './queryClient'
import type {
  DefaultError,
  DefaultedQueryObserverOptions,
  PlaceholderDataFunction,
  QueryKey,
  QueryObserverBaseResult,
  QueryObserverOptions,
  QueryObserverResult,
  RefetchOptions,
} from './types'

type QueryObserverListener<TData, TError> = (
  result: QueryObserverResult<TData, TError>,
) => void

interface ObserverFetchOptions extends FetchOptions {
  throwOnError?: boolean
}

/**
 * A `QueryObserver` watches a single query in the `QueryCache` and computes a
 * `QueryObserverResult` from its state, recomputing and notifying subscribers
 * whenever the underlying query (or the observer's options) changes. It is
 * the primitive that framework adapters (e.g. `useQuery`) build their hooks
 * on top of, but it can also be used directly to observe and switch between
 * queries outside of any framework.
 * @example
 * ```ts
 * const observer = new QueryObserver(queryClient, {
 *   queryKey: ['posts'],
 *   queryFn: fetchPosts,
 * })
 *
 * const unsubscribe = observer.subscribe((result) => {
 *   console.log(result.data)
 * })
 * ```
 */
// ═══ 中文注释导读 ═══
// QueryObserver 是「Query 状态」到「组件可用的 result」之间的翻译层，也是框架 hook 的真正内核。
// 一个 useQuery 调用 = 一个 QueryObserver（React 用 useState 保持它跨渲染稳定）。
// 读这个文件抓住三条主线：
//   1) 订阅线：onSubscribe 才 addObserver → 决定首屏是否 fetch → 更新定时器；
//   2) 派生线：createResult 把 query.state 派生成 status/fetchStatus/一堆布尔标记；
//   3) 通知线：updateResult 浅比较新旧 result，按 notifyOnChangeProps / 属性追踪决定是否回调监听者。
// 与 Query 的分工：Query 管「数据与取数」，Observer 管「这个观察者视角下该不该取、结果长什么样、要不要通知」。
// 因此 staleTime / enabled / refetchOn* 这些是 observer 级选项，可以按组件不同而不同。
// ──────────────────────
export class QueryObserver<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
> extends Subscribable<QueryObserverListener<TData, TError>> {
  #client: QueryClient
  // #currentQuery 与 #currentQueryInitialState 是配套的：
  // 后者保存「切换到当前 query 那一刻的 state」，专门用来算 isFetchedAfterMount
  // （本次挂载之后是否完成过一次取数 = 当前计数 > 初始计数）。
  #currentQuery: Query<TQueryFnData, TError, TQueryData, TQueryKey> = undefined!
  #currentQueryInitialState: QueryState<TQueryData, TError> = undefined!
  #currentResult: QueryObserverResult<TData, TError> = undefined!
  // 三个「上一次结果」缓存分别服务于不同优化：
  //   #currentResultState：select 的记忆化（data 引用没变就不重跑 select）与 placeholderData 判断；
  //   #currentResultOptions：判断 placeholderData 选项是否换了新函数；
  //   #currentResult：通知前的浅比较基线。
  #currentResultState?: QueryState<TQueryData, TError>
  #currentResultOptions?: QueryObserverOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryData,
    TQueryKey
  >
  #selectError: TError | null
  #selectFn?: (data: TQueryData) => TData
  #selectResult?: TData
  // This property keeps track of the last query with defined data.
  // It will be used to pass the previous data and query to the placeholder function between renders.
  #lastQueryWithDefinedData?: Query<TQueryFnData, TError, TQueryData, TQueryKey>
  #staleTimeoutId?: ManagedTimerId
  #refetchIntervalId?: ManagedTimerId
  #currentRefetchInterval?: number | false
  // 「组件读过哪些字段」的记录。只有在适配层用 trackResult 包了 result 且用户没配 notifyOnChangeProps 时才起作用；
  // 这是 v5 默认「只在你读的字段变化时重渲染」的实现基础。
  #trackedProps = new Set<keyof QueryObserverResult>()

  constructor(
    client: QueryClient,
    public options: QueryObserverOptions<
      TQueryFnData,
      TError,
      TData,
      TQueryData,
      TQueryKey
    >,
  ) {
    super()

    this.#client = client
    this.#selectError = null

    // 构造即 setOptions：会立刻 build() 出 Query（可能新建），但此时还没订阅、不可能 fetch。
    // 真正的取数发生在 onSubscribe（adapter 把 subscribe 交给框架的订阅机制之后）。
    // 「构造时 build、订阅时 fetch」这个时序是理解 SSR/首屏行为的关键。
    this.bindMethods()
    this.setOptions(options)
  }

  /**
   * Binds the methods of the result (`refetch`) to the observer, so they keep working when destructured
   * from it. Subclasses override it to bind their own result methods as well.
   */
  protected bindMethods(): void {
    this.refetch = this.refetch.bind(this)
  }

  // 只有「第一个订阅者」才做挂载动作（size === 1）。
  // addObserver 会 clearGcTimeout，并从此刻起 query 有了 active 观察者。
  // 首屏是否 fetch 由 shouldFetchOnMount 决定：无数据→必取；有数据→看 refetchOnMount 与是否 stale。
  // 不取数时也要 updateResult()：把当前缓存立刻派生成 result，供首次渲染使用。
  // 最后 #updateTimers() 排 stale 到期与 refetchInterval 两个定时器。
  protected override onSubscribe(): void {
    if (this.listeners.size === 1) {
      this.#currentQuery.addObserver(this)

      if (shouldFetchOnMount(this.#currentQuery, this.options)) {
        this.#executeFetch()
      } else {
        this.updateResult()
      }

      this.#updateTimers()
    }
  }

  // 订阅者清空即 destroy（observer 生命期与订阅者绑定，React 卸载 hook 时就是这里）。
  // destroy 内部会 removeObserver → 触发 Query 侧的 GC 调度与取消判定。
  protected override onUnsubscribe(): void {
    if (!this.hasListeners()) {
      this.destroy()
    }
  }

  /**
   * Returns whether the observed query is currently stale and configured
   * (via the `refetchOnReconnect` option) to refetch when the network
   * reconnects.
   * @returns `true` if the observer should refetch the query on reconnect.
   */
  shouldFetchOnReconnect(): boolean {
    return shouldFetchOn(
      this.#currentQuery,
      this.options,
      this.options.refetchOnReconnect,
    )
  }

  /**
   * Returns whether the observed query is currently stale and configured
   * (via the `refetchOnWindowFocus` option) to refetch when the window
   * regains focus.
   * @returns `true` if the observer should refetch the query on window focus.
   */
  shouldFetchOnWindowFocus(): boolean {
    return shouldFetchOn(
      this.#currentQuery,
      this.options,
      this.options.refetchOnWindowFocus,
    )
  }

  /**
   * Stops observing the current query: clears all listeners, cancels the
   * stale and refetch-interval timers, and removes this observer from the
   * query it was observing.
   */
  // 顺序：清监听器 → 清两个定时器 → 从 query 上摘掉自己。
  // 注意它不取消请求：是否取消由 Query.removeObserver 依据 abortSignalConsumed 决定。
  destroy(): void {
    this.listeners = new Set()
    this.#clearStaleTimeout()
    this.#clearRefetchInterval()
    this.#currentQuery.removeObserver(this)
  }

  /**
   * Updates the observer's options. This will re-resolve the query being
   * observed (switching to a different query if the `queryKey` changed),
   * trigger a fetch if the new options require one and the observer has
   * subscribers, recompute the current result, and reschedule the stale and
   * refetch-interval timers as needed.
   * @param options - The new observer options. They are defaulted with {@link
   * QueryClient#defaultQueryOptions} before being applied.
   * @throws {Error} If `enabled` is neither a boolean nor a function.
   * @example
   * ```ts
   * observer.setOptions({ queryKey: ['posts', 1], queryFn: () => fetchPost(1) })
   * // later: switch to a different query, reusing the same observer
   * observer.setOptions({ queryKey: ['posts', 2], queryFn: () => fetchPost(2) })
   * ```
   */
  // setOptions 是观察者层面的「重新对齐」：
  //   1) 用 client 默认值覆盖（_defaulted 防止重复处理）；
  //   2) 校验 enabled 只能是 boolean 或返回 boolean 的函数（开发期提前暴露配置错误）；
  //   3) #updateQuery：key/hash 变了就切到另一个 Query 并迁移订阅；
  //   4) currentQuery.setOptions：把 staleTime/gcTime/queryFn 等写回 Query（Query.options 永远是最新观察者的那份）；
  //   5) 已挂载且新条件要求取数 → executeFetch；
  //   6) updateResult + 按需重排 stale / refetchInterval 定时器。
  // 第 4 步的「写回」是有代价的：多个观察者共用同一 Query 时，最后 setOptions 的那个会覆盖 Query.options。
  // 但取数用的 options 是 fetch(this.options) 传进去的，所以行为仍按各自 observer 来。
  setOptions(
    options: QueryObserverOptions<
      TQueryFnData,
      TError,
      TData,
      TQueryData,
      TQueryKey
    >,
  ): void {
    const prevOptions = this.options
    const prevQuery = this.#currentQuery

    this.options = this.#client.defaultQueryOptions(options)

    if (
      this.options.enabled !== undefined &&
      typeof this.options.enabled !== 'boolean' &&
      typeof this.options.enabled !== 'function' &&
      typeof resolveQueryValue(this.options.enabled, this.#currentQuery) !==
        'boolean'
    ) {
      throw new Error(
        'Expected enabled to be a boolean or a callback that returns a boolean',
      )
    }

    // 先切 query 再写 options：顺序反了会把 options 写到旧 query 上。
    this.#updateQuery()
    this.#currentQuery.setOptions(this.options)

    if (
      prevOptions._defaulted &&
      !shallowEqualObjects(this.options, prevOptions)
    ) {
      this.#client.getQueryCache().notify({
        type: 'observerOptionsUpdated',
        query: this.#currentQuery,
        observer: this,
      })
    }

    const mounted = this.hasListeners()

    // Fetch if there are subscribers
    if (
      mounted &&
      shouldFetchOptionally(
        this.#currentQuery,
        prevQuery,
        this.options,
        prevOptions,
      )
    ) {
      this.#executeFetch()
    }

    // Update result
    this.updateResult()

    // Update stale interval if needed
    if (
      mounted &&
      (this.#currentQuery !== prevQuery ||
        resolveQueryValue(this.options.enabled, this.#currentQuery) !==
          resolveQueryValue(prevOptions.enabled, this.#currentQuery) ||
        resolveQueryValue(this.options.staleTime, this.#currentQuery) !==
          resolveQueryValue(prevOptions.staleTime, this.#currentQuery))
    ) {
      this.#updateStaleTimeout()
    }

    const nextRefetchInterval = this.#computeRefetchInterval()

    // Update refetch interval if needed
    if (
      mounted &&
      (this.#currentQuery !== prevQuery ||
        resolveQueryValue(this.options.enabled, this.#currentQuery) !==
          resolveQueryValue(prevOptions.enabled, this.#currentQuery) ||
        nextRefetchInterval !== this.#currentRefetchInterval)
    ) {
      this.#updateRefetchInterval(nextRefetchInterval)
    }
  }

  /**
   * Computes the result the observer would produce for the given (already-defaulted) options
   * right now, building the underlying `Query` if it doesn't exist yet, without waiting for a
   * subscription callback. Called by framework adapters on every render (e.g. `useQuery`) so the
   * returned value is available synchronously, ahead of `setOptions` triggering an actual fetch.
   * @param options - The defaulted observer options to compute the result for.
   * @returns The result for the given options.
   */
  getOptimisticResult(
    options: DefaultedQueryObserverOptions<
      TQueryFnData,
      TError,
      TData,
      TQueryData,
      TQueryKey
    >,
  ): QueryObserverResult<TData, TError> {
    const query = this.#client.getQueryCache().build(this.#client, options)

    const result = this.createResult(query, options)

    // 乐观结果与当前结果不同才「移动游标」。
    // 下方长注释解释的场景：queryKey 切换后，select 记忆化依赖 currentResultState 与 currentResult 一致；
    // 若不在这里同步游标，新数据回来时会拿旧 key 的 currentResult 做记忆化，导致 select 结果错位。
    if (!shallowEqualObjects(this.getCurrentResult(), result)) {
      // this assigns the optimistic result to the current Observer
      // because if the query function changes, useQuery will be performing
      // an effect where it would fetch again.
      // When the fetch finishes, we perform a deep data cloning in order
      // to reuse objects references. This deep data clone is performed against
      // the `observer.currentResult.data` property
      // When QueryKey changes, we refresh the query and get new `optimistic`
      // result, while we leave the `observer.currentResult`, so when new data
      // arrives, it finds the old `observer.currentResult` which is related
      // to the old QueryKey. Which means that currentResult and selectData are
      // out of sync already.
      // To solve this, we move the cursor of the currentResult every time
      // an observer reads an optimistic value.

      // When keeping the previous data, the result doesn't change until new
      // data arrives.
      this.#currentResult = result
      this.#currentResultOptions = this.options
      this.#currentResultState = this.#currentQuery.state
    }
    return result
  }

  /**
   * Returns the most recently computed `QueryObserverResult` for the
   * observed query. This is a point-in-time read; to be notified of updates
   * as they happen, subscribe to the observer instead (its inherited
   * `subscribe` method).
   * @returns The observer's latest result.
   * @example
   * ```ts
   * const result = observer.getCurrentResult()
   * console.log(result.status, result.data)
   * ```
   */
  // 无副作用的点读。框架在 useSyncExternalStore 的 getSnapshot 里调用。
  getCurrentResult(): QueryObserverResult<TData, TError> {
    return this.#currentResult
  }

  /**
   * Wraps a `QueryObserverResult` in a `Proxy` that records which properties are read, via
   * {@link QueryObserver#trackProp} (and an optional `onPropTracked` callback). Used by framework
   * adapters when `notifyOnChangeProps` is not set, to implement its default "only re-render on
   * properties you actually read" behavior.
   * @param result - The result to wrap.
   * @param onPropTracked - Called with the name of each property that is read.
   * @returns A proxy of `result` that tracks property reads.
   */
  // Proxy 记录字段读访问。适配层只在「未配置 notifyOnChangeProps」时才包这一层，
  // 于是开发者的 `const { data } = useQuery(...)` 会自动变成「只订阅 data」。
  // 这是编译期无法做到、只能在运行时用 Proxy 做的依赖收集。
  trackResult(
    result: QueryObserverResult<TData, TError>,
    onPropTracked?: (key: keyof QueryObserverResult) => void,
  ): QueryObserverResult<TData, TError> {
    return new Proxy(result, {
      get: (target, key) => {
        this.trackProp(key as keyof QueryObserverResult)
        onPropTracked?.(key as keyof QueryObserverResult)
        return Reflect.get(target, key)
      },
    })
  }

  /**
   * Records that the given `QueryObserverResult` property was read, so a subsequent update only
   * notifies this observer if a tracked property actually changed. Normally called indirectly via
   * {@link QueryObserver#trackResult}'s proxy; exposed directly for adapters that track property
   * access themselves (e.g. through their own reactivity system) instead of via the proxy.
   * @param key - The name of the property that was read.
   */
  trackProp(key: keyof QueryObserverResult) {
    this.#trackedProps.add(key)
  }

  /**
   * Returns the `Query` instance this observer is currently observing.
   * @returns The observed query.
   */
  getCurrentQuery(): Query<TQueryFnData, TError, TQueryData, TQueryKey> {
    return this.#currentQuery
  }

  /**
   * Refetches the observed query and returns a promise that resolves with
   * the resulting `QueryObserverResult`.
   * @param options - Set `cancelRefetch` to `false` to keep a running fetch instead of cancelling
   * it, and `throwOnError` to `true` to reject when the refetch fails.
   * @returns A promise that resolves with the result after the refetch.
   * @example
   * ```ts
   * const result = await observer.refetch({ cancelRefetch: false })
   * console.log(result.data)
   * ```
   */
  // refetch 与 fetch 的差别只有默认值：refetch 走 protected fetch() → cancelRefetch 默认 true。
  // 也就是说组件手动 refresh 默认会打断旧请求；而 Query.onFocus 调的是 refetch({cancelRefetch:false})。
  refetch({ ...options }: RefetchOptions = {}): Promise<
    QueryObserverResult<TData, TError>
  > {
    return this.fetch({
      ...options,
    })
  }

  /**
   * Fetches a query defined by the given options without affecting this
   * observer's own tracked query or result, and returns a promise that
   * resolves with the `QueryObserverResult` for that fetch. This is useful
   * for prefetching data that another observer (e.g. a query about to be
   * navigated to) will need, ahead of time.
   * @param options - The observer options of the query to fetch.
   * @returns A promise that resolves with the result for the fetched query.
   * @example
   * ```ts
   * const result = await observer.fetchOptimistic({
   *   queryKey: ['posts', 2],
   *   queryFn: () => fetchPost(2),
   * })
   * console.log(result.data)
   * ```
   */
  // 用于 suspense 与 prefetch：在不影响本 observer 结果的前提下取一次数。
  // 两条竞争路径的用意：
  //   · query.fetch(...)：正常路径，fetch 完成即返回；
  //   · cachePromise：监听 cache 的 'updated' 事件，只要「同一个 query 有了 data」就提前返回。
  // 后者覆盖「别的 observer 先取到了数据」的情况，避免这里白等一个已被复用的请求。
  // Promise.race 之后仍要 unsubscribe()，否则缓存事件监听会泄漏。
  fetchOptimistic(
    options: QueryObserverOptions<
      TQueryFnData,
      TError,
      TData,
      TQueryData,
      TQueryKey
    >,
  ): Promise<QueryObserverResult<TData, TError>> {
    const defaultedOptions = this.#client.defaultQueryOptions(options)

    const query = this.#client
      .getQueryCache()
      .build(this.#client, defaultedOptions)

    let unsubscribe = () => {}
    let resolveEarly:
      | ((result: QueryObserverResult<TData, TError>) => void)
      | undefined

    const cachePromise = new Promise<QueryObserverResult<TData, TError>>(
      (resolve) => {
        resolveEarly = resolve
        unsubscribe = this.#client.getQueryCache().subscribe((event) => {
          if (
            event.type === 'updated' &&
            event.query.queryHash === query.queryHash &&
            query.state.data !== undefined
          ) {
            unsubscribe()
            resolve(this.createResult(query, defaultedOptions))
          }
        })
      },
    )

    return Promise.race([
      query
        .fetch(defaultedOptions)
        .then(() => {
          const result = this.createResult(query, defaultedOptions)
          // Settle the subscriber promise so both branches always settle.
          // This value is ignored by Promise.race since the fetch branch already won.
          resolveEarly?.(result)
          return result
        })
        .finally(() => {
          unsubscribe()
        }),
      cachePromise,
    ])
  }

  /**
   * Fetches the observed query and updates the result once the fetch settles. Used by `refetch` and,
   * in `InfiniteQueryObserver`, to fetch more pages.
   * @param fetchOptions - Options for this fetch. `cancelRefetch` defaults to `true`.
   * @returns A promise that resolves with the updated result.
   */
  // 统一入口：执行 fetch → 等结算 → updateResult → 返回最新 result。
  // 返回的是「结果」而不是 data，因为调用方（refetch/fetchNextPage）需要完整状态。
  protected fetch(
    fetchOptions: ObserverFetchOptions,
  ): Promise<QueryObserverResult<TData, TError>> {
    return this.#executeFetch({
      ...fetchOptions,
      cancelRefetch: fetchOptions.cancelRefetch ?? true,
    }).then(() => {
      this.updateResult()
      return this.#currentResult
    })
  }

  // 取数前先 #updateQuery()：query 可能已被 removeQueries 删掉，此时要重新 build 一个，
  // 否则会往一个已销毁的实例上写数据。
  // 非 throwOnError 时 catch(noop) 吞错：错误已经写进 state，会通过 result 呈现，不需要再抛。
  #executeFetch(
    fetchOptions?: Omit<ObserverFetchOptions, 'initialPromise'>,
  ): Promise<TQueryData | undefined> {
    // Make sure we reference the latest query as the current one might have been removed
    this.#updateQuery()

    // Fetch
    let promise: Promise<TQueryData | undefined> = this.#currentQuery.fetch(
      this.options,
      fetchOptions,
    )

    if (!fetchOptions?.throwOnError) {
      promise = promise.catch(noop)
    }

    return promise
  }

  // 三个前置条件：非服务端、observer 未被禁用、超时值是有限数。
  // 服务端不排定时器是 SSR 安全性的关键（Node 进程里挂着成千上万个 refetchInterval 会窒息）。
  #shouldScheduleTimer(timeout: unknown): timeout is number {
    return (
      !isServerEnvironment() &&
      resolveQueryValue(this.options.enabled, this.#currentQuery) !== false &&
      isValidTimeout(timeout)
    )
  }

  // 只在「当前还不 stale」时排：已经 stale 就没必要等，下次挂载/聚焦自然会取。
  // `time + 1` 是规避定时器精度问题（有时会提前 1ms 触发，导致看到的仍是 fresh，从而永不重排）。
  // 回调里再判一次 isStale，仍然 fresh 才 updateResult —— 定时器只是「让 result 重新派生一次」。
  #updateStaleTimeout(): void {
    this.#clearStaleTimeout()
    const staleTime = resolveQueryValue(
      this.options.staleTime,
      this.#currentQuery,
    )

    if (this.#currentResult.isStale || !this.#shouldScheduleTimer(staleTime)) {
      return
    }

    const time = timeUntilStale(this.#currentResult.dataUpdatedAt, staleTime)

    // The timeout is sometimes triggered 1 ms before the stale time expiration.
    // To mitigate this issue we always add 1 ms to the timeout.
    const timeout = time + 1

    this.#staleTimeoutId = timeoutManager.setTimeout(() => {
      if (!this.#currentResult.isStale) {
        this.updateResult()
      }
    }, timeout)
  }

  #computeRefetchInterval() {
    return (
      resolveQueryValue(this.options.refetchInterval, this.#currentQuery) ??
      false
    )
  }

  // interval 为 0 视为关闭（0 是 falsy，容易误判为「立即轮询」）。
  // 每次触发都检查 focus（除非 refetchIntervalInBackground）：后台标签页默认不轮询。
  // 这里直接 #executeFetch，不经过 refetch，所以不会打断已有请求（fetchOptions 未传 cancelRefetch）。
  #updateRefetchInterval(nextInterval: number | false): void {
    this.#clearRefetchInterval()

    this.#currentRefetchInterval = nextInterval

    if (
      this.#currentRefetchInterval === 0 ||
      !this.#shouldScheduleTimer(this.#currentRefetchInterval)
    ) {
      return
    }

    this.#refetchIntervalId = timeoutManager.setInterval(() => {
      if (
        this.options.refetchIntervalInBackground ||
        focusManager.isFocused()
      ) {
        this.#executeFetch()
      }
    }, this.#currentRefetchInterval)
  }

  #updateTimers(): void {
    this.#updateStaleTimeout()
    this.#updateRefetchInterval(this.#computeRefetchInterval())
  }

  #clearStaleTimeout(): void {
    if (this.#staleTimeoutId !== undefined) {
      timeoutManager.clearTimeout(this.#staleTimeoutId)
      this.#staleTimeoutId = undefined
    }
  }

  #clearRefetchInterval(): void {
    if (this.#refetchIntervalId !== undefined) {
      timeoutManager.clearInterval(this.#refetchIntervalId)
      this.#refetchIntervalId = undefined
    }
  }

  /**
   * Computes the result for a query and options from the query's state, applying `select`,
   * `placeholderData`, and the derived flags. Subclasses override it to add their own fields.
   * @param query - The query to compute the result for.
   * @param options - The observer options to compute the result with.
   * @returns The computed result.
   */
  // 派生逻辑的全部入口。输入 query.state + options，输出组件用的 result。
  // 处理顺序：乐观 fetching 态 → placeholderData → select → select 错误 → 计算各类布尔标记。
  // 关键点：result 里的 status/fetchStatus 基本来自 state，但 isLoading/isRefetchError 这类是组合出来的；
  // 因此「状态只有 3×3 种组合」这句话要落到这些布尔值上才算读懂。
  protected createResult(
    query: Query<TQueryFnData, TError, TQueryData, TQueryKey>,
    options: QueryObserverOptions<
      TQueryFnData,
      TError,
      TData,
      TQueryData,
      TQueryKey
    >,
  ): QueryObserverResult<TData, TError> {
    const prevQuery = this.#currentQuery
    const prevOptions = this.options
    const prevResult = this.#currentResult as
      | QueryObserverResult<TData, TError>
      | undefined
    const prevResultState = this.#currentResultState
    const prevResultOptions = this.#currentResultOptions
    const queryChange = query !== prevQuery
    const queryInitialState = queryChange
      ? query.state
      : this.#currentQueryInitialState

    const { state } = query
    let newState = { ...state }
    let isPlaceholderData = false
    let data: TData | undefined

    // Optimistically set result in fetching state if needed
    // 乐观态：在真正订阅/发起 fetch 之前，先按「如果现在取数会怎样」派生出 fetching 结果。
    // 这是首屏不闪「空态」的原因：第一次渲染就能拿到 isFetching/isLoading=true。
    // 'isRestoring' 是持久化恢复期间的特例：强制 fetchStatus='idle'，避免恢复还没完成就显示「加载中」。
    if (options._optimisticResults) {
      const mounted = this.hasListeners()

      const fetchOnMount = !mounted && shouldFetchOnMount(query, options)

      const fetchOptionally =
        mounted && shouldFetchOptionally(query, prevQuery, options, prevOptions)

      if (fetchOnMount || fetchOptionally) {
        newState = {
          ...newState,
          ...fetchState(state.data, query.options),
        }
      }
      if (options._optimisticResults === 'isRestoring') {
        newState.fetchStatus = 'idle'
      }
    }

    let { error, errorUpdatedAt, status } = newState

    // Per default, use query data
    data = newState.data as unknown as TData
    let skipSelect = false

    // use placeholderData if needed
    // placeholderData 只在「无 data 且 status 仍为 pending」时顶替，不会盖掉已有数据。
    // 记忆化：如果上一次结果就是 placeholder 且选项函数没换，直接复用上一次的 data ——
    // 因为 prevResult.data 已经过 select，所以 skipSelect=true，不能再 select 一遍。
    // 新占位数据也要走 replaceData 做结构共享，保证引用稳定。
    if (
      options.placeholderData !== undefined &&
      data === undefined &&
      status === 'pending'
    ) {
      let placeholderData

      // Memoize placeholder data
      if (
        prevResult?.isPlaceholderData &&
        options.placeholderData === prevResultOptions?.placeholderData
      ) {
        placeholderData = prevResult.data
        // we have to skip select when reading this memoization
        // because prevResult.data is already "selected"
        skipSelect = true
      } else {
        // compute placeholderData
        placeholderData =
          typeof options.placeholderData === 'function'
            ? (
                options.placeholderData as unknown as PlaceholderDataFunction<TQueryData>
              )(
                this.#lastQueryWithDefinedData?.state.data,
                this.#lastQueryWithDefinedData as any,
              )
            : options.placeholderData
      }

      if (placeholderData !== undefined) {
        status = 'success'
        data = replaceData(
          prevResult?.data,
          placeholderData as unknown,
          options,
        ) as TData
        isPlaceholderData = true
      }
    }

    // Select data if needed
    // this also runs placeholderData through the select function
    // select 记忆化条件很严格：上一次 result 存在、源 data 引用未变、select 函数引用未变。
    // 三条同时成立才复用 #selectResult，否则重跑。
    // select 抛错不会冒泡：捕获后存到 #selectError，本次结果变成 error 状态（见下个分支）。
    // select 之后还要 replaceData：因为 select 常返回新对象，结构共享能把「内容相同」的新对象折叠回旧引用。
    if (options.select && data !== undefined && !skipSelect) {
      // Memoize select result
      if (
        prevResult &&
        data === prevResultState?.data &&
        options.select === this.#selectFn
      ) {
        data = this.#selectResult
      } else {
        try {
          this.#selectFn = options.select
          data = options.select(data as any)
          data = replaceData(prevResult?.data, data, options)
          this.#selectResult = data
          this.#selectError = null
        } catch (selectError) {
          this.#selectError = selectError as TError
        }
      }
    } else if (data === undefined) {
      // a stored select error belongs to previously selected data; once that
      // data is gone (query switch or reset), it must not leak into this result
      this.#selectError = null
    }

    // select 错误是「粘性」的：只要 select 一直抛，就一直用 #selectError 覆盖状态；
    // 一旦数据被切走（data === undefined 的 else 分支）就清空，避免旧 key 的 select 错误泄漏到新 key。
    if (this.#selectError) {
      error = this.#selectError
      data = this.#selectResult
      errorUpdatedAt =
        prevResult?.error === error ? prevResult.errorUpdatedAt : Date.now()
      status = 'error'
      isPlaceholderData = false
    }

    const isFetching = newState.fetchStatus === 'fetching'
    const isPending = status === 'pending'
    const isError = status === 'error'

    const isLoading = isPending && isFetching
    const hasData = data !== undefined

    // 三个容易混的布尔值：
    //   isPending：没有可展示的数据（status 层）；
    //   isFetching：正在取数（fetchStatus 层）；
    //   isLoading = isPending && isFetching：首次加载（两者都真）；
    //   isRefetching = isFetching && !isPending：已有数据时的后台刷新。
    // 错误同理：isLoadingError（无数据时失败）vs isRefetchError（有数据但刷新失败）。
    // isStale 走本文件的 isStale()（enabled 为 false 时永远不算 stale），不要与 Query.isStale 混用。
    const result: QueryObserverBaseResult<TData, TError> = {
      status,
      fetchStatus: newState.fetchStatus,
      isPending,
      isSuccess: status === 'success',
      isError,
      isInitialLoading: isLoading,
      isLoading,
      data,
      dataUpdatedAt: newState.dataUpdatedAt,
      error,
      errorUpdatedAt,
      failureCount: newState.fetchFailureCount,
      failureReason: newState.fetchFailureReason,
      errorUpdateCount: newState.errorUpdateCount,
      isFetched: query.isFetched(),
      isFetchedAfterMount:
        newState.dataUpdateCount > queryInitialState.dataUpdateCount ||
        newState.errorUpdateCount > queryInitialState.errorUpdateCount,
      isFetching,
      isRefetching: isFetching && !isPending,
      isLoadingError: isError && !hasData,
      isPaused: newState.fetchStatus === 'paused',
      isPlaceholderData,
      isRefetchError: isError && hasData,
      isStale: isStale(query, options),
      refetch: this.refetch,
      isEnabled: resolveQueryValue(options.enabled, query) !== false,
    }

    const nextResult = result as QueryObserverResult<TData, TError>

    return nextResult
  }

  /**
   * Recomputes and stores the current result from the current query/options, notifying listeners
   * if it changed. Framework adapters call this right after subscribing to make sure no query
   * update was missed in the gap between creating the observer and subscribing to it.
   */
  // 通知前的三步：重算 → 记录用于下次记忆化的 state/options → 更新 #lastQueryWithDefinedData。
  // #lastQueryWithDefinedData 只记「有 data 的那个 query」，placeholderData 函数拿它当上一份数据来源。
  updateResult(): void {
    const prevResult = this.#currentResult as
      | QueryObserverResult<TData, TError>
      | undefined

    const nextResult = this.createResult(this.#currentQuery, this.options)

    this.#currentResultState = this.#currentQuery.state
    this.#currentResultOptions = this.options

    if (this.#currentResultState.data !== undefined) {
      this.#lastQueryWithDefinedData = this.#currentQuery
    }

    // Only notify and update result if something has changed
    if (shallowEqualObjects(nextResult, prevResult)) {
      return
    }

    this.#currentResult = nextResult

    // 通知判定，优先级从上到下：
    //   1) 没有旧 result → 必通知（首次）
    //   2) notifyOnChangeProps === 'all' → 必通知
    //   3) 未配置且没有任何 trackedProps → 必通知（适配层没做追踪时的保守行为）
    //   4) throwOnError 且 error 变了 → 必通知（要重新抛给 ErrorBoundary）
    //   5) 否则只比较「被追踪的字段 / 配置的字段」
    // 注意第 5 步只做浅比较：嵌套对象内容变了但引用没变时不会通知，这是结构共享必须保证引用稳定的原因。
    const shouldNotifyListeners = (): boolean => {
      if (!prevResult) {
        return true
      }

      const { notifyOnChangeProps } = this.options
      const notifyOnChangePropsValue =
        typeof notifyOnChangeProps === 'function'
          ? notifyOnChangeProps()
          : notifyOnChangeProps

      if (
        notifyOnChangePropsValue === 'all' ||
        (!notifyOnChangePropsValue && !this.#trackedProps.size)
      ) {
        return true
      }

      if (
        this.options.throwOnError &&
        this.#currentResult.error !== prevResult.error
      ) {
        return true
      }

      for (const key of notifyOnChangePropsValue ?? this.#trackedProps) {
        if (
          this.#currentResult[key as keyof QueryObserverResult] !==
          prevResult[key as keyof QueryObserverResult]
        ) {
          return true
        }
      }
      return false
    }

    const notifyListeners = shouldNotifyListeners()

    notifyManager.batch(() => {
      // First, trigger the listeners
      if (notifyListeners) {
        this.listeners.forEach((listener) => {
          listener(this.#currentResult)
        })
      }

      // Then the cache listeners
      this.#client.getQueryCache().notify({
        query: this.#currentQuery,
        type: 'observerResultsUpdated',
      })
    })
  }

  // build 出 options.queryHash 对应的 query；同一个就直接返回。
  // 切换 query 时：记录新 query 的初始 state，并且「只有在已订阅时」才迁移 observer（先摘旧的、再挂新的）。
  // 未订阅时只改指针：等 onSubscribe 时再一次性挂上，避免在构造/渲染期产生副作用。
  #updateQuery(): void {
    const query = this.#client.getQueryCache().build(this.#client, this.options)

    if (query === this.#currentQuery) {
      return
    }

    const prevQuery = this.#currentQuery as
      | Query<TQueryFnData, TError, TQueryData, TQueryKey>
      | undefined
    this.#currentQuery = query
    this.#currentQueryInitialState = query.state

    if (this.hasListeners()) {
      prevQuery?.removeObserver(this)
      query.addObserver(this)
    }
  }

  /**
   * Updates the observer's result when the observed query changes, and reschedules its timers if it
   * has listeners.
   * @internal
   */
  // Query.#dispatch 遍历 observers 时调的就是它。
  // 顺序：先 updateResult（可能通知组件），再在「有订阅者」时重排定时器（stale 可能刚刚变化）。
  onQueryUpdate(): void {
    this.updateResult()

    if (this.hasListeners()) {
      this.#updateTimers()
    }
  }
}

/**
 * Checks whether a query has no data yet and should do its initial load when an observer mounts.
 * @param query - The query to check.
 * @param options - The observer options.
 * @returns `true` if the query is enabled, has no data, and isn't in an error state with
 * `retryOnMount: false`.
 */
// 「首屏必须有数据」的唯一语义：enabled、当前无 data、且不是「上次错误 + retryOnMount:false」。
// 第三条是为了配合 ErrorBoundary：错误边界已展示错误时，重新挂载不应自动重试。
function shouldLoadOnMount(
  query: Query<any, any, any, any>,
  options: QueryObserverOptions<any, any, any, any>,
): boolean {
  return (
    resolveQueryValue(options.enabled, query) !== false &&
    query.state.data === undefined &&
    !(
      query.state.status === 'error' &&
      resolveQueryValue(options.retryOnMount, query) === false
    )
  )
}

/**
 * Checks whether a query should fetch when an observer mounts: either for its initial load, or
 * because it has data and `refetchOnMount` asks for a refetch.
 * @param query - The query to check.
 * @param options - The observer options.
 * @returns `true` if the query should fetch on mount.
 */
// 首屏取数 = 首次加载(shouldLoadOnMount) 或 已有数据但 refetchOnMount 要求刷新。
// refetchOnMount 默认 true，但只有 stale 才真的取；所以「有新鲜数据时挂载不发请求」。
function shouldFetchOnMount(
  query: Query<any, any, any, any>,
  options: QueryObserverOptions<any, any, any, any, any>,
): boolean {
  return (
    shouldLoadOnMount(query, options) ||
    (query.state.data !== undefined &&
      shouldFetchOn(query, options, options.refetchOnMount))
  )
}

/**
 * Checks whether a query should fetch for a `refetchOnMount`, `refetchOnWindowFocus`, or
 * `refetchOnReconnect` option.
 * @param query - The query to check.
 * @param options - The observer options.
 * @param field - The value of the option to check.
 * @returns `true` if the query is enabled, not static, and the option is `'always'`, or is not
 * `false` and the query is stale.
 */
// refetchOnMount / refetchOnWindowFocus / refetchOnReconnect 三者共用这一套判定：
//   'always' → 取；false → 不取；其余（true/undefined）→ 只在 stale 时取。
// 前提是 enabled 且 staleTime 不是 'static'。
function shouldFetchOn(
  query: Query<any, any, any, any>,
  options: QueryObserverOptions<any, any, any, any, any>,
  field: (typeof options)['refetchOnMount'] &
    (typeof options)['refetchOnWindowFocus'] &
    (typeof options)['refetchOnReconnect'],
) {
  if (
    resolveQueryValue(options.enabled, query) !== false &&
    resolveQueryValue(options.staleTime, query) !== 'static'
  ) {
    const value = resolveQueryValue(field, query)

    return value === 'always' || (value !== false && isStale(query, options))
  }
  return false
}

/**
 * Checks whether a query should fetch after the observer's options change.
 * @param query - The query observed with the new options.
 * @param prevQuery - The query observed with the previous options.
 * @param options - The new observer options.
 * @param prevOptions - The previous observer options.
 * @returns `true` if the query changed or was disabled before, it isn't a suspense query in an
 * error state, and it is stale.
 */
// options 变化后的取数判定：只有「换了 query」或「刚从 disabled 变 enabled」才考虑，
// 且 suspense 模式下如果 query 处于 error 态就不自动重取（交给 ErrorBoundary/重试按钮）。
function shouldFetchOptionally(
  query: Query<any, any, any, any>,
  prevQuery: Query<any, any, any, any>,
  options: QueryObserverOptions<any, any, any, any, any>,
  prevOptions: QueryObserverOptions<any, any, any, any, any>,
): boolean {
  return (
    (query !== prevQuery ||
      resolveQueryValue(prevOptions.enabled, query) === false) &&
    (!options.suspense || query.state.status !== 'error') &&
    isStale(query, options)
  )
}

/**
 * Checks whether a query is stale for the given observer options.
 * @param query - The query to check.
 * @param options - The observer options, whose `enabled` and `staleTime` are used.
 * @returns `true` if the query is enabled and its data is stale for `staleTime`.
 */
function isStale(
  query: Query<any, any, any, any>,
  options: QueryObserverOptions<any, any, any, any, any>,
): boolean {
  return (
    resolveQueryValue(options.enabled, query) !== false &&
    query.isStaleByTime(resolveQueryValue(options.staleTime, query))
  )
}
