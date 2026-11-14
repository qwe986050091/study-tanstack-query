import { addConsumeAwareSignal, addToEnd, fetchSignal } from './utils'
import type { FetchSignalContext } from './utils'
import type {
  OmitKeyof,
  QueryFunction,
  QueryFunctionContext,
  QueryKey,
} from './types'

type BaseStreamedQueryParams<TQueryFnData, TQueryKey extends QueryKey> = {
  /** The function that returns an `AsyncIterable` to stream data from. */
  streamFn: (
    context: QueryFunctionContext<TQueryKey>,
  ) => AsyncIterable<TQueryFnData> | Promise<AsyncIterable<TQueryFnData>>
  /**
   * Defines how refetches are handled.
   * - `'reset'` (default): erases all data and puts the query back into `pending` state.
   * - `'append'`: appends new data to the existing data.
   * - `'replace'`: writes all data to the cache once the stream ends.
   */
  refetchMode?: 'append' | 'reset' | 'replace'
}

type SimpleStreamedQueryParams<
  TQueryFnData,
  TQueryKey extends QueryKey,
> = BaseStreamedQueryParams<TQueryFnData, TQueryKey> & {
  reducer?: never
  initialValue?: never
}

type ReducibleStreamedQueryParams<
  TQueryFnData,
  TData,
  TQueryKey extends QueryKey,
> = BaseStreamedQueryParams<TQueryFnData, TQueryKey> & {
  /**
   * Reduces streamed chunks into the final data shape. Required whenever `TData` is not an
   * array, since there is no default way to accumulate non-array chunks.
   */
  reducer: (acc: TData, chunk: TQueryFnData) => TData
  /**
   * The value used while the first chunk is being fetched, and returned if the stream yields no
   * values. Required together with a custom `reducer`.
   */
  initialValue: TData
}

type StreamedQueryParams<TQueryFnData, TData, TQueryKey extends QueryKey> =
  | SimpleStreamedQueryParams<TQueryFnData, TQueryKey>
  | ReducibleStreamedQueryParams<TQueryFnData, TData, TQueryKey>

/**
 * This is a helper function to create a query function that streams data from an AsyncIterable.
 * Data will be an Array of all the chunks received.
 * The query will be in a 'pending' state until the first chunk of data is received, but will go to 'success' after that.
 * The query will stay in fetchStatus 'fetching' until the stream ends.
 * Explicit cancellation stops further cache updates, even if `streamFn` does not read `signal`.
 * If `streamFn` does not read `signal`, the stream continues after the last observer unsubscribes.
 * @param options - The `streamFn` that returns an AsyncIterable to stream data from, and the optional
 * `refetchMode`, `reducer`, and `initialValue` options.
 * @returns A query function to pass as `queryFn`.
 * @example
 * ```ts
 * await queryClient.query({
 *   queryKey: ['data'],
 *   queryFn: streamedQuery({
 *     streamFn: fetchDataInChunks,
 *   }),
 * })
 * ```
 */
// ═══ 中文注释导读 ═══
// streamedQuery 是「一个 queryFn 的工厂」：把 AsyncIterable 的每个 chunk 增量写进缓存。
// 因为写缓存走 setQueryData，组件会在流的过程中持续收到新结果（不用等流结束）。
// 三种 refetchMode 的差异（第二次及以后取数时生效）：
//   reset（默认）：先清空数据并回到 pending，再重新累积；
//   append：在已有数据后面继续追加；
//   replace：流期间只累积在局部变量里，结束后一次性写入 —— 避免用户看到「半新半旧」。
// 取消语义：只有当调用方读过 signal 时才会真正中断；没读 signal 时，
//   最后一个 observer 退订后流仍会跑完（与 Query.removeObserver 的 cancelRetry 行为一致）。
// ──────────────────────
export function streamedQuery<
  TQueryFnData = unknown,
  TData = Array<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey,
>({
  streamFn,
  refetchMode = 'reset',
  reducer = (items, chunk) =>
    addToEnd(items as Array<TQueryFnData>, chunk) as TData,
  initialValue = [] as TData,
}: StreamedQueryParams<TQueryFnData, TData, TQueryKey>): QueryFunction<
  TData,
  TQueryKey
> {
  return async (context) => {
    const signalContext: FetchSignalContext = context
    const signal = signalContext[fetchSignal]
    if (signal?.aborted) {
      return initialValue
    }

    const query = context.client
      .getQueryCache()
      .find({ queryKey: context.queryKey, exact: true })
    // isRefetch 的判定基于「这个 query 之前尝试过取数」，而不是「本次是否被手动 refetch」。
    // 首次加载时 refetchMode 不起作用（没有旧数据可 reset/append/replace）。
    const isRefetch = !!query && query.isFetched()
    // reset 模式必须手动清数据：正常 fetch 不会主动清空旧 data（那会闪屏），
    // 而流式场景需要「从头开始」的语义。fetchStatus 设成 fetching 是为了让 UI 显示加载中。
    if (isRefetch && refetchMode === 'reset') {
      query.setState({
        ...query.resetState,
        fetchStatus: 'fetching',
      })
    }

    let result = initialValue

    let cancelled = false as boolean
    const streamFnContext = addConsumeAwareSignal<
      OmitKeyof<typeof context, 'signal'>
    >(
      {
        client: context.client,
        meta: context.meta,
        queryKey: context.queryKey,
        pageParam: context.pageParam,
        direction: context.direction,
      },
      () => context.signal,
      () => (cancelled = true),
      signal,
    )

    const isStreamInactive = () => cancelled || signal?.aborted === true
    const stream = await streamFn(streamFnContext)

    const isReplaceRefetch = isRefetch && refetchMode === 'replace'

    for await (const chunk of stream) {
      if (isStreamInactive()) {
        break
      }

      // replace 模式：只更新局部 result，不写缓存；循环结束后统一写。
      // 其余模式：每个 chunk 立刻 setQueryData，updater 拿到的是「当前缓存值」。
      if (isReplaceRefetch) {
        // don't append to the cache directly when replace-refetching
        result = reducer(result, chunk)
      } else {
        context.client.setQueryData<TData>(context.queryKey, (prev) =>
          reducer(prev === undefined ? initialValue : prev, chunk),
        )
      }
    }

    // finalize result: replace-refetching needs to write to the cache
    // 被取消时故意不写：保证「取消后缓存里不会出现一个只装了一半的新结果」。
    if (isReplaceRefetch && !isStreamInactive()) {
      context.client.setQueryData<TData>(context.queryKey, result)
    }

    const data = context.client.getQueryData<TData>(context.queryKey)
    return data === undefined ? initialValue : data
  }
}
