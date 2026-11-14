'use client'
import * as React from 'react'
import { shouldThrowError } from '@tanstack/query-core'
import type {
  DefaultedQueryObserverOptions,
  Query,
  QueryKey,
  QueryObserverResult,
  ThrowOnError,
} from '@tanstack/query-core'
import type { QueryErrorResetBoundaryValue } from './QueryErrorResetBoundary'

/**
 * Turns off `retryOnMount` for a query that throws its errors (with `suspense` or `throwOnError`),
 * unless the error boundary has been reset, so a remount doesn't retry the failed query before the
 * user resets the boundary. Mutates the options.
 * @param options - The defaulted query options to adjust.
 * @param errorResetBoundary - The value of the nearest `QueryErrorResetBoundary`.
 * @param query - The query, used to evaluate a `throwOnError` function against its error.
 */
// 关键机制：错误抛出后，组件卸载再挂载时默认 retryOnMount 会再取一次，
// 结果又是错误 → 再次抛给边界 → 用户看到错误页闪烁。
// 所以在「会抛错（suspense 或 throwOnError）」且「边界还没被重置」时关掉 retryOnMount，
// 直到用户主动 reset（ErrorBoundary 的 reset 按钮）。
export const ensurePreventErrorBoundaryRetry = <
  TQueryFnData,
  TError,
  TData,
  TQueryData,
  TQueryKey extends QueryKey,
>(
  options: DefaultedQueryObserverOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryData,
    TQueryKey
  >,
  errorResetBoundary: QueryErrorResetBoundaryValue,
  query: Query<TQueryFnData, TError, TQueryData, TQueryKey> | undefined,
) => {
  const throwOnError =
    query?.state.status === 'error' &&
    typeof options.throwOnError === 'function'
      ? shouldThrowError(options.throwOnError, [
          query.state.error as TError,
          query,
        ])
      : options.throwOnError

  if (options.suspense || throwOnError) {
    // Prevent retrying failed query if the error boundary has not been reset yet
    if (!errorResetBoundary.isReset()) {
      options.retryOnMount = false
    }
  }
}

/**
 * Clears the reset state of the error boundary after the component mounts, so later errors are
 * thrown to the boundary again.
 * @param errorResetBoundary - The value of the nearest `QueryErrorResetBoundary`.
 */
// 挂载后立刻清掉 reset 标记：保证「这次挂载之后」再发生的错误仍能正常抛给边界。
// 与上面的 prevent 配合，形成「只抑制跨挂载的重复重试，不抑制本次渲染内的错误」。
export const useClearResetErrorBoundary = (
  errorResetBoundary: QueryErrorResetBoundaryValue,
) => {
  React.useEffect(() => {
    errorResetBoundary.clearReset()
  }, [errorResetBoundary])
}

/**
 * Checks whether the query error should be thrown to the nearest error boundary: the query errored
 * and isn't fetching, the boundary hasn't been reset, and either `suspense` is enabled with no data
 * or `throwOnError` says so.
 * @param params - The observer `result`, the `errorResetBoundary`, the `throwOnError` option, the
 * `query`, and the `suspense` option.
 * @returns `true` if the error should be thrown.
 */
// 四个条件全真才抛：isError、边界未被重置、当前不在 fetching、query 存在，
// 且（suspense 且无数据）或 throwOnError 判定为真。
// !result.isFetching 是为了「重试中不抛」：重试成功后这次错误就自然消失了。
export const getHasError = <
  TData,
  TError,
  TQueryFnData,
  TQueryData,
  TQueryKey extends QueryKey,
>({
  result,
  errorResetBoundary,
  throwOnError,
  query,
  suspense,
}: {
  result: QueryObserverResult<TData, TError>
  errorResetBoundary: QueryErrorResetBoundaryValue
  throwOnError: ThrowOnError<TQueryFnData, TError, TQueryData, TQueryKey>
  query: Query<TQueryFnData, TError, TQueryData, TQueryKey> | undefined
  suspense: boolean | undefined
}) => {
  return (
    result.isError &&
    !errorResetBoundary.isReset() &&
    !result.isFetching &&
    query &&
    ((suspense && result.data === undefined) ||
      shouldThrowError(throwOnError, [result.error, query]))
  )
}
