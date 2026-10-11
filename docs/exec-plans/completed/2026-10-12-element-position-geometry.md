# Explicit element position geometry

## 目标

让 locator 的显式 position 在元素自身及祖先经过 CSS 缩放、旋转和有限透视后，
仍定位到原元素 padding box 中请求的位置。保留后台输入、原 deadline、逐层
命中检查和按钮提交后不重放。此项属于 P06，不缩小完整 Browser Use 对齐目标。

## 范围与背景

- 本片开始时 frame adapter 已处理 iframe 投影，但 leaf position 仍是 AABB 左上角
  加未变换 border/offset；大的目标可能收到错误内部位置却让点击通过。
- 调查 DOM.getBoxModel padding quad 与 fractional CSS padding 尺寸契约，
  复用实际 renderer local-root 映射，不根据 origin 猜测进程边界。
- 验证 root、同进程及 OOPIF、box-sizing、zoom、旋转/透视和动态布局。
- 不把非替换 inline、多片段与 SVG 等没有单一 CSS padding 平面的情况伪装为已支持。
  保留兼容行为的地方须明确记录，不静默把错误坐标当正确位置。
- 不改公开 preview 包、不提 PR；完成后提交并推送用户 fork。

## 风险与验证

- 原生 box 尺寸是整数，CSS 尺寸和滚动条可能不同；先做隔离几何实测。
- sequential DOM/CDP 读取不是原子快照；原节点/上下文/期限校验不能删减。
- 单纯命中原 node 不能证明内部位置正确。新 fixture 必须核对独立局部位置、
  原生发送/ACK、原 document 的可信事件与唯一业务 POST。
- 先用旧生产代码运行反例，再跑最终候选专项和完整回归。已有焦点规则不变，
  root 独占浏览器运行，其他 agent 仅编写代码/只读审计。
- 定向/完整 Node、扩展构建、独立代码及真实证据审查、仓库文档检查。

## 进度

- [x] 核当前 bd137cb 干净工作树、上一轮实际完成证据与矩阵。
- [x] 验证原生 padding 几何契约并收敛生产方案。
- [x] 实现、反例、专项及完整回归。
- [x] 文档、history、独立审查与仓库检查；随本片提交推送授权fork。

## 决策记录

- 2026-10-12：上一 goal 轮有实际代码/提交/119 项浏览器证据进展；安装指导
  已另行交付。Vivaldi 原证据已排除 DOM.focus/hover/逐键候选，本轮不重复
  没有新机制的实验，推进确定的 position 几何缺口。
- 2026-10-12：旧生产 rj4xe2 八场全部未通过，实际9POST均错误位置；新候选
  fRwtGy 在最初逐轴0.025CSS的事件中心判据下6/8。两OOPIF实际pointer相对
  DOM marker偏约0.10–0.17CSS，但CDP发送点独立投影误差小于0.005CSS。
  两份独立算术检查与Chromium paint offset取整源码吻合，保留该失败。
- 2026-10-12：无扩展 raw CDP 对照同样出现OOPIF偏差。固定设备比例的三份
  DPR1原点对照与物理像素原点取整预测相差不到0.013CSS；后续DPR1.5原始
  探针未观察到pointerdown并退出，不能记为通过。另一context设备比例探针
  不改变实际合成设备比例，也不充当三DPR物理证明。
- 2026-10-12：明确区分请求投影与浏览器原生事件量化。最终验收保留原生
  root发送点对独立中心投影≤0.025CSS；root/same保留原事件精度；OOPIF另核
  原PointerEvent投回root后与实际native点逐轴≤1物理像素，同时原12×12热点、
  原node和唯一正确POST必须成立并报告精确偏差。该分离由原生对照证据驱动，
  不宣称已实现原先理想化的OOPIF子页面亚像素精度，不硬编码生产补偿。

## 最终验收

- `gQRNO2`：专项2/2 aggregate、八场通过，25Input、8正确唯一POST/83724B，
  11原document/HTML，3150ms零focus/allowance，精确回收八页/targets。
- `DF0lUQ`：完整120/120、actual exit0，原119名称/相对顺序保留；新增八场
  25Input、8唯一正确POST/83571B、11原document/HTML与精确回收独立核实。
  227112ms只有原12activation/4controlfocus，无新增allowance；sentinel身份/
  选择保持，但height1222→1187。新增case的完整输入观察窗2610ms零focus。
- 两最终run原生root请求逐轴最大偏差0.010545CSS；OOPIF局部逐轴最大0.173981CSS
  保留，投回root逐轴最大0.256823物理像素。fixture逐轴推导预算约0.5534物理
  像素，且上限不得大于1px；这不是任意变换/嵌套/DPR的通用保证。
- Node1699/1699零skip/cancel；51生产/53暂存成员和普通扩展ZIP独立逐字节
  核验，旧preview三ZIP仍匹配已有checksum。49个Go构建源与八个复用bin
  核对已有manifest；本轮没有重新运行Go/SDK套件。
- docs、repo hygiene、Action固定SHA及git diff检查通过；两个测试host和
  DF0lUQ的Chromium进程已退出，不需要停止用户浏览器。
- SVG/非替换inline/fragment保留原语义；hover/drag未新增click后置门禁。下一步
  对正式boundingBox和元素截图的变换OOPIF路径先做真实反例，完整P01–P15
  仍开放，主计划保持active。
