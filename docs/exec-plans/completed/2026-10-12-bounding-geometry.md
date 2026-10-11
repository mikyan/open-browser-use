# Transformed frame bounding boxes and element screenshots

## 目标与范围

让正式 locator boundingBox 与元素截图在变换 iframe 中返回正确的主页面
视口边界和像素，继续推进 P05/P09 的实际能力，不缩小完整 Browser Use
对齐目标。保留原 action deadline、控制权、后台标签及系统鼠标不变。

## 已知背景

- 前一 goal 轮取得120项完整浏览器证据并完成296a3ce提交推送，属于进展。
- 当前工作树从296a3ce干净开始；已冻结该版51个生产文件和逐文件哈希，
  新反例使用它，不以修改后的代码冒充旧版本。
- 源码中 CRX `_getBoundingBox` 先求 renderer-local border AABB，再通过
  `_framePosition` 相加；元素截图使用该 box。前一轮 pointer 修复未覆盖。
  尚无本片真实失败，先验证再判定，不把源码推断当运行事实。

## 实施与验证

- [x] 读取当前规则、状态与正式调用链；冻结旧生产。
- [x] 独立几何/像素 fixture：root/same、变换 OOPIF、nested与导航。
- [x] 跑旧生产真实反例，保留返回box、原native命令/ACK、文档身份和PNG。
- [x] 按实际renderer local-root投影原border四角后求AABB；原期限与身份检查。
- [x] 最终专项、完整回归、Node测试及独立原始证据/产物审计。
- [x] 同步架构、质量、能力矩阵、history，并完成仓库检查。

## 不得丢失的边界

- boundingBox不按viewport裁切；负坐标、离屏和零宽/高有合法语义。
- 无布局仍返回null；SVG/inline遵循原生border model，不能猜CSS padding尺寸。
- 非有限或跨投影无穷远的几何不能静默给出看似有效的错误矩形。
- public bbox 与 screenshot 都必须使用真正的剩余期限，不能伪造无限progress。
- 原native quad含同renderer变换，不能重复投影；helper不能递归旧bbox路径。
- expected geometry和PNG像素须独立核验，不能仅复用生产投影函数或比较
  截图与同一错误bbox的宽高。旧120项相对顺序与focus规则不变。
- root独占所有浏览器运行，子agent仅代码、测试或只读审查。已确认运行的
  process不因观察超时重启；原preview ZIP保持不变、不创建PR。

## 实施记录

- 旧生产 `6khFx1` actual exit1：root/same/root-bounds三个scene通过；四个
  OOPIF/nested/navigation scene失败，共五个截图phase误位，八份PNG均保留。
  原root-bounds已确认负坐标、离屏、零宽/高、hidden target和hidden OOPIF
  parent均有旧语义；不能以新映射吞掉这些行为。
- 新生产 `9QZ5oF` actual exit1：正式返回box与native clip已通过前置断言，
  但fixture错误要求`chrome.debugger.getTargets`的OOPIF type为iframe，
  实际该API为other；同ID的原attachedToTarget记录才为iframe并携带session。
  修正两个API的身份关联，保留此失败，不调整坐标/像素阈值。
- 首轮生产Node1712/1712通过（包含38项几何测试）；finite locator剩余0/-1在
  native读取前失败，截图沿用同一progress。known no-layout返回null；
  route/deadline错误优先。same-renderer退化不依赖逆映射，跨renderer
  退化/不可恢复平面与projective horizon域外外推仍不支持，明确报错。
  native请求是逻辑期限保护，不宣称已发出的CDP被物理取消；临时handle
  仍是上游best-effort disposal。

- 最终专项`yXtuCJ`actual exit0、2/2，七场八phase独立核native clip、原PNG
  字节/CRC及十个像素见证；15原文档/HTML、222原生调用和ACK、零Input。
  3704ms零focus事件/豁免，七任务页和15相关URL精确清理。
- 完整`iRrKtt`从原session取得terminal actual exit0，121/121；原120名称/
  顺序保持。新场景223原生调用各有唯一ACK，八PNG共118442B，最大逐轴bbox
  误差0.004898049 CSS。237085ms仅原12activation/4controlfocus，无新增
  豁免；sentinel身份/选择保持，高1222→1190。原host按测试SIGTERM，替代
  host exit0。独立raw、provenance及supplement报告均通过。
- 最终Node1723/1723、无skip/cancel；51生产/53暂存逐字节匹配当前source
  重建，专项与完整51成员一致。普通ZIP逐成员一致，三个旧preview ZIP
  匹配既有本地checksum；没有新的远端release核验或启动前快照。
- 本轮从已确认存活的原完整进程取得终态并完成独立证据审计，属于进展。
  跨renderer退化、更多perspective/DPR、hover/drag及当前Codex文件/诊断
  同组任务仍开放；整体目标继续active。
- docs、repo hygiene、Action SHA pinning和diff检查通过；本片完成，归档到
  completed，随本次生产修复提交并推送用户fork，不创建PR或替换preview。
