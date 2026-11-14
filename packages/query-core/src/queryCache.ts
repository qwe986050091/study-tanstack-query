import { hashQueryKeyByOptions, matchQuery } from './utils'
import { Query } from './query'
import { notifyManager } from './notifyManager'
import { Subscribable } from './subscribable'
import type { QueryFilters } from './utils'
import type { Action, QueryState } from './query'
import type {
  DefaultError,
  NotifyEvent,
  QueryKey,
  QueryOptions,
  WithRequired,
} from './types'
import type { QueryClient } from './queryClient'
import type { QueryObserver } from './queryObserver'

// TYPES

/**
 * Global callbacks that fire for every query handled by a `QueryCache`, regardless of which
 * component or observer triggered it. Unlike `QueryClient`'s `defaultOptions`, which a query can
 * override, these callbacks are always called. Unlike `MutationCacheConfig`'s callbacks, these
 * are fire-and-forget: their return value is not awaited before the query settles.
 */
export interface QueryCacheConfig {
  /** Called when any query in the cache encounters an error. */
  onError?: (
    error: DefaultError,
    query: Query<unknown, unknown, unknown>,
  ) => void
  /** Called when any query in the cache is successful. */
  onSuccess?: (data: unknown, query: Query<unknown, unknown, unknown>) => void
  /** Called when any query in the cache is settled, either successfully or with an error. */
  onSettled?: (
    data: unknown | undefined,
    error: DefaultError | null,
    query: Query<unknown, unknown, unknown>,
  ) => void
}

interface NotifyEventQueryAdded extends NotifyEvent {
  type: 'added'
  query: Query<any, any, any, any>
}

interface NotifyEventQueryRemoved extends NotifyEvent {
  type: 'removed'
  query: Query<any, any, any, any>
}

interface NotifyEventQueryUpdated extends NotifyEvent {
  type: 'updated'
  query: Query<any, any, any, any>
  action: Action<any, any>
}

interface NotifyEventQueryObserverAdded extends NotifyEvent {
  type: 'observerAdded'
  query: Query<any, any, any, any>
  observer: QueryObserver<any, any, any, any, any>
}

interface NotifyEventQueryObserverRemoved extends NotifyEvent {
  type: 'observerRemoved'
  query: Query<any, any, any, any>
  observer: QueryObserver<any, any, any, any, any>
}

interface NotifyEventQueryObserverResultsUpdated extends NotifyEvent {
  type: 'observerResultsUpdated'
  query: Query<any, any, any, any>
}

interface NotifyEventQueryObserverOptionsUpdated extends NotifyEvent {
  type: 'observerOptionsUpdated'
  query: Query<any, any, any, any>
  observer: QueryObserver<any, any, any, any, any>
}

/**
 * The event passed to a `QueryCache` subscriber. Fired whenever a query is added or removed from
 * the cache, its state is updated (e.g. via `query.setState` or `queryClient.removeQueries`), or
 * one of its observers is added, removed, or has its results or options updated.
 */
export type QueryCacheNotifyEvent =
  | NotifyEventQueryAdded
  | NotifyEventQueryRemoved
  | NotifyEventQueryUpdated
  | NotifyEventQueryObserverAdded
  | NotifyEventQueryObserverRemoved
  | NotifyEventQueryObserverResultsUpdated
  | NotifyEventQueryObserverOptionsUpdated

type QueryCacheListener = (event: QueryCacheNotifyEvent) => void

/**
 * The store a `QueryCache` keeps its queries in, keyed by query hash.
 */
export interface QueryStore {
  /**
   * Returns whether a query with the given hash is stored.
   */
  has: (queryHash: string) => boolean
  /**
   * Stores a query under its hash.
   */
  set: (queryHash: string, query: Query) => void
  /**
   * Returns the query with the given hash, if any.
   */
  get: (queryHash: string) => Query | undefined
  /**
   * Removes the query with the given hash.
   */
  delete: (queryHash: string) => void
  /**
   * Returns an iterator over all stored queries.
   */
  values: () => IterableIterator<Query>
}

// CLASS

/**
 * The `QueryCache` is the storage mechanism for TanStack Query. It stores all the data, meta
 * information, and state of the queries it contains.
 *
 * Normally, you will not interact with the `QueryCache` directly and instead use a `QueryClient`
 * for a specific cache. You can subscribe to it (inherited from `Subscribable`) to be informed of
 * safe/known updates to the cache, such as queries being added, removed, or updated — updates made
 * outside of the cache's own tracked mechanisms (e.g. mutating a query's state object directly) do
 * not notify subscribers.
 * @example
 * ```ts
 * const unsubscribe = queryCache.subscribe((event) => {
 *   console.log(event.type, event.query)
 * })
 * ```
 */
// ═══ 中文注释导读 ═══
// QueryCache = 一个 Map<queryHash, Query> + 一组缓存级事件。
// 它在链路里的三个职责：
//   1) 去重的唯一入口：build() 先按 hash 查，查不到才 new Query，所以同一 hash 永远只有一个实例；
//   2) 提供批量操作：find/findAll 是 invalidate/refetch/remove 等所有 QueryClient 方法的地基；
//   3) 广播事件：added/removed/updated/observer* 供 devtools、持久化、broadcast 插件订阅。
// 注意 QueryCache 自己不决定「什么时候取数」，它只是存储与筛选；取数决策在 QueryObserver。
// ──────────────────────
export class QueryCache extends Subscribable<QueryCacheListener> {
  #queries: QueryStore

  constructor(public config: QueryCacheConfig = {}) {
    super()
    // 键是 queryHash（utils.hashKey 的产物），不是 queryKey 数组。
    // 这解释了为什么 queryKey 里对象的键顺序不影响去重、而数组顺序会影响。
    this.#queries = new Map<string, Query>()
  }

  /**
   * Returns the existing `Query` instance for the given options' `queryKey`/`queryHash`, or
   * builds and adds a new one to the cache if none exists yet. Used by framework adapters and
   * plugins (e.g. broadcast/persistence) that need to get-or-create a `Query` directly, bypassing
   * the reactive `QueryObserver` machinery.
   * @param client - The client the query belongs to, used to default its options.
   * @param options - The query options, including the `queryKey`. A new query is created with the
   * options defaulted by {@link QueryClient#defaultQueryOptions}.
   * @param state - The initial state of a newly created query, e.g. when hydrating. Ignored if the
   * query already exists.
   * @returns The existing or newly created query.
   * @example
   * ```ts
   * const queryCache = queryClient.getQueryCache()
   *
   * const query = queryCache.build(queryClient, {
   *   queryKey: ['posts'],
   *   queryFn: fetchPosts,
   * })
   * ```
   */
  // get-or-create。三件事必须按顺序：先算 hash → 查已有 → 用 client 的默认值造新 Query。
  // 传 state 的场景只有 hydration / broadcast 恢复；已有 query 时 state 被忽略（不覆盖运行中的真实状态）。
  // 新 Query 同时拿到两份默认值：client.defaultQueryOptions(options) 是「本次调用的完整默认值」，
  // getQueryDefaults(queryKey) 是「按 key 前缀注册的那份」，两者在 Query 内部再合并。
  build<
    TQueryFnData = unknown,
    TError = DefaultError,
    TData = TQueryFnData,
    TQueryKey extends QueryKey = QueryKey,
  >(
    client: QueryClient,
    options: WithRequired<
      QueryOptions<TQueryFnData, TError, TData, TQueryKey>,
      'queryKey'
    >,
    state?: QueryState<TData, TError>,
  ): Query<TQueryFnData, TError, TData, TQueryKey> {
    const queryKey = options.queryKey
    const queryHash =
      options.queryHash ?? hashQueryKeyByOptions(queryKey, options)
    let query = this.get<TQueryFnData, TError, TData, TQueryKey>(queryHash)

    if (!query) {
      query = new Query({
        client,
        queryKey,
        queryHash,
        options: client.defaultQueryOptions(options),
        state,
        defaultOptions: client.getQueryDefaults(queryKey),
      })
      this.add(query)
    }

    return query
  }

  /**
   * Adds a query to the cache.
   * @internal
   * @param query - The query to add. If a query with the same hash is already cached, nothing
   * happens.
   */
  // 同 hash 已存在就什么都不做（并静默丢弃新实例），保证「一个 hash 一个 Query」不变量。
  add(query: Query<any, any, any, any>): void {
    if (!this.#queries.has(query.queryHash)) {
      this.#queries.set(query.queryHash, query)

      this.notify({
        type: 'added',
        query,
      })
    }
  }

  /**
   * Destroys the given `Query` and removes it from the cache, notifying subscribers with a
   * `'removed'` event. A no-op if the query is no longer the one currently stored under its hash
   * (e.g. it was already replaced). Used by plugins (e.g. the broadcast client) that mirror
   * removals across `QueryCache` instances.
   * @param query - The query to remove.
   * @example
   * ```ts
   * const queryCache = queryClient.getQueryCache()
   * const query = queryCache.find({ queryKey: ['posts'] })
   *
   * if (query) {
   *   queryCache.remove(query)
   * }
   * ```
   */
  // 用「实例同一性」而不是 hash 判断：如果该 hash 下已经换成别的实例，说明这次 remove 针对的是旧对象，
  // 直接忽略，避免误删新实例。
  // query.destroy() 会取消在途请求（Query.destroy → cancel({silent:true})），这是 remove 的隐藏副作用。
  remove(query: Query<any, any, any, any>): void {
    const queryInMap = this.#queries.get(query.queryHash)

    if (queryInMap === query) {
      query.destroy()
      this.#queries.delete(query.queryHash)
      this.notify({ type: 'removed', query })
    }
  }

  /**
   * Removes all queries from the cache.
   * @example
   * ```ts
   * const queryCache = queryClient.getQueryCache()
   *
   * queryCache.clear()
   * ```
   */
  // 整批包在 notifyManager.batch 里：N 个 query 的 removed 事件会合并成一次通知周期。
  clear(): void {
    notifyManager.batch(() => {
      this.getAll().forEach((query) => {
        this.remove(query)
      })
    })
  }

  /**
   * Returns the `Query` instance stored under the given `queryHash`, or `undefined` if none
   * exists. Unlike {@link QueryCache#find}, this looks up by the already-computed hash rather
   * than by `QueryFilters`. Used by plugins (e.g. broadcast/hydration) that already have a hash
   * to look up directly.
   * @param queryHash - The hash of the query to look up.
   * @returns The query stored under the hash, or `undefined`.
   * @example
   * ```ts
   * const queryCache = queryClient.getQueryCache()
   * const queryHash = hashKey(['posts'])
   *
   * const query = queryCache.get(queryHash)
   * ```
   */
  get<
    TQueryFnData = unknown,
    TError = DefaultError,
    TData = TQueryFnData,
    TQueryKey extends QueryKey = QueryKey,
  >(
    queryHash: string,
  ): Query<TQueryFnData, TError, TData, TQueryKey> | undefined {
    return this.#queries.get(queryHash) as
      | Query<TQueryFnData, TError, TData, TQueryKey>
      | undefined
  }

  /**
   * Returns all queries within the cache.
   * @returns Every query in the cache.
   * @example
   * ```ts
   * const queryCache = queryClient.getQueryCache()
   *
   * const queries = queryCache.getAll()
   * ```
   */
  getAll(): Array<Query> {
    return [...this.#queries.values()]
  }

  /**
   * A slightly more advanced method that can be used to get an existing query instance from the
   * cache. This instance not only contains all the state for the query, but all of the instances,
   * and underlying guts of the query as well. If the query does not exist, `undefined` is
   * returned.
   *
   * This is not typically needed for most applications, but can come in handy when needing more
   * information about a query in rare scenarios (e.g. looking at `query.state.dataUpdatedAt` to
   * decide whether a query is fresh enough to be used as an initial value).
   * @param filters - The filters to match, including the required `queryKey`. `exact` defaults to
   * `true`.
   * @returns The first matching query, or `undefined`.
   * @see {@link QueryCache#findAll}
   * @example
   * ```ts
   * const queryCache = queryClient.getQueryCache()
   *
   * const query = queryCache.find({ queryKey: ['posts'] })
   * ```
   */
  // exact 默认 true：find({queryKey}) 是精确匹配；要前缀匹配必须显式 findAll 或传 exact:false。
  // 这是「invalidateQueries 默认级联、find 默认不级联」差异的根源。
  find<TQueryFnData = unknown, TError = DefaultError, TData = TQueryFnData>(
    filters: WithRequired<QueryFilters, 'queryKey'>,
  ): Query<TQueryFnData, TError, TData> | undefined {
    const defaultedFilters = { exact: true, ...filters }

    return this.getAll().find((query) =>
      matchQuery(defaultedFilters, query),
    ) as Query<TQueryFnData, TError, TData> | undefined
  }

  /**
   * An even more advanced method that can be used to get existing query instances from the cache
   * that partially match a query key. If no queries match, an empty array is returned.
   *
   * This is not typically needed for most applications, but can come in handy when needing more
   * information about queries in rare scenarios.
   * @param filters - The filters to match. Without filters, every query is returned.
   * @returns The matching queries.
   * @see {@link QueryCache#find}
   * @example
   * ```ts
   * const queryCache = queryClient.getQueryCache()
   *
   * const queries = queryCache.findAll({ queryKey: ['posts'] })
   * ```
   */
  // 无 filters 时直接返回全量：invoke invalidateQueries() 不传参数会命中所有 query，就是这个分支。
  findAll(filters: QueryFilters<any> = {}): Array<Query> {
    const queries = this.getAll()
    return Object.keys(filters).length > 0
      ? queries.filter((query) => matchQuery(filters, query))
      : queries
  }

  /**
   * Notifies every cache listener of an event, in one batch.
   * @internal
   * @param event - The event passed to every listener.
   */
  // 事件本身也包 batch：一次 Query.#dispatch 内的多个 observer 通知 + cache 通知会在同一批里派发。
  notify(event: QueryCacheNotifyEvent): void {
    notifyManager.batch(() => {
      this.listeners.forEach((listener) => {
        listener(event)
      })
    })
  }

  /**
   * Calls {@link Query#onFocus} on every cached query, in one batch.
   * @internal
   */
  // 由 QueryClient.mount 注册的 focusManager 回调调用；逐个 Query 转发 onFocus。
  // 每个 Query.onFocus 会挑一个「希望聚焦重取」的 observer 触发 refetch，并继续被暂停的 retryer。
  onFocus(): void {
    notifyManager.batch(() => {
      this.getAll().forEach((query) => {
        query.onFocus()
      })
    })
  }

  /**
   * Calls {@link Query#onOnline} on every cached query, in one batch.
   * @internal
   */
  // 与 onFocus 对称，触发源是 onlineManager。
  onOnline(): void {
    notifyManager.batch(() => {
      this.getAll().forEach((query) => {
        query.onOnline()
      })
    })
  }
}
