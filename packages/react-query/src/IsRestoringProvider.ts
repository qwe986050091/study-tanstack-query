'use client'
import * as React from 'react'

const IsRestoringContext = React.createContext(false)

/**
 * If you are using `PersistQueryClientProvider`, you can also use the `useIsRestoring` hook alongside it to
 * check if a restore is currently in progress. `useQuery` and friends also check this internally to avoid
 * race conditions between the restore and mounting queries.
 * @returns `true` while a persisted client is being restored, `false` otherwise.
 */
// 一个布尔 Context，只有持久化场景（PersistQueryClientProvider）会把它置 true。
// useBaseQuery / useQueries 读到 true 时会跳过订阅与取数，等恢复完成再开始，
// 从而避免「磁盘里的数据还没读完，组件已经发了一轮请求」。
export const useIsRestoring = () => React.useContext(IsRestoringContext)

/**
 * The Provider that `PersistQueryClientProvider` uses to signal whether a persisted client is currently
 * being restored, read by `useIsRestoring`.
 */
export const IsRestoringProvider = IsRestoringContext.Provider
