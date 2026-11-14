# TanStack Query 阅读指南

> 版本：`packages/query-core` 5.107.1，上游 commit `36dd792`（2026-11-14）。
> 范围：`packages/query-core` 与框架适配层（`react-query` 为主，其余框架只给跳转点）。
> **不含**：`query-devtools`、各框架的 `*-devtools`、`examples/`、`docs/`、`__tests__/`。
> 所有位置都指到**文件 + 函数/字段名**，不指行号区间（本仓注释增删会让行号漂移）。

## 0. 注释约定

- 每个被注释的文件顶部有 `// ═══ 中文注释导读 ═══` 块，说明它在链路中的位置、上下游、关键不变量。
- 复杂流程里有 `// ── 段N begin ──` 之类的分段标记，与本文的「分段路线」一一对应。
- 行内中文注释优先解释**为什么**与**顺序约束**（例如「为什么先加监听器再回调 onSubscribe」），
  API 语义仍以文件里保留的上游英文 JSDoc 为准。
- 密度按 `DENSITY-CALIBER v1` 统计（X = 注释行/代码行，Y = 非空注释行/代码行），
  逐文件数字见同目录 [INDEX.md](./INDEX.md)。

## 1. 前置知识

只列读这套代码真正会用到的：

1. **JS 事件循环与宏任务**：`notifyManager` 的默认调度是 `setTimeout(cb, 0)`，
   所以「状态已变」与「组件收到通知」之间隔了一个宏任务。读通知相关代码时先记住这一点。
2. **对象引用相等**：整套渲染优化的地基是「引用没变就不通知」。结构共享
   （`utils.replaceEqualDeep`）负责让内容相同的重取结果复用旧引用。
3. **类私有字段 `#`**：`Query`、`QueryObserver` 的内部状态全用 `#`，
   它们就是「不变量」的边界：外部只能通过公开方法与 `#dispatch` 影响状态。
4. **`Proxy`**：`QueryObserver.trackResult` 用它做「组件读了哪些字段」的运行时收集。
5. **`AbortController` / `AbortSignal`**：取消语义不是「总是中断」，而是
   「只有 `queryFn` 读过 `signal` 才中断」；`utils.addConsumeAwareSignal` 是这套懒读取的实现。
6. **`Symbol` 哨兵**：`skipToken`（禁用查询）与 `fetchSignal`（内部 signal 透传）。
7. **React 的 `useSyncExternalStore` / `Suspense` / ErrorBoundary**：只在段 7 需要；
   不读框架适配层可以完全跳过。

## 2. 从哪开始读（以及为什么不是 `useQuery`）

**入口：`packages/query-core/src/query.ts`，按 `QueryState` → `#dispatch` → `fetch()` 的顺序读。**

理由：

- `QueryState` 只有 12 个字段，但它定义了后面所有代码的词汇表：
  `status`（有没有数据）与 `fetchStatus`（在不在取数）是**两个正交维度**，
  `dataUpdatedAt` / `errorUpdatedAt` 决定新鲜度，`fetchFailureCount` 只描述**本轮**失败次数。
  先把这 12 个字段的含义吃透，后面 8 个 action 的 reducer 就不需要再解释了。
- `#dispatch` 是**唯一的状态写入口**。读完它你会得到一个强不变量：
  没有第二处能改 `query.state`（`setData` / `setState` / `invalidate` / `fetch` 内部都只是构造 action）。
- `fetch()` 把「去重、options 合并、signal、behavior、retryer、结算、取消」串成一条直线，
  读完这一段，你就知道一次请求从哪里开始、在哪里结束。

**为什么不要从最容易想到的入口开始：**

| 容易想到的入口 | 为什么不适合作为起点 |
|---|---|
| `packages/react-query/src/useQuery.ts` | 289 行里只有最后一行 `return useBaseQuery(options, QueryObserver, queryClient)` 有运行时逻辑，其余是 3 个类型重载 + 大量示例。从它开始只能看到「转发」，看不到取数发生在哪。 |
| `packages/query-core/src/index.ts` | 纯 re-export，没有逻辑，只会给你一堆名字。 |
| `packages/query-core/src/queryClient.ts` | 是门面（facade）：`invalidateQueries`/`refetchQueries`/`removeQueries`/`cancelQueries` 都是「`findAll` → 逐个转发 → 包 `batch`」的同一形状。先读它会误以为缓存策略都在这里，实际上真正的策略在 `QueryObserver` 与 `Query`。 |
| `packages/query-core/src/types.ts` | 2,344 行纯类型。它描述的是「能配什么」，不是「怎么跑」。当字典查，别通读。 |

## 3. 分段路线

### 段 0 数据模型与状态机（`query.ts` 前半）

- 入口：`QueryState` 接口 → `FetchContext` / `QueryBehavior` / `FetchOptions`。
- 结束：`Action` 联合类型与 `#dispatch` 的 reducer 读完。
- 获得：`status × fetchStatus` 的 3×3 组合里哪些真实存在；`isInvalidated` 与 `dataUpdatedAt` 的分工；
  `fetchMeta` 是无限查询传递方向信息的唯一通道。
- 衔接：reducer 的每种 action 都对应 `fetch()` 里的一个调用点，下一段逐个对上。

### 段 1 一次取数（`query.ts#fetch` + `retryer.ts`）

- 入口：`Query.fetch` 的去重分支（`fetchStatus !== 'idle'`）。
- 结束：`fetchPromise` 的 `finally` 分支（清 `#retryer`/`#fetchPromise`、`scheduleGc`）。
- 获得：
  - 「同一 queryKey 并发只发一个请求」的确切实现（返回 `#fetchPromise`）；
  - `cancelRefetch` 只在「已有 data」时打断旧请求；
  - `#revertState` 的三处写入与 `cancel({revert:true})` 的回滚语义；
  - `retryer` 的 `pause/continue/cancelRetry` 三个概念的区别。
- 衔接：本段结束时数据已经通过 `setData` 写进 `state`，下一步看谁被通知（段 5）。

### 段 2 存储与去重（`queryCache.ts` + `utils.hashKey/partialMatchKey`）

- 入口：`QueryCache.build`（get-or-create）。
- 结束：`find` / `findAll`（`exact` 默认 `true`）。
- 获得：
  - `queryHash` 是 Map 键，`hashKey` 排序对象键但不排序数组 → 决定「什么算同一个查询」；
  - `partialMatchKey` 是前缀匹配 → 决定 `invalidateQueries({queryKey:['posts']})` 的级联范围；
  - `remove` 用实例同一性判断 → 旧实例不会误删新实例。
- 衔接：`QueryCache` 只负责存与筛；「什么时候取数」在段 5。

### 段 3 门面与级联（`queryClient.ts`）

- 入口：`defaultQueryOptions`（所有配置的最终装配点）。
- 结束：`invalidateQueries` → `refetchQueries` 的调用链。
- 获得：
  - 配置合并优先级：`defaultOptions.queries` → `setQueryDefaults(queryKey)` → 调用方 options；
  - 四组派生默认值（`refetchOnReconnect`、`throwOnError`、`persister→offlineFirst`、`skipToken→enabled:false`）；
  - `invalidate`（只打标记）与 `refetch`（真取数）如何被 `refetchType` 串起来；
  - `refetchQueries` 为什么跳过 `isDisabled` / `isStatic`，为什么暂停中的 query 立即 resolve。
- 衔接：`queryClient.query()` 是新统一取数 API，逻辑等同「`stale` 才 `fetch`」，读一段即可。

### 段 4 观察者与派生（`queryObserver.ts`）

- 入口：`onSubscribe`（首屏是否取数的决策点）。
- 结束：`createResult` 的字段表 + `updateResult` 的通知判定。
- 获得：
  - 为什么「构造 observer 不取数、订阅才取数」；
  - `isLoading = isPending && isFetching`、`isRefetching = isFetching && !isPending` 这组定义；
  - `select` 与 `placeholderData` 各自的记忆化条件；
  - `notifyOnChangeProps` / `trackedProps` 如何决定「要不要重渲染」。
- 衔接：「要不要取数」的四个谓词（`shouldFetchOnMount` / `shouldFetchOn` / `shouldFetchOptionally` / `isStale`）
  在文件末尾，建议最后读，它们是段 5 的输入。

### 段 5 调度与批处理（`notifyManager.ts` 及其使用者）

- 入口：`notifyManager.batch` 与 `schedule`。
- 结束：`timeoutManager` 的 provider 抽象（为什么定时器不能直接用全局 `setTimeout`）。
- 获得：
  - 两种通知路径：`batch` 包住的「入队 → flush」与直接 `listeners.forEach` 的同步通知；
  - `focusManager` / `onlineManager` 是全局单例，只在 `QueryClient.mount` 之后才被订阅；
  - `Removable` 的 GC 定时器与 `Query.optionalRemove` 的「到点也可能不删」；
  - `environmentManager.isServer` 影响的三处默认值（gcTime / retry / 定时器）。
- 衔接：段 6 把这些机制映射到框架的渲染周期。

### 段 6 框架映射（`packages/react-query/src/useBaseQuery.ts`）

- 入口：`useBaseQuery`（常规 hook 路径创建 `QueryObserver` 的地方）。
- 注意：`useQueries` 的 suspense 分支会**临时**再 new 一个不订阅的 `QueryObserver` 用于发一次 fetch
  （`useQueries.ts` 的 `shouldAtLeastOneSuspend` 分支），别把它当成第二个常规入口。
- 结束：`useSyncExternalStore` 的三个参数与最后的 `trackResult`。
- 获得：一次渲染的固定顺序 ——
  默认化 options → 惰性创建 observer → `getOptimisticResult`（同步、可 build、不 fetch）
  → effect `setOptions` → 订阅（`onSubscribe` 才真正取数）→ `updateResult` 补漏
  → suspense / error boundary 的抛出。
- 衔接：`useQuery` 只是 `useBaseQuery(options, QueryObserver)`；`useQueries` 换成 `QueriesObserver`，
  结构完全平行（见下节分支）。

### 段 7 分支主题

见下一节表格。

## 4. 分支路线

| 只想懂 | 跳入点 | 必须先补 |
|---|---|---|
| 无限滚动 / 分页 | `query-core/src/infiniteQueryBehavior.ts` 的 `infiniteQueryBehavior.onFetch` | 段 1（`FetchOptions.meta` 与 `fetchMeta`）、段 4（`InfiniteQueryObserver.createResult`） |
| 一次观察多查询（`useQueries`） | `query-core/src/queriesObserver.ts` 的 `setQueries` / `getOptimisticResult` | 段 4（先懂单个 observer），否则看不懂「结构变化 vs 结果变化」 |
| 乐观更新 / 写操作 | `query-core/src/mutation.ts` 的 `execute` | 段 3（`invalidateQueries` / `cancelQueries` 配合），`mutationCache.canRun`（scope 串行） |
| SSR / 预取水合 | `query-core/src/hydration.ts` 的 `dehydrate` / `hydrate` | 段 2（hash 与 state 结构）、段 1（`initialPromise` 与 `ensureQueryFn`） |
| 离线持久化 / 多标签同步 | `packages/query-persist-client-core`、`query-broadcast-client-experimental` | 段 2；两个包都建立在 `QueryCache` 的 `build` + 事件上 |
| 流式数据 | `query-core/src/streamedQuery.ts` | 段 3（`setQueryData`）、段 1（signal 懒读取） |
| Vue / Solid / Svelte / Angular / Lit / Preact 适配 | 见下方「各框架的对应文件」 | 段 6，映射方式与 React 同构 |

**各框架的对应文件（已逐一核对调用点，不是推测；只列常规 hook 路径）：**

| 框架 | 常规 hook 路径创建 `QueryObserver` 的地方 | 调用 `client.mount()` 的地方 |
|---|---|---|
| React | `packages/react-query/src/useBaseQuery.ts` | `QueryClientProvider.tsx` |
| Preact | `packages/preact-query/src/useBaseQuery.ts` | `QueryClientProvider.tsx` |
| Vue | `packages/vue-query/src/useBaseQuery.ts` | `vueQueryPlugin.ts` |
| Solid | `packages/solid-query/src/useBaseQuery.ts` | `QueryClientProvider.tsx` |
| Svelte | `packages/svelte-query/src/createBaseQuery.svelte.ts` | `QueryClientProvider.svelte` |
| Angular | `packages/angular-query-experimental/src/create-base-query.ts` | `providers.ts` |
| Lit | `packages/lit-query/src/createQueryController.ts`、`createInfiniteQueryController.ts` | `QueryClientProvider.ts` |

读这些文件时只需要盯三件事：**observer 在哪创建、订阅在哪发生、结果怎么映射成框架的响应式原语**
（Vue 的 `shallowRef`、Solid 的 `createStore`、Svelte 的 `$state`、Angular 的 `signal`、Lit 的 controller）。

另有三处**非 hook 常规路径**的创建点，读代码时可能撞上，别当成新机制：
`query-core/src/queriesObserver.ts`（`useQueries` 每个子查询一个，属于常规路径但不在上表）、
`react-query/src/useQueries.ts` 与 `preact-query/src/useQueries.ts` 的 suspense 分支（临时、不订阅）、
`lit-query/src/createQueryController.ts`（controller 本身即入口，两处创建分别对应首次与重建）。

## 5. 可以跳过的部分

- `packages/query-core/src/types.ts`（2,344 行）：当字典查。真正需要时按符号搜。
- `packages/query-core/src/__tests__/`、各框架的 `__tests__/`：以行为规格为主，
  想确认某个边界时再定向查（例如 `query.test.tsx` 的取消用例、`queryClient.test.tsx` 的级联用例）。
- `packages/react-query/src/useQuery.ts` 的 3 个类型重载、`useQueries.ts` 前 ~350 行类型体操、
  `infiniteQueryObserver.ts` 顶部的 `override subscribe/getCurrentResult/fetch` 类型覆盖：**零运行时逻辑**。
- `packages/query-core/src/index.ts`：纯 re-export。
- 已废弃的一族：`fetchQuery` / `prefetchQuery` / `fetchInfiniteQuery` / `ensureQueryData`（`@deprecated`），
  只在做迁移或读旧代码时看，新代码统一走 `queryClient.query()` / `infiniteQuery()`。
- `query-devtools`、`*-devtools`、`examples/`、`docs/`：按题目要求不纳入。

## 6. 已知坑（读的时候会撞上）

1. **「谁在用它」类断言必须先看调用点。** 例如 `QueryObserver` 并不是被 `useQuery` 直接 `new` 的，
   而是由各框架的 base-query 模块创建；写注释或改代码前请回到上表的文件确认。
2. **取消不等于中断。** `Query.removeObserver` 只有在 `#abortSignalConsumed` 为真（`queryFn` 读过 `signal`）
   或「paused 且 pending」时才 `cancel({revert:true})`；否则只 `cancelRetry()`，请求会继续跑完并写缓存。
3. **`Query.isStale()` 与 `Query.isStaleByTime()` 不是同一件事。** 前者在「有 observer」时返回
   `observers.some(o => o.getCurrentResult().isStale)`，会把每个 observer 的 `enabled` 算进去；
   后者只按 `staleTime` 与 `dataUpdatedAt` 计算。`enabled:false` 的 observer 会让前者为 `false`、后者仍可能为 `true`。
4. **`gcTime` 取历史最大值。** `Removable.updateGcTime` 用 `Math.max`，不是覆盖。
   同一 query 被多个 observer 用不同 options `setOptions` 时，短的 `gcTime` 不会缩短已排的回收时间。
5. **同一 hash 只有一个 `Query`，但 `options` 只有一份。** `Query.setOptions` 会被最后调用的 observer 覆盖；
   不过取数时传的是各 observer 自己的 options（`query.fetch(this.options, ...)`），所以行为仍按各自配置。
6. **`notifyManager` 有两条通知路径。** `batch` 里的通知会入队并在 `setTimeout(0)` 后统一派发；
   但各 `#dispatch`/`notify` 内部的 `listeners.forEach` 是同步执行的。看到「改了状态但组件这一帧没更新」先想到这一点。
7. **`removeQueries` 会取消在途请求。** 链路是 `QueryCache.remove → Query.destroy → cancel({silent:true})`；
   如果只想失效、不想打断请求，用 `invalidateQueries`。
8. **suspense 会给 `staleTime` / `gcTime` 兜底 1000ms。** `suspense.ts#ensureSuspenseTimers` 就地改 options；
   排查「为什么 suspense 下刚取的数据不立刻 stale」时看这里。
9. **`_optimisticResults` 是渲染期的假象。** 它只让 `createResult` 按「如果现在取数」派生出 `fetching`，
   不会改 `query.state`，也不会发请求。真正的 `fetchStatus` 要等订阅之后。
10. **`refetchQueries` 对暂停中的 query 立即 resolve。** 否则调用方会 `await` 到一个「等网络恢复」的 promise，
    可能永远不返回；代价是「await 完成」不代表数据已经取到。
11. **`streamedQuery` 在没有读 `signal` 时会跑完。** 取消只截断后续 `setQueryData`，
    不会中断 `streamFn` 本身的迭代（除非它自己读 signal）。

## 7. 把各段串起来：一次 `useQuery` 的完整时序

以 React 为例，两个组件用同一个 `queryKey`：

1. **渲染**：`useBaseQuery` 默认化 options，`useState` 惰性创建 `QueryObserver`；
   构造函数里 `setOptions` 会 `QueryCache.build` 出 `Query`（此时 `observers` 为空）。
2. **同帧渲染**：`getOptimisticResult` 再 `build`（命中同一个实例），用 `_optimisticResults` 派生出
   「假设正在取数」的 result —— 首帧就能显示 `isLoading`。
3. **提交后**：`setOptions` effect 把最新 options 写回 `observer` 与 `query`；未订阅时不会取数。
4. **订阅**：`useSyncExternalStore` 调 `observer.subscribe` → `onSubscribe` →
   `query.addObserver`（`clearGcTimeout`）→ `shouldFetchOnMount` 为真 → `#executeFetch`。
5. **取数**：`Query.fetch` 检查 `fetchStatus`，`idle` 则创建 `AbortController`、组装 context、
   选 behavior、`dispatch('fetch')`、`createRetryer` 并 `start()`。
6. **第二个组件挂载**：它的 observer 也 `addObserver`；`shouldFetchOnMount` 仍为真（无数据），
   调 `fetch` 时命中「`fetchStatus !== 'idle'`」分支 → 直接返回第一个请求的 `#fetchPromise`（去重完成）。
7. **成功**：`retryer` resolve → `setData` → `replaceData` 结构共享 → `dispatch('success')`：
   `dataUpdateCount++`、`isInvalidated=false`、`fetchStatus='idle'`；随后同步通知两个 observer 的 `onQueryUpdate`。
8. **派生与通知**：每个 observer `createResult` → `updateResult` 浅比较 →
   按 `notifyOnChangeProps`/`trackedProps` 决定是否回调 → `notifyManager` 在下一宏任务里让 React 重渲染。
9. **失效**：`invalidateQueries({queryKey:['x']})` → `findAll` 前缀匹配 → `query.invalidate()`（只打标记）
   → 默认 `refetchType:'active'` → `refetchQueries` 对 active 且非 static 的 query 调 `fetch`（默认打断旧请求）。
10. **卸载**：最后一个 observer 退订 → `QueryObserver.destroy` → `query.removeObserver`：
    读过 signal 则取消并回滚，否则只停止重试 → `scheduleGc()` 开始 `gcTime` 倒计时 →
    到点 `optionalRemove`：无 observer 且非 fetching 才真正 `QueryCache.remove`。

## 8. 只读 `query-core`（不看框架）的读法

可以完全不碰 React：直接 `new QueryClient()`，手动 `new QueryObserver(...)` 并 `subscribe`。
这正是 `query-core/src/__tests__/` 里大多数用例的写法，也是最短的验证路径：

```ts
const client = new QueryClient()
const observer = new QueryObserver(client, { queryKey: ['k'], queryFn })
const unsubscribe = observer.subscribe((result) => console.log(result.status))
// 此时才开始取数；unsubscribe() 会触发 GC 倒计时
```

注意：手动 `new QueryClient()` 后**不需要** `mount()` 也能取数；`mount()` 只影响
「焦点 / 网络恢复时的自动重取」与「暂停 mutation 的恢复」。
