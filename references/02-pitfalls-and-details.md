# 02 · 踩坑清单与版本/平台细节

按"违背必出 bug → 高频坑 → 版本陷阱 → 平台注意 → 验收自测"组织。以下结论针对 Cocos Creator 3.8.6 的引擎行为。

## 0. 引擎事实速查（向用户解释"为什么"时引用）

- 2D 渲染无视口剔除：每帧遍历 RenderRoot2D 下全部 active 节点，每个激活的 UIRenderer 每帧重新组装顶点。
- `activeInHierarchy === false` 的节点整棵子树被跳过（这正是池化能省 CPU 的依据）。
- Mask 是 GPU 模板裁剪（stencil 流程），不节省遍历/组顶点的 CPU 开销（合批影响见引擎 2D 渲染文档）。
- ScrollView 的 SCROLLING 在 touch-move 与惯性/自动滚动期高频发射；惯性结束发 SCROLL_ENDED。
- ScrollView `cancelInnerEvents` 默认 true：判定为滚动手势时给子节点补发 TOUCH_CANCEL。
- content 引用变化触发滚动边界重算（走 content setter → `_calculateBoundary`）。
- `cc.NodePool` 存在（2.x 兼容层）；通用池 `js.Pool`（`import { js } from 'cc'`）**非** cc 顶层导出，`import { Pool } from 'cc'` 拿不到。
- content/view 尺寸变化 → 引擎自动重算滚动边界（无需手动触发）；替换 content 节点引用才走 setter。
- 3.8.6 **无** `Sorting2D`（分层 DC 优化需 3.8.7+）。
- `requestAnimationFrame` 各端由平台 adapter 提供（原生 jsb-adapter、小游戏 wrapper）。

经验：判断"引擎有没有 API X"时，检索范围要覆盖 `cocos/`、`extensions/`、`platforms/`、`exports/` 全树（兼容层 API 常落在 `extensions/` 而非 `cocos/`）；同时要确认**导出形态**——某个类虽存在于某源文件，却可能只经命名空间（如 `js.Pool`）转出，而非 `cc` 顶层导出。

## 1. 回收清理清单（每一条缺失都有对应症状）

- [ ] `Tween.stopAllByTarget(node)`——否则复用时旧入场动画中途接管，节点缩放/位移错乱。
- [ ] 重置 `scale`、`position`、`UIOpacity`——入场动效常改这些，复用残留。
- [ ] 取消 `Scheduler`/自定义定时器（组件在 item 上时 `unscheduleAllCallbacks`）。
- [ ] 清理/重绑事件监听：点击必须在节点创建时绑一次、回调读 dataIndex；**不要**每次绑定 on/off 一对（高频滚动下这是分配与泄漏源头）。
- [ ] 异步回调守卫：`renderItemFn` 里发起的异步加载（头像、远程图）回来时必须检查`node.isValid` 且 dataIndex 仍是发起时的 index，否则写错到已复用的节点上（闪烁旧图）。
- [ ] Label/RichText 长文本清空或复用时立即覆写——同帧残留一帧旧内容是复用闪烁主因。
- [ ] 池本身上限：长期不封顶的池在"大量一次性模板"场景（活动页）会驻留内存，可设 `maxPoolSize` 超出即 destroy。

## 2. 坐标与锚点

- [ ] 所有可见性/落点计算统一走"距内容顶部距离"模型（references/01 §2 公式），不要混用世界坐标 `convertToWorldSpaceAR` 做每帧判断——那是方案 B 的 O(cells) 路径。
- [ ] 若必须读世界坐标（初始化测视口边界）：改锚点/改父节点后世界矩阵**下一帧**才更新，需 `scheduleOnce`/下一帧再读（等一帧即为此）。用 `getScrollOffset()` 读滚动量则完全绕开该问题。
- [ ] 视口边界计算要带 anchor 修正（2.x 移植常见 bug：右/上边缘忘记乘 `(1-anchor)` 导致"列表最右一列不显示"）。
- [ ] `pixelAlign`：取整后再 setPosition。
- [ ] content 尺寸不能小于视口（references/01 §10）；尺寸变化后的边界重算由引擎`SIZE_CHANGED` 监听自动完成，**无需手动触发**。

## 3. 组件与布局冲突

- [ ] content 上不挂 `Layout`（双写位置 + 增删节点触发全量重排）。
- [ ] content 上慎挂 `Widget`：ALWAYS 模式的对齐每帧改 content 位置，与滚动冲突；需要居中效果用列表自己的"内容不足一屏时居中"逻辑。
- [ ] 想保留编辑器所见即所得：item 模板Prefab 内部随便用 Layout（仅模板内部，一次性排版），list 层不介入。

## 4. 事件与交互

- [ ] 点击判定：item 根节点监听 `TOUCH_END` + 位移阈值（TOUCH_START 记起点，释放时位移 < ~8px 才算点击）；ScrollView `cancelInnerEvents` 默认会把滚动转成对子节点的 TOUCH_CANCEL，天然过滤误触。
- [ ] 回调签名统一 `(node, index)`，index 从槽位 dataIndex 读，闭包不捕获循环变量。
- [ ] 嵌套列表：子列表按**起手主轴方向**认领手势；子列表该轴滚到头后放行给父列表（反向也要放行）。引擎 ScrollView 间嵌套还需注意 `cancelInnerEvents` 的吞触。
- [ ] 下拉刷新/加载更多用一次性边界事件（`SCROLL_TO_TOP/BOTTOM`）+ 状态锁，不要用 SCROLLING 高频事件里做阈值判断又忘记去抖。
- [ ] item 内嵌 `Button` 时防双触发：触摸事件沿父链冒泡，Button 的 CLICK 与 item 根的TOUCH_END 都会响应——二选一（整面点击用 item 根的监听就不放 Button，或局部可点区只靠 Button 的 click）。
- [ ] 自定义按压态要同时监听 `TOUCH_CANCEL`：ScrollView 默认 `cancelInnerEvents` 为 true，判定为滚动手势时会给子节点补发 CANCEL，只监听 END 的按压效果会卡在按下外观。

## 5. 测量与动态尺寸

- [ ] Label/RichText 只有 `active=true`（enabledInHierarchy）才立即排版：先激活 → renderItem 写内容 → 再读 UITransform 尺寸（先激活再读是引擎组件排版时序的要求）。
- [ ] 回写容差 ≥1px，防浮点抖动死循环；每索引一次回写护栏。
- [ ] 视口上方项尺寸变化 → 平移 content 保持视口锚定；位于底部（聊天）→ 贴底。两者都做完再 markDirty 重对齐（references/01 §8）。
- [ ] `getItemSize` 必须是**纯函数**（同步、无副作用）；异步尺寸（远程图片高度）只能事后回写走单点尺寸变化路径。
- [ ] 展开动画期间逐帧改尺寸 = 每帧 O(n-i) 重建前缀和；条数多时改为动画结束一次性回写，或动画期间锁定该项尺寸（用 tween UITransform，配合视口外补偿，但注意每次都更新节点的成本）。

## 6. 版本陷阱（3.8.6 ↔ 3.8.7+ ↔ 2.4.x）

- `Sorting2D`：是 3.8.7 新增的接口，可以通过 `import { Sorting2D} from 'cc'` 引入，3.8.6 是没有的。3.8.6 上做"分层合批"只能上代理方案（见 references/03 分层渲染分析）或 UIStaticBatch/合图集。完整实现在 3.8.0–3.8.6 上运行会自动退化为无分层 DC 优化。
- 3.x 节点**没有 zIndex**（2.x 有）：层级 = 兄弟序 + 树序。分层渲染要自管排序键（代理方案用合成排序键 rZIndex + 手动 sort children 替代）。
- 2.x 的 `cc.ScrollView` 事件常量风格（`scroll-view-scrolling` 字符串）在 3.x 用`ScrollView.EventType.SCROLLING`；直接用 `"scrolling"` 字符串也能对上（枚举值即该字符串），但新代码用枚举。

## 7. 平台注意

- `requestAnimationFrame`：web/原生/小游戏都有 adapter 提供，**不是**可用性问题；不建议用在列表逻辑的原因是生命周期归属（组件销毁要手动停）与规模成本（每代理一条循环）。组件 `update()` 是归属正确、随组件启停的默认选择。
- 微信小游戏：真机调试注意 `console.log`：完整实现常在初始化时打印槽位日志，真机上是纯损耗，上线前要删；分包下 item Prefab 所在 bundle 需先加载。
- 高分屏抖动：`pixelAlign` + 设计分辨率缩放（View scale）下取整应取UI 坐标系（content 本地）而不是物理像素。

## 8. 性能验收自测（交付前跑一遍）

1. **万级数据首屏**：setCount(10000) 后首帧无明显卡顿（只应实例化可见+缓冲个节点；可用 profiler 看 JS time 与节点数）。
2. **快速甩动**：inertia 甩到底，边缘无白屏（有则调 buffer/开速度自适应）；甩动过程帧率平稳（无每帧 O(n) 尖峰——用性能面板确认 `_updateWindow` 成本）。
3. **慢滚**：逐像素滚动，item 内容正确、无旧内容闪烁、点击 index 正确。
4. **回收往返**：来回滚动 30s 后，content 子节点数恒定（= 槽位数），内存平稳（池未泄漏、tween 未堆积——`Tween.stopAllByTarget` 生效）。
5. **数据变更**：追加（贴底）、单点展开（视口锚定）、整表刷新（位置符合预期）、清空（`setCount(0)` 后 content 下无残留 item 节点）。
6. **重构后**：`director.loadScene` 往返，无 onDestroy 报错（事件/定时器已解绑）。

## 9. 什么时候**不该**上虚拟列表

- 条目 < 视口能显示的数量（一屏内）——直接摆。
- 条目几十条且无增长可能——普通 ScrollView + 图集合批已够，虚拟化是白付复杂度。
- item 之间尺寸差异完全随机且频繁变化 + 强动画需求——先考虑分页/分组，虚拟化不等高的测量闭环成本可能超过收益。
- 瓶颈其实在 DC 而不是节点数——先归类瓶颈，可能合图集/分层渲染就够了（方案 C）。
