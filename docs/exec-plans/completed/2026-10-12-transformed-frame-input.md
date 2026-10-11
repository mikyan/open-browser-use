# 变换 iframe 的定位器输入与祖先命中

## 目标

继续 P06/P07/P15：网页 iframe 或其祖先经过缩放、旋转时，普通定位器
点击仍把输入送到原目标，并逐层检查父页面遮挡。保持后台 tab、系统鼠标
不动、原 action deadline、原节点/上下文和提交后不重放的约束。

## 背景与范围

- 当前固定 CRX 的 `_checkFrameIsHitTarget` 遇到 transformed style 会
  直接返回未定义 framePoint，跳过祖先命中；现有 pointer receipt 不能
  证明父页面仍未遮挡。
- Chromium OOPIF `_getContentQuads` 目前只加 iframe boundingBox 平移；
  缩放和旋转还需要正确投影，不能只删 shortcut。
- 首先覆盖同源、跨进程、嵌套的二维变换及动态遮挡，随后据实际证据扩展。
  不能把未验证变换默认为成功，也不宣称整套输入能力或整体 parity 完成。
- 参考：`docs/references/pointer-delivery.md`、P01–P15 矩阵、固定
  `playwright-crx@0.15.0` 构建脚本。既有 preview ZIP 不改、不提 PR。

## 风险与验证

原始 CDP quad 的坐标相对 renderer local root；同进程子 frame 的变换
可能已包含其中，必须区分 renderer 边界，不能重复投影或用矩形包围盒
近似旋转。布局、导航与 native send 非原子；沿用原作用域/期限和投递门禁。

1. 读取固定代码与权威协议/实现，收敛坐标契约；必要时用隔离 profile
   只读采样验证原始几何。仅 root 可启动浏览器。
2. 新独立 fixture 保存旧代码失败及原始 native/页面事件，覆盖正常变换、
   父遮挡、hover 后移动、连续点击中遮挡；保留原118项名称及相对顺序。
3. 实现固定版本可审计 patch，确定性测试验证算法与失效边界。
4. 冻结源后专项与完整回归，独立审查原始证据/焦点账本/回收；同步文档、
   history 后提交并推送 fork。每一阶段保留实际失败与未验证范围。

## 进度

- [x] 重新核实工作树干净、HEAD e00945b；上一开发轮已完成直接上传。
- [x] 安装说明已独立交付；目标继续 active。
- [x] 下载调查改变下一行动：Browser.cancelDownload 虽有 GUID 路径，
  但内部创建 context delegate 有全局行为影响；Page 路径仍缺可靠桥接。
  保留现有限制，不采用猜测下载归属或读取用户 History 的方案。
- [x] 坐标契约与实现方案：按实际 CRPage session local-root 组合原生
  content quad；默认点击与显式 position 都需投影，祖先命中逐层逆投影。
  初始、hover 后及后继 down 的几何指纹绑定原 frame/context/尺寸与 quad，
  不允许围绕同一点旋转后仅因 framePoint 恰好相同而沿用旧 receipt。
- [x] 旧代码反例、新实现与确定性测试：SDqvcJ保留三实际父层误投；
  固定bundle几何17项、pointer47项、fixture11项与完整Node1673项通过。
  独立review补出zero fragment、source-domain perspective裁剪及dispose
  虚假ACK的问题，均已修复并保留实际固定上游方法的测试。
- [x] 真实浏览器专项及完整回归：WmZggR2/2与t0MP0c119/119，实际exit0。
- [x] 文档与独立原始证据审计；本片随最终提交推送，不宣称整体目标完成。

## 几何实验

隔离 headless Chromium 156 原始 CDP 实验 exit 0（不是扩展输入验收）：
content-box CSS 400.5×210.25，子 frame innerWidth/innerHeight 为401×210。
iframe 自身 zoom1.25 和父元素 zoom1.25 都保持子元素 quad 的本地 CSS
坐标，但 child DPR 变为1.25、父 content quad 已缩放。border-box 减去
实际 fractional padding/border 后为387，子宽度也为387。由此确认
不能用 rounded innerWidth 给 fractional content quad 归一。

原始证据保存在本地只写一次的 geometry-contract-v1.json；仅探测器首次
执行的模块定位失败，未启动浏览器，随后显式复用 integration 依赖成功。
正式实机验收仍须走公开 SDK→host→extension 和既有焦点账本。

专项WmZggR actual exit0、2/2，含全部七场：同源scale、旋转OOPIF、
嵌套、move后cover、move后shift、首击后cover及12×12窄目标position。
cover只1move且0按钮；shift2move后唯一提交；首击cover拒第二对。
该轮无activation/window-focus。专项前旧baseline完整运行中有一次仅
checker/identity断言更新的源码hash交叉；原六场14份HTML逐字节未改，
独立baseline报告显式保留此边界。窄目标不声称旧版已实机测试。
完整`t0MP0c`已actual exit0、119/119。独立审计逐项核原118名称/相对顺序，
七新场景20 Input、6原POST/24256B、16原文档/HTML；独立CSS矩阵计算
核最终root点≤0.011 CSS，窄目标实际pointer在12×12内。226850ms焦点
账本原12activation/4focus逐seq/id匹配，allowance理由顺序与旧118一致；
sentinel身份/选择不变、高1222→1165。七任务页及targets已回收，旧host
预期SIGTERM后新host exit0，无残留测试进程。扩展打包和基础仓库检查通过。

本片验收完成；P01–P15仍有当前Codex同组文件/诊断任务、下载路径/实际
取消、其他平台/原生恢复、目标自身变换position、pinch zoom和更广输入
路径等缺口。后续继续父计划，不能将本片119项通过当作整体parity证据。
