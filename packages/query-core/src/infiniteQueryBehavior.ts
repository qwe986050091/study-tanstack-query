import {
  addConsumeAwareSignal,
  addToEnd,
  addToStart,
  ensureQueryFn,
  fetchSignal,
} from './utils'
import type { FetchSignalContext } from './utils'
import type { QueryBehavior } from './query'
import type {
  InfiniteData,
  InfiniteQueryPageParamsOptions,
  OmitKeyof,
  QueryFunctionContext,
  QueryKey,
} from './types'

/**
 * Creates the behavior that fetches the pages of an infinite query: the next or previous page for
 * `fetchNextPage`/`fetchPreviousPage`, or all pages again from the start on a refetch.
 * @param pages - The number of pages to fetch from the start when all pages are fetched again,
 * e.g. from the `pages` option of `queryClient.infiniteQuery`. Defaults to the number of cached
 * pages.
 * @returns The query behavior to set on an infinite query.
 */
// ═══ 中文注释导读 ═══
// 无限查询没有单独的 Query 子类，全部逻辑集中在这个 behavior 里：
// Query.fetch 会在取数前调用 behavior.onFetch(context)，由它替换 context.fetchFn。
// 因此这里只负责「取哪一页 / 取几页」，状态机、去重、GC 仍由 Query 完成。
// 三种模式（由 fetchOptions.meta.fetchMore.direction 与 pages 参数决定）：
//   1) direction='forward'  → 取下一页（fetchNextPage）；
//   2) direction='backward' → 取上一页（fetchPreviousPage）；
//   3) 无 direction         → 从头重新取 pages 页（首次加载或 refetch）。
// ──────────────────────
export function infiniteQueryBehavior<TQueryFnData, TError, TData, TPageParam>(
  pages?: number,
): QueryBehavior<TQueryFnData, TError, InfiniteData<TData, TPageParam>> {
  return {
    onFetch: (context, query) => {
      const options = context.options as InfiniteQueryPageParamsOptions<TData>
      // direction 与 oldPages 都来自「取数开始时」的 state 快照（context.state）。
      // 方向由 InfiniteQueryObserver.fetchNextPage 塞进 fetchOptions.meta，Query.fetch 再写进 fetchMeta。
      const direction = context.fetchOptions?.meta?.fetchMore?.direction
      const oldPages = context.state.data?.pages || []
      const oldPageParams = context.state.data?.pageParams || []
      let result: InfiniteData<unknown> = { pages: [], pageParams: [] }
      let currentPage = 0

      const fetchFn = async () => {
        let cancelled = false
        const signalContext: FetchSignalContext = context
        const addSignalProperty = (object: object) => {
          addConsumeAwareSignal(
            object,
            () => context.signal,
            () => (cancelled = true),
            signalContext[fetchSignal],
          )
        }

        const queryFn = ensureQueryFn(context.options, context.fetchOptions)

        // Create function to fetch a page
        // 取单页。三个要点：
        //   1) 已取消（signal 被读且 abort）就 reject signal.reason，让取消立即生效；
        //   2) param == null 且已有页时直接返回原数据 —— 这是「没有下一页」的空转保护，不再调 queryFn；
        //   3) 归一化用 addToEnd/addToStart，maxPages 会同时裁剪 pages 与 pageParams，保证两者等长。
        const fetchPage = async (
          data: InfiniteData<unknown>,
          param: unknown,
          previous?: boolean,
        ): Promise<InfiniteData<unknown>> => {
          if (cancelled) {
            return Promise.reject(context.signal.reason)
          }

          if (param == null && data.pages.length) {
            return Promise.resolve(data)
          }

          const createQueryFnContext = () => {
            const queryFnContext: OmitKeyof<
              QueryFunctionContext<QueryKey, unknown>,
              'signal'
            > = {
              client: context.client,
              queryKey: context.queryKey,
              pageParam: param,
              direction: previous ? 'backward' : 'forward',
              meta: context.options.meta,
            }
            addSignalProperty(queryFnContext)
            return queryFnContext as QueryFunctionContext<QueryKey, unknown>
          }

          const queryFnContext = createQueryFnContext()

          const page = await queryFn(queryFnContext)

          const { maxPages } = context.options
          const addTo = previous ? addToStart : addToEnd

          return {
            pages: addTo(data.pages, page, maxPages),
            pageParams: addTo(data.pageParams, param, maxPages),
          }
        }

        // fetch next / previous page?
        // 增量取一页：用 getNextPageParam / getPreviousPageParam 从当前末页/首页算参数。
        // 这两个函数返回 null/undefined 就表示「没有更多」，此时 fetchPage 会走上面的空转保护。
        // 注意 `oldPages.length` 条件：没有历史页时即使带方向也走下面的「全量重取」分支。
        if (direction && oldPages.length) {
          const previous = direction === 'backward'
          const pageParamFn = previous ? getPreviousPageParam : getNextPageParam
          const oldData = {
            pages: oldPages,
            pageParams: oldPageParams,
          }
          const param = pageParamFn(options, oldData)

          result = await fetchPage(oldData, param, previous)
        } else {
          // 全量模式：`pages` 参数来自 queryClient.infiniteQuery 的限页重取；未指定则沿用当前页数。
          // 循环的起点参数优先沿用旧的首页参数（oldPageParams[0]），没有才用 initialPageParam ——
          // 这样「重新取前 N 页」不会把游标重置，能保持与用户当前浏览位置一致。
          const remainingPages = pages ?? oldPages.length

          // Fetch all pages
          do {
            const param =
              currentPage === 0
                ? oldPageParams[0] === undefined
                  ? options.initialPageParam
                  : oldPageParams[0]
                : getNextPageParam(options, result)
            // 第一页允许 param 为 null（由 initialPageParam 决定，理论上不该是 null），
            // 之后任何一页算不出参数就停止，不再无意义地继续循环。
            if (currentPage > 0 && param == null) {
              break
            }
            result = await fetchPage(result, param)
            currentPage++
          } while (currentPage < remainingPages)
        }

        return result
      }
      // 有 persister 时把 fetchFn 再包一层，让持久化中间件决定「从磁盘读还是真的发请求」。
      // 注意传给 persister 的 context 里 signal 是原始 signal（不是懒 getter 包装），避免内部读取被当成用户消费。
      if (context.options.persister) {
        context.fetchFn = () => {
          return context.options.persister?.(
            fetchFn as any,
            {
              client: context.client,
              queryKey: context.queryKey,
              meta: context.options.meta,
              signal: context.signal,
            },
            query,
          )
        }
      } else {
        context.fetchFn = fetchFn
      }
    },
  }
}

/**
 * Computes the page param of the page after the last one, with the `getNextPageParam` option.
 * @param options - The infinite query options.
 * @param data - The current pages and page params.
 * @returns The next page param, or `undefined` if there are no pages yet.
 */
function getNextPageParam(
  options: InfiniteQueryPageParamsOptions<any>,
  { pages, pageParams }: InfiniteData<unknown>,
): unknown | undefined {
  const lastIndex = pages.length - 1
  return pages.length > 0
    ? options.getNextPageParam(
        pages[lastIndex],
        pages,
        pageParams[lastIndex],
        pageParams,
      )
    : undefined
}

/**
 * Computes the page param of the page before the first one, with the `getPreviousPageParam`
 * option.
 * @param options - The infinite query options.
 * @param data - The current pages and page params.
 * @returns The previous page param, or `undefined` if there are no pages yet or no
 * `getPreviousPageParam` option.
 */
function getPreviousPageParam(
  options: InfiniteQueryPageParamsOptions<any>,
  { pages, pageParams }: InfiniteData<unknown>,
): unknown | undefined {
  return pages.length > 0
    ? options.getPreviousPageParam?.(pages[0], pages, pageParams[0], pageParams)
    : undefined
}

/**
 * Checks if there is a next page.
 * @param options - The infinite query options with `getNextPageParam`.
 * @param data - The current pages and page params.
 * @returns `true` if `getNextPageParam` returns a value other than `null` or `undefined`.
 */
// hasNextPage / hasPreviousPage 只是「用同一套 pageParam 函数探测一下」：
// 返回非 null 即认为还有下一页。因此它们不会发请求，但可能调用用户函数（要保证纯函数）。
export function hasNextPage(
  options: InfiniteQueryPageParamsOptions<any, any>,
  data?: InfiniteData<unknown>,
): boolean {
  if (!data) return false
  return getNextPageParam(options, data) != null
}

/**
 * Checks if there is a previous page.
 * @param options - The infinite query options with `getPreviousPageParam`.
 * @param data - The current pages and page params.
 * @returns `true` if `getPreviousPageParam` is set and returns a value other than `null` or
 * `undefined`.
 */
export function hasPreviousPage(
  options: InfiniteQueryPageParamsOptions<any, any>,
  data?: InfiniteData<unknown>,
): boolean {
  if (!data || !options.getPreviousPageParam) return false
  return getPreviousPageParam(options, data) != null
}
