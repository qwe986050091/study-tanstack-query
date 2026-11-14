'use client'
import * as React from 'react'

import { noop, notifyManager } from '@tanstack/query-core'
import { useQueryClient } from './QueryClientProvider'
import { useQueryErrorResetBoundary } from './QueryErrorResetBoundary'
import {
  ensurePreventErrorBoundaryRetry,
  getHasError,
  useClearResetErrorBoundary,
} from './errorBoundaryUtils'
import { useIsRestoring } from './IsRestoringProvider'
import {
  ensureSuspenseTimers,
  fetchOptimistic,
  shouldSuspend,
} from './suspense'
import type {
  QueryClient,
  QueryKey,
  QueryObserver,
  QueryObserverResult,
} from '@tanstack/query-core'
import type { UseBaseQueryOptions } from './types'

/**
 * Base implementation shared by `useQuery`, `useInfiniteQuery`, `useSuspenseQuery`, and
 * `useSuspenseInfiniteQuery`.
 * @param options - The options passed to the calling hook.
 * @param Observer - The observer class from query-core (`QueryObserver` or
 * `InfiniteQueryObserver`).
 * @param queryClient - Use this to use a custom `QueryClient`. Otherwise, the one from the nearest
 * context will be used.
 * @returns The query result, tracking which properties are read unless `notifyOnChangeProps` is
 * set.
 * @throws {Error} If `options` is not an object (outside production), or the query error when it should be
 * thrown to the nearest error boundary (see `throwOnError`). While suspending, it throws a promise instead.
 */
// ═══ 中文注释导读 ═══
// 这是「QueryObserver → React hook」的常规映射点（useQueries 另有自己的 QueriesObserver，
// 其 suspense 分支会临时 new 一个 QueryObserver，但不订阅）；useQuery / useInfiniteQuery /
// useSuspenseQuery / useSuspenseInfiniteQuery 都只是传入不同 Observer 类的薄壳。
// 一次渲染的顺序（也就是读这个文件的顺序）：
//   1) 取 client、把 options 默认化（补 queryHash 等派生默认值）；
//   2) useState 惰性创建 observer（每组件实例一个，跨渲染稳定）；
//   3) getOptimisticResult：同步算出本次要渲染的 result（可能假装 fetching）；
//   4) effect 里 setOptions：把本次 options 同步给 observer，必要时触发 fetch；
//   5) useSyncExternalStore：订阅 observer，把 getCurrentResult 作为快照；
//   6) 最后处理 suspense（throw promise）与 error boundary（throw error）。
// 为什么 3 必须在 5 之前：订阅发生在 commit 之后，若不先乐观算一次，首帧会显示空态。
// ──────────────────────
export function useBaseQuery<
  TQueryFnData,
  TError,
  TData,
  TQueryData,
  TQueryKey extends QueryKey,
>(
  options: UseBaseQueryOptions<
    TQueryFnData,
    TError,
    TData,
    TQueryData,
    TQueryKey
  >,
  Observer: typeof QueryObserver,
  queryClient?: QueryClient,
): QueryObserverResult<TData, TError> {
  if (process.env.NODE_ENV !== 'production') {
    if (typeof options !== 'object' || Array.isArray(options)) {
      throw new Error(
        'Bad argument type. Starting with v5, only the "Object" form is allowed when calling query related functions. Please use the error stack to find the culprit call. More info here: https://tanstack.com/query/latest/docs/react/guides/migrating-to-v5#supports-a-single-signature-one-object',
      )
    }
  }

  // 三个上下文依赖：持久化恢复标记、错误边界重置器、QueryClient。
  // isRestoring 为真时「不订阅、不取数」，避免恢复尚未完成就发起重复请求。
  const isRestoring = useIsRestoring()
  const errorResetBoundary = useQueryErrorResetBoundary()
  const client = useQueryClient(queryClient)
  const defaultedOptions = client.defaultQueryOptions(options)

  const query = client
    .getQueryCache()
    .get<TQueryFnData, TError, TQueryData, TQueryKey>(
      defaultedOptions.queryHash,
    )

  if (process.env.NODE_ENV !== 'production') {
    if (!defaultedOptions.queryFn) {
      console.error(
        `[${defaultedOptions.queryHash}]: No queryFn was passed as an option, and no default queryFn was found. The queryFn parameter is only optional when using a default queryFn. More info here: https://tanstack.com/query/latest/docs/framework/react/guides/default-query-function`,
      )
    }
  }

  const subscribed = options.subscribed !== false

  // Make sure results are optimistically set in fetching state before subscribing or updating options
  defaultedOptions._optimisticResults = isRestoring
    ? 'isRestoring'
    : subscribed
      ? 'optimistic'
      : undefined

  ensureSuspenseTimers(defaultedOptions)
  ensurePreventErrorBoundaryRetry(defaultedOptions, errorResetBoundary, query)
  useClearResetErrorBoundary(errorResetBoundary)

  // observer 的生命周期 = 组件实例生命周期：useState 惰性初始化，之后 re-render 不再新建。
  // 注意这里 new Observer 只 build query（不 fetch）；fetch 在 subscribe 之后才发生。
  const [observer] = React.useState(
    () =>
      new Observer<TQueryFnData, TError, TData, TQueryData, TQueryKey>(
        client,
        defaultedOptions,
      ),
  )

  // note: this must be called before useSyncExternalStore
  // 这一行是「渲染期允许产生副作用」的唯一例外：它会按需 build Query（写入 cache），
  // 但不会触发网络请求。目的是让首帧的 isLoading 等标记正确。
  const result = observer.getOptimisticResult(defaultedOptions)

  // options 每次渲染都是新对象，effect 每次都会跑；observer.setOptions 内部做了浅比较与幂等处理，
  // 因此不必担心「每次都 fetch」——是否取数由 shouldFetchOptionally 决定。
  React.useEffect(() => {
    observer.setOptions(defaultedOptions)
  }, [defaultedOptions, observer])

  const shouldSubscribe = !isRestoring && subscribed
  // 订阅回调包了 notifyManager.batchCalls：把 observer 的多次通知合并成一次 store 变更。
  // 订阅后立刻 observer.updateResult()：补上「创建 observer → 订阅」之间的窗口，避免漏更新。
  // 两个 getSnapshot 都返回 getCurrentResult()：服务端渲染与客户端首次渲染必须一致，否则 hydration 报错。
  // subscribed=false 时返回 noop：允许「只读不订阅」的用法（例如由父级统一订阅）。
  React.useSyncExternalStore(
    React.useCallback(
      (onStoreChange) => {
        const unsubscribe = shouldSubscribe
          ? observer.subscribe(notifyManager.batchCalls(onStoreChange))
          : noop

        // Update result to make sure we did not miss any query updates
        // between creating the observer and subscribing to it.
        observer.updateResult()

        return unsubscribe
      },
      [observer, shouldSubscribe],
    ),
    () => observer.getCurrentResult(),
    () => observer.getCurrentResult(),
  )

  // Handle suspense
  // suspense：把 fetch 的 promise 抛给 React，由 Suspense 接住。
  // fetchOptimistic 不会修改本 observer 的 result，所以恢复渲染时走的是缓存里的最新数据。
  // 失败时它会 clearReset()，让错误可以被 ErrorBoundary 捕获（而不是一直 suspend）。
  if (shouldSuspend(defaultedOptions, result)) {
    throw fetchOptimistic(defaultedOptions, observer, errorResetBoundary)
  }

  // Handle error boundary
  // error boundary：满足条件就把 error 抛出去。判定集中在 errorBoundaryUtils.getHasError，
  // 关键条件是「!isFetching」与「errorResetBoundary 未被重置」——前者避免重试期间反复抛错，
  // 后者保证「用户点了重试」之后不会立刻又被同一错误打回。
  if (
    getHasError({
      result,
      errorResetBoundary,
      throwOnError: defaultedOptions.throwOnError,
      query,
      suspense: defaultedOptions.suspense,
    })
  ) {
    throw result.error
  }

  // Handle result property usage tracking
  // 默认路径返回 trackResult(result)：Proxy 会在渲染期记录读了哪些字段，
  // 之后 updateResult 只按这些字段判断是否通知 —— 这就是 v5「只在你用的字段变化时重渲染」。
  // 一旦显式配置了 notifyOnChangeProps，就退回普通对象（由配置决定比较范围）。
  return !defaultedOptions.notifyOnChangeProps
    ? observer.trackResult(result)
    : result
}
