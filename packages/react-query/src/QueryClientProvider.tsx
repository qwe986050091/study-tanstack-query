'use client'
import * as React from 'react'

import type { QueryClient } from '@tanstack/query-core'

/**
 * The context that `useQueryClient` reads from. `QueryClientProvider` is the normal way to set it.
 */
export const QueryClientContext = React.createContext<QueryClient | undefined>(
  undefined,
)

/**
 * The `useQueryClient` hook returns the current `QueryClient` instance.
 * @param queryClient - Use this to use a custom `QueryClient`. Otherwise, the one from the nearest context will
 * be used.
 * @returns The current `QueryClient` instance.
 * @throws {Error} If no `queryClient` argument is passed and no `QueryClientProvider` is found in the
 * component tree.
 */
// 显式传入 queryClient 时优先用它（便于测试/多 client）；否则读 Context。
// 抛错而不是返回 undefined：让「忘了包 Provider」在开发期立刻暴露。
export const useQueryClient = (queryClient?: QueryClient) => {
  const client = React.useContext(QueryClientContext)

  if (queryClient) {
    return queryClient
  }

  if (!client) {
    throw new Error('No QueryClient set, use QueryClientProvider to set one')
  }

  return client
}

/**
 * The props accepted by `QueryClientProvider`.
 */
export type QueryClientProviderProps = {
  /**
   * **Required**
   *
   * The `QueryClient` instance to provide.
   */
  client: QueryClient
  /**
   * The components that get access to the provided `QueryClient`.
   */
  children?: React.ReactNode
}

/**
 * Use the `QueryClientProvider` component to connect and provide a `QueryClient` to your application. Also
 * calls `client.mount()`/`client.unmount()` as this component mounts/unmounts, which subscribes the client to
 * focus/online events (resuming any paused mutations and refetching as needed when the app regains focus or
 * comes back online).
 * @param props - The `client` to provide, and the `children` that get access to it.
 * @returns The provided `children`, wrapped so they can read the `QueryClient` via `useQueryClient`.
 * @example
 * ```tsx
 * import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
 *
 * const queryClient = new QueryClient()
 *
 * function App() {
 *   return <QueryClientProvider client={queryClient}>...</QueryClientProvider>
 * }
 * ```
 */
export const QueryClientProvider = ({
  client,
  children,
}: QueryClientProviderProps): React.JSX.Element => {
  // Provider 挂载 = client.mount()：这一刻才订阅 focus/online 事件。
  // 卸载时 unmount() 引用计数减一；这就是「没有 Provider 时 refetchOnWindowFocus 不生效」的原因。
  // effect 依赖 client：切换 client 会先 unmount 旧的再 mount 新的。
  React.useEffect(() => {
    client.mount()
    return () => {
      client.unmount()
    }
  }, [client])

  return (
    <QueryClientContext.Provider value={client}>
      {children}
    </QueryClientContext.Provider>
  )
}
