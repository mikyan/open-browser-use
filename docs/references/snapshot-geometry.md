# 快照位置元数据

`snapshotAI({ boxes: true })` 在同一有界观察中返回可访问树、元素引用和
位置数据。它用于让 Agent 将语义节点对应到页面位置；不会移动系统鼠标、
滚动页面、聚焦元素或激活标签。默认及 `boxes: false` 保持原有响应形状。
能力标记为 `engineInfo.capabilities.snapshotBoxes === 1`。

## 坐标与身份

每个原生输出的 ref 都有一条结构化 box。YAML 同时带有
`[box=x,y,width,height]` 注释，但引用和几何身份来自原生 renderer 的实际
元素记录，不通过扫描网页文本或注释建立。数值保留浮点精度，负坐标、
离屏位置及零尺寸都合法；box 不是可见性、遮挡或可点击性的保证。

所有 box 都是该元素**所属 frame 的视口 CSS 坐标**，来自同步读取的
`getBoundingClientRect()`。每个 frame 同时记录 `innerWidth/innerHeight`、
`scrollX/scrollY` 和 `devicePixelRatio`。它们不是屏幕坐标或截图像素，
也不是从 iframe 的左上角相加得出的顶层坐标。iframe 边框、父级变换、
嵌套滚动及视觉视口缩放都会影响跨 frame 或截图映射；不得只靠 DPR 或
累加 box 偏移自行声称已得到准确点击点。操作元素仍使用当前 capture ref。

```json
{
  "coordinateSpace": "frame-viewport-css",
  "frames": [
    {"id":"root","parentId":null,"ownerRef":null,"viewport":{"width":800,"height":600,"scrollX":0,"scrollY":100,"devicePixelRatio":1.5}},
    {"id":"f2","parentId":"root","ownerRef":"e1","viewport":{"width":400,"height":250,"scrollX":0,"scrollY":20,"devicePixelRatio":1.5}}
  ],
  "boxes": [
    {"ref":"e1","frameId":"root","box":{"x":20,"y":50,"width":410,"height":260}},
    {"ref":"f2e3","frameId":"f2","box":{"x":12,"y":-4,"width":80,"height":30}}
  ]
}
```

此对象位于原响应的 `geometry` 字段；示例仅说明形状。root 为首项，
其余 frame 的父项先出现。`ownerRef` 是父 frame 中对应 iframe 的原生
引用；稳定 frame slot 不要求连续。内部 Frame GUID 只用于对照当前
真实 Frame 对象、父关系和 ref 归属，不返回给客户端。空子文档仍保留
自己的 frame 元数据，不为它发明元素 ref。

## 时效、限额和失败

每个文档的 ARIA/box/viewport 在同一次 utility-world 调用中读取。
不同 frame 的观察并非原子事务，返回后布局、滚动和节点状态也可能变化。
原有 capture 失效规则完全适用：新快照、frame 生命周期、结束控制、
暂停和断线等会撤销引用；生成期间发生 frame 生命周期变化不能发布结果。
几何不引入新的控制身份，也不会在失败后重试输入或重新选择节点。

`maxBytes` 仍限制最终 UTF-8 YAML，现在也计入 box 注释。结构化几何
没有任意网页字符串或额外节点，只有固定字段、有限数值、最多 `maxRefs`
条 box 和 `maxFrames` 条 viewport，硬上限分别为 2,000 和 32。原节点、
深度和请求总期限不变；所有限制都不会静默截断后报告成功。

请求 `boxes: true` 时，缺少 geometry、ref/box 不一一对应、错误 frame
关系、非有限数值或断开的真实元素会显式失败。没有请求时，不接受额外
geometry。旧引擎不支持该选项就正常报错，不退回无位置的成功响应。

## 参考与验证范围

当前 [Playwright 文档](https://playwright.dev/docs/api/class-locator#locator-aria-snapshot)
同样将 snapshot box 描述为 `getBoundingClientRect()` 的视口 CSS 坐标。
本项目仍是固定 Playwright CRX 版本上的独立有界协议，不能由此推断
已经支持新版全部 API 或 Codex 的全部观察能力。

确定性回归覆盖原生元数据、真实 Frame 绑定、严格 SDK 契约、期限及
capture 失效。2026-10-11 的三个独立 Windows Chromium 156 实例分别以
原生 DPR 1/1.5/2 启动：`run-oVaN3m`、`run-wTM1CH`、`run-x5s4pZ`
各 **10/10**，终端与独立审计均通过。每轮含 JS/Python/Go/CLI/MCP
五入口、三种布局，以及原快照引用/生命周期/取消与限额测试。

45 张 PNG 的 nonce/阶段色块由实际原生 marker ref 的 box 定位；315 个
目标框和180个 iframe owner 框与独立 DOM 读取完全一致，实测偏差为0。
覆盖同源、跨源 OOPIF、嵌套、open shadow、内部滚动及父 iframe 缩放/旋转。
测得的各 frame DPR 与启动比例一致，快照前后文档、滚动和几何保持相等；
12 个当前 capture ref 的真实读取成功。三轮观察窗口内无激活/focus事件，
没有新增豁免；启动和退出不计入该观察窗口。采用测试 Port adapter，
这不是所有浏览器、OS 原生生命周期或动态页面的完整保证。

首轮 `run-tIVleQ` 的 **5/10** 失败保留：动态 CDP emulation 的截图比例
与 DOM DPR 不一致，部分子文档值还会变化，原因未锁定；Go 测试调用器
另有截图字段大小写错误。后者已修正，最终验收使用固定启动比例，未
放宽坐标或观察前后比较。这里不声称已经修复动态 emulation 的行为。
