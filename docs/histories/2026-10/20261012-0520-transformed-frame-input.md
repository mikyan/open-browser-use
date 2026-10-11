## [2026-10-12 05:20] | Task: 修复变换 iframe 的后台点击

### 🤖 Execution Context

- **Agent ID**: `/root` 与三个协作 Agent
- **Base Model**: GPT-6
- **Runtime**: Codex desktop，Windows PowerShell / Node.js

### 📥 User Query

> 持续开发，直到 Browser Use 能力与 Codex 不相上下；保留后台操作，
> 不抢系统鼠标，推送用户 fork，不提 PR。

### 🛠 Changes Overview

**Scope:** 固定 CRX 几何适配、普通定位器点击门禁、真实浏览器测试与文档。

- 按实际 renderer local-root session 映射原生 quad，使用小数 CSS content
  尺寸并逐层检查父 iframe 命中；移除 transformed 就跳过检查的旧路径。
- 初次、hover 后、后继 down 的原几何指纹必须一致；移动后布局变化可在
  提交前重新准备，已发送按钮不得重放。缺失指纹不能放行。
- 默认坐标先在原 renderer 可见域裁剪再投影；保留后续有效 inline
  fragment 及经 scale 放大后可点击的小目标。position 投影原局部坐标。
- 七场真实页面保存原 Input ACK、可信 DOM、原 POST、精确文档与回收；
  未增加焦点豁免。旧六场 HTML 保持可比，新窄目标另列。

### 🧠 Design Intent (Why)

旧版真实反例证明“命令成功”和“目标收到 move”仍不足：父层在 hover 或
首击后出现遮挡，后续按钮可以落到父层；OOPIF 平移近似又被宽目标掩盖。
修复同时处理 root 坐标与父页面命中，并保留控制权/期限/不重放约束。

### 验证与边界

旧候选 SDqvcJ actual exit1：三正例可点，三场真实父层误投保留。
独立报告核20 Input、4 POST/14887B、零focus及六页/targets回收；其中
checker-only 源码哈希交叉明确记录，不能称整个源树运行期间完全未变。

新专项 WmZggR actual exit0：全部七场通过，20 Input、6唯一POST/24244B，
父层零错误按钮；7859ms零focus，七页/targets回收。独立CSS矩阵计算核
最终root点误差不超过0.011 CSS，窄目标实际事件在12×12内部。专项未记录
的新增source hash已在完整runner补齐。Node1673/1673通过，无skip/cancel。

最终完整`t0MP0c` **119/119、actual exit0**；新七场20 Input、6原始POST
共24256B。extension构建/打包、文档/仓库卫生/Action固定SHA检查通过。
现有Go构建49源与8bin精确匹配后复用；SDK/Go源码本片未变，三SDK与
CLI/MCP仍在完整浏览器回归中验证。历史失败和未验证范围继续保留。
独立制品核对51生产与53暂存成员，仅既有adapter/CSP/observer差异；
新普通扩展ZIP的51成员与全量所测生产一致。原preview三ZIP与现有校验清单
一致，未重打；没有把现有清单核对称作本轮开始前快照或远程release复核。
审计脚本最初把数字recordingErrors=0当数组的错误保留并修正，没有改原run。

临时几何handle仍是原Playwright best-effort dispose，不能称native释放
已确认。顺序观察非原子，不证明未来native命中已预留；透视有数学测试，
不以七个实际场景泛化全部3D/pinch zoom。目标自身transform的position
旧约定未修。旧preview ZIP保持不变，完整P01–P15目标仍未完成。

### 📁 Files Modified

- `scripts/patch-frame-geometry.mjs` 与对应实际bundle测试
- `scripts/patch-pointer-delivery.mjs`、`scripts/build-chrome-extension.mjs`
- `scripts/browser-integration/transformed-pointer-fixture.mjs` 与runner
- `docs/references/transformed-frame-input.md`、架构/矩阵/质量/计划
