import {
  ensureQueryFn,
  fetchSignal,
  noop,
  replaceData,
  resolveQueryValue,
  skipToken,
  timeUntilStale,
} from './utils'
import { notifyManager } from './notifyManager'
import { CancelledError, canFetch, createRetryer } from './retryer'
import { Removable } from './removable'
import { infiniteQueryBehavior } from './infiniteQueryBehavior'
import type { QueryCache } from './queryCache'
import type { QueryClient } from './queryClient'
import type {
  CancelOptions,
  DefaultError,
  FetchStatus,
  InitialDataFunction,
  OmitKeyof,
  QueryFunctionContext,
  QueryKey,
  QueryMeta,
  QueryOptions,
  QueryStatus,
  SetDataOptions,
  StaleTime,
} from './types'
import type { QueryObserver } from './queryObserver'
import type { Retryer } from './retryer'

// TYPES

interface QueryConfig<
  TQueryFnData,
  TError,
  TData,
  TQueryKey extends QueryKey = QueryKey,
> {
  client: QueryClient
  queryKey: TQueryKey
  queryHash: string
  options?: QueryOptions<TQueryFnData, TError, TData, TQueryKey>
  defaultOptions?: QueryOptions<TQueryFnData, TError, TData, TQueryKey>
  state?: QueryState<TData, TError>
}

/**
 * The raw state stored on a `Query` instance. This is the underlying state
 * that observer results (e.g. `QueryObserverResult`) are derived from.
 */
export interface QueryState<TData = unknown, TError = DefaultError> {
  /**
   * The last successfully resolved data for the query.
   */
  data: TData | undefined
  /**
   * The number of times the query has successfully resolved.
   */
  dataUpdateCount: number
  /**
   * The timestamp for when the query most recently returned the `status` as `"success"`.
   */
  dataUpdatedAt: number
  /**
   * The error object for the query, if the last attempt resulted in an error.
   * - Defaults to `null`.
   */
  error: TError | null
  /**
   * The sum of all errors, incremented every time the query resolves with an error.
   */
  errorUpdateCount: number
  /**
   * The timestamp for when the query most recently returned the `status` as `"error"`.
   */
  errorUpdatedAt: number
  /**
   * The failure count for the current fetch.
   * - Incremented every time the fetch fails.
   * - Reset to `0` when the fetch succeeds.
   */
  fetchFailureCount: number
  /**
   * The reason the current fetch failed, as reported by the retryer.
   * - Reset to `null` when the fetch succeeds.
   */
  fetchFailureReason: TError | null
  /**
   * Metadata passed to the currently in-flight (or most recent) fetch, e.g. the
   * `fetchMore` direction for infinite queries.
   */
  fetchMeta: FetchMeta | null
  /**
   * Whether the query has been marked as invalidated via `invalidate()`.
   * - Reset to `false` whenever the query resolves successfully.
   */
  isInvalidated: boolean
  /**
   * The status of the query.
   * - `pending` if there's no cached data and no attempt was finished yet.
   * - `error` if the last attempt resulted in an error.
   * - `success` if the query has data.
   */
  status: QueryStatus
  /**
   * The fetch status of the query.
   * - `fetching`: the `queryFn` is currently executing.
   * - `paused`: a fetch wanted to run but has been paused (see network mode).
   * - `idle`: the query is not fetching.
   */
  fetchStatus: FetchStatus
}

/**
 * The context passed to a {@link QueryBehavior}'s `onFetch`, which can replace `fetchFn` to change
 * how the query fetches (e.g. to fetch pages for an infinite query).
 */
export interface FetchContext<
  TQueryFnData,
  TError,
  TData,
  TQueryKey extends QueryKey = QueryKey,
> {
  /**
   * The function that runs the fetch. By default it calls `queryFn`; `onFetch` can replace it.
   */
  fetchFn: () => unknown | Promise<unknown>
  /**
   * The options of this fetch.
   */
  fetchOptions?: FetchOptions
  /**
   * The `AbortSignal` that aborts when the fetch is cancelled.
   */
  signal: AbortSignal
  /**
   * The options of the query.
   */
  options: QueryOptions<TQueryFnData, TError, TData, any>
  /**
   * The `QueryClient` the query belongs to.
   */
  client: QueryClient
  /**
   * The key of the query.
   */
  queryKey: TQueryKey
  /**
   * The state of the query when the fetch starts.
   */
  state: QueryState<TData, TError>
}

/**
 * Customizes how a query fetches, e.g. the behavior that fetches the pages of an infinite query.
 */
export interface QueryBehavior<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
> {
  /**
   * Called before each fetch of the query, e.g. to replace `fetchFn` in the context.
   */
  onFetch: (
    context: FetchContext<TQueryFnData, TError, TData, TQueryKey>,
    query: Query,
  ) => void
}

/**
 * The direction an infinite query fetches in: `'forward'` for the next page, `'backward'` for the
 * previous one.
 */
export type FetchDirection = 'forward' | 'backward'

/**
 * Metadata for a fetch, e.g. the direction when an infinite query fetches more pages.
 */
export interface FetchMeta {
  /**
   * Set when an infinite query fetches another page, with the direction to fetch in.
   */
  fetchMore?: { direction: FetchDirection }
}

/**
 * Options for a single fetch of a query.
 */
export interface FetchOptions<TData = unknown> {
  /**
   * If `true`, an in-flight fetch is cancelled before starting a new one, when the query already
   * has data. Otherwise, the in-flight fetch is reused.
   */
  cancelRefetch?: boolean
  /**
   * Metadata of the fetch, stored in the query's `fetchMeta` state.
   */
  meta?: FetchMeta
  /**
   * A promise to use for the first attempt instead of calling `fetchFn`, e.g. a pending promise
   * restored by `hydrate`.
   */
  initialPromise?: Promise<TData>
}

interface FailedAction<TError> {
  type: 'failed'
  failureCount: number
  error: TError
}

interface FetchAction {
  type: 'fetch'
  meta?: FetchMeta
}

interface SuccessAction<TData> {
  data: TData | undefined
  type: 'success'
  dataUpdatedAt?: number
  manual?: boolean
}

interface ErrorAction<TError> {
  type: 'error'
  error: TError
}

interface InvalidateAction {
  type: 'invalidate'
}

interface PauseAction {
  type: 'pause'
}

interface ContinueAction {
  type: 'continue'
}

interface SetStateAction<TData, TError> {
  type: 'setState'
  state: Partial<QueryState<TData, TError>>
}

/**
 * The actions a query dispatches to update its state, e.g. when it starts fetching, fails, or
 * succeeds.
 */
export type Action<TData, TError> =
  | ContinueAction
  | ErrorAction<TError>
  | FailedAction<TError>
  | FetchAction
  | InvalidateAction
  | PauseAction
  | SetStateAction<TData, TError>
  | SuccessAction<TData>

// CLASS

/**
 * Represents a single cached query. A `Query` holds the query's key, options,
 * state (data/error/status), and the observers currently subscribed to it.
 *
 * Instances are created and managed internally by `QueryCache`; application
 * code typically interacts with queries indirectly through `QueryClient` or
 * a framework hook like `useQuery`. Direct access to a `Query` instance is
 * possible via `queryCache.find()`/`findAll()` for inspecting cache state.
 * @example
 * ```ts
 * const queryCache = queryClient.getQueryCache()
 * const query = queryCache.find({ queryKey: ['posts'] })
 *
 * if (query) {
 *   console.log(query.state.dataUpdatedAt)
 * }
 * ```
 */
// ═══ 中文注释导读（本文件是整条链路的核心，建议按下面 5 块读）═══
// Query = 「一个 queryKey 对应的一份缓存 + 一个显式状态机」。它自己不会主动取数：
//   · 谁触发 fetch？QueryObserver（首屏 / refetch / 定时器 / 聚焦）或 QueryClient 的命令式 API；
//   · 谁读 state？QueryObserver.createResult 把 state 派生成组件用的 result；
//   · 谁决定生死？Removable 的 gcTime 定时器 + observers 数量（见 optionalRemove）。
// 建议顺序：
//   ① 状态字段与构造（queryKey/state/#retryer/#revertState 各自代表什么）
//   ② 状态迁移的唯一入口 #dispatch（8 个 action 的 reducer）
//   ③ fetch()（去重 → 组装 context → retryer → 结算/取消）
//   ④ 观察者生命周期（addObserver/removeObserver 与取消语义）
//   ⑤ 纯查询型判定（isStale/isActive/isDisabled…，它们只是把 state 翻译成布尔值）
// 一个必须记住的不变量：state 只能通过 #dispatch 修改（setData/setState/invalidate/fetch 内部都走它），
// 因此「谁改了状态、改完之后通知了谁」永远只有一个答案。
// ──────────────────────
export class Query<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
> extends Removable {
  queryKey: TQueryKey
  queryHash: string
  options!: QueryOptions<TQueryFnData, TError, TData, TQueryKey>
  state: QueryState<TData, TError>
  #queryType?: 'infinite'

  #initialState: QueryState<TData, TError>
  // 取消回滚用的快照。三处写入，读的时候对照着看：
  //   1) fetch 开始前保存当前 state；
  //   2) success 且非 manual 时置 undefined（已经成功，没有可回滚的了）；
  //   3) success 且 manual（setQueryData）时置为刚写入的新 state —— 这样后续 cancel({revert:true})
  //      会回滚到「手动写入之后」而不是「手动写入之前」。
  #revertState?: QueryState<TData, TError>
  #cache: QueryCache
  #client: QueryClient
  // #retryer 表示「此刻有一次在途 fetch」。它是判断能否复用在途请求、能否取消的唯一依据。
  // fetch 结束时（finally）会在 `this.#retryer === retryer` 时清空，
  // 这个同一性判断很重要：如果期间已有新 fetch 覆盖，旧 fetch 的收尾不能把新的 retryer 抹掉。
  // #fetchPromise 与 #retryer.promise 不是同一个对象：前者是本文件包装后的 promise（带 setData、回调、错误分支），
  // 后者是 retryer 内部的原始 promise。去重时返回的是 #fetchPromise。
  #retryer?: Retryer<TData>
  #fetchPromise?: Promise<TData>
  observers: Array<QueryObserver<any, any, any, any, any>>
  #defaultOptions?: QueryOptions<TQueryFnData, TError, TData, TQueryKey>
  #abortSignalConsumed: boolean

  constructor(config: QueryConfig<TQueryFnData, TError, TData, TQueryKey>) {
    super()

    // 是否「读过 signal」的标记。它决定 removeObserver 时是取消请求还是让请求跑完（见 removeObserver）。
    // 每次 fetch 开始与 queryFn 调用前都会重置，避免上一次 fetch 的读取污染这一次。
    this.#abortSignalConsumed = false
    this.#defaultOptions = config.defaultOptions
    // 注意构造顺序：setOptions 先跑，此时 this.state 还不存在，
    // 所以 setOptions 里必须用 `if (this.state && ...)` 保护（源码里那条 oxlint-disable 就是为此）。
    // 之后才创建 #initialState 与 state —— reset() 回滚的目标就是 #initialState。
    this.setOptions(config.options)
    this.observers = []
    this.#client = config.client
    this.#cache = this.#client.getQueryCache()
    this.queryKey = config.queryKey
    this.queryHash = config.queryHash
    this.#initialState = getDefaultState(this.options)
    this.state = config.state ?? this.#initialState
    // 新建即排 GC：一个从未被观察过的 query（例如只 build 没 subscribe）也会在 gcTime 后被回收。
    // 一旦有 observer subscribe，QueryObserver.onSubscribe → query.addObserver → clearGcTimeout 取消它。
    this.scheduleGc()
  }
  /**
   * The `meta` object passed in the query's options, if any.
   * @returns The query's `meta`, or `undefined` if none was set.
   */
  get meta(): QueryMeta | undefined {
    return this.options.meta
  }

  /**
   * `'infinite'` for an infinite query, otherwise `undefined`.
   * @internal
   * @returns The type of the query, set from the `_type` option (e.g. `'infinite'`).
   */
  get queryType() {
    return this.#queryType
  }

  /**
   * The promise for the currently in-flight fetch, if the query is fetching.
   * `undefined` when the query is not fetching.
   * @returns The promise of the in-flight fetch, or `undefined`.
   */
  get promise(): Promise<TData> | undefined {
    return this.#retryer?.promise
  }

  /**
   * Replaces the query's options and applies their `gcTime`. If the query has no data yet, it gets
   * the `initialData` from the new options, if any.
   * @internal
   * @param options - The new query options, merged on top of the query's default options.
   */
  // 合并顺序：默认值（构造时传入的 defaultOptions）< 本次 options。
  // initialData 只在「当前还没有 data」时生效，因此不会覆盖已经取到的真实数据；
  // 生效时同步刷新 #initialState，保证之后的 reset() 会回到这份 initialData 而不是 undefined。
  setOptions(
    options?: QueryOptions<TQueryFnData, TError, TData, TQueryKey>,
  ): void {
    this.options = { ...this.#defaultOptions, ...options }

    if (options?._type) {
      this.#queryType = options._type
    }

    this.updateGcTime(this.options.gcTime)

    // oxlint-disable-next-line typescript/no-unnecessary-condition -- the constructor calls 'setOptions' before it assigns 'state'
    if (this.state && this.state.data === undefined) {
      const defaultState = getDefaultState(this.options)
      if (defaultState.data !== undefined) {
        this.setState(
          successState(defaultState.data, defaultState.dataUpdatedAt),
        )
        this.#initialState = defaultState
      }
    }
  }

  // GC 到点后的最终判定：必须同时满足「没有 observer」与「不在 fetching」，否则放弃本次回收。
  // 放弃时不再重新 scheduleGc —— 下一次 removeObserver / fetch 结束会重新排。
  protected override optionalRemove() {
    if (!this.observers.length && this.state.fetchStatus === 'idle') {
      this.#cache.remove(this)
    }
  }

  /**
   * Writes new data to the query and marks it as successfully fetched.
   * @internal
   * @param newData - The data to write. Structural sharing with the current data is applied.
   * @param options - Set `updatedAt` to override the timestamp, and `manual` to mark the write as
   * manual (e.g. from `queryClient.setQueryData`).
   * @returns The data that was written.
   */
  // 所有「写入成功数据」的路径都汇聚到这里：fetch 成功、setQueryData、hydration 恢复、streamedQuery 增量写。
  // replaceData 做结构共享：新数据与旧数据深度相等时返回旧引用，于是本次 dispatch 产出的 state 变化最小，
  // 下游 observer 的浅比较才有机会判定「没变化、不通知」。
  setData(
    newData: TData,
    options?: SetDataOptions & { manual: boolean },
  ): TData {
    const data = replaceData(this.state.data, newData, this.options)

    // Set data and mark it as cached
    this.#dispatch({
      data,
      type: 'success',
      dataUpdatedAt: options?.updatedAt,
      manual: options?.manual,
    })

    return data
  }

  /**
   * Merges the given partial state directly into this query's state, notifying observers. Used
   * by persistence and broadcast plugins to restore a state snapshot, and by devtools to let a
   * user manually trigger a loading/error state or edit the cached data.
   * @param state - The partial state to merge into the query's state.
   */
  // 直接合并部分 state，不做任何推导。用于：持久化/广播插件恢复快照、devtools 手动改状态、
  // 以及本文件的 reset() 与取消回滚。
  // 注意它是浅合并：传 data 时最好同时传 dataUpdatedAt，否则时间戳还是旧的。
  setState(state: Partial<QueryState<TData, TError>>): void {
    this.#dispatch({ type: 'setState', state })
  }

  /**
   * Cancels the query's currently in-flight fetch, if any.
   * - Returns a promise that resolves once the cancellation has settled.
   * - If no fetch is in progress, resolves immediately.
   * @param options - Set `revert` to restore the state from before the fetch started, and `silent`
   * to suppress the cancellation error when a new fetch replaces the cancelled one.
   * @returns A promise that resolves once the cancellation has settled.
   * @example
   * ```ts
   * await query.cancel()
   * ```
   */
  // 先取 promise 再 cancel：cancel 会同步 reject，之后再取就晚了。
  // then(noop).catch(noop) 把「取消导致 reject」吞掉，返回的 promise 只表示「取消动作已结束」。
  // 若当前没有在途 fetch，直接 resolve。
  cancel(options?: CancelOptions): Promise<void> {
    const promise = this.#retryer?.promise
    this.#retryer?.cancel(options)
    return promise ? promise.then(noop).catch(noop) : Promise.resolve()
  }

  /**
   * Clears the query's garbage collection timeout and silently cancels any
   * in-flight fetch. Called by `QueryCache` when the query is removed from
   * the cache.
   * @see {@link Query#cancel}
   */
  // destroy = 撤 GC 定时器 + 静默取消在途 fetch。
  // 静默（silent）的含义见 retryer 的 CancelledError：不把取消当成错误抛给等待者。
  // QueryCache.remove 调用的就是它，所以「removeQueries 会顺带打断请求」。
  override destroy(): void {
    super.destroy()

    this.cancel({ silent: true })
  }

  /**
   * The state the query was created with.
   * @internal
   * @returns The state the query had when it was first created, used by {@link Query#reset}.
   */
  get resetState(): QueryState<TData, TError> {
    return this.#initialState
  }

  /**
   * Resets the query back to its initial state (the state it had when it was
   * first created, e.g. any `initialData`), destroying it first to cancel any
   * in-flight fetch.
   */
  // 先 destroy 再回到初始态：destroy 保证在途请求不会在 reset 之后又把数据写回来。
  // resetState 是构造时的 #initialState（含 initialData），不是空状态。
  reset(): void {
    this.destroy()
    this.setState(this.resetState)
  }

  /**
   * Returns `true` if the query has at least one observer for which `enabled`
   * does not resolve to `false`.
   * @returns `true` if the query has an enabled observer.
   */
  // 「有至少一个 observer 且其 enabled 不为 false」= active。
  // QueryFilters.type: 'active' / refetchType 默认值都基于这个判定。
  isActive(): boolean {
    return this.observers.some(
      (observer) => resolveQueryValue(observer.options.enabled, this) !== false,
    )
  }

  /**
   * Returns `true` if the query is disabled, meaning it will not fetch
   * automatically.
   * - If the query has observers, it is disabled when none of them are active
   *   (see `isActive`).
   * - If the query has no observers, it is disabled when its `queryFn` is
   *   `skipToken` or it has never been fetched.
   * @returns `true` if the query is disabled.
   */
  // 两套判定，别混：
  //   有 observer 时：等价于 !isActive()，即所有 observer 都 enabled:false；
  //   没 observer 时：queryFn 是 skipToken，或从未成功/失败过一次（isFetched 为假）。
  // refetchQueries 会先过滤掉 isDisabled 的 query，这条规则让「从未启用」的查询不会被命令式重取。
  isDisabled(): boolean {
    if (this.getObserversCount() > 0) {
      return !this.isActive()
    }
    // if a query has no observers, it should still be considered disabled if it never attempted a fetch
    return this.options.queryFn === skipToken || !this.isFetched()
  }

  /**
   * Returns `true` if the query has been fetched, i.e. it has resolved with
   * either data or an error at least once.
   * @returns `true` if the query has been fetched.
   */
  // 用「成功次数 + 失败次数 > 0」表示「尝试过」。
  // 因此一个失败过的 query 也算 fetched —— 它决定了 retryOnMount、isFetchedAfterMount 等语义。
  isFetched() {
    return this.state.dataUpdateCount + this.state.errorUpdateCount > 0
  }

  /**
   * Returns `true` if the query has data and at least one observer configured with
   * `staleTime: 'static'`, meaning it is treated as never stale.
   * @returns `true` if the query is static.
   */
  isStatic(): boolean {
    if (this.state.data === undefined) {
      return false
    }

    if (this.getObserversCount() > 0) {
      return this.observers.some(
        (observer) =>
          resolveQueryValue(observer.options.staleTime, this) === 'static',
      )
    }

    return false
  }

  /**
   * Returns `true` if the query is stale.
   * - If the query has observers, defers to whether any observer's current
   *   result reports `isStale` (which accounts for each observer's own
   *   `staleTime` and `enabled` state).
   * - If the query has no observers, it is considered stale when it has no
   *   data or has been invalidated.
   * @returns `true` if the query is stale.
   * @see {@link Query#isStaleByTime}
   * @example
   * ```ts
   * if (query.isStale()) {
   *   // refetch or otherwise treat the cached data as outdated
   * }
   * ```
   */
  // 有 observer 时以 observer 的 result.isStale 为准：因为 staleTime 可以被每个 observer 覆盖，
  // 同一个 query 对不同组件可能一个 stale 一个不 stale。
  // 没 observer 时退回最粗的判定：没数据或已 invalidate。
  isStale(): boolean {
    // check observers first, their `isStale` has the source of truth
    // calculated with `isStaleByTime` and it takes `enabled` into account
    if (this.getObserversCount() > 0) {
      return this.observers.some(
        (observer) => observer.getCurrentResult().isStale,
      )
    }

    return this.state.data === undefined || this.state.isInvalidated
  }

  /**
   * Returns `true` if the query's data is stale relative to the given
   * `staleTime` (defaults to `0`).
   * - A query with no data is always stale.
   * - `staleTime: 'static'` is never stale.
   * - An invalidated query is always stale.
   * - Otherwise, staleness is based on elapsed time since `dataUpdatedAt`.
   * @param staleTime - The time, in milliseconds, after which data is considered stale, or
   * `'static'` to never treat existing data as stale. A query without data is stale either way.
   * @returns `true` if the query's data is stale.
   * @see {@link Query#isStale}
   * @example
   * ```ts
   * const isStale = query.isStaleByTime(60 * 1000)
   * ```
   */
  // 四步短路顺序：无数据 → 必 stale；'static' → 永 stale 为假；已 invalidate → 必 stale；最后才看时间差。
  // invalidate 优先于 'static' 是刻意的：invalidate 是「人为宣告过期」，应压过配置。
  isStaleByTime(staleTime: StaleTime = 0): boolean {
    // no data is always stale
    if (this.state.data === undefined) {
      return true
    }
    // static is never stale
    if (staleTime === 'static') {
      return false
    }
    // if the query is invalidated, it is stale
    if (this.state.isInvalidated) {
      return true
    }

    return !timeUntilStale(this.state.dataUpdatedAt, staleTime)
  }

  /**
   * Refetches the query when the window regains focus, if an observer wants that, and continues a
   * paused fetch.
   * @internal
   */
  // 聚焦重取的真实决策点：在 observers 里找第一个 shouldFetchOnWindowFocus() 为真的，
  // 用它触发 refetch，且 cancelRefetch:false（不打断已在跑的请求）。
  // 之后无条件 retryer.continue()：把因失焦而暂停的重试放行。
  // onOnline 与之同构，只是谓词换成 shouldFetchOnReconnect()。
  onFocus(): void {
    const observer = this.observers.find((x) => x.shouldFetchOnWindowFocus())

    observer?.refetch({ cancelRefetch: false })

    // Continue fetch if currently paused
    this.#retryer?.continue()
  }

  /**
   * Refetches the query when the app reconnects, if an observer wants that, and continues a paused
   * fetch.
   * @internal
   */
  onOnline(): void {
    const observer = this.observers.find((x) => x.shouldFetchOnReconnect())

    observer?.refetch({ cancelRefetch: false })

    // Continue fetch if currently paused
    this.#retryer?.continue()
  }

  /**
   * Subscribes an observer to the query and stops its garbage collection.
   * @internal
   * @param observer - The observer to add. Adding an observer that is already subscribed does
   * nothing.
   */
  // 第一个 observer 的到来会 clearGcTimeout —— 这就是「有人看就不回收」的实现点。
  // 重复添加直接忽略（数组 includes 判重）。
  addObserver(observer: QueryObserver<any, any, any, any, any>): void {
    if (!this.observers.includes(observer)) {
      this.observers.push(observer)

      // Stop the query from being garbage collected
      this.clearGcTimeout()

      this.#cache.notify({ type: 'observerAdded', query: this, observer })
    }
  }

  /**
   * Unsubscribes an observer from the query.
   * @internal
   * @param observer - The observer to remove. When the last observer is removed, the in-flight
   * fetch is cancelled if its abort signal was consumed (otherwise only its retries are stopped),
   * and garbage collection is scheduled.
   */
  // 只有「最后一个 observer 离开」才处理在途请求，分三种情况：
  //   a) queryFn 读过 signal，或 (paused 且 status=pending)：cancel({revert:true})，真正中断并回滚；
  //   b) 否则 cancelRetry()：不中断当前请求，只禁止后续重试 —— 让结果仍能写入缓存，供下次挂载直接命中；
  //   c) 没有 retryer：什么都不做。
  // 最后 scheduleGc()：从现在开始倒计时回收。
  // 这就是「组件卸载后请求还在跑」与「请求被取消」两种行为的唯一分叉点。
  removeObserver(observer: QueryObserver<any, any, any, any, any>): void {
    const index = this.observers.indexOf(observer)
    if (index !== -1) {
      this.observers.splice(index, 1)

      if (!this.observers.length) {
        // If the transport layer does not support cancellation
        // we'll let the query continue so the result can be cached
        if (this.#retryer) {
          if (
            this.#abortSignalConsumed ||
            (this.state.fetchStatus === 'paused' &&
              this.state.status === 'pending')
          ) {
            this.#retryer.cancel({ revert: true })
          } else {
            this.#retryer.cancelRetry()
          }
        }

        this.scheduleGc()
      }

      this.#cache.notify({ type: 'observerRemoved', query: this, observer })
    }
  }

  /**
   * Returns the number of observers currently subscribed to this query.
   * @returns The number of observers.
   * @example
   * ```ts
   * if (query.getObserversCount() === 0) {
   *   // no component is currently watching this query
   * }
   * ```
   */
  getObserversCount(): number {
    return this.observers.length
  }

  /**
   * Marks the query as invalidated, unless it is already invalidated. This
   * updates `state.isInvalidated` and notifies observers, but does not by
   * itself trigger a refetch.
   * @example
   * ```ts
   * query.invalidate()
   * ```
   */
  // 只改标记、不取数。真正重取由 QueryClient.invalidateQueries 之后的 refetchQueries 负责。
  // 幂等：已经 invalidate 过就不再 dispatch，避免重复通知。
  invalidate(): void {
    if (!this.state.isInvalidated) {
      this.#dispatch({ type: 'invalidate' })
    }
  }

  /**
   * Fetches the query, i.e. runs its `queryFn` (through any configured
   * retryer/behavior) and updates the query's state with the result.
   * - If a fetch is already in flight, returns its promise instead of
   *   starting a new one, unless `fetchOptions.cancelRefetch` is set and the
   *   query already has data, in which case the current fetch is silently
   *   cancelled first.
   * - If `options` is passed, it replaces the query's current options
   *   before fetching.
   * @param options - Query options that replace the query's current options before fetching. They
   * are not applied when an in-flight fetch is reused.
   * @param fetchOptions - Set `cancelRefetch` to cancel an in-flight fetch first (only if the query
   * already has data), and `meta` to pass extra information to the query's behavior.
   * @returns A promise that resolves with the fetched data, or rejects with the fetch error. If the
   * fetch is cancelled with `revert` while the query has data, it resolves with the restored data
   * instead.
   */
  // ── ③ fetch：状态机的外部驱动入口 ──
  // 完整顺序：复用判定 → 合并 options → 组装 AbortController/signal → 组装 fetchFn 与 context
  //          → behavior.onFetch（无限查询改 fetchFn）→ 保存 revertState → dispatch('fetch')
  //          → 建 retryer 并 start → 等 promise → 成功 setData / 失败 dispatch('error') → finally 清理。
  async fetch(
    options?: QueryOptions<TQueryFnData, TError, TData, TQueryKey>,
    fetchOptions?: FetchOptions<TQueryFnData>,
  ): Promise<TData> {
    // 去重分支的前提：已经在 fetching/paused，且 retryer 没处于已 reject 状态。
    // 「已 reject 还要重开」是个补丁：promise 已 reject 但 fetchStatus 可能还没回到 idle（异步间隙），
    // 此时必须允许重新发起，否则会返回一个已失败的 promise。
    if (
      this.state.fetchStatus !== 'idle' &&
      // If the promise in the retryer is already rejected, we have to definitely
      // re-start the fetch; there is a chance that the query is still in a
      // pending state when that happens
      this.#retryer?.status() !== 'rejected'
    ) {
      // cancelRefetch 只在「已有 data」时打断旧请求；没有 data 时保留旧请求（首个数据比新请求更重要）。
      // silent 表示这次取消不产生用户可见的错误。
      // 注意这里没有 return：取消后继续往下走，新建一次 fetch。
      if (this.state.data !== undefined && fetchOptions?.cancelRefetch) {
        // Silently cancel current fetch if the user wants to cancel refetch
        this.cancel({ silent: true })
      // 复用分支：直接返回同一个 #fetchPromise，这就是「同一 queryKey 并发只发一个请求」的落点。
      // continueRetry() 是补偿：observer 卸载可能把重试关掉过（cancelRetry），有新观察者回来时重新打开。
      } else if (this.#retryer && this.#fetchPromise) {
        // make sure that retries that were potentially cancelled due to unmounts can continue
        this.#retryer.continueRetry()
        // Return current promise if we are already fetching
        return this.#fetchPromise
      }
    }

    // Update config if passed, otherwise the config from the last execution is used
    if (options) {
      this.setOptions(options)
    }

    // Use the options from the first observer with a query function if no function is found.
    // This can happen when the query is hydrated or created with setQueryData.
    // 补 queryFn：hydration 或 setQueryData 建出来的 query 没有 queryFn，
    // 此时从任意一个带 queryFn 的 observer 借一份 options（refetch 依赖它）。
    if (!this.options.queryFn) {
      const observer = this.observers.find((x) => x.options.queryFn)
      if (observer) {
        this.setOptions(observer.options)
      }
    }

    if (process.env.NODE_ENV !== 'production') {
      if (!Array.isArray(this.options.queryKey)) {
        console.error(
          `As of v4, queryKey needs to be an Array. If you are using a string like 'repoData', please change it to an Array, e.g. ['repoData']`,
        )
      }
    }

    const abortController = new AbortController()

    // Adds an enumerable signal property to the object that
    // which sets abortSignalConsumed to true when the signal
    // is read.
    // signal 用 getter 懒返回：read 时才把 #abortSignalConsumed 置 true。
    // 同时用 Symbol 键挂一份原始 signal（enumerable 但不会序列化），供无限查询内部透传；读取它不计入消费。
    // addConsumeAwareSignal（utils.ts）是同一套逻辑的复用版本，两处语义保持一致。
    const addSignalProperty = (object: object) => {
      Object.defineProperties(object, {
        [fetchSignal]: { value: abortController.signal, enumerable: true },
        signal: {
          enumerable: true,
          get: () => {
            this.#abortSignalConsumed = true
            return abortController.signal
          },
        },
      })
    }

    // Create fetch function
    // fetchFn 是「这一次 fetch 的最小执行单元」，会被 retryer 每次重试重新调用。
    // context 每次重建（含新的 signal getter），因此重试拿到的 signal 仍是同一个 abortController 的。
    // persister 存在时，queryFn 被交给 persister 包装（离线持久化场景）。
    const fetchFn = () => {
      const queryFn = ensureQueryFn(this.options, fetchOptions)

      // Create query function context
      const createQueryFnContext = (): QueryFunctionContext<TQueryKey> => {
        const queryFnContext: OmitKeyof<
          QueryFunctionContext<TQueryKey>,
          'signal'
        > = {
          client: this.#client,
          queryKey: this.queryKey,
          meta: this.meta,
        }
        addSignalProperty(queryFnContext)
        return queryFnContext as QueryFunctionContext<TQueryKey>
      }

      const queryFnContext = createQueryFnContext()

      this.#abortSignalConsumed = false
      if (this.options.persister) {
        return this.options.persister(
          queryFn,
          queryFnContext,
          this as unknown as Query,
        )
      }

      return queryFn(queryFnContext)
    }

    // Trigger behavior hook
    const createFetchContext = (): FetchContext<
      TQueryFnData,
      TError,
      TData,
      TQueryKey
    > => {
      const context: OmitKeyof<
        FetchContext<TQueryFnData, TError, TData, TQueryKey>,
        'signal'
      > = {
        fetchOptions,
        options: this.options,
        queryKey: this.queryKey,
        client: this.#client,
        state: this.state,
        fetchFn,
      }

      addSignalProperty(context)
      return context as FetchContext<TQueryFnData, TError, TData, TQueryKey>
    }

    const context = createFetchContext()

    // 行为钩子：无限查询在这里把 fetchFn 换成分页版本；普通查询用 options.behavior（自定义扩展点）。
    // onFetch 必须同步执行完（它只改 context.fetchFn），真正的取数仍由 retryer 触发。
    const behavior =
      this.#queryType === 'infinite'
        ? (infiniteQueryBehavior(
            (this.options as { pages?: number }).pages,
          ) as QueryBehavior<TQueryFnData, TError, TData, TQueryKey>)
        : this.options.behavior
    behavior?.onFetch(context, this as unknown as Query)

    // Store state in case the current fetch needs to be reverted
    // 在 dispatch('fetch') 之前保存：撤销量要回到「开始取数之前」，而不是 fetching 中间态。
    // 接着的 dispatch 只在 fetchStatus 非 idle 或 meta 变化时才发，避免重复通知（fetchMeta 用于无限查询方向）。
    this.#revertState = this.state

    // Set to fetching state if not already in it
    if (
      this.state.fetchStatus === 'idle' ||
      this.state.fetchMeta !== context.fetchOptions?.meta
    ) {
      this.#dispatch({ type: 'fetch', meta: context.fetchOptions?.meta })
    }

    // Try to fetch the data
    // retryer 的四个回调全部翻译成 action，Query 自身不维护重试计数。
    // onCancel 里：revert 型取消回滚到 #revertState 并把 fetchStatus 置 idle；最后一定 abort 掉底层请求。
    // canRun: () => true —— 对 query 而言「能否运行」只由 networkMode 决定，没有 mutation 那种串行 scope。
    const retryer = (this.#retryer = createRetryer({
      initialPromise: fetchOptions?.initialPromise as
        | Promise<TData>
        | undefined,
      fn: context.fetchFn as () => Promise<TData>,
      onCancel: (error) => {
        if (error instanceof CancelledError && error.revert) {
          this.setState({
            ...this.#revertState,
            fetchStatus: 'idle' as const,
          })
        }
        abortController.abort()
      },
      onFail: (failureCount, error) => {
        this.#dispatch({ type: 'failed', failureCount, error })
      },
      onPause: () => {
        this.#dispatch({ type: 'pause' })
      },
      onContinue: () => {
        this.#dispatch({ type: 'continue' })
      },
      retry: context.options.retry,
      retryDelay: context.options.retryDelay,
      networkMode: context.options.networkMode,
      canRun: () => true,
    }))

    // 包装层负责把「retryer 的结果」翻译成「query 状态 + 缓存级回调」，并处理取消的三种姿态：
    //   silent + 已被新 fetch 取代 → 返回新 fetch 的 promise（调用方无感）；
    //   revert + 有 data → 返回 data（视为成功回滚）；
    //   revert + 无 data → 继续抛 CancelledError（首个请求被取消，确实没有数据可给）。
    // 成功路径：setData → 触发 cache.config.onSuccess/onSettled → 返回 data。
    // 失败路径：dispatch('error') → 触发 onError/onSettled → 原样 rethrow。
    const fetchPromise = (async () => {
      try {
        const data = await retryer.promise
        // this is more of a runtime guard
        if (data === undefined) {
          if (process.env.NODE_ENV !== 'production') {
            console.error(
              `Query data cannot be undefined. Please make sure to return a value other than undefined from your query function. Affected query key: ${this.queryHash}`,
            )
          }
          throw new Error(`${this.queryHash} data is undefined`)
        }

        // data === undefined 会被当成错误（上方有开发环境提示）：queryFn 必须返回值，
        // 否则无法区分「成功但无数据」与「还没完成」。
        this.setData(data)

        // Notify cache callback
        this.#cache.config.onSuccess?.(data, this as Query<any, any, any, any>)
        this.#cache.config.onSettled?.(
          data,
          this.state.error as any,
          this as Query<any, any, any, any>,
        )
        return data
      } catch (error) {
        if (error instanceof CancelledError) {
          if (error.silent) {
            if (this.#retryer !== retryer && this.#fetchPromise) {
              // A new fetch replaced the silently cancelled one,
              // so we piggyback onto that promise.
              return this.#fetchPromise
            }
            throw error
          } else if (error.revert) {
            // transform error into reverted state data
            // if the initial fetch was cancelled, we have no data, so we have
            // to get reject with a CancelledError
            if (this.state.data === undefined) {
              throw error
            }
            return this.state.data
          }
        }
        this.#dispatch({
          type: 'error',
          error: error as TError,
        })

        // Notify cache callback
        this.#cache.config.onError?.(
          error as any,
          this as Query<any, any, any, any>,
        )
        this.#cache.config.onSettled?.(
          this.state.data,
          error as any,
          this as Query<any, any, any, any>,
        )

        throw error // rethrow the error for further handling
      // 收尾三件事：清 #retryer/#fetchPromise（同一性判断防止覆盖新 fetch）、排 GC、
      // 注释里提到的「pin 住 raw result」是真实的内存考虑：retryer 的 promise 会持有 fetch 的原始返回值，
      // 不清掉就会在 query 生命周期内多留一份数据副本。
      } finally {
        // The settled retryer's promise would otherwise pin this fetch's raw
        // result (a second copy after structural sharing) for the query's lifetime
        if (this.#retryer === retryer) {
          this.#retryer = undefined
          this.#fetchPromise = undefined
        }
        // Schedule query gc after fetching
        this.scheduleGc()
      }
    })()
    this.#fetchPromise = fetchPromise
    // 先赋值 #fetchPromise 再 start：start 可能同步进入 run，run 内部若失败会走到 catch，
    // 那里需要读到最新的 #fetchPromise。
    retryer.start()
    return fetchPromise
  }

  // ── ② #dispatch：整个文件的「状态写入唯一入口」 ──
  // reducer 是纯函数（除 success 分支写 #revertState），之后统一做两件通知：
  //   1) 同步遍历 observers 调 onQueryUpdate（observer 再自行 updateResult）；
  //   2) 发 QueryCache 的 'updated' 事件（带 action，devtools/持久化据此判断发生了什么）。
  // observers.slice() 是防御：通知过程中 observer 可能同步退订，直接遍历会跳过元素。
  #dispatch(action: Action<TData, TError>): void {
    const reducer = (
      state: QueryState<TData, TError>,
    ): QueryState<TData, TError> => {
      switch (action.type) {
        case 'failed':
          return {
            ...state,
            fetchFailureCount: action.failureCount,
            fetchFailureReason: action.error,
          }
        case 'pause':
          return {
            ...state,
            fetchStatus: 'paused',
          }
        case 'continue':
          return {
            ...state,
            fetchStatus: 'fetching',
          }
        case 'fetch':
          return {
            ...state,
            ...fetchState(state.data, this.options),
            fetchMeta: action.meta ?? null,
          }
        // non-manual（真实 fetch 成功）：顺便把 fetchStatus 置 idle、清零失败计数/原因。
        // manual（setQueryData）：保留当前 fetchStatus 与失败计数 —— 手动写数据不该影响在途请求的状态。
        // 两者都会通过 successState 把 isInvalidated 置回 false。
        case 'success':
          const newState = {
            ...state,
            ...successState(action.data, action.dataUpdatedAt),
            dataUpdateCount: state.dataUpdateCount + 1,
            ...(!action.manual && {
              fetchStatus: 'idle' as const,
              fetchFailureCount: 0,
              fetchFailureReason: null,
            }),
          }
          // If fetching ends successfully, we don't need revertState as a fallback anymore.
          // For manual updates, capture the state to revert to it in case of a cancellation.
          this.#revertState = action.manual ? newState : undefined

          return newState
        // 失败一定 isInvalidated = true：即使有旧数据，也标记为需要重新验证。
        // 注意 status 直接变 'error'，但同时保留 state.data —— 这就是 isRefetchError（有数据但刷新失败）的来源。
        // fetchStatus 置 idle 表示本轮取数结束，重试与否由 retryer 决定（retryer 内部还在跑时不会走到这里）。
        case 'error':
          const error = action.error
          return {
            ...state,
            error,
            errorUpdateCount: state.errorUpdateCount + 1,
            errorUpdatedAt: Date.now(),
            fetchFailureCount: state.fetchFailureCount + 1,
            fetchFailureReason: error,
            fetchStatus: 'idle',
            status: 'error',
            // flag existing data as invalidated if we get a background error
            // note that "no data" always means stale so we can set unconditionally here
            isInvalidated: true,
          }
        // 只置标记，不动 data/status。
        case 'invalidate':
          return {
            ...state,
            isInvalidated: true,
          }
        case 'setState':
          return {
            ...state,
            ...action.state,
          }
      }
    }

    this.state = reducer(this.state)

    notifyManager.batch(() => {
      // Keep the current iteration stable if an observer unsubscribes
      // synchronously while it is being notified.
      this.observers.slice().forEach((observer) => {
        observer.onQueryUpdate()
      })

      this.#cache.notify({ query: this, type: 'updated', action })
    })
  }
}

/**
 * Returns the state changes applied when a query starts fetching.
 * @param data - The query's current data. If it is `undefined`, the query is also reset to
 * `'pending'` with no error.
 * @param options - The query options, whose `networkMode` decides whether the query is `'fetching'`
 * or `'paused'`.
 * @returns The partial query state for a starting fetch.
 */
// dispatch('fetch') 与 QueryObserver.createResult 的乐观结果共用这份推导：
// 无 data 时同时把 status 拉回 pending、error 清空（重新开始，而不是带着旧错误）；
// fetchStatus 由 networkMode 决定：canFetch 为假则直接进入 'paused'。
export function fetchState<
  TQueryFnData,
  TError,
  TData,
  TQueryKey extends QueryKey,
>(
  data: TData | undefined,
  options: QueryOptions<TQueryFnData, TError, TData, TQueryKey>,
) {
  return {
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchStatus: canFetch(options.networkMode) ? 'fetching' : 'paused',
    ...(data === undefined &&
      ({
        error: null,
        status: 'pending',
      } as const)),
  } as const
}

/**
 * Returns the state changes applied when a query receives data.
 * @param data - The new data.
 * @param dataUpdatedAt - The timestamp the data is recorded with. Defaults to the current time.
 * @returns The partial query state for a successful update.
 */
function successState<TData>(data: TData | undefined, dataUpdatedAt?: number) {
  return {
    data,
    dataUpdatedAt: dataUpdatedAt ?? Date.now(),
    error: null,
    isInvalidated: false,
    status: 'success' as const,
  }
}

/**
 * Returns the initial state of a query, based on its `initialData` and `initialDataUpdatedAt`
 * options.
 * @param options - The query options.
 * @returns The initial query state: `'success'` if `initialData` is set, otherwise `'pending'`.
 */
// 初始态：有 initialData → status 'success' 且 dataUpdatedAt 取 initialDataUpdatedAt（可能为 0，
// 表示「数据很旧」，从而让首次挂载必然 stale 并触发后台刷新）；没有 → 'pending'。
// 注意 dataUpdatedAt 与 status 是配套的，devtools 里看到的「新鲜度」完全由这两个字段决定。
function getDefaultState<
  TQueryFnData,
  TError,
  TData,
  TQueryKey extends QueryKey,
>(
  options: QueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): QueryState<TData, TError> {
  const data =
    typeof options.initialData === 'function'
      ? (options.initialData as InitialDataFunction<TData>)()
      : options.initialData

  const hasData = data !== undefined

  const initialDataUpdatedAt = hasData
    ? typeof options.initialDataUpdatedAt === 'function'
      ? options.initialDataUpdatedAt()
      : options.initialDataUpdatedAt
    : 0

  return {
    data,
    dataUpdateCount: 0,
    dataUpdatedAt: hasData ? (initialDataUpdatedAt ?? Date.now()) : 0,
    error: null,
    errorUpdateCount: 0,
    errorUpdatedAt: 0,
    fetchFailureCount: 0,
    fetchFailureReason: null,
    fetchMeta: null,
    isInvalidated: false,
    status: hasData ? 'success' : 'pending',
    fetchStatus: 'idle',
  }
}
