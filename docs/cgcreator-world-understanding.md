# 导演地图理解（cg-world-2）

本阶段实现完整读取地图及其区域位置、关系和只读查询；保留 WorldForge main 的地图协议。它不等同于新 NavMesh、交互接触求解或完整自动机位搜索。

## 数据链路

`EditableMap → buildWorldSemanticIndex → analyzeWorld → buildSemanticContext → directorAnswer → DirectorDocument / scoped patch`

`cgSpatialRegions.ts` 负责圆形、多边形、带宽路径的范围和点归属。凹多边形采用区域内代表点；包围矩形不能证明归属。`cgWorldAnalysis.ts` 保留完整 designSemantics，补齐生态区域、接缝、设计组入口/出口/轴线、对象所属关系、焦点和实际位置。规划视点 Y 取地形，不能视为已验证机位。

精度明确分为 source-boundary、sampled-curve、object-envelope、density-envelope、terrain-mask。缺失设计组边界可由成员物体推导包络，但不改写原地图、不称作原始边界。水岸复用 WorldForge 水体函数，实际水面查询同时检查地形；草地查询复用双线性密度场，包络空洞不能回答成有草。草地花卉比例不提供单朵花坐标。部件局部坐标仍不是已验证世界空间 socket。

`completeness` 描述明确区域数、推导范围数、未知区域和路径数。`issues` 报告缺失引用、未绑定焦点、对象移出所属区域、缺少道路等。无生成来源记录不自动标记为人工确认。整体设计关系和几何归属分开保留。

## 导演查询协议

导演可在最终文档前返回 `{"worldQueries":[...]}`，最多 3 轮，每轮最多 6 项。支持 summary、resolve(text)、inspect(semanticId)、point(position:[x,z])。名称歧义明确返回；查询不会创建或修改地图、anchor 或约束。所有结果携带同一 sourceHash。查询超限或最终文档无效时项目事务不提交，confirmed 保留。

既有一次性文档输出保持兼容。局部修改使用相同查询协议，最终仍必须通过原有 Patch 范围和人工硬约束校验。地图文字仅作为数据。精确空间事实由程序提供，不承诺语言模型每次都能作出正确的艺术判断。

## 本地 API

- `GET /api/cg/projects/:id/world`：当前项目地图语义摘要、projectRevision、sourceHash。
- `POST /api/cg/projects/:id/world-query`：`{revision,sourceHash,query}`；只读，不增加 revision。旧 revision 或 hash 返回 409，非法查询返回 400。

每次从当前 mapSnapshot 计算，不读取过期 candidate/confirmed。sync-map 后再次查询会反映新地图；删除焦点不会回退到 [0,0,0]。sourceHash 排除地图版本和时间元数据，包含实际地图内容。

## 编辑器

CG 工作区右侧“导演地图语义 · 当前快照”提供名称/ID 搜索、原始形状、世界位置、X/Z 范围、精度、关系和诊断。点击“在地图中定位”切换到当前地图快照的自由视角，显示黄色轮廓。路径显示中心线，宽度在详情列出。切换查看不会修改源地图或已确认演出。

旧导出包不强制迁移；需要检查时从其地图重新构建索引。具有语义的 WorldForge 原生导入可保留原信息；只有对象的旧地图被标记 objects-only，不自动编造道路和功能分区。

## 验证

`tests/cgWorldSemantics.test.ts` 覆盖凹形边界、道路宽度、草地空洞、水面裁切、海洋、焦点删除、区域过期、导入兼容和 UI 转义。`tests/cgServer.test.ts` 覆盖导演多轮读取、超限回滚、只读 API、同步后 hash 失效和区域位置刷新。全量测试、构建与 verify:worldforge 为交付检查。
