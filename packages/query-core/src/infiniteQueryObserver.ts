import { QueryObserver } from './queryObserver'
import { hasNextPage, hasPreviousPage } from './infiniteQueryBehavior'
import type { Subscribable } from './subscribable'
import type {
  DefaultError,
  DefaultedInfiniteQueryObserverOptions,
  FetchNextPageOptions,
  FetchPreviousPageOptions,
  InfiniteData,
  InfiniteQueryObserverBaseResult,
  InfiniteQueryObserverOptions,
  InfiniteQueryObserverResult,
  QueryKey,
} from './types'
import type { QueryClient } from './queryClient'
import type { Query } from './query'

type InfiniteQueryObserverListener<TData, TError> = (
  result: InfiniteQueryObserverResult<TData, TError>,
) => void

/**
 * An `InfiniteQueryObserver` extends `QueryObserver` to observe and switch
 * between infinite queries. It augments the base `QueryObserverResult` with
 * infinite-query-specific fields and methods, such as `hasNextPage` and
 * `fetchNextPage`, and is the primitive that framework adapters (e.g.
 * `useInfiniteQuery`) build their hooks on top of.
 * @example
 * ```ts
 * const observer = new InfiniteQueryObserver(queryClient, {
 *   queryKey: ['projects'],
 *   queryFn: ({ pageParam }) => fetchProjects(pageParam),
 *   initialPageParam: 0,
 *   getNextPageParam: (lastPage) => lastPage.nextCursor,
 * })
 *
 * const unsubscribe = observer.subscribe((result) => console.log(result))
 * ```
 */
// ═══ 中文注释导读 ═══
// InfiniteQueryObserver 是 QueryObserver 的子类，只做三处增量：
//   1) 所有入口都把 options._type 标成 'infinite'（让 Query 选用无限查询 behavior）；
//   2) 提供 fetchNextPage / fetchPreviousPage（本质是带 meta 的 fetch）；
//   3) createResult 额外产出 hasNextPage / isFetchingNextPage 等方向相关字段。
// 前两个「类型覆盖」块（subscribe / getCurrentResult / fetch）没有运行时逻辑，
// 只是把父类签名收窄成无限查询的结果类型，读代码时可以直接跳过。
// ──────────────────────
export class InfiniteQueryObserver<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = InfiniteData<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
> extends QueryObserver<
  TQueryFnData,
  TError,
  TData,
  InfiniteData<TQueryFnData, TPageParam>,
  TQueryKey
> {
  // Type override
  override subscribe!: Subscribable<
    InfiniteQueryObserverListener<TData, TError>
  >['subscribe']

  // Type override
  override getCurrentResult!: ReplaceReturnType<
    QueryObserver<
      TQueryFnData,
      TError,
      TData,
      InfiniteData<TQueryFnData, TPageParam>,
      TQueryKey
    >['getCurrentResult'],
    InfiniteQueryObserverResult<TData, TError>
  >

  // Type override
  protected override fetch!: ReplaceReturnType<
    QueryObserver<
      TQueryFnData,
      TError,
      TData,
      InfiniteData<TQueryFnData, TPageParam>,
      TQueryKey
    >['fetch'],
    Promise<InfiniteQueryObserverResult<TData, TError>>
  >

  constructor(
    client: QueryClient,
    options: InfiniteQueryObserverOptions<
      TQueryFnData,
      TError,
      TData,
      TQueryKey,
      TPageParam
    >,
  ) {
    super(client, options)
  }

  protected override bindMethods(): void {
    super.bindMethods()
    this.fetchNextPage = this.fetchNextPage.bind(this)
    this.fetchPreviousPage = this.fetchPreviousPage.bind(this)
  }

  /**
   * Updates the observer's options. Behaves the same as
   * `QueryObserver.setOptions`, additionally marking the options as
   * belonging to an infinite query before delegating to the base
   * implementation.
   * @param options - The new infinite query observer options.
   */
  // 标记 _type 必须在 super.setOptions 之前：父类会用它创建/更新 Query，
  // 晚一步 Query.#queryType 就不会被设置，behavior 也选不到 infiniteQueryBehavior。
  override setOptions(
    options: InfiniteQueryObserverOptions<
      TQueryFnData,
      TError,
      TData,
      TQueryKey,
      TPageParam
    >,
  ): void {
    options._type = 'infinite'
    super.setOptions(options)
  }

  /**
   * The infinite-query counterpart of {@link QueryObserver#getOptimisticResult}, marking the
   * options as an infinite query before delegating to it. Called by framework adapters (e.g.
   * `useInfiniteQuery`) ahead of subscribing, to compute the current `InfiniteQueryObserverResult`
   * synchronously.
   * @param options - The defaulted infinite query observer options to compute the result for.
   * @returns The result for the given options.
   */
  override getOptimisticResult(
    options: DefaultedInfiniteQueryObserverOptions<
      TQueryFnData,
      TError,
      TData,
      TQueryKey,
      TPageParam
    >,
  ): InfiniteQueryObserverResult<TData, TError> {
    options._type = 'infinite'
    return super.getOptimisticResult(options) as InfiniteQueryObserverResult<
      TData,
      TError
    >
  }

  /**
   * Fetches the next page of the infinite query and returns a promise that
   * resolves with the resulting `InfiniteQueryObserverResult`. The page
   * param used for the fetch is determined by `getNextPageParam`, which
   * receives the current pages/page params and whose result also determines
   * `hasNextPage`.
   * @param options - Set `cancelRefetch` to `false` to ignore the call while a fetch is running,
   * and `throwOnError` to `true` to reject when the fetch fails.
   * @returns A promise that resolves with the result after the next page is fetched. With
   * `cancelRefetch: false`, a running fetch is reused instead, so the next page may not be fetched.
   * @see {@link InfiniteQueryObserver#fetchPreviousPage}
   * @example
   * ```ts
   * const { hasNextPage } = observer.getCurrentResult()
   *
   * if (hasNextPage) {
   *   await observer.fetchNextPage()
   * }
   * ```
   */
  // 只是给 fetch 加 meta.fetchMore.direction。
  // 这个 meta 会一路传到 Query.fetch 的 dispatch('fetch') → state.fetchMeta → behavior.onFetch，
  // 是「同一套 fetch 流程如何表达取第几页」的唯一通道。
  // cancelRefetch 默认 true：快速连点「下一页」会取消上一页请求（保持只有一次在途）。
  fetchNextPage(
    options?: FetchNextPageOptions,
  ): Promise<InfiniteQueryObserverResult<TData, TError>> {
    return this.fetch({
      ...options,
      meta: {
        fetchMore: { direction: 'forward' },
      },
    })
  }

  /**
   * Fetches the previous page of the infinite query and returns a promise
   * that resolves with the resulting `InfiniteQueryObserverResult`. The page
   * param used for the fetch is determined by `getPreviousPageParam`, which
   * receives the current pages/page params and whose result also determines
   * `hasPreviousPage`.
   * @param options - Set `cancelRefetch` to `false` to ignore the call while a fetch is running,
   * and `throwOnError` to `true` to reject when the fetch fails.
   * @returns A promise that resolves with the result after the previous page is fetched. With
   * `cancelRefetch: false`, a running fetch is reused instead, so the previous page may not be fetched.
   * @see {@link InfiniteQueryObserver#fetchNextPage}
   * @example
   * ```ts
   * const { hasPreviousPage } = observer.getCurrentResult()
   *
   * if (hasPreviousPage) {
   *   await observer.fetchPreviousPage()
   * }
   * ```
   */
  fetchPreviousPage(
    options?: FetchPreviousPageOptions,
  ): Promise<InfiniteQueryObserverResult<TData, TError>> {
    return this.fetch({
      ...options,
      meta: {
        fetchMore: { direction: 'backward' },
      },
    })
  }

  // 先拿父类结果，再叠加方向相关字段。fetchDirection 读自 state.fetchMeta ——
  // 因此 isFetchingNextPage 能区分「整体在刷新」与「正在取下一页」，组件可以只给按钮加 loading。
  // 最后两行是互相排斥处理：取下一页时不再算作 isRefetching/isRefetchError，避免 UI 重复提示。
  protected override createResult(
    query: Query<
      TQueryFnData,
      TError,
      InfiniteData<TQueryFnData, TPageParam>,
      TQueryKey
    >,
    options: InfiniteQueryObserverOptions<
      TQueryFnData,
      TError,
      TData,
      TQueryKey,
      TPageParam
    >,
  ): InfiniteQueryObserverResult<TData, TError> {
    const { state } = query
    const parentResult = super.createResult(query, options)

    const { isFetching, isRefetching, isError, isRefetchError } = parentResult
    const fetchDirection = state.fetchMeta?.fetchMore?.direction

    const isFetchNextPageError = isError && fetchDirection === 'forward'
    const isFetchingNextPage = isFetching && fetchDirection === 'forward'

    const isFetchPreviousPageError = isError && fetchDirection === 'backward'
    const isFetchingPreviousPage = isFetching && fetchDirection === 'backward'

    const result: InfiniteQueryObserverBaseResult<TData, TError> = {
      ...parentResult,
      fetchNextPage: this.fetchNextPage,
      fetchPreviousPage: this.fetchPreviousPage,
      hasNextPage: hasNextPage(options, state.data),
      hasPreviousPage: hasPreviousPage(options, state.data),
      isFetchNextPageError,
      isFetchingNextPage,
      isFetchPreviousPageError,
      isFetchingPreviousPage,
      isRefetchError:
        isRefetchError && !isFetchNextPageError && !isFetchPreviousPageError,
      isRefetching:
        isRefetching && !isFetchingNextPage && !isFetchingPreviousPage,
    }

    return result as InfiniteQueryObserverResult<TData, TError>
  }
}

type ReplaceReturnType<
  TFunction extends (...args: Array<any>) => unknown,
  TReturn,
> = (...args: Parameters<TFunction>) => TReturn
