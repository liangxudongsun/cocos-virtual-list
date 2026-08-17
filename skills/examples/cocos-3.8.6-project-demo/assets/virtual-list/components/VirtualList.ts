import { _decorator, Component, Node, ScrollView, UITransform, Vec2, Vec3, Size, instantiate, EventTouch, Tween, UIOpacity } from 'cc';
const { ccclass, property, menu, disallowMultiple } = _decorator;

/**
 * 高性能虚拟列表组件（Cocos Creator 3.8.x）
 *
 * 核心思想：数据可能有 10 万条，但屏幕同时只能显示二三十条。
 * 所以只创建"可见区 + 缓冲"内的 item 节点，滚动时用对象池复用节点，
 * 滚出视野的回收、滚入视野的复用，节点总量始终保持在几十个量级。
 *
 * 使用前提：
 *  1. 组件挂在 ScrollView 的 content 节点上；
 *  2. 节点层级为 ScrollView > view(带 Mask 的 UITransform) > content(本组件)；
 *  3. content 下有一个 item 模板节点（会被隐藏，作为克隆来源），
 *     或在属性面板指定 itemTemplate；
 *  4. 通过 onItemRender 回调把数据渲染到 item 节点上。
 *
 * 支持：
 *  - 垂直 / 水平滚动（vertical 属性）
 *  - 多列（垂直）或多行（水平）网格布局
 *  - 任意 content anchor
 *  - setItemCount / refresh / scrollToIndex 等运行时 API
 *
 * 性能特征：
 *  - 滚动过程中零节点创建/销毁，只有复用时 setPosition + 数据绑定；
 *  - 组件每帧只做几次浮点比较，无额外渲染负担。
 */
@ccclass('VirtualList')
@menu('UI/VirtualList')
@disallowMultiple
export class VirtualList extends Component {

    // ---------- 基础引用 ----------

    @property({ type: ScrollView, tooltip: '关联的 ScrollView（默认自动沿节点树向上查找，通常可留空）' })
    public scrollView: ScrollView | null = null;

    @property({ type: Node, tooltip: 'item 模板节点（克隆来源，会自动隐藏；默认取 content 下第一个子节点）' })
    public itemTemplate: Node | null = null;

    // ---------- 布局 ----------

    @property({ tooltip: '滚动方向：勾选=垂直列表，取消=水平列表' })
    public vertical: boolean = true;

    @property({ tooltip: '单个 item 的尺寸（宽 x 高），所有 item 等大' })
    public itemSize: Size = new Size(100, 100);

    @property({ tooltip: '顶部内边距（水平滚动时为首行间距）' })
    public paddingTop: number = 0;

    @property({ tooltip: '底部内边距' })
    public paddingBottom: number = 0;

    @property({ tooltip: '左侧内边距' })
    public paddingLeft: number = 0;

    @property({ tooltip: '右侧内边距' })
    public paddingRight: number = 0;

    @property({ tooltip: 'item 之间的间距' })
    public gap: number = 0;

    @property({ tooltip: '像素对齐（默认开）：item 落点取整后再设置位置，防止子像素采样导致的纹理发虚/闪烁' })
    public pixelAlign: boolean = true;

    @property({ min: 0, max: 20, tooltip: '缓冲行数：可视区外每侧额外缓存的 item 行数（单列列表即前后各 N 个 item）。越大快速滚动越不易白屏，但存活节点越多；一般 2~4 足够' })
    public buffer: number = 2;

    @property({ tooltip: '快速滚动降频（默认开启）：滚动很快时降低窗口刷新率（飞速≈20fps、快速≈30fps、慢速≈60fps），减少快速甩动时的重绑开销——快速滚动时人眼本来看不清内容，降频基本无感。停稳会自动补刷一次保证显示正确；若 onItemRender 极轻且追求极致清晰可关闭' })
    public throttle: boolean = true;

    @property({ tooltip: '低性能自动降级（默认开启，需配合 throttle 开启）：统计每次窗口刷新的耗时（保留最近 5 次），≥3 次超过 16ms 判定设备吃力，自动把慢速滚动的刷新率也降到 30fps，无需手动判断设备性能' })
    public autoDowngrade: boolean = true;

    @property({ tooltip: '速度自适应缓冲（默认开）：快速甩动时按"未来 6 帧位移"临时扩大缓冲行数（最多 +4 行），防止边缘白屏；停稳自动回落' })
    public adaptiveBuffer: boolean = true;

    // ---------- 数据 ----------

    @property({ tooltip: '数据总条数（也可用 setItemCount 运行时修改）' })
    public itemCount: number = 0;

    // ---------- 回调（代码里赋值） ----------

    /** 渲染回调：item 节点进入可视区（或刷新）时调用，在这里绑定数据。 */
    public onItemRender: ((item: Node, index: number) => void) | null = null;

    /** 回收回调：item 节点滚出可视区被回收前调用（可选）。 */
    public onItemRecycle: ((item: Node, index: number) => void) | null = null;

    @property({ tooltip: '回收自动清理（默认开）：回收时自动停掉节点上的 tween、重置缩放与透明度，防止复用节点残留旧动画/形变。若 item 有常驻动画需自行在 onItemRender 重新启动' })
    public autoCleanOnRecycle: boolean = true;

    /** 点击回调（可选）：内置"按下-抬起位移 ≤ clickSensitivity 才算点击"的判定，滚动会被 ScrollView 转成 TOUCH_CANCEL 天然过滤，不会误触。 */
    public onItemClick: ((item: Node, index: number) => void) | null = null;

    @property({ min: 1, max: 30, tooltip: '点击判定位移阈值（像素）：按下到抬起的位移超过该值判定为滚动，不触发点击' })
    public clickSensitivity: number = 8;

    // ---------- 统计（调试用） ----------

    /** 当前存活的 item 节点数（约等于 可见数 × (1 + buffer)） */
    public get aliveCount (): number { return this._activeItems.size; }

    /** 累计实例化的节点总数（应远小于 itemCount，用于验证虚拟化效果） */
    public get totalCreated (): number { return this._totalCreated; }

    /** 累计复用节点次数 */
    public get reusedCount (): number { return this._reusedCount; }

    // ---------- 内部状态 ----------

    private _scrollView: ScrollView | null = null;
    private _contentTrans: UITransform | null = null;
    private _template: Node | null = null;

    /** 对象池：被回收的 item 节点 */
    private _pool: Node[] = [];
    /** 当前在用的 index -> 节点 */
    private _activeItems: Map<number, Node> = new Map();

    /** 滚动方向上的步长（垂直=itemH+gap，水平=itemW+gap） */
    private _stride: number = 1;
    /** 每"行/列"容纳的 item 数（垂直=列数，水平=行数） */
    private _perLine: number = 1;
    /** 总行数 / 总列数 */
    private _totalLines: number = 0;

    private _lastPosX: number = 0;
    private _lastPosY: number = 0;
    private _lastViewWidth: number = 0;
    private _lastViewHeight: number = 0;

    /** 平滑后的每帧位移（px/frame），用于速度分档降频 */
    private _velSmooth: number = 0;
    /** 降频时距上次刷新的累计时间（秒） */
    private _throttleAccum: number = 0;
    /** 刚经历降频跳过，停稳后需兜底刷新一次 */
    private _pendingSettle: boolean = false;

    /** 低性能降级：最近 5 次刷新的耗时（ms） */
    private _frameTimes: number[] = [];
    /** 是否处于低性能模式 */
    private _lowPerf: boolean = false;

    /** item 点击：节点 -> 数据 index（节点复用会覆盖，节点销毁自动释放） */
    private _indexOf: WeakMap<Node, number> = new WeakMap();
    /** 最近一次按下位置（UI 坐标），用于点击位移判定 */
    private _touchStartX: number = 0;
    private _touchStartY: number = 0;

    private _totalCreated: number = 0;
    private _reusedCount: number = 0;

    private _initialized: boolean = false;
    private _tempVec3: Vec3 = new Vec3();

    // ---------- 生命周期 ----------

    protected onLoad (): void {
        this._init();
    }

    protected onDestroy (): void {
        // 解绑 item 点击事件（池节点 + 活跃节点），避免组件销毁后残留监听
        this._activeItems.forEach((node) => this._unbindItemEvents(node));
        for (let i = 0; i < this._pool.length; i++) this._unbindItemEvents(this._pool[i]);
        this._activeItems.clear();
        this._pool.length = 0;
    }

    private _unbindItemEvents (node: Node): void {
        node.off(Node.EventType.TOUCH_START, this._onItemTouchStart, this);
        node.off(Node.EventType.TOUCH_END, this._onItemTouchEnd, this);
    }

    protected update (dt: number): void {
        // 刷新驱动：每帧零分配检测 content 位置与视口尺寸（属性读取，无对象分配）。
        // 位置没变就什么都不做——静止帧成本趋近于零，滚动帧每帧最多刷新一次，
        // 天然覆盖触摸滚动与惯性滚动（比监听高频 SCROLLING 事件更简单可靠）。
        if (!this._initialized || !this._scrollView) return;
        const viewTrans = this._scrollView.view;
        if (!viewTrans) return;

        // 视口尺寸变化（如屏幕旋转）→ 行列数可能改变，需要全量重建
        if (viewTrans.width !== this._lastViewWidth || viewTrans.height !== this._lastViewHeight) {
            this._lastViewWidth = viewTrans.width;
            this._lastViewHeight = viewTrans.height;
            this._updateLayout();
            return;
        }

        const pos = this.node.position;
        const dx = pos.x - this._lastPosX;
        const dy = pos.y - this._lastPosY;
        if (dx === 0 && dy === 0) {
            // 静止：若刚经历降频跳过，兜底刷新一次，确保停留位置显示正确（正确性铁律）
            if (this._pendingSettle) {
                this._pendingSettle = false;
                this._updateVisibleRange();
            }
            this._velSmooth = 0;
            return;
        }
        this._lastPosX = pos.x;
        this._lastPosY = pos.y;
        // 平滑每帧位移（px/frame），供速度分档使用
        this._velSmooth = this._velSmooth * 0.6 + (this.vertical ? dy : dx) * 0.4;

        if (this.throttle) {
            // 速度分档降频：速度越快刷新越少（px/s ≈ px/frame × 60）
            const v = Math.abs(this._velSmooth) * 60;
            let minInterval = 0;
            if (v > 2000) minInterval = 0.05;      // 飞速：≈20fps
            else if (v > 1000) minInterval = 0.033; // 快速：≈30fps
            else if (this.autoDowngrade && this._lowPerf) minInterval = 0.033; // 低性能：慢速也降到 30fps
            this._throttleAccum += dt;
            if (minInterval > 0 && this._throttleAccum < minInterval) {
                this._pendingSettle = true;
                return; // 跳过本帧刷新
            }
            this._throttleAccum = 0;
        }
        this._pendingSettle = false;

        // 低性能降级：测量单次刷新耗时，持续超 16ms 判定设备吃力（最近 5 次 ≥3 次超阈值）。
        // 仅 throttle 开启时才有意义——_lowPerf 只在降频档位里被读取，throttle 关了就别白计时。
        if (this.throttle && this.autoDowngrade) {
            const t0 = performance.now();
            this._updateVisibleRange();
            this._recordFrameCost(performance.now() - t0);
        } else {
            this._updateVisibleRange();
        }
    }

    // ---------- 公开 API ----------

    /** 修改数据条数（自动重算 content 尺寸并重建可视区） */
    public setItemCount (count: number): void {
        this.itemCount = Math.max(0, Math.floor(count));
        if (this._initialized) {
            this._updateLayout();
        }
    }

    /** 数据内容变了（条数不变），重渲染当前可见的 item */
    public refresh (): void {
        if (!this._initialized) return;
        this._clearAllItems();
        this._updateVisibleRange();
    }

    /** 单条刷新：只重渲染第 index 条（若它在当前可见窗口内；不在则滚到时自然生效） */
    public refreshItem (index: number): void {
        if (!this._initialized) return;
        const node = this._activeItems.get(index);
        if (node && this.onItemRender) {
            this.onItemRender(node, index);
        }
    }

    /**
     * 追加数据（加载更多）：条数增加、content 变长，保持当前滚动位置；
     * 若追加前正好在底部，则自动贴住新的底部（聊天"加载历史"的体验）。
     */
    public appendItems (count: number): void {
        if (count <= 0 || !this._initialized) return;
        const sv = this._scrollView!;
        const wasAtEnd = this._isAtEnd();
        this.setItemCount(this.itemCount + count);
        if (wasAtEnd) {
            const max = sv.getMaxScrollOffset();
            sv.stopAutoScroll();
            sv.scrollToOffset(this.vertical ? new Vec2(0, max.y) : new Vec2(max.x, 0), 0);
        }
    }

    /**
     * 滚动到指定 index 的 item 处（对齐到可视区起始边）。
     * 会先立即停止进行中的惯性/动画滚动，再执行跳转——否则新目标位置会被旧滚动动画覆盖。
     * @param index 目标索引
     * @param timeInSecond 滚动动画时长，0 = 立即跳转（推荐：远距离跳转时中间帧内容无意义，
     *                     动画过程伴随逐帧重建窗口，观感差且有开销，直接 0 最干净）
     */
    public scrollToIndex (index: number, timeInSecond: number = 0): void {
        const sv = this._scrollView;
        if (!this._initialized || !sv || !sv.view) return;

        const max = sv.getMaxScrollOffset();
        // 内容不足一屏时无可滚动范围，直接返回（避免除零产生 NaN）
        if ((this.vertical && max.y <= 0) || (!this.vertical && max.x <= 0)) return;
        // clamp 到合法范围（否则超界 index 会算出超界 offset，只能靠 min(max) 兜底）
        const target = Math.min(this.itemCount - 1, Math.max(0, index));
        const offset = new Vec2();
        if (this.vertical) {
            const row = Math.floor(target / this._perLine);
            offset.set(0, Math.min(this.paddingTop + row * this._stride, max.y));
        } else {
            const col = Math.floor(target / this._perLine);
            offset.set(Math.min(this.paddingLeft + col * this._stride, max.x), 0);
        }
        sv.stopAutoScroll(); // 立即停止惯性/自动滚动（scroll-view.ts 公开 API）
        sv.scrollToOffset(offset, timeInSecond);
    }

    // ---------- 初始化 ----------

    private _init (): void {
        if (this._initialized) return;

        // 1. 定位 ScrollView：优先属性，否则沿节点树向上查找
        let sv = this.scrollView;
        if (!sv) {
            let p = this.node.parent;
            while (p) {
                const found = p.getComponent(ScrollView);
                if (found) { sv = found; break; }
                p = p.parent;
            }
        }
        if (!sv) {
            console.error('[VirtualList] 未找到 ScrollView：请把本组件挂在 ScrollView 的 content 节点上（层级 ScrollView > view > content），或在属性面板指定 scrollView 属性。');
            this.enabled = false;
            return;
        }
        if (!sv.view) {
            console.error('[VirtualList] 找到 ScrollView，但其未绑定 content（或 content 的父节点缺少 UITransform）——ScrollView 的显示区由 content 的父节点推导，请检查 ScrollView 的 content 属性是否已指向 content 节点。');
            this.enabled = false;
            return;
        }
        this._scrollView = sv;
        this._contentTrans = this.node.getComponent(UITransform) || this.node.addComponent(UITransform);

        // 2. 定位 item 模板
        let template = this.itemTemplate;
        if (!template) {
            template = this.node.children.length > 0 ? this.node.children[0] : null;
        }
        if (!template) {
            console.error('[VirtualList] 未找到 itemTemplate（需在属性面板指定，或让 content 下第一个子节点作为模板），组件已停用。');
            this.enabled = false;
            return;
        }
        this._template = template;
        this._template.active = false; // 模板只作为克隆来源，永不显示

        this._initialized = true;
        this._updateLayout();
    }

    // ---------- 布局 ----------

    /** 是否滚动到底部（容差 1px） */
    private _isAtEnd (): boolean {
        const sv = this._scrollView;
        if (!sv || !sv.view) return true;
        const max = sv.getMaxScrollOffset();
        const off = sv.getScrollOffset();
        const pos = this.vertical ? off.y : -off.x;
        const maxPos = this.vertical ? max.y : max.x;
        return pos >= maxPos - 1;
    }

    /** 全量重建：清空节点 -> 重算行列/尺寸 -> 重建可视区 */
    private _updateLayout (): void {
        this._clearAllItems();
        this._updateMetrics();
        this._updateContentSize();
        this._updateVisibleRange();
    }

    private _updateMetrics (): void {
        const viewTrans = this._scrollView!.view;
        if (!viewTrans) return;
        const { width, height } = this.itemSize;
        const safeW = Math.max(1, width);
        const safeH = Math.max(1, height);
        if (this.vertical) {
            this._perLine = Math.max(1,
                Math.floor((viewTrans.width - this.paddingLeft - this.paddingRight + this.gap) / (safeW + this.gap)));
            this._stride = Math.max(1, safeH + this.gap);
        } else {
            this._perLine = Math.max(1,
                Math.floor((viewTrans.height - this.paddingTop - this.paddingBottom + this.gap) / (safeH + this.gap)));
            this._stride = Math.max(1, safeW + this.gap);
        }
        this._totalLines = Math.ceil(this.itemCount / this._perLine);
    }

    /** 根据数据总量设置 content 尺寸，ScrollView 会因此自动重算可滚动范围 */
    private _updateContentSize (): void {
        const trans = this._contentTrans;
        if (!trans) return;
        const viewTrans = this._scrollView ? this._scrollView.view : null;
        const { width, height } = this.itemSize;
        let w = this.paddingLeft + this.paddingRight;
        let h = this.paddingTop + this.paddingBottom;
        if (this.vertical) {
            w += this._perLine * width + Math.max(0, this._perLine - 1) * this.gap;
            h += this._totalLines * height + Math.max(0, this._totalLines - 1) * this.gap;
            // content 主轴不小于视口，保证回弹/边界行为正常
            if (viewTrans) h = Math.max(h, viewTrans.height);
        } else {
            h += this._perLine * height + Math.max(0, this._perLine - 1) * this.gap;
            w += this._totalLines * width + Math.max(0, this._totalLines - 1) * this.gap;
            if (viewTrans) w = Math.max(w, viewTrans.width);
        }
        trans.setContentSize(w, h);
    }

    // ---------- 可见区计算与增删 ----------

    /** 根据当前滚动偏移，diff 出需要回收/新建的 item */
    private _updateVisibleRange (): void {
        const sv = this._scrollView!;
        const viewTrans = sv.view;
        if (!viewTrans || !this._contentTrans) return;

        const offset = sv.getScrollOffset();

        if (this.itemCount <= 0) {
            this._clearAllItems();
            return;
        }

        // 可视窗口在内容坐标系中的位置（起点 = 起始边）。
        // 注意引擎符号约定：垂直 offset.y 与"距顶部已滚距离"同号（正）；
        // 水平 offset.x 与"距左侧已滚距离"**反号**（引擎 get/scroll 两 API 的历史不一致）。
        const viewLen = this.vertical ? viewTrans.height : viewTrans.width;
        const scrollPos = this.vertical ? offset.y : -offset.x;
        const paddingStart = this.vertical ? this.paddingTop : this.paddingLeft;

        // 缓冲按"行"计：可视区外每侧额外缓存 buffer 行（单列列表即前后各 buffer 个 item）
        // 速度自适应：快速甩动时按"未来 6 帧位移"临时多扩几行，停稳 _velSmooth→0 自动回落
        let effectiveBuffer = this.buffer;
        if (this.adaptiveBuffer) {
            effectiveBuffer += Math.min(4, Math.floor(Math.abs(this._velSmooth) * 6 / this._stride));
        }
        let lineStart = Math.floor((scrollPos - paddingStart) / this._stride) - effectiveBuffer;
        let lineEnd = Math.ceil((scrollPos + viewLen - paddingStart) / this._stride) + effectiveBuffer;
        lineStart = Math.max(0, lineStart);
        lineEnd = Math.min(this._totalLines, lineEnd);

        const indexStart = lineStart * this._perLine;
        const indexEnd = Math.min(this.itemCount, lineEnd * this._perLine);

        // 1. 回收滚出可视区的
        if (this._activeItems.size > 0) {
            this._activeItems.forEach((node, index) => {
                if (index < indexStart || index >= indexEnd) {
                    this._recycle(node, index);
                    this._activeItems.delete(index);
                }
            });
        }

        // 2. 补齐滚入可视区的
        for (let i = indexStart; i < indexEnd; i++) {
            if (this._activeItems.has(i)) continue;
            const node = this._obtainItem();
            node.name = `item_${i}`; // 便于层级面板区分（克隆默认继承模板名）
            this._indexOf.set(node, i); // 点击回调据此读 dataIndex
            this._placeItem(node, i);
            this._activeItems.set(i, node);
            if (this.onItemRender) this.onItemRender(node, i);
        }
    }

    /** 计算 item 在 content 局部坐标系中的位置（支持任意 content anchor） */
    private _placeItem (node: Node, index: number): void {
        const trans = this._contentTrans!;
        const { width, height } = this.itemSize;

        // content 左上角在局部坐标中的位置
        const leftTopX = -trans.anchorX * trans.width;
        const leftTopY = (1 - trans.anchorY) * trans.height;

        let x: number;
        let y: number;
        if (this.vertical) {
            const row = Math.floor(index / this._perLine);
            const col = index % this._perLine;
            x = leftTopX + this.paddingLeft + col * (width + this.gap) + width * 0.5;
            y = leftTopY - this.paddingTop - row * this._stride - height * 0.5;
        } else {
            const row = index % this._perLine;
            const col = Math.floor(index / this._perLine);
            x = leftTopX + this.paddingLeft + col * this._stride + width * 0.5;
            y = leftTopY - this.paddingTop - row * (height + this.gap) - height * 0.5;
        }
        this._tempVec3.set(
            this.pixelAlign ? Math.round(x) : x,
            this.pixelAlign ? Math.round(y) : y,
            0,
        );
        node.setPosition(this._tempVec3);
    }

    // ---------- 对象池 ----------

    private _obtainItem (): Node {
        let node = this._pool.pop();
        if (!node) {
            node = instantiate(this._template!);
            node.parent = this.node;
            this._totalCreated++;
            // item 点击：节点创建时绑定一次，回调读 dataIndex；复用节点不重复绑定，避免监听器泄漏
            node.on(Node.EventType.TOUCH_START, this._onItemTouchStart, this);
            node.on(Node.EventType.TOUCH_END, this._onItemTouchEnd, this);
        } else {
            this._reusedCount++;
        }
        node.active = true;
        return node;
    }

    private _recycle (node: Node, index: number): void {
        if (this.onItemRecycle) this.onItemRecycle(node, index);
        // 回收自动清理：停掉残留 tween、重置缩放/透明度，防止复用节点残留旧动画/形变
        // （position 无需重置，下次 _placeItem 会重设）
        if (this.autoCleanOnRecycle) {
            Tween.stopAllByTarget(node);
            node.setScale(1, 1, 1);
            const opacity = node.getComponent(UIOpacity);
            if (opacity) opacity.opacity = 255;
        }
        node.active = false;
        this._pool.push(node);
    }

    private _clearAllItems (): void {
        if (this._activeItems.size === 0) return;
        this._activeItems.forEach((node, index) => this._recycle(node, index));
        this._activeItems.clear();
    }

    // ---------- 低性能降级 ----------

    /** 记录单次刷新耗时（保留最近 5 次），≥3 次超 16ms 判定低性能 */
    private _recordFrameCost (cost: number): void {
        this._frameTimes.push(cost);
        if (this._frameTimes.length > 5) this._frameTimes.shift();
        let slow = 0;
        for (let i = 0; i < this._frameTimes.length; i++) {
            if (this._frameTimes[i] > 16) slow++;
        }
        this._lowPerf = slow >= 3;
    }

    // ---------- item 点击 ----------

    private _onItemTouchStart (event: EventTouch): void {
        const pos = event.getUILocation();
        this._touchStartX = pos.x;
        this._touchStartY = pos.y;
    }

    private _onItemTouchEnd (event: EventTouch): void {
        if (!this.onItemClick) return;
        const pos = event.getUILocation();
        const dx = pos.x - this._touchStartX;
        const dy = pos.y - this._touchStartY;
        // 位移超过阈值 = 滚动，不算点击（ScrollView 的 cancelInnerEvents 也会把滚动转成 TOUCH_CANCEL 双保险）
        if (dx * dx + dy * dy > this.clickSensitivity * this.clickSensitivity) return;
        const target = event.currentTarget as Node;
        const index = this._indexOf.get(target);
        if (index === undefined) return;
        this.onItemClick(target, index);
    }
}
