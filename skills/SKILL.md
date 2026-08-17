---
name: cocos-virtual-list
description: "Create and optimize high-performance virtual lists (虚拟列表/循环列表/长列表) in Cocos Creator 3.x projects. Covers architecture selection (slot-based virtualization vs placeholder+object-pool vs layered rendering for draw calls), a complete ready-to-adapt implementation recipe, object pooling, variable heights & grid, chat stick-to-bottom, pull-refresh/load-more, nested lists, scroll-event throttling, speed-adaptive buffers, and recycling pitfalls (stale content, tween leaks, pool selection, touch bubbling). Use when the user mentions 虚拟列表, virtual list, 循环列表/循环利用, item 回收/复用, 长列表卡顿/优化, ScrollView 性能, 无限滚动, 背包/聊天/排行榜/邮件列表, or reports blank items during fast scroll."
---

# Create Cocos Virtual List

## Purpose

指导在 Cocos Creator 3.x（以工作区 3.8.6 为准）中实现高性能虚拟列表：方案选型、核心算法、完整可改造实现、踩坑清单。

## 为什么需要虚拟列表（先向用户讲清楚）

引擎 3.8.x 的 2D 渲染**没有视口剔除**：

- 批处理器（Batcher2D）每帧深度遍历 RenderRoot2D 下**全部** active 节点，每个 UIRenderer 都会执行 `fillBuffers` 重新组装顶点。
- `Mask` 只在 GPU 模板测试阶段裁剪像素，**不节省**遍历/组顶点的 CPU 开销，也不减批外的顶点内存。
- 因此 1000 条数据的 ScrollView，即使 900 条在视口外，每帧仍付全量遍历成本；唯一解法是让视口外的节点**根本不存在（或 active=false）**，即虚拟化。

批处理器对 `activeInHierarchy === false` 的节点直接跳过整棵子树——这就是"回收时 `active=false` 或 removeFromParent"有效的依据。

## 性能是第一要求（本技能所有取舍的锚点）

本技能的全部设计决策以**性能为第一判据**，任何"功能更全但拖慢热路径"的扩展一律不做：

- 窗口定位选 O(1)（等高）或 O(log n)（不等高），**绝不用 O(n) 扫描**；
- diff 旋转保证稳定滚动时每帧只重绑 0~1 个节点，空闲帧近零成本；
- 等高模式坚持**所有模板等尺寸**——O(1) 依赖固定 stride，不为异尺寸模板"开小灶"（那会把它拖回 O(log n)）；异尺寸模板走不等高模式（O(log n) 定位，同样流畅）；
- 防御性检查（如多模板尺寸一致性 warn）只发生在初始化，**绝不进入滚动/绑定/回收热路径**；
- 降频/速度自适应等优化围绕"少做"与"做得快"两层，先量化再启用（见 references/01 §9）。

评估任何"加功能"的建议时先回答：它进了 `update()`/绑定/回收热路径吗？进了就不做。

## 方案选型（先读这里再动手）

| 方案 | 节点数 vs 数据量 | 每帧刷新成本 | 复杂度 | 适用 |
|---|---|---|---|---|
| **A. 槽位式纯虚拟列表**（推荐默认） | 恒定 = 可视+缓冲 | 等高 O(1)、不等高 O(log n) 定位 + O(diff) 重绑 | 中 | 万级数据、背包/排行榜/邮件/聊天 |
| B. 占位节点 + ShowNode 对象池 | 占位节点 = 数据量（或窗口数） | O(cells) 世界坐标 AABB 检测 | 低 | 几百条、Layout 迁移、高定制 |
| C. 分层渲染（降 DC，正交手段） | 不变 | 每代理一个同步循环 | 高 | 与 A/B 叠加，item 内 Label+Sprite 混排断批严重时 |

选型规则：
1. 默认选 **A**。完整可改造实现见 `examples/VirtualListView.ts`。
2. 列表规模 ≤ 数百、且团队想沿用 Layout/编辑器摆位 → 可选 B（方案 B 的 LoopList 思路，详见 references/03）。
3. DC 高可能是因为 item 内多材质组件混排（每个 item 一个 Label + 一个 Sprite 就会断批）→ 在 A/B 之上叠 C（机制见 references/03）。
4. 用户只是"列表卡"→ 先确认是节点规模/遍历成本再虚拟化，可用性能分析（帧率/节点数 profiler）确认瓶颈来源。

## 方案 A 核心架构（实现前必读）

结构：`ScrollView(view + Mask) → content`，虚拟列表组件驱动 content 尺寸与 item 位置。

1. **数据模型先行**：`sizes: number[]` + 前缀和 `prefix: number[]`（等高可省略，直接公式算）。
2. **窗口计算**：
   - 等高：`firstLine = floor(max(0, scrollPos - paddingTop) / stride)`，`first = firstLine * gridCount`，O(1)
   - 不等高：对 prefix 二分找 `start`，向后扫到 `end`，两端各扩 `buffer`，O(log n)
3. **槽位数组 + 旋转**：`slotNodes[i]` 显示数据 `firstIndex + i`；滚动 diff < slots 时
   splice+push/unshift 旋转数组，只重绑 `|diff|` 个节点；diff === 0 直接早退（空闲帧近零成本）。
4. **多模板对象池**：`typeIndex → Node[]`，按 `getItemType(index)` 取还。`cc.NodePool` 在 3.8.6 可用（属 2.x 兼容层），但一个实例只对应一种模板、依赖 unuse/reuse 处理组件机制；多模板虚拟列表更直接的做法是 `typeIndex → Node[]` 数组池（或 `js.Pool`：`import { js } from 'cc'`——注意它**不是** cc 顶层导出，`import { Pool } from 'cc'` 拿不到），每种模板一个 `NodePool` 实例亦可。
5. **回收清理**：`active=false` + `removeFromParent`，回收前 `Tween.stopAllByTarget(node)`、重置 scale/position/opacity、清事件闭包、清 Label 文本（防复用闪旧内容）。
6. **content 尺寸** = 最后一个 prefix + 尾项尺寸 + footerSpacing，且 **不小于视口尺寸**（否则回弹/边界行为异常）。content/view 的 UITransform 尺寸变化会被引擎经 `SIZE_CHANGED` 监听自动重算滚动边界，无需手动触发；只有运行期替换 content **节点引用**才走 content setter 的重算。
7. **刷新节流**：不依赖事件频率。`update()` 里直接读 content 位置，与缓存值比较，变了才刷新——每帧最多一次，天然覆盖惯性滚动；比监听 SCROLLING（touch-move 与惯性期高频发射）+ 计数器降频更简单可靠。
8. **可选速度自适应缓冲**：`effectiveBuffer = buffer + |每帧位移| * 预估帧数 / stride`（clamp 上限），
快速甩动时提前多绑几条防白屏，停稳后回落。默认 buffer=1~2 即可，先量化再开。低端机可再叠加分档降频（>2000px/s 刷 20fps、>1000px/s 刷 30fps）与低性能自动降级（最近 5 次刷新 ≥3 次超 16ms 则减半）——**任何降频都必须配"停止时强制刷新"兜底**，否则停留位置显示旧窗口（详见 references/01 §9）。

不等高测量闭环（聊天/展开项必读）：Label/RichText 只有 `active=true` 时才立即排版，所以流程是 绑定 → 激活 → renderItem 回调写内容 → 读真实 UITransform 尺寸 → 与模型不符则回写 + 从该 index 起重建前缀和 → 保持视口锚点（上方尺寸变化时平移 content 补偿）或贴底（聊天）。

## 实施步骤

1. 确认需求：方向、等高/不等高、grid 列数、模板种数、条目量级、是否要 scrollToIndex / 下拉刷新 / 上拉加载 / 贴底 / 嵌套。
2. 读 `references/01-architecture-and-algorithms.md`（算法细节 + 坐标数学推导）。
3. 复制 `examples/VirtualListView.ts` 为起点，删掉不需要的特性；业务侧用法见 `examples/usage-example.ts`。
4. 对照 `references/02-pitfalls-and-details.md` 逐条自检（回收残留、锚点数学、Mask 位置、平台 API、版本陷阱都在这份清单里）。
5. 想深入方案 B（占位 + AABB 可见性）与方案 C（分层渲染）的机制、取舍与局限时，读 `references/03-method-b-and-layered-rendering.md`。

## 硬性注意事项（违背必出 bug）

- **不要在 content 上挂引擎 `Layout`**：与手动定位互相打架，且增删节点会触发整容器重排。
- **刷新定时用组件 `update()`/`scheduler`，不用 `requestAnimationFrame`**：rAF 在 3.8.6 各端由平台 adapter 提供（原生、各小游戏 wrapper 均有），可用性不是主要问题；问题是 rAF 回调游离于组件生命周期之外——销毁时必须手动停，且"每个代理一条 rAF 循环"的做法在规模上去后白白多付 N 次回调。
- **对象池选型**：`cc.NodePool`（2.x 兼容层）单实例只管一种模板，`put()` 自动 `removeFromParent` 但**不重置节点状态**；多模板列表用 `typeIndex → Node[]` 数组池更直接。无论哪种池，下一条的回收清理都必须自己做。
- **回收节点必须清理 tween/定时器/事件**，否则复用时动画错乱、闭包持旧 index。
- **点击回调必须每次重绑 index**：复用节点上残留旧监听是虚拟列表最常见 bug。
- 分层渲染（方案 C）在 3.8.6 上是代理 hack：被代理节点父级不能旋转+非等比缩放并存，Mask 内列表的分层节点必须仍在同一 Mask 子树内，详见 references/02。
