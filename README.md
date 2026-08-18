# cocos-virtual-list

指导 Agent 如何打造 Cocos Creator 高性能虚拟列表的 Skill。

> 💡 想尝试 Agent 的可以[来 workbuddy 薅羊毛](https://www.workbuddy.cn/events/invite?inviteCode=21331jsck) ， 新用户送 2600 积分，每天签到又送 100 积分，搭配 ds v4 flash 可以用很久很久。

## 它能帮你做什么

- 在 `ScrollView` 里流畅渲染**成千上万条**数据，不卡顿、不爆内存。
- 动手前先帮你**选型**：槽位式虚拟化 / 占位 + 对象池 / 分层渲染（降 Draw Call）三条路线怎么选。
- 提供**可直接改造的完整实现**（`examples/cocos-3.8.6-project-demo`），可直接运行调试。
- 覆盖常见需求：等高 & 不等高、网格（Grid）、聊天贴底、下拉刷新 / 上拉加载、嵌套列表、滚动节流、速度自适应缓冲。
- 预判并避开**回收复用**的经典坑：旧内容闪烁、动画 / tween 泄漏、对象池选错、触摸事件冒泡误触。

## 适合谁用

- 在 Cocos Creator 里做**背包、排行榜、邮件、聊天、好友列表**等长列表功能的开发者。
- 遇到"列表一滑就卡""快速滚动出现空白 item""复用后显示旧数据"等问题的人。
- 想自己实现虚拟列表、但不想从零啃引擎渲染机制的人。

## 包含什么

```
SKILL.md                                     # 主文件：用途、选型、核心架构、实施步骤、硬性注意
references/
  01-architecture-and-algorithms.md           # 方案 A 的完整算法与坐标数学推导
  02-pitfalls-and-details.md                  # 踩坑清单 + 版本/平台细节 + 验收自测
  03-method-b-and-layered-rendering.md        # 方案 B / C 的机制、取舍与已知限制
examples/
  VirtualListView.ts                         # 可直接改造的槽位式虚拟列表实现
  usage-example.ts                           # 业务侧调用示例
  cocos-3.8.6-project-demo/                  # 可运行的 Cocos 3.8.6 示例工程
```

## 怎么用

将 `skills` 文件夹放到你的项目根目录下，然后直接向 Agent 提出疑问或需求：

- “基于 cocos-virtual-list，总结下实现一个高性能虚拟列表需要留意哪些点？”
- “基于 cocos-virtual-list，修改 assets/virtual-list（替换为你的虚拟列表文件夹路径）的虚拟列表，让它支持不等高 item 的模式。”
- “修改 assets/virtual-list（替换为你的虚拟列表文件夹路径）的虚拟列表，让它支持分层渲染。”

> 保守起见，建议以「基于 cocos-virtual-list」开头，确保 agent 命中该 SKILL。

另外 `skills/examples/cocos-3.8.6-project-demo` 是一个可直接运行的示例工程，里面的 `assets/virtual-list` 便是利用该 SKILL 创建的简易高性能虚拟列表，使用方式可参阅 [skills/examples/cocos-3.8.6-project-demo/README.md](skills/examples/cocos-3.8.6-project-demo/README.md)。你也可以基于它进行改造。

## 版本说明

- 面向 **Cocos Creator 3.x**，内容以 **3.8.6** 为准。
- 分层渲染（降 DC）在 3.8.6 上是代理方案；3.8.7+ 可用官方 `Sorting2D` 组件替代。
