# CGCreator skill 与库选用记录

检索目的：为高层导演意图、Three.js 摄影机、确定时间轴、资源调用和视觉检查寻找可复用方法。以下资料为架构参考；没有把整套外部 skill/示例代码导入本仓库。

| 来源 | 选用内容 | 接入方式 |
| --- | --- | --- |
| [Threejs-Awesome-Graphics-Agent-Skills](https://github.com/scottstts/Threejs-Awesome-Graphics-Agent-Skills) | camera-direction、procedural-animation、visual-validation：依据尺度构图、运动所有权、绝对时间采样、视觉验证 | 原创项目 skill 与编译器实现；不复制其整套包 |
| [cutscene_agent](https://github.com/KuaishouGameMind/cutscene_agent) | 先查真实资产与场景状态，再顺序执行依赖动作，保留可编辑结果 | 导演上下文与资源适配器设计参考 |
| [CutsceneProvider](https://github.com/KuaishouGameMind/CutsceneProvider) | OTS、Dolly、Orbit 等摄影机能力分解 | Three.js Y-up 摄影机求解器自主实现，未引入 Unreal 运行时 |
| [camera-controls](https://github.com/yomotsu/camera-controls) | 可交互机位编辑能力 | 本版沿用 WorldForge 已有 OrbitControls，保留后续替换空间 |
| [CinemaTraj](https://github.com/Pangolin112/CinemaTraj) | 参数化轨迹与 `evaluate(t)`，区分自由参数和固定参数 | 确定性采样与人工约束的概念参考；未引入 Python/CUDA/3DGS 栈 |
| [Theatre.js](https://github.com/theatre-js/theatre) | 可视化时间轴与编辑模型 | 本版使用轻量原生时间轴；后续接入前单独核对 Core 与 Studio 的授权边界 |
| [everything-ai-filmmaking](https://github.com/PitchySentinel/everything-ai-filmmaking) | cinematography、shot-sequencing、continuity-checking：叙事意图到景别/角度、30 度规则、视线与运动方向、动机剪辑 | 提炼为原创 camera grammar，进入规划提示词、编译器诊断与项目 skill；不复制原文 |
| [Unity Cinemachine documentation](https://docs.unity3d.com/Packages/com.unity.cinemachine@3.1/manual/CinemachineThirdPersonFollow.html) | 主体相对跟随、构图旋转、镜头质量评估的运行时机制 | 在 Three.js 编译器内实现主体坐标系、语义注视点与确定性遮挡评分；不引入 Unity 包 |
| [FilmAgent](https://arxiv.org/abs/2501.12909) / [VideoClaw source](https://github.com/HITsz-TMG/VideoClaw/tree/main/FilmAgent/FilmAgent) | 导演、演员、摄影师分阶段中间 JSON 与有限轮审核 | 采用角色分工与有限协商；改为强类型 Artifact、证据、版本和确定性实时 3D 编译 |
| [OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO) | Timeline / Stack / Track / Clip / Gap / Transition 和资源引用分离 | `CgTimelineComposition` 作为 CompiledCG 的可编辑派生视图 |
| [Unity Cinemachine source](https://github.com/Unity-Technologies/com.unity.cinemachine) | Brain、Virtual Camera、CameraState、Shot 与 Blend 栈分离 | Camera Agent 输出机位方案，Compiler 统一产生最终相机轨迹 |
| [BehaviorTree.CPP](https://github.com/BehaviorTree/BehaviorTree.CPP) | Sequence、Parallel、Fallback、任务状态、重试与日志 | 用于持久化生成任务图和恢复；不用于实时角色播放 |
| [OpenUSD](https://openusd.org/release/intro.html) | 稳定路径、引用组合、来源与层级覆盖 | Artifact 稳定 ID、input refs、provenance、map/resource revision |

授权处理：Threejs-Awesome-Graphics-Agent-Skills 的仓库根许可与部分包/依赖许可范围并不完全一致，因此不把“根目录 MIT”当作所有文件均可直接商用的证明。CutsceneProvider 与 cutscene_agent 研究时为 MIT；CinemaTraj 的第三方资产、模型与依赖仍需独立核对。本项目保留 WorldForge 原有授权与 vendor 声明，新增 skill 是本项目原创说明。

Skill 是给 AI 的工作方法，不能代替执行接口。实际支持的 camera/action/constraint 类型由 `src/shared/cgTypes.ts` 和编译校验器限定。模型输出再符合 skill，也必须经过程序校验。
