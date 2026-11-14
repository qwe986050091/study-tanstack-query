import type {
  DefaultError,
  DefaultedQueryObserverOptions,
  Query,
  QueryKey,
  QueryObserver,
  QueryObserverResult,
} from '@tanstack/query-core'
import type { QueryErrorResetBoundaryValue } from './QueryErrorResetBoundary'

/**
 * The default `throwOnError` of the suspense hooks: throws the error to the nearest error boundary
 * only if the query has no data to show.
 * @param _error - The error of the query. Unused.
 * @param query - The query that errored.
 * @returns `true` if the query has no data.
 */
// suspense 场景的默认 throwOnError：只有在「没有数据可展示」时才把错误抛给 ErrorBoundary。
// 有缓存数据时即使刷新失败，也应继续展示旧数据，而不是把整棵子树炸掉。
export const defaultThrowOnError = <
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  _error: TError,
  query: Query<TQueryFnData, TError, TData, TQueryKey>,
) => query.state.data === undefined

/**
 * Raises `staleTime` and a numeric `gcTime` to at least 1000ms when `suspense` is enabled, so a
 * component that remounts after suspending doesn't refetch right away or find the query garbage
 * collected. A `'static'` `staleTime` is kept as is. Mutates the options.
 * @param defaultedOptions - The defaulted query options to adjust.
 */
// suspense 特有的两个下限（1000ms）：
//   staleTime：组件 suspend 后重挂载时不要立刻又判定 stale 并重取；
//   gcTime：给「suspend 期间卸载 → 恢复后重新挂载」留出时间，避免缓存已被回收。
// 它是就地修改（mutate）defaultedOptions，因为调用方拿到的就是这个对象。
export const ensureSuspenseTimers = (
  defaultedOptions: DefaultedQueryObserverOptions<any, any, any, any, any>,
) => {
  if (defaultedOptions.suspense) {
    // Handle staleTime to ensure minimum 1000ms in Suspense mode
    // This prevents unnecessary refetching when components remount after suspending
    const MIN_SUSPENSE_TIME_MS = 1000

    const clamp = (value: number | 'static' | undefined) =>
      value === 'static'
        ? value
        : Math.max(value ?? MIN_SUSPENSE_TIME_MS, MIN_SUSPENSE_TIME_MS)

    const originalStaleTime = defaultedOptions.staleTime
    defaultedOptions.staleTime =
      typeof originalStaleTime === 'function'
        ? (...args) => clamp(originalStaleTime(...args))
        : clamp(originalStaleTime)

    if (typeof defaultedOptions.gcTime === 'number') {
      defaultedOptions.gcTime = Math.max(
        defaultedOptions.gcTime,
        MIN_SUSPENSE_TIME_MS,
      )
    }
  }
}

/**
 * Checks whether a query should suspend: `suspense` is enabled and the result is still `pending`.
 * @param defaultedOptions - The defaulted query options, if any.
 * @param result - The current result of the observer.
 * @returns `true` if the component should suspend.
 */
// 唯一条件：开了 suspense 且当前 result 仍是 pending（没有可渲染的数据）。
export const shouldSuspend = (
  defaultedOptions:
    | DefaultedQueryObserverOptions<any, any, any, any, any>
    | undefined,
  result: QueryObserverResult<any, any>,
) => defaultedOptions?.suspense && result.isPending

/**
 * Fetches the query for a suspending component, without affecting the observer's own result. If
 * the fetch fails, the reset state of the error boundary is cleared, so the error is thrown to it.
 * @param defaultedOptions - The defaulted query options to fetch with.
 * @param observer - The observer of the query.
 * @param errorResetBoundary - The value of the nearest `QueryErrorResetBoundary`.
 * @returns A promise that resolves once the fetch settles. It never rejects.
 */
// 用 fetchOptimistic（而不是 ensureQueryData）是为了「不影响本 observer 的结果」；
// 失败时 clearReset()：让 ErrorBoundary 处于「可捕获」状态，否则错误会被边界忽略。
export const fetchOptimistic = <
  TQueryFnData,
  TError,
  TData,
  TQueryData,
  TQueryKey extends QueryKey,
>(
  defaultedOptions: DefaultedQueryObserverOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryData,
    TQueryKey
  >,
  observer: QueryObserver<TQueryFnData, TError, TData, TQueryData, TQueryKey>,
  errorResetBoundary: QueryErrorResetBoundaryValue,
) =>
  observer.fetchOptimistic(defaultedOptions).catch(() => {
    errorResetBoundary.clearReset()
  })
