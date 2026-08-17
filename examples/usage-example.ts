/**
 * VirtualListView 业务侧用法示例（Cocos Creator 3.8.x）
 * 演示四类典型场景：等高长列表 / 不等高+贴底聊天（含异步高度回写）/
 * 多模板混排 / 加载更多。节点结构与回调注入方式见 VirtualListView.ts 头注释。
 */
import { _decorator, Component, Label, Node, ScrollView, Sprite, SpriteFrame } from 'cc';
import { VirtualListView } from './VirtualListView';

const { ccclass, property } = _decorator;

@ccclass('VirtualListDemo')
export class VirtualListDemo extends Component {
    @property(VirtualListView)
    public vlist: VirtualListView | null = null;

    @property(ScrollView)
    public scrollView: ScrollView | null = null;

    // 模拟异步数据
    private mails: Array<{ title: string; time: string }> = [];

    // 注意：renderItemFn 等回调必须在 setCount 之前设置——setCount 会立即绑定首屏，
    // 之后才设置的回调要再调 markDirty()（全量重绑）才会生效。
    public onLoad(): void {
        const vl = this.vlist;
        if (!vl) return;

        // ---- 场景 1：等高长列表（1 万条）----
        vl.renderItemFn = (node, index) => {
            const data = this.mails[index];
            node.getChildByName('title')!.getComponent(Label)!.string = data.title;
            node.getChildByName('time')!.getComponent(Label)!.string = data.time;
        };
        vl.onItemClickFn = (_node, index) => {
            console.log(`click ${index}: ${this.mails[index].title}`);
        };
        vl.onRecycleFn = (node) => {
            // 回收清理：示例里没有 tween/异步，实际项目在此停动画、撤远程图回调
            node.getChildByName('title')!.getComponent(Label)!.string = '';
        };

        this.mails = Array.from({ length: 10000 }, (_, i) => ({
            title: `重要通知 ${i + 1}`,
            time: `2026.08.${(i % 28) + 1}`,
        }));
        vl.setCount(this.mails.length);
        vl.scrollToIndex(50); // 初始定位

        // ---- 场景 2：不等高 + 贴底聊天 ----
        // vl.stickToBottom = true;                          // 编辑器属性或代码开启
        // vl.getItemSizeFn = (i) => this.chats[i].height;   // 已知高度：直接供给
        // vl.renderItemFn = (node, i) => { ... };
        // 收到新消息（高度未知，先用估算值，图片加载后回写真实高度）：
        // this.chats.push(msg); vl.appendItems(1);
        // vl.setItemSize(index, realHeight);                // 自动贴底/视口锚定

        // ---- 场景 3：多模板混排（通知/广告/系统消息三种样式）----
        // vl.getItemTypeFn = (i) => this.mails[i].typeIndex; // 对应 itemPrefabs 下标
        // 性能第一：等高模式允许多模板，但所有模板主轴尺寸必须一致（等高窗口定位是 O(1)，
        // 依赖固定 stride；尺寸不一致会静默摆错，组件首次 setCount 时会 warn 提示）。
        // 不同模板尺寸不同 → 必须走不等高模式（getItemSizeFn 供给尺寸，O(log n) 定位，同样流畅）。

        // ---- 场景 4：上拉加载更多 ----
        this.scrollView?.node.on(ScrollView.EventType.SCROLL_TO_BOTTOM, this.onLoadMore, this);
    }

    private _loadingMore = false;

    private onLoadMore(): void {
        if (this._loadingMore || !this.vlist) return; // 状态锁：防重复触发
        this._loadingMore = true;
        fetchNextPage().then((page) => {
            this._loadingMore = false;
            if (!this.vlist || !this.vlist.node.isValid) return; // 异步守卫
            this.mails.push(...page);
            this.vlist.appendItems(page.length);
        });
    }

    // ---- 场景 5：异步头像（回收安全示范）----
    private bindAvatar(node: Node, index: number, spriteFrame: SpriteFrame): void {
        if (!node.isValid) return;                                   // 节点可能已销毁
        if ((node as any).__vlIndex !== index) return;               // 节点可能已被复用
        node.getChildByName('avatar')!.getComponent(Sprite)!.spriteFrame = spriteFrame;
    }
}

function fetchNextPage(): Promise<Array<{ title: string; time: string }>> {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve(Array.from({ length: 20 }, (_, i) => ({
                title: `下一页条目 ${i + 1}`,
                time: '2026.08.17',
            })));
        }, 300);
    });
}
