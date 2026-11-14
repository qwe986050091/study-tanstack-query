# 深度注释索引

> 配套文档：[READING-GUIDE.md](./READING-GUIDE.md)（前置知识 / 起点 / 分段路线 / 分支跳转 / 跳过项 / 已知坑）。
> 版本：`@tanstack/query-core` 5.107.1，上游 commit `36dd792`。

## 0. 口径与边界

**统计口径（DENSITY-CALIBER v1）**

- `code` = 非空且非注释的行；`comment` = 整行注释（含块注释的每一行）；`空注释` = 内容为空的 `//` 行。
- `X = comment / code`，`Y = (comment - 空注释) / code`，均为百分比。
- 「前」= 上游 HEAD 原文件，「后」= 本仓当前文件。**代码行数前后完全一致**（只增注释，不改代码）。

**覆盖边界（可机械核对）**

| 范围 | 文件数 | 已注释 | 未注释 |
|---|---|---|---|
| `packages/query-core/src` | 23 | 22 | `types.ts`（2,344 行纯类型） |
| `packages/react-query/src` | 23 | 7 | 16 个薄壳 / 类型 / 内部工具（见 §3） |
| 其他框架适配层 | — | 0 | 只在 READING-GUIDE 给出跳转点，不改源码 |

合计：**29 个源码文件，863 行新增注释，0 行删除**（`git diff --shortstat`：`29 files changed, 863 insertions(+)`）。

**这份索引能证明什么、不能证明什么**

- 能证明：上表文件的注释行数、密度、以及「只增行」这一机械事实。
- 不能证明：注释的**正确性**。正确性只做过两类检查——(a) 所有跨文件断言都回到调用点 grep 验证；
  (b) 注释与代码在同一文件内逐段对照。没有做「注释内容 vs 运行时行为」的自动化验证。

## 1. 核心链路索引（按建议阅读顺序）

| # | 文件 | 一句话职责 | 建议入口（函数 / 字段） | code | 注释 | X% | Y% |
|---|---|---|---|---|---|---|---|
| 1 | `query-core/src/query.ts` | 一个 queryKey 的缓存 + 状态机 | `QueryState` → `#dispatch` → `fetch` | 650 | 511 | 78.62 | 78.62 |
| 2 | `query-core/src/retryer.ts` | 单次 fetch 的执行器：重试/退避/暂停/取消 | `createRetryer` 的 `pause` / `canContinue` | 190 | 128 | 67.37 | 67.37 |
| 3 | `query-core/src/queryCache.ts` | Map<queryHash, Query> + 缓存级事件 | `build` / `findAll` / `remove` | 186 | 202 | 108.60 | 108.60 |
| 4 | `query-core/src/utils.ts` | 哈希、前缀匹配、结构共享、懒 signal | `hashKey` / `partialMatchKey` / `replaceEqualDeep` / `addConsumeAwareSignal` | 389 | 343 | 88.17 | 88.17 |
| 5 | `query-core/src/queryClient.ts` | 门面：命令式 API + 默认值装配 | `defaultQueryOptions` / `invalidateQueries` / `refetchQueries` | 617 | 559 | 90.60 | 90.60 |
| 6 | `query-core/src/queryObserver.ts` | Query 状态 → 组件 result 的翻译层 | `onSubscribe` / `createResult` / `updateResult` | 647 | 344 | 53.17 | 53.17 |
| 7 | `query-core/src/notifyManager.ts` | 通知批量调度 | `batch` / `flush` / `batchCalls` | 75 | 92 | 122.67 | 122.67 |
| 8 | `query-core/src/focusManager.ts` | 聚焦状态单例（refetchOnWindowFocus 源） | `onSubscribe` / `setFocused` / `isFocused` | 65 | 83 | 127.69 | 127.69 |
| 9 | `query-core/src/onlineManager.ts` | 在线状态单例（networkMode / 暂停恢复源） | `setOnline` / `isOnline` | 53 | 63 | 118.87 | 118.87 |
| 10 | `query-core/src/removable.ts` | GC 基类：gcTime 定时器 | `scheduleGc` / `updateGcTime` / `optionalRemove` | 32 | 48 | 150.00 | 150.00 |
| 11 | `query-core/src/subscribable.ts` | 最小订阅基类 | `subscribe` / `hasListeners` | 21 | 56 | 266.67 | 266.67 |
| 12 | `query-core/src/timeoutManager.ts` | 定时器 provider 抽象 | `setTimeoutProvider` / `systemSetTimeoutZero` | 60 | 203 | 338.33 | 328.33 |
| 13 | `query-core/src/environmentManager.ts` | 服务端/客户端判定总闸 | `isServer` / `setIsServer` | 10 | 36 | 360.00 | 360.00 |
| 14 | `query-core/src/index.ts` | 公共 API 表面（纯 re-export） | 无（只做反向查名字） | 154 | 8 | 5.19 | 5.19 |

## 2. 分支主题索引

| 主题 | 文件 | 建议入口 | code | 注释 | X% | Y% |
|---|---|---|---|---|---|---|
| 无限滚动 | `query-core/src/infiniteQueryBehavior.ts` | `infiniteQueryBehavior.onFetch` 的三种分支 | 155 | 65 | 41.94 | 41.94 |
| 无限滚动（观察者） | `query-core/src/infiniteQueryObserver.ts` | `fetchNextPage` / `createResult` | 164 | 93 | 56.71 | 56.71 |
| 多查询组合 | `query-core/src/queriesObserver.ts` | `setQueries` / `getOptimisticResult` | 279 | 129 | 46.24 | 46.24 |
| 写操作 | `query-core/src/mutation.ts` | `execute` 的回调顺序 | 372 | 181 | 48.66 | 48.66 |
| 写操作（缓存/scope） | `query-core/src/mutationCache.ts` | `canRun` / `runNext` | 207 | 157 | 75.85 | 75.85 |
| 写操作（hook 内核） | `query-core/src/mutationObserver.ts` | `mutate` / `#notify` | 202 | 110 | 54.46 | 54.46 |
| SSR 水合 | `query-core/src/hydration.ts` | `dehydrate` / `hydrate` / `tryResolveSync` | 254 | 181 | 71.26 | 70.87 |
| 流式数据 | `query-core/src/streamedQuery.ts` | 三种 `refetchMode` | 100 | 54 | 54.00 | 54.00 |
| React 映射 | `react-query/src/useBaseQuery.ts` | `useSyncExternalStore` 前后各一步 | 116 | 53 | 45.69 | 45.69 |
| React 入口 | `react-query/src/useQuery.ts` | 只有最后一行有运行时逻辑 | 43 | 252 | 586.05 | 586.05 |
| React 多查询 | `react-query/src/useQueries.ts` | `useQueries` 函数体（前面是类型体操） | 290 | 197 | 67.93 | 67.93 |
| Suspense | `react-query/src/suspense.ts` | `ensureSuspenseTimers` / `shouldSuspend` | 66 | 38 | 57.58 | 57.58 |
| ErrorBoundary | `react-query/src/errorBoundaryUtils.ts` | `ensurePreventErrorBoundaryRetry` / `getHasError` | 77 | 31 | 40.26 | 40.26 |
| Client Provider | `react-query/src/QueryClientProvider.tsx` | `useQueryClient` / mount effect | 36 | 45 | 125.00 | 125.00 |
| 恢复标记 | `react-query/src/IsRestoringProvider.ts` | `useIsRestoring` | 5 | 13 | 260.00 | 260.00 |
| **合计** | 29 个文件 | — | **5,515** | **4,275** | **77.52** | **77.39** |

> `useQuery.ts` 与 `QueryClientProvider.tsx` 的 X > 100% 是因为上游本身就把大量示例写在注释里
> （`useQuery.ts` 注释 246 行 / 代码 43 行）。这两个数字反映的是「文件里文字多」，不代表本次新增密度。

## 3. 未注释清单与理由

**`packages/query-core/src/types.ts`（2,344 行）**
纯类型声明，没有运行时逻辑；注释它只会重复类型名。读的时候按符号搜索，不要通读。

**`packages/react-query/src` 未注释的 16 个文件**

| 文件 | 为什么不注释 |
|---|---|
| `index.ts` | 纯 re-export |
| `types.ts` | 纯类型 |
| `queryOptions.ts`、`infiniteQueryOptions.ts`、`mutationOptions.ts` | 身份函数（只做类型收窄），无运行时逻辑 |
| `useInfiniteQuery.ts`、`useSuspenseQuery.ts`、`useSuspenseInfiniteQuery.ts`、`useSuspenseQueries.ts` | 均是一行转发到 `useBaseQuery` / `useQueries`，模式与已注释的两个入口完全相同 |
| `useMutation.ts`、`useMutationState.ts` | 转发到 `MutationObserver`（内核已在 `query-core/src/mutationObserver.ts` 注释） |
| `useIsFetching.ts`、`usePrefetchQuery.tsx`、`usePrefetchInfiniteQuery.tsx` | 组合既有 API 的薄封装 |
| `HydrationBoundary.tsx` | 只调 `hydration.hydrate` 并把 promise 交给 `use()`；水合逻辑已在 `hydration.ts` 注释 |
| `QueryErrorResetBoundary.tsx`、`errorBoundaryUtils.ts`（后者已注释） | 前者是 Context 容器，后者是判定逻辑（已注释） |

需要时按同一套方法补：先读被转发的 core 实现，再回来只需要确认「参数怎么传、结果怎么包」。

## 4. 机械校验记录

| 检查 | 命令 | 结果 |
|---|---|---|
| 只增行 | `git diff --numstat` | 29 个文件，删除列全为 0 |
| 总增量 | `git diff --shortstat` | `29 files changed, 863 insertions(+)` |
| 行序保留 | 插入器内置断言（原文件每行按序出现在新文件中） | 29/29 通过 |
| 密度 | `density.mjs`（按 DENSITY-CALIBER v1） | 合计 X 77.52% / Y 77.39% |
| 空注释行 | 同上 | 7 行（均为上游原有，非本次新增） |
| 语法可解析 | `esbuild <file> --outfile=...`（逐文件，30 个） | 30/30 通过（0 error） |

未做：完整 TypeScript 类型检查与测试（仓库未安装依赖，`node_modules` 不存在）。
本次改动**只插入整行注释**，插入器在写入前断言「原文件每一行按顺序保留」；
另外用 esbuild 对 30 个文件逐个做了语法解析，均无报错。
仍建议在装了依赖的环境跑一次 `pnpm --filter @tanstack/query-core test` 作为最终确认。
