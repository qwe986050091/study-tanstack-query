import { notifyManager } from './notifyManager'
import { QueryObserver } from './queryObserver'
import { Subscribable } from './subscribable'
import { replaceEqualDeep, shallowEqualObjects } from './utils'
import type {
  DefaultedQueryObserverOptions,
  QueryObserverOptions,
  QueryObserverResult,
} from './types'
import type { QueryClient } from './queryClient'

/**
 * Returns the items of `array1` that are not in `array2`.
 * @param array1 - The items to filter.
 * @param array2 - The items to exclude.
 * @returns A new array with the items of `array1` that are not in `array2`.
 */
function difference<T>(array1: Array<T>, array2: Array<T>): Array<T> {
  const excludeSet = new Set(array2)
  return array1.filter((x) => !excludeSet.has(x))
}

type QueriesObserverListener = (result: Array<QueryObserverResult>) => void

type CombineFn<TCombinedResult> = (
  result: Array<QueryObserverResult>,
) => TCombinedResult

/**
 * Options for a `QueriesObserver` that apply to all of its queries at once.
 */
export interface QueriesObserverOptions<
  TCombinedResult = Array<QueryObserverResult>,
> {
  /**
   * A function that combines the array of `QueryObserverResult`s (one per
   * observed query) into a single value. The combined value is memoized and
   * only recomputed when one of the underlying results, the query hashes, or
   * the `combine` function itself changes.
   *
   * Defaults to returning the array of `QueryObserverResult`s unchanged.
   */
  combine?: CombineFn<TCombinedResult>
}

/**
 * A `QueriesObserver` watches an array of queries at once, exposing them as
 * a single array of `QueryObserverResult`s (or, when a `combine` option is
 * given, as a combined value derived from that array). It manages one
 * internal `QueryObserver` per query, and is the primitive that framework
 * adapters (e.g. `useQueries`) build their hooks on top of.
 * @example
 * ```ts
 * const observer = new QueriesObserver(queryClient, [
 *   { queryKey: ['post', 1], queryFn: fetchPost },
 *   { queryKey: ['post', 2], queryFn: fetchPost },
 * ])
 *
 * const unsubscribe = observer.subscribe((result) => {
 *   console.log(result)
 * })
 * ```
 */
// ═══ 中文注释导读 ═══
// QueriesObserver 是「N 个 QueryObserver 的组合器」，服务于 useQueries。
// 它不自己派生状态，只做三件事：
//   1) 按 queryHash 复用/新建子 observer（setQueries → #findMatchingObservers）；
//   2) 聚合子结果成数组，可选地用 combine 折成一个值；
//   3) 把「结构变化」与「结果变化」分开判断，避免无意义的通知。
// 读的时候注意：它有两套结果概念 —— #result（数组）与 #combinedResult（combine 之后）。
// 对外通知的是 #result（数组），combine 结果通过 getOptimisticResult 返回的闭包给到适配层。
// ──────────────────────
export class QueriesObserver<
  TCombinedResult = Array<QueryObserverResult>,
> extends Subscribable<QueriesObserverListener> {
  #client: QueryClient
  #result!: Array<QueryObserverResult>
  #queries: Array<QueryObserverOptions>
  #options?: QueriesObserverOptions<TCombinedResult>
  #observers: Array<QueryObserver>
  #combinedResult!: TCombinedResult
  #lastCombine?: CombineFn<TCombinedResult>
  #lastResult?: Array<QueryObserverResult>
  #lastQueryHashes?: Array<string>
  #observerMatches: Array<QueryObserverMatch> = []

  constructor(
    client: QueryClient,
    queries: Array<QueryObserverOptions<any, any, any, any, any>>,
    options?: QueriesObserverOptions<TCombinedResult>,
  ) {
    super()

    this.#client = client
    this.#options = options
    this.#queries = []
    this.#observers = []
    this.#result = []

    this.setQueries(queries)
  }

  // 第一个订阅者到来时，才逐个订阅子 observer，并把子更新汇到 #onUpdate。
  // 也就是说「构造 QueriesObserver」不会触发任何取数，真正的取数发生在子 observer 首次 subscribe 时。
  protected override onSubscribe(): void {
    if (this.listeners.size === 1) {
      this.#observers.forEach((observer) => {
        observer.subscribe((result) => {
          this.#onUpdate(observer, result)
        })
      })
    }
  }

  protected override onUnsubscribe(): void {
    if (!this.listeners.size) {
      this.destroy()
    }
  }

  /**
   * Stops observing all queries: clears all listeners and destroys every
   * underlying `QueryObserver` this observer manages.
   */
  destroy(): void {
    this.listeners = new Set()
    this.#observers.forEach((observer) => {
      observer.destroy()
    })
  }

  /**
   * Replaces the set of queries being observed. Existing `QueryObserver`s
   * are reused for queries that match an already-observed query hash;
   * observers for queries that are no longer present are destroyed, and new
   * observers are created and subscribed to for newly added queries.
   * @param queries - The options of the queries to observe.
   * @param options - Replaces the observer's options, e.g. its `combine` function.
   * @example
   * ```ts
   * observer.setQueries([
   *   { queryKey: ['post', 1], queryFn: fetchPost },
   *   { queryKey: ['post', 3], queryFn: fetchPost },
   * ])
   * ```
   */
  // setQueries 是 useQueries 每次渲染后（effect 里）调用的同步入口。
  // 它先按 hash 重新匹配 observer（能复用就复用，保留其内部缓存与定时器），再逐个 setOptions。
  // 之后比较两件事：结构是否变（长度/位置/实例）、结果是否变（浅比较）；两者都不变直接 return，不通知。
  // 结构变化时才销毁多余 observer、订阅新增 observer —— 且只在已有订阅者时做（否则等 onSubscribe 统一挂）。
  setQueries(
    queries: Array<QueryObserverOptions>,
    options?: QueriesObserverOptions<TCombinedResult>,
  ): void {
    this.#queries = queries
    this.#options = options

    if (process.env.NODE_ENV !== 'production') {
      const queryHashes = queries.map(
        (query) => this.#client.defaultQueryOptions(query).queryHash,
      )
      if (new Set(queryHashes).size !== queryHashes.length) {
        console.warn(
          '[QueriesObserver]: Duplicate Queries found. This might result in unexpected behavior.',
        )
      }
    }

    notifyManager.batch(() => {
      const prevObservers = this.#observers

      const newObserverMatches = this.#findMatchingObservers(this.#queries)

      // set options for the new observers to notify of changes
      newObserverMatches.forEach((match) =>
        match.observer.setOptions(match.defaultedQueryOptions),
      )

      const newObservers = newObserverMatches.map((match) => match.observer)
      const newResult = newObservers.map((observer) =>
        observer.getCurrentResult(),
      )

      const hasLengthChange = prevObservers.length !== newObservers.length
      const hasIndexChange = newObservers.some(
        (observer, index) => observer !== prevObservers[index],
      )
      const hasStructuralChange = hasLengthChange || hasIndexChange

      // 结构没变才逐项浅比较；结构变了直接视为有变化。
      const hasResultChange = hasStructuralChange
        ? true
        : newResult.some((result, index) => {
            const prev = this.#result[index]
            return !prev || !shallowEqualObjects(result, prev)
          })

      if (!hasStructuralChange && !hasResultChange) return

      if (hasStructuralChange) {
        this.#observerMatches = newObserverMatches
        this.#observers = newObservers
      }

      this.#result = newResult

      if (!this.hasListeners()) return

      if (hasStructuralChange) {
        difference(prevObservers, newObservers).forEach((observer) => {
          observer.destroy()
        })
        difference(newObservers, prevObservers).forEach((observer) => {
          observer.subscribe((result) => {
            this.#onUpdate(observer, result)
          })
        })
      }

      this.#notify()
    })
  }

  /**
   * Returns the most recently computed array of `QueryObserverResult`s, one
   * per observed query, in the same order as the queries passed to the
   * constructor or `setQueries`.
   * @returns The current results.
   * @example
   * ```ts
   * const results = observer.getCurrentResult()
   * const data = results.map((result) => result.data)
   * ```
   */
  getCurrentResult(): Array<QueryObserverResult> {
    return this.#result
  }

  /**
   * Returns the underlying `Query` instances currently being observed, in
   * the same order as the queries passed to the constructor or `setQueries`.
   * @returns The observed queries.
   */
  getQueries() {
    return this.#observers.map((observer) => observer.getCurrentQuery())
  }

  /**
   * Returns the underlying `QueryObserver` instances this observer manages,
   * in the same order as the queries passed to the constructor or
   * `setQueries`.
   * @returns The managed query observers.
   */
  getObservers() {
    return this.#observers
  }

  /**
   * The `QueriesObserver` counterpart of {@link QueryObserver#getOptimisticResult} — computes
   * the result for the given (already-defaulted) queries right now, synchronously. Called by
   * framework adapters (e.g. `useQueries`) ahead of subscribing, returning a tuple of the raw
   * per-query results, a function to compute the combined result from them, and a function to
   * wrap the results for property-access tracking.
   * @param queries - The defaulted options of the queries to compute the result for.
   * @param combine - The `combine` function used by the returned `combineResult`, if any.
   * @returns A tuple of the per-query results, a function that computes the combined result, and a
   * function that returns the results wrapped for property-access tracking.
   */
  // 返回三元组而不是单个结果，是因为适配层需要「先拿原始数组，再按需 combine，最后按需包追踪」：
  //   rawResult：每个子查询的 result 数组（供 suspense / error 判断逐项使用）；
  //   combineResult：把数组折成最终返回值的函数（内部有记忆化）；
  //   trackResult：把数组包上属性追踪 Proxy 的函数。
  // 拆成三个闭包是为了让 useQueries 能在不同阶段只做需要的那一步，避免重复 combine。
  getOptimisticResult(
    queries: Array<QueryObserverOptions>,
    combine: CombineFn<TCombinedResult> | undefined,
  ): [
    rawResult: Array<QueryObserverResult>,
    combineResult: (r?: Array<QueryObserverResult>) => TCombinedResult,
    trackResult: () => Array<QueryObserverResult>,
  ] {
    const matches = this.#findMatchingObservers(queries)
    const result = matches.map((match) =>
      match.observer.getOptimisticResult(match.defaultedQueryOptions),
    )
    const queryHashes = matches.map(
      (match) => match.defaultedQueryOptions.queryHash,
    )

    return [
      result,
      (r?: Array<QueryObserverResult>) => {
        return this.#combineResult(r ?? result, combine, queryHashes)
      },
      () => {
        return this.#trackResult(result, matches)
      },
    ]
  }

  // 关键细节：任一子 result 的属性被读取时，会在**所有**子 observer 上登记同一个属性名。
  // 原因（源码注释里的 #7000）：若不统一，各 observer 的 trackedProps 不一致，
  // 会导致「某个子查询变化时只有部分 observer 通知」，数组结果出现不同步。
  // 这是 useQueries 特有的、与单个 useQuery 不同的追踪策略。
  #trackResult(
    result: Array<QueryObserverResult>,
    matches: Array<QueryObserverMatch>,
  ) {
    const trackedProps = new Set<keyof QueryObserverResult>()

    return matches.map((match, index) => {
      const observerResult = result[index]!
      return !match.defaultedQueryOptions.notifyOnChangeProps
        ? match.observer.trackResult(observerResult, (accessedProp) => {
            // track property on all observers to ensure proper (synchronized) tracking (#7000)
            if (!trackedProps.has(accessedProp)) {
              trackedProps.add(accessedProp)
              matches.forEach((m) => {
                m.observer.trackProp(accessedProp)
              })
            }
          })
        : observerResult
    })
  }

  // combine 的记忆化条件（三者任一成立才重算）：
  //   · #result 换了引用（有子结果更新或被 setQueries 重建）；
  //   · queryHashes 序列变了（查询集合变化，即使数组长度相同）；
  //   · combine 函数引用变了（内联函数每次渲染都变，所以文档建议 useCallback）。
  // 重算后过一遍 replaceEqualDeep：combine 常返回新对象，结构共享能把它折回旧引用，
  // 从而让下游组件不因「内容相同的新对象」而重渲染。
  #combineResult(
    input: Array<QueryObserverResult>,
    combine: CombineFn<TCombinedResult> | undefined,
    queryHashes?: Array<string>,
  ): TCombinedResult {
    if (combine) {
      const lastHashes = this.#lastQueryHashes
      const queryHashesChanged =
        queryHashes !== undefined &&
        lastHashes !== undefined &&
        (lastHashes.length !== queryHashes.length ||
          queryHashes.some((hash, i) => hash !== lastHashes[i]))

      if (
        this.#result !== this.#lastResult ||
        queryHashesChanged ||
        combine !== this.#lastCombine
      ) {
        this.#lastCombine = combine
        this.#lastResult = this.#result

        if (queryHashes !== undefined) {
          this.#lastQueryHashes = queryHashes
        }
        this.#combinedResult = replaceEqualDeep(
          this.#combinedResult,
          combine(input),
        )
      }

      return this.#combinedResult
    }
    return input as any
  }

  // suspense 模式下，只要有子查询还没有 data，就跳过 combine。
  // 否则 combine 函数会拿到 undefined 的 data 而抛错 —— 此时应该 suspend，而不是执行用户代码。
  #shouldSkipCombine(): boolean {
    return (
      !this.#options?.combine ||
      this.#observers.some((observer, index) => {
        return (
          observer.options.suspense && this.#result[index]?.data === undefined
        )
      })
    )
  }

  // 复用策略：先按 queryHash 把现有 observer 分桶（数组，因为允许重复 key），
  // 然后按新 queries 顺序，每个 hash 用 shift() 取一个旧 observer；取不到就新建。
  // 用数组而不是单值，是为了正确处理「同一个 queryKey 出现多次」的用例（虽不推荐，但不能崩）。
  #findMatchingObservers(
    queries: Array<QueryObserverOptions>,
  ): Array<QueryObserverMatch> {
    const prevObserversMap = new Map<string, Array<QueryObserver>>()

    this.#observers.forEach((observer) => {
      const key = observer.options.queryHash
      if (!key) return

      const previousObservers = prevObserversMap.get(key)

      if (previousObservers) {
        previousObservers.push(observer)
      } else {
        prevObserversMap.set(key, [observer])
      }
    })

    const observers: Array<QueryObserverMatch> = []

    queries.forEach((options) => {
      const defaultedOptions = this.#client.defaultQueryOptions(options)
      const match = prevObserversMap.get(defaultedOptions.queryHash)?.shift()
      const observer =
        match ?? new QueryObserver(this.#client, defaultedOptions)

      observers.push({
        defaultedQueryOptions: defaultedOptions,
        observer,
      })
    })

    return observers
  }

  // 子 observer 更新 → 复制数组、替换对应下标 → 再通知。
  // indexOf 找不到说明该 observer 已被移除（异步回调晚到），直接丢弃。
  #onUpdate(observer: QueryObserver, result: QueryObserverResult): void {
    const index = this.#observers.indexOf(observer)
    if (index !== -1) {
      this.#result = this.#result.slice()
      this.#result[index] = result
      this.#notify()
    }
  }

  // 通知前先算 combine；若「跳过 combine」或 combine 结果引用未变，仍然要通知一次，
  // 因为对外暴露的是数组 #result（与 combine 结果无关），数组项已经变了。
  #notify(): void {
    if (this.hasListeners()) {
      const shouldSkipCombine = this.#shouldSkipCombine()
      const previousResult = this.#combinedResult
      const newResult = shouldSkipCombine
        ? previousResult
        : this.#combineResult(
            this.#trackResult(this.#result, this.#observerMatches),
            this.#options?.combine,
          )

      if (shouldSkipCombine || previousResult !== newResult) {
        notifyManager.batch(() => {
          this.listeners.forEach((listener) => {
            listener(this.#result)
          })
        })
      }
    }
  }
}

type QueryObserverMatch = {
  defaultedQueryOptions: DefaultedQueryObserverOptions
  observer: QueryObserver
}
