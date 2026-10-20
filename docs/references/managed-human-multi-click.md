# Managed 人工双击与三击

## 行为与兼容

查看器从可信本地 `mousedown.detail` 取得浏览器已识别的点击次数，逐次
发送原 down/up。双击不会等待 dblclick 再补发点击；也不用自定义时间或
距离阈值替代系统设置。完整的同按钮本地序列才延续计数；首次接管、导航、
End、按钮组合和原生弹窗打断后从一开始。第四击及更大的合法计数不会截成三。

原 human lease 声明固定 `pointerClickCountVersion: 1`；只读 view 不允许
声明。新能力使用鼠标事件，旧能力缺失时保留 pointer 单击路径，避免重复
发送两套事件。Go 和扩展都要求 down/up 的可选 `clickCount` 为正 int32；
省略为一，move 禁带。up 必须匹配原已确认 down 的按钮和次数，未知 ACK
不推进持键记录。导航建立新代次，旧计数不能授权新代输入。

鼠标按下只从画面接收，窗口级监听保留实际 move/up；持键移出画面、窗口
失焦或真实取消时走已有 End 清理。网页弹窗/文件卡片导致命中目标改变时，
仍按原几何区分是否真的离开；原按键释放可以排队等回答。没有新增 pointer
capture。通用原生清理继续使用 `clickCount: 0`，不制造额外双击。

相关规范：[Pointer Events](https://www.w3.org/TR/pointerevents3/#attributes-and-default-actions)、
[UI Events](https://www.w3.org/TR/uievents/#event-type-mousedown)。

## 验证与交付

旧 UI、扩展及 Go 的失败回归保留。UI 193 项、扩展相关 311 项及 Go 三包
检查通过，独立审查补齐能力固定、真实取消与 modal 命中变化。全新构建
`mso-build-ebanssld` 绑定 463 份输入和 79 份扩展，完整 Go test/vet 与
3,102 项 Node 检查通过。本功能已包含在
[preview-20261021-5b3d2f4](https://github.com/mikyan/open-browser-use/releases/tag/preview-20261021-5b3d2f4)，
此前 `preview-20261021-748af2f` 不包含本片。

正式 `mmc-VzihL3` 七步、实际退出 0，`featurePassed: true`。两原 textarea
收到十次原 down/up 和匹配 ACK；双击出现一次可信 dblclick，三击保留
1/2/3 次数和原生选区。双击选择 `[6,12]` 的 `BRAVO `，三击选择 `[0,20]`
首行及换行，原文字不变。完整事件总账连续，无段间多余输入。End 后原文档
和选区保持，显式 Resume、新轮次及原 handoff 表单唯一 POST、Stop 通过。
结果 SHA256：`d148ebcb79454c8997d9a7b84c8ccdd212aff63d9dfc13b940f85cf60100b7c7`。

独立原事件审计 668 项、来源及生命周期审计 174 项通过。两个 move 与
十次 down/up 的原回执、27 次原任务事件、完整连续账本均一致；29 个原
进程身份已退出，Job 归零、双注册视图、原管道及 endpoint 清理通过，无
强制终止。46 张 PNG 完整解码，根 agent 目视三击选区和查看器状态。
事件审计 SHA256：
`fb7e488c5754bcedca892c15f61826efcbc713b37e6ecd8a6ad1eeba8cd3e907`；
生命周期审计 SHA256：
`e11467cd8e94a2c50bd5de5873ad5c4a926a59b962b90ef22089243592619fd2`。

发布源码为 `5b3d2f4329564e064419c1f2c82c5ddb2e2dd902`。完整包/扩展/Skill
为 110/79/7 文件，完整 ZIP 10,685,428 字节，SHA256：
`c7c7859f7e89617cb4d9cb15b98f3485be4598db79c2e367ad0c7ce9212de472`。
发布 EXE 从干净精确提交独立重建，离线 CLI/MCP 30 工具和 4,757 项制品
独审通过；三个 ZIP 与 SHA256SUMS 共四资产回下载一致，114 份本地副本
核对通过。发布时未重跑内部构建的原网页业务。制品独审 SHA256：
`10aa580d9c85adfa7f0757115c2f3d6535d350d20889c8f88b0f0a5e4e316fc1`。

首轮 `mmc-RFHcjV` 实际退出 1 保留：测试把选区写成不含空格的 `[6,11]`，
原事件和回执已经匹配，但原生实际包含词尾空格。独立同浏览器、同页面、
无扩展的 `native-reference-qtvms6` 确认 Windows 原生行为，实际退出 0。
只修正测试期望并补充跨段事件总账，未修改产品或重建 EXE。随后 40 项
脚手架检查及上述新运行通过；首失败没有三击或业务提交证据。

复用 `scripts/browser-integration/managed-human-check.mjs`，
设置 `OBU_TEST_HUMAN_SCENARIO=multi-click`，并提供同一构建的
`OBU_TEST_HOST_BINARY`、`OBU_TEST_EXTENSION_DIR`、`OBU_TEST_BUILD_MANIFEST`
及固定 `OBU_TEST_CHROMIUM_BINARY`。原查看器的真实 down/up 必须在原任务
页产生匹配的可信鼠标事件和精确选区；随后原 End/Resume、唯一 POST 和
Stop 仍须通过。`baseline` 模式只诊断旧行为，不可当成功能验收。

有限隔离浏览器证据不证明物理鼠标、系统多击设置、普通公司 Edge、跨站
复杂编辑器或完整 P01–P15 能力对齐。
