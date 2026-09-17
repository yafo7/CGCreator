# V1 本地验收记录

项目目录：`D:\workshop\developer_learn\agentland\cgcreator`。

- `npm run build`：TypeScript 与 Vite 生产构建通过。底座主包仍有体积提示，CG 工作区已独立动态加载。
- 自动测试覆盖 WorldForge 原有能力及 CG 编译、资源解码、版本事务、人工约束和局部修改。使用注入的服务响应，不消耗远程生成额度。
- 浏览器在餐厅地图中创建并播放 11 秒内置演出，包含跟拍、推镜、特写、角色移动、原地动画和 spark。
- 将第三镜头自然语言修改为“这个镜头慢一点”：时长从 3 秒变为 3.75 秒，前两个镜头保留 4 秒。
- 捕获当前机位并施加硬约束，编译、确认、导出 JSON 成功。
- 将移动终点标到桌面上的精确坐标：编译返回 `unreachable_target`，禁用确认，保留旧确认版本。没有自动把该点吸附到地面。
- 移除测试终点约束后重新编译、确认、重开项目，文档、资源、时长与机位约束均恢复。
- 窄窗口中，预览和时间轴占满上方宽度，导演意图与人工约束位于下方滚动区。

远程自然语言生成的视觉效果与外部服务可用性未在本次验收中验证。复杂动态避让和精细演出接触仍属于后续版本。

## WorldForge main 底座清理验收（2026-09-14）

- 底座：`linkq-q/worldforge-studio` 的 `main`，提交 `b74cb54e8ccde95fafe299718167cebc07bfc7ff`。独立 `worldforge-studio` 仓库仍为该提交，工作区干净。
- 移除旧 `DirectorPlan`、`CinematicDocument`、director agent、map host、旧导演界面和旧 cinematic 存储/导出逻辑。地图 API、存储、事务、导出、样式与 map-core 导出恢复到上游版本。当前 CG 仅使用 `DirectorDocument → CompiledCG`、`/api/cg/projects` 和 `CgStore`。
- `npm run verify:worldforge` 通过：检查 511 个上游文件，仅有 12 个在 `worldforge-base.json` 中逐项说明的集成文件存在差异，其余上游文件一致。
- 完整测试通过：107 个测试文件，780 个测试。TypeScript、生产构建、map-core 构建及 smoke 验证通过；生产构建仅有现有的大包体积提示。
- HTTP 集成测试覆盖 WorldForge 地图事务后创建/规划 CG、原地图不被改变、最新人工路径约束能力声明；旧 cinematic 和 director plan 端点返回 404，新的 MapStore 不创建 cinematic 目录。
- 浏览器实际打开“园林少年·奔向凉亭”，恢复文档 r7、3 个镜头和 22 秒演出，播放至结束。绿色角色路线、蓝色摄影机路径和控制点可见；语义索引显示 62 个对象、1453 个模型部件、6 个区域及 1 个水体，镜头观察面板显示物品位置、覆盖率与遮挡信息。
- 返回地图后 CG 对话框移除，保存按钮可用，地图渲染恢复；本次页面无 console error/warn。未拖动并保存真实项目的控制点，人工点约束由编译器回归测试覆盖。
- 数据与清理前备份逐文件 SHA-256 对比：117 个文件，无修改、缺失或新增。备份位于 `data/backups/map-editor-2026-09-14T04-49-08-516Z`。本轮不调用远程模型生成，不据此宣称生成审美质量已有提升。
- 工作位于 `cleanup/worldforge-main` 分支；保留清理前 stash 供恢复，不推送远程仓库。

## 智能动线编辑验收（2026-09-14）

- 路线工具进入后自动切换到动线总览；单击只选择整条动线，双击才进入该动线的控制点编辑，Esc 只退出控制点层级。编辑状态下再次双击曲线会提交一个新增途经点事务。
- 自动摄影机运动默认暴露起点、途经点、终点 3 个控制点；控制点带编号，并随观察距离保持可读大小。真实园林项目中已浏览器验证角色动线的单击选线和双击编辑状态，未拖动或新增点，项目数据未改变。
- 人工摄影机路径在编译器 `cgcreator-1.4.0` 中采用按弧长求值的 centripetal Catmull-Rom 曲线；两点和旧编译结果保持线性。镜头位置曲线不接管语义注视目标与构图。
- 人工 NPC 途经点启用平滑求值，位置逐帧投影到冻结地形；编译时采样检查可玩区域与静态碰撞，不能安全平滑时产生 `smoothed_route_blocked` 错误。
- 专项测试 28 项通过；完成改动后的完整测试为 107 个测试文件、781 项测试通过。TypeScript、生产构建、map-core smoke 和 WorldForge baseline 检查通过。

## 多 Agent 生成内核验收（2026-09-16）

- 一键入口执行 `World bootstrap → Preproduction → World/Production 并行 → Readiness Gate → Final Director → Performance → Camera → Negotiation → Compile → Validate → Preview`，Run 和不可变 Artifact 均持久化；服务重启后的恢复测试通过。
- 自编演出测试：“青衣少女沿园林石子路走到池塘边；提灯老人从凉亭方向走来并举灯；少女转身点头；镜头从两人身后升起并揭示园林。”通过注入的 3d-generate 协议适配器完成，不消耗远程额度；最终候选有效，包含 3 个模型、4 个标记为 `generated` 的动作、1 个 `3d-generate-mount` 装配、两条 WorldForge guide 走位和最终 crane 镜头。步态未提供标称速度时保留明确 warning。
- 修复并发表演的自动镜头边界：镜头以“下一个有效叙事节点”切分，不再用重叠行为结束时间产生零或负时长。
- 完整测试：112 个测试文件、836 项测试通过。`npm run build` 通过；仅保留既有主包体积提示。`npm run verify:worldforge` 通过：511 个上游文件中仅 13 个登记集成文件不同。
- 浏览器在“中式园林9（导入）”上通过一键 Run 生成 11 秒演出；UI 显示 12 个 Agent 任务全部完成、实时播放到 11 秒、确认成功、Run 状态变为 `confirmed`、导出按钮启用。开发服务终端无运行时错误。
