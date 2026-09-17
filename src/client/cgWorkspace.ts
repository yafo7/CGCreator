import type { EditableMap } from '../shared/map';
import type { RenderScheme } from '../shared/renderScheme';
import type { CgMapSyncSummary, CgPatchOperation, CgProject, CgProjectSummary, CgVec3, CompiledCG, DirectorDocument } from '../shared/cgTypes';
import type { CgGenerationRun } from '../shared/cgRunTypes';
import { stableHash } from '../shared/cgValidation';
import { inspectCgView } from '../shared/cgViewSemantics';
import { buildWorldSemanticIndex } from '../shared/cgWorldSemantics';
import { renderWorldInspector } from './cgWorldInspector';
import { CgPlaybackRuntime, type CgEditablePathPoint } from './cgRuntime';
import { serverHttpBase } from './serverEndpoint';
import './cgWorkspace.css';

export interface CgWorkspaceOptions { map: EditableMap; scheme: RenderScheme | null; onClose?: () => void }

const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const seconds = (value: number): string => Number.isFinite(value) ? value.toFixed(2) : '0.00';
const movement: Record<string, string> = { static: '固定', dolly: '推镜', tracking: '跟拍', orbit: '环绕' };
const framing: Record<string, string> = { wide: '全景', medium: '中景', 'close-up': '特写', 'over-shoulder': '越肩' };
const cameraView: Record<string, string> = { front: '正面', 'front-three-quarter': '前侧 3/4', side: '侧面', 'rear-three-quarter': '后侧 3/4', rear: '背面' };
const cameraAim: Record<string, string> = { body: '全身构图', 'upper-body': '上半身构图', face: '面部对焦', eyes: '眼部对焦', interaction: '互动构图' };
const actionName: Record<string, string> = { move: '移动', airborne: '飞身与落地', face: '朝向', animate: '动作', visibility: '显隐', effect: '特效', attach: '道具挂载', detach: '道具分离', handoff: '道具交接', sit: '坐下与保持接触', dialogue: '对话表演', hold: '保持状态' };

export function describeMapSync(summary: CgMapSyncSummary): string {
  const changes = [
    summary.addedObjectIds.length ? `新增 ${summary.addedObjectIds.length} 个物体` : '',
    summary.removedObjectIds.length ? `移除 ${summary.removedObjectIds.length} 个物体` : '',
    summary.changedObjectIds.length ? `修改 ${summary.changedObjectIds.length} 个物体` : '',
    summary.changedAssetIds.length ? `更新 ${summary.changedAssetIds.length} 个资源` : '',
    summary.worldChanged ? '地形或场景结构已更新' : '',
    summary.schemeChanged ? '渲染方案已更新' : ''
  ].filter(Boolean);
  return changes.join('、') || '快照元数据已更新';
}

export function parseCgTarget(value: string): { kind: string; targetId: string } {
  const delimiter = value.indexOf(':');
  return delimiter < 0 ? { kind: '', targetId: '' } : { kind: value.slice(0, delimiter), targetId: value.slice(delimiter + 1) };
}

export function createPointConstraintPatch(document: DirectorDocument, value: string, position: CgVec3, anchorId: string): CgPatchOperation[] {
  const { kind, targetId } = parseCgTarget(value);
  const entity = document.entities.find(item => item.id === targetId);
  const action = document.actions.find(item => item.id === targetId);
  if (kind === 'entity' ? !entity : kind !== 'action' || action?.type !== 'move') throw new Error('请选择角色、道具或移动动作作为位置约束目标。');
  return [
    { type: 'anchor.upsert', anchor: { id: anchorId, name: '用户标记点', kind: 'point', position, space: 'world' } },
    { type: 'constraint.upsert', constraint: { id: `point-${targetId}`, source: 'user', strength: 'hard', type: kind === 'action' ? 'action-target' : 'entity-position', targetId, anchorId, ...(kind === 'entity' ? { scope: entity?.kind === 'prop' ? 'throughout' as const : 'initial' as const } : {}) } }
  ];
}

/** A self-contained workspace; the WorldForge editor remains mounted behind it. */
export async function openCgWorkspace(options: CgWorkspaceOptions): Promise<void> {
  const workspace = new CgWorkspace(options);
  await workspace.mount();
}

class CgWorkspace {
  private root = document.createElement('section');
  private runtime: CgPlaybackRuntime | null = null;
  private project: CgProject | null = null;
  private generationRun: CgGenerationRun | null = null;
  private bundle: CompiledCG | null = null;
  private selectedShot = '';
  private selectedBehavior = '';
  private selectedPoint: [number, number, number] | null = null;
  private time = 0;
  private playing = false;
  private manual = false;
  private marking = false;
  private pathEditing = false;
  private busy = false;
  private closed = false;
  private frameId = 0;
  private lastFrame = 0;
  private resize: ResizeObserver | null = null;
  private progressId = 0;
  private abort = new AbortController();
  private viewObservationKey = '';
  private pendingPreparedAssetId = '';

  constructor(private options: CgWorkspaceOptions) {}

  async mount(): Promise<void> {
    this.root.className = 'cg-workspace';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.tabIndex = -1;
    this.root.setAttribute('aria-label', 'CGCreator 实机演出工作区');
    this.root.innerHTML = `
      <header class="cg-header"><div class="cg-brand"><span class="cg-logo">C<span>G</span></span><div><strong>CGCreator</strong><small>实时 3D 演出工作台</small></div><span class="cg-version">V 0.2</span></div>
        <div class="cg-source"><span class="cg-status-dot"></span><span data-cg="source"></span><span class="cg-source-tag">WorldForge 快照</span></div>
        <div class="cg-header-actions"><button data-do="open-3d-editor">3D 资产工坊</button><button data-do="import">导入演出</button><button data-do="export" disabled>导出已确认</button><button data-do="close" class="cg-close">返回地图 ↗</button></div>
      </header>
      <div class="cg-body">
        <aside class="cg-story"><div class="cg-panel-heading"><span>01 / 导演意图</span><span class="cg-muted">DIRECT</span></div>
          <label class="cg-label" for="cg-project-select">演出项目</label><div class="cg-project-row"><select id="cg-project-select" data-cg="projects"><option value="">新建 · 当前地图</option></select><button data-do="load" title="打开所选项目">打开</button></div>
          <div data-cg="map-sync" class="cg-map-sync"><span data-cg="map-sync-text">打开项目后检查地图版本</span><button data-do="sync-map" disabled>同步当前地图</button></div>
          <label class="cg-label" for="cg-prompt">描述这一段故事</label><textarea id="cg-prompt" data-cg="prompt" rows="5" placeholder="角色走向场景中央，镜头缓缓跟随。角色停下后，切到面部特写，停留片刻。"></textarea>
          <button data-do="plan" class="cg-primary cg-full">✦ 一键生成可播放 CG</button>
          <button data-do="demo" class="cg-demo cg-full">体验内置演出 · 无需 AI 服务</button>
          <button data-do="foundation-demo" class="cg-demo cg-full">基础闭环演示 · 跑步、对话、坐下</button>
          <p class="cg-help">从当前地图开始。角色、道具和运镜被编译成可编辑的实时演出。</p>
          <div class="cg-panel-heading cg-divider"><span>制作准备</span><span class="cg-muted">CAST & PROP</span></div>
          <div class="cg-prep-form"><select data-cg="prep-kind" aria-label="资源类型"><option value="actor">角色</option><option value="prop">道具</option></select><input data-cg="prep-name" aria-label="资源名称" placeholder="名称，例如少年"></div>
          <input data-cg="prep-description" aria-label="一句话资源描述" placeholder="穿蓝色短衫的少年">
          <button data-do="prepare-asset" class="cg-full">＋ 制作角色或道具</button>
          <p class="cg-help">用一句话描述。生成后可被导演直接选择；模型版本固定，后续替换不会覆盖已确认演出。</p>
          <div class="cg-prep-form"><select data-cg="motion-asset" aria-label="动作所属资源"><option value="">先制作角色</option></select><input data-cg="motion-description" aria-label="一句话动作描述" placeholder="原地跑步"></div>
          <button data-do="prepare-motion" class="cg-full">＋ 制作动作</button>
          <div data-cg="preparation" class="cg-preparation"><div class="cg-empty">还没有准备角色或道具。</div></div>
          <div class="cg-panel-heading cg-divider"><span>镜头列表</span><span data-cg="shot-count" class="cg-muted">0 SHOTS</span></div>
          <div data-cg="shots" class="cg-shot-list"><div class="cg-empty">写下导演意图，或体验内置演出。镜头与动作将在这里展开。</div></div>
          <div class="cg-panel-heading cg-divider"><span>角色与资源</span><span data-cg="resource-count" class="cg-muted">0</span></div><div data-cg="entities" class="cg-entities"></div>
          <details class="cg-semantic" open><summary>已求解的演出行为</summary><div data-cg="performance" class="cg-semantic-list">编译后显示行为时间、接触和镜头选择。</div></details>
          <details class="cg-semantic" open><summary>多 Agent 制作流程</summary><div data-cg="agent-run" class="cg-semantic-list">等待生成。地图、资源、表演与摄影会按依赖顺序协作。</div></details>
        </aside>
        <main class="cg-center">
          <div class="cg-view" data-cg="view"><canvas data-cg="canvas" aria-label="可交互的 3D 演出预览"></canvas>
            <div class="cg-view-top"><span class="cg-live">● REALTIME</span><span data-cg="view-label">场景预览</span><span data-cg="revision" class="cg-revision">未生成</span></div>
            <div class="cg-view-tools"><button data-do="manual" title="用鼠标旋转、平移和缩放摄影机">自由机位</button><button data-do="paths" title="显示动线；单击选线，双击编辑控制点">路线编辑</button><button data-do="mark" title="在可见场景表面点击标点">＋ 场景标点</button><button data-do="reset-view">回到演出机位</button></div>
            <div data-cg="subtitle" class="cg-subtitle"></div><div data-cg="view-hint" class="cg-view-hint">拖动旋转 · 右键平移 · 滚轮缩放</div>
            <div data-cg="loading" class="cg-loading"><span></span>正在载入 WorldForge 场景…</div>
          </div>
          <section class="cg-timeline"><div class="cg-transport"><div><button data-do="start" aria-label="回到开始">|◀</button><button data-do="play" class="cg-play" aria-label="播放" disabled>▶</button><span data-cg="time">00.00 / 00.00</span></div><span class="cg-muted">确定性时间轴 · 拖动可精确回看</span><span data-cg="timeline-count" class="cg-muted"></span></div>
            <input data-cg="seek" type="range" min="0" max="1" step="0.01" value="0" aria-label="演出时间" disabled>
            <div data-cg="tracks" class="cg-tracks"><div class="cg-timeline-empty">编译后，镜头和连续角色动作在这里对齐。</div></div>
          </section>
        </main>
        <aside class="cg-inspector"><div class="cg-panel-heading"><span>02 / 镜头与约束</span><span class="cg-muted">REFINE</span></div>
          <div data-cg="selection" class="cg-selection"><h2>让意图成为演出</h2><p>选择镜头后，可以调整景别、节奏与机位。</p></div>
          <label class="cg-label" for="cg-refine">自然语言精修</label><textarea id="cg-refine" data-cg="refine" rows="3" placeholder="这个镜头慢一点，改成特写"></textarea><button data-do="refine" class="cg-full" disabled>✦ 只修改所选镜头</button>
          <div class="cg-panel-heading cg-divider"><span>精确人工约束</span><span class="cg-lock-label">HARD LOCK</span></div>
          <label class="cg-label" for="cg-lock-target">约束目标</label><select id="cg-lock-target" data-cg="lock-target"><option value="">生成文档后选择目标</option></select>
          <p data-cg="point" class="cg-point">尚未标点。点击「场景标点」，再点击场景表面。</p><button data-do="lock-point" class="cg-full" disabled>将目标锁定到标记点</button>
          <div class="cg-two-buttons"><button data-do="manual">摆放机位</button><button data-do="lock-camera" disabled>锁定当前机位</button></div>
          <label class="cg-label" for="cg-duration">镜头时长 / 秒</label><div class="cg-project-row"><input id="cg-duration" data-cg="duration" type="number" min="0.1" max="600" step="0.1" value="3"><button data-do="lock-duration" disabled>锁定</button></div>
          <label class="cg-label" for="cg-action-time">动作开始 / 秒</label><div class="cg-project-row"><input id="cg-action-time" data-cg="action-time" type="number" min="0" max="600" step="0.1" value="0"><button data-do="lock-time" disabled>锁定</button></div>
          <p class="cg-help">人工约束优先于 AI。冲突会明确报错，确认前必须解决。</p><div data-cg="constraints" class="cg-constraints"></div>
          <details class="cg-semantic" open><summary>镜头当前能看到什么</summary><div data-cg="view-semantics" class="cg-semantic-list"><p>编译预览后显示画面语义。</p></div></details>
          <details class="cg-semantic"><summary>导演地图语义 · 当前快照</summary><input data-cg="world-filter" aria-label="搜索地图区域或物体" placeholder="搜索凉亭、树林、道路或 ID"><div data-cg="world-semantics" class="cg-semantic-list"><p>载入地图语义中…</p></div></details>
          <details class="cg-document"><summary>查看结构化导演文档</summary><pre data-cg="document">等待生成</pre></details>
        </aside>
      </div>
      <footer class="cg-footer"><div class="cg-pipeline"><span data-phase="document">导演文档</span><b>→</b><span data-phase="compile">Compile</span><b>→</b><span data-phase="validate">Validate</span><b>→</b><span data-phase="preview">Preview</span><b>→</b><span data-phase="confirm">Confirm</span></div><div class="cg-footer-actions"><button data-do="compile" disabled>编译并预览</button><button data-do="confirm" class="cg-primary" disabled>确认此版本</button></div></footer>
      <div data-cg="status" class="cg-status" role="status">当前地图已作为演出起点；源地图保持独立。</div><div data-cg="diagnostics" class="cg-diagnostics" hidden></div>
      <input type="file" data-cg="file" accept="application/json,.json" hidden>
      <input type="file" data-cg="prepared-file" accept="application/json,.json" hidden>
    `;
    document.body.append(this.root);
    this.root.focus();
    this.text('source', this.options.map.name);
    this.root.addEventListener('click', event => { const button = (event.target as Element).closest<HTMLButtonElement>('[data-do]'); if (button && !button.disabled) void this.handle(button.dataset.do!, button); });
    this.el<HTMLInputElement>('seek').addEventListener('input', event => { this.playing = false; this.time = Number((event.target as HTMLInputElement).value); this.syncButtons(); this.draw(); });
    this.el<HTMLSelectElement>('projects').addEventListener('change', () => this.renderMapSync());
    this.el<HTMLSelectElement>('lock-target').addEventListener('change', () => this.syncButtons());
    this.el<HTMLInputElement>('world-filter').addEventListener('input', () => this.renderWorld());
    this.el<HTMLInputElement>('file').addEventListener('change', () => void this.importBundle());
    this.el<HTMLInputElement>('prepared-file').addEventListener('change', () => void this.importPreparedModel());
    this.el<HTMLCanvasElement>('canvas').addEventListener('pointerdown', event => {
      if (this.pathEditing && this.runtime?.pickPathControl(event.clientX, event.clientY)) { event.stopPropagation(); return; }
      if (!this.marking || this.busy || !this.runtime) return;
      this.selectedPoint = this.runtime.pick(event.clientX, event.clientY);
      if (!this.selectedPoint) { this.status('没有命中可见表面，请选择地面或物体表面。'); return; }
      this.marking = false;
      this.root.classList.remove('cg-is-marking');
      this.runtime.controls.enabled = this.manual || !this.bundle;
      this.text('point', `世界坐标 [ ${this.selectedPoint.map(value => value.toFixed(3)).join(', ')} ]`);
      this.status('标点已记录。选择角色、道具或移动动作，然后锁定。');
      this.syncButtons();
    });
    this.el<HTMLCanvasElement>('canvas').addEventListener('click', event => {
      if (!this.pathEditing || this.busy || event.detail !== 1) return;
      const selection = this.runtime?.selectPath(event.clientX, event.clientY);
      this.status(selection ? `已选择${selection.kind === 'camera' ? '摄影机轨迹' : '角色走位'}。双击这条线进入控制点编辑。` : '未选择动线。单击绿色角色走位或蓝色摄影机轨迹。');
    });
    this.el<HTMLCanvasElement>('canvas').addEventListener('dblclick', event => {
      if (!this.pathEditing || this.busy || !this.runtime) return;
      event.preventDefault();
      if (this.runtime.insertPathPoint(event.clientX, event.clientY)) {
        this.status('正在新增控制点并重新编译…');
        return;
      }
      const selection = this.runtime.editSelectedPath();
      if (selection) this.status(`正在编辑${selection.kind === 'camera' ? '摄影机轨迹' : '角色走位'}：拖动控制点；再次双击曲线可增加途经点。`);
    });
    this.root.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key !== 'Escape') return;
      if (this.marking) { this.marking = false; this.root.classList.remove('cg-is-marking'); this.runtime?.setManual(this.manual); return; }
      if (this.pathEditing && this.runtime?.cancelPathPointEditing()) this.status('已退出控制点编辑；动线仍保持选中。双击可再次编辑。');
    });
    this.syncButtons();
    void this.refreshProjects();
    try {
      this.runtime = await CgPlaybackRuntime.create(this.el<HTMLCanvasElement>('canvas'), this.options.map, this.options.scheme);
      if (this.closed) { this.runtime.dispose(); return; }
      this.el('loading').hidden = true;
      const view = this.el('view');
      this.resize = new ResizeObserver(() => this.runtime?.resize(view.clientWidth, view.clientHeight));
      this.resize.observe(view);
      this.runtime.resize(view.clientWidth, view.clientHeight);
      this.renderWorld();
      this.lastFrame = performance.now();
      this.syncButtons();
      this.loop();
    } catch (error) { if (!this.closed) { this.el('loading').hidden = true; this.status(`场景载入失败：${this.message(error)}`, true); } }
  }

  private el<T extends HTMLElement = HTMLElement>(name: string): T { return this.root.querySelector<T>(`[data-cg="${name}"]`)!; }
  private text(name: string, value: string): void { this.el(name).textContent = value; }
  private get document(): DirectorDocument | null { return this.project?.document ?? this.bundle?.document ?? null; }
  private get current(): boolean { return !!this.project?.candidate && this.project.candidate.documentRevision === this.project.document.revision && this.bundle?.id === this.project.candidate.id && this.bundle.inputHash === this.project.candidate.inputHash; }
  private message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private status(message: string, error = false): void { if (this.closed) return; this.text('status', message); this.el('status').classList.toggle('cg-error', error); }

  private async request<T>(path: string, body?: unknown): Promise<T> {
    if (this.closed) throw new DOMException('工作区已关闭', 'AbortError');
    const response = await fetch(`${serverHttpBase(location, import.meta.env.DEV)}/api/cg${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: this.abort.signal });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value.message === 'string' ? value.message : typeof value.error === 'string' ? value.error : `请求失败 (${response.status})`);
    return value as T;
  }

  private async run(message: string, operation: () => Promise<void>): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    this.playing = false;
    this.status(message);
    this.syncButtons();
    try { await operation(); } catch (error) { this.status(this.message(error), true); }
    finally { this.busy = false; if (!this.closed) this.syncButtons(); }
  }

  private async handle(action: string, button: HTMLButtonElement): Promise<void> {
    if (action === 'foundation-demo') {
      await this.run('正在准备独立的基础演出验证场景…', async () => {
        const project = await this.request<CgProject>('/foundation-demo', {});
        this.selectedShot = '';
        await this.present(project, true);
        await this.refreshProjects();
        this.status('已打开独立演示场景：沿弯路跑步、双人对话、坐下并保持坐姿。演示不修改当前 WorldForge 地图，确认仍由你决定。');
      });
      return;
    }
    if (action === 'world-focus') {
      await this.run('正在定位当前地图区域…', async () => {
        const map = this.worldMap;
        const entity = buildWorldSemanticIndex(map).entities.find(e => e.id === button.dataset.id);
        if (!entity || !this.runtime) return;
        this.playing = false;
        if (this.bundle && this.project) await this.resetScene(map, this.project.schemeSnapshot);
        else if (this.bundle) this.time = 0; // Keep an imported read-only bundle and its map available.
        this.manual = true;
        this.runtime.focusWorldEntity(entity, map);
        this.status(`已定位 ${entity.name}。显示当前地图快照；黄色轮廓为区域边界，路径显示中心线，准确宽度可在语义详情中查看。`);
      });
      return;
    }
    if (action === 'close') { this.close(); return; }
    if (action === 'play') { this.manual = false; this.runtime?.setManual(false); if (this.time >= (this.bundle?.duration ?? 0)) this.time = 0; this.playing = !this.playing; this.syncButtons(); return; }
    if (action === 'start') { this.time = 0; this.playing = false; this.syncButtons(); this.draw(); return; }
    if (action === 'manual') { this.playing = false; this.manual = !this.manual; this.runtime?.setManual(this.manual); this.status(this.manual ? '自由机位：左键旋转，右键平移，滚轮缩放。摆好后点击「锁定当前机位」。' : '已回到演出摄影机。'); this.syncButtons(); this.draw(); return; }
    if (action === 'paths') { this.playing = false; this.pathEditing = !this.pathEditing; this.marking = false; this.root.classList.remove('cg-is-marking'); this.runtime?.setPathEditing(this.pathEditing, point => void this.commitPathEdit(point)); this.status(this.pathEditing ? '动线已显示：先单击选择一条线，再双击进入控制点编辑；编辑中双击曲线可增加途经点。' : '已隐藏动线。'); this.syncButtons(); this.draw(); return; }
    if (action === 'reset-view') { this.manual = false; this.runtime?.setManual(false); this.syncButtons(); this.draw(); return; }
    if (action === 'mark') { this.playing = false; this.marking = !this.marking; this.root.classList.toggle('cg-is-marking', this.marking); if (this.runtime) this.runtime.controls.enabled = this.marking ? false : this.manual || !this.bundle; this.status(this.marking ? '点击场景中的可见表面。Esc 取消标点。' : '已取消标点。'); this.syncButtons(); return; }
    if (action === 'shot') { this.selectedBehavior = ''; this.selectedShot = button.dataset.id!; this.time = this.bundle?.shots.find(shot => shot.id === this.selectedShot)?.start ?? this.time; this.playing = false; this.renderDocument(); this.draw(); return; }
    if (action === 'behavior') { this.selectedBehavior = button.dataset.id!; this.selectedShot = ''; this.time = this.bundle?.actions.find(a => a.id === this.selectedBehavior)?.start ?? this.time; this.playing = false; this.renderDocument(); this.draw(); return; }
    if (action === 'import') { this.el<HTMLInputElement>('file').click(); return; }
    if (action === 'open-3d-editor') { await this.run('正在打开 3d-generate 资产工坊…', async () => {
      const { url } = await this.request<{ url: string }>('/tools/3d-editor', {});
      window.open(url, '_blank', 'noopener');
      this.status('3D 资产工坊已打开。编辑后导出模型 JSON，再在对应资源上点击「导入编辑结果」。');
    }); return; }
    if (action === 'load') { await this.run('正在打开已保存的演出…', async () => {
      const id = this.el<HTMLSelectElement>('projects').value;
      if (!id) { await this.resetScene(this.options.map, this.options.scheme); this.project = null; this.generationRun = null; this.selectedShot = ''; this.text('source', this.options.map.name); this.renderDocument(); this.status('已切换为新建项目；下一次生成将使用进入工作区时的地图快照。'); return; }
      await this.present(await this.request<CgProject>(`/projects/${encodeURIComponent(id)}`), true);
      const history = await this.request<{ runs: CgGenerationRun[] }>(`/projects/${encodeURIComponent(id)}/runs`);
      this.generationRun = history.runs[0] ?? null;
      this.renderDocument();
      this.status('项目已恢复。导演文档、资源和已确认版本均保存在本地。');
    }); return; }
    if (action === 'sync-map') { await this.run('正在同步 WorldForge 地图并重新编译…', async () => {
      if (!this.project) throw new Error('请先打开一个 CG 项目。');
      if (this.project.mapSnapshot.id !== this.options.map.id) throw new Error('当前 WorldForge 地图与这个 CG 项目不是同一张地图。');
      const result = await this.request<{ project: CgProject; summary: CgMapSyncSummary }>(`/projects/${this.project.id}/sync-map`, { revision: this.project.revision, map: this.options.map, scheme: this.options.scheme });
      await this.present(result.project, false);
      await this.resetScene(result.project.mapSnapshot, result.project.schemeSnapshot);
      this.renderDocument();
      await this.compile(true);
      const summary = describeMapSync(result.summary);
      this.status(this.project?.candidate?.validation.valid
        ? `WorldForge 地图已同步并重新编译通过：${summary}。导演文档和人工约束已保留。`
        : `WorldForge 地图已同步：${summary}。新地图与演出存在冲突，请查看诊断；上次确认版本仍保留。`, !this.project?.candidate?.validation.valid);
      await this.refreshProjects();
    }); return; }
    if (action === 'plan' || action === 'demo') { await this.run(action === 'demo' ? '正在创建内置演出…' : '正在理解剧情与地图…', async () => {
      const prompt = this.el<HTMLTextAreaElement>('prompt').value.trim();
      if (action === 'plan' && !prompt) throw new Error('请先描述剧情或导演意图。');
      if (!this.project) this.project = await this.request<CgProject>('/projects', { map: this.options.map, scheme: this.options.scheme, title: prompt.slice(0, 32) || '内置演出' });
      this.progressId = window.setInterval(() => {
        if (!this.project || this.closed) return;
        void this.request<{ stage: string; message: string; running: boolean }>(`/projects/${this.project.id}/progress`).then(progress => { if (progress.running && !this.closed) this.status(progress.message || progress.stage); }).catch(() => undefined);
      }, 700);
      try {
        const result = await this.request<{ run: CgGenerationRun; project: CgProject }>(`/projects/${this.project.id}/runs`, { revision: this.project.revision, prompt: prompt || '角色走向场景中央，跟拍后切换特写。', demo: action === 'demo' });
        this.generationRun = result.run;
        await this.present(result.project, true);
        this.status(`完整制作流程已通过 · ${result.project.candidate?.duration.toFixed(2) ?? '0.00'} 秒 · 可以直接预览，确认后即可导出。`);
        await this.refreshProjects();
      } catch (error) {
        const history = await this.request<{ runs: CgGenerationRun[] }>(`/projects/${this.project.id}/runs`).catch(() => ({ runs: [] }));
        this.generationRun = history.runs[0] ?? null;
        this.renderDocument();
        throw error;
      } finally { clearInterval(this.progressId); this.progressId = 0; }
    }); return; }
    if (action === 'prepare-asset') { await this.run('正在制作演出资源…', async () => {
      const description = this.el<HTMLInputElement>('prep-description').value.trim();
      if (!description) throw new Error('请用一句话描述角色或道具。');
      if (!this.project) this.project = await this.request<CgProject>('/projects', { map: this.options.map, scheme: this.options.scheme, title: 'CG 制作准备' });
      const project = await this.request<CgProject>(`/projects/${this.project.id}/prepare-asset`, {
        revision: this.project.revision,
        kind: this.el<HTMLSelectElement>('prep-kind').value,
        name: this.el<HTMLInputElement>('prep-name').value.trim(),
        description
      });
      await this.present(project, false);
      this.el<HTMLInputElement>('prep-name').value = '';
      this.el<HTMLInputElement>('prep-description').value = '';
      this.status('资源已准备完成。导演生成时会优先使用它；模型编辑后将创建新版本。');
      await this.refreshProjects();
    }); return; }
    if (action === 'prepare-motion') { await this.run('正在制作动作…', async () => {
      if (!this.project) throw new Error('请先制作角色或道具。');
      const assetId = this.el<HTMLSelectElement>('motion-asset').value;
      const description = this.el<HTMLInputElement>('motion-description').value.trim();
      if (!assetId || !description) throw new Error('请选择资源，并用一句话描述动作。');
      await this.present(await this.request<CgProject>(`/projects/${this.project.id}/prepare-motion`, { revision: this.project.revision, assetId, description }), false);
      this.el<HTMLInputElement>('motion-description').value = '';
      this.status('动作已制作完成，并绑定到当前模型版本。导演可直接选择这个动作。');
    }); return; }
    if (action === 'edit-prepared') {
      this.pendingPreparedAssetId = button.dataset.id ?? '';
      if (!this.pendingPreparedAssetId) throw new Error('准备资源不存在。');
      this.el<HTMLInputElement>('prepared-file').click();
      return;
    }
    if (action === 'compile') { await this.run('正在编译演出…', () => this.compile()); return; }
    if (action === 'refine') { await this.run('正在精修所选行为或镜头…', async () => {
      const prompt = this.el<HTMLTextAreaElement>('refine').value.trim();
      if (!prompt) throw new Error('请描述要修改的内容。');
      const result = await this.request<{ project: CgProject; operations: CgPatchOperation[] }>(`/projects/${this.project!.id}/refine`, { revision: this.project!.revision, prompt, targetId: this.selectedBehavior || this.selectedShot });
      await this.present(result.project);
      await this.compile();
      this.el<HTMLTextAreaElement>('refine').value = '';
    }); return; }
    if (action === 'confirm') { await this.run('正在确认当前预览版本…', async () => {
      const candidate = this.project!.candidate!;
      await this.present(await this.request<CgProject>(`/projects/${this.project!.id}/confirm`, { revision: this.project!.revision, compileId: candidate.id, inputHash: candidate.inputHash }));
      if (this.generationRun?.status === 'preview-ready') { this.generationRun.status = 'confirmed'; this.generationRun.phase = 'confirmed'; this.renderDocument(); }
      this.status(`已确认「${this.project!.title}」。当前编译、验证和预览属于同一版本，可导出播放。`);
      await this.refreshProjects();
    }); return; }
    if (action === 'export') { await this.run('正在导出已确认演出…', async () => {
      const bundle = await this.request<CompiledCG>(`/projects/${this.project!.id}/export`);
      this.download(bundle, `${this.project!.title || 'CGCreator'}.cg.json`);
      this.status('已导出可播放 JSON，包含地图、导演文档、冻结资源和时间轴。');
    }); return; }
    if (action.startsWith('lock-') || action === 'remove-constraint') await this.run('正在应用人工约束并重新验证…', async () => {
      if (!this.project) throw new Error('请先生成或打开演出项目。');
      const operations: CgPatchOperation[] = [];
      const id = `user-${crypto.randomUUID()}`;
      if (action === 'lock-point') {
        if (!this.selectedPoint) throw new Error('请先在场景中标点。');
        operations.push(...createPointConstraintPatch(this.project.document, this.el<HTMLSelectElement>('lock-target').value, this.selectedPoint, id));
      } else if (action === 'lock-camera') {
        if (!this.selectedShot || !this.runtime) throw new Error('请先选择镜头。');
        const pose = this.runtime.captureCamera();
        operations.push({ type: 'anchor.upsert', anchor: { id, name: '用户指定机位', kind: 'camera', position: pose.position, quaternion: pose.quaternion, fov: pose.fov, space: 'world' } }, { type: 'constraint.upsert', constraint: { id: `camera-${this.selectedShot}`, source: 'user', strength: 'hard', type: 'camera-pose', targetId: this.selectedShot, anchorId: id } });
      } else if (action === 'lock-duration') {
        const value = Number(this.el<HTMLInputElement>('duration').value);
        if (!Number.isFinite(value) || value <= 0) throw new Error('镜头时长必须为正数。');
        operations.push({ type: 'constraint.upsert', constraint: { id: `duration-${this.selectedShot}`, source: 'user', strength: 'hard', type: 'shot-duration', targetId: this.selectedShot, seconds: value } });
      } else if (action === 'lock-time') {
        const { kind, targetId } = parseCgTarget(this.el<HTMLSelectElement>('lock-target').value);
        const value = Number(this.el<HTMLInputElement>('action-time').value);
        if (kind !== 'action') throw new Error('请在约束目标中选择一个移动动作。');
        if (!Number.isFinite(value) || value < 0) throw new Error('动作开始时间必须大于或等于 0。');
        operations.push({ type: 'constraint.upsert', constraint: { id: `time-${targetId}`, source: 'user', strength: 'hard', type: 'action-time', targetId, seconds: value, edge: 'start' } });
      } else operations.push({ type: 'constraint.remove', id: button.dataset.id! });
      await this.present(await this.request<CgProject>(`/projects/${this.project.id}/patch`, { revision: this.project.revision, operations }));
      await this.compile();
    });
  }

  private async compile(keepMapSnapshotOnError = false): Promise<void> {
    if (!this.project) throw new Error('请先生成导演文档。');
    this.progressId = window.setInterval(() => {
      if (!this.project || this.closed) return;
      void this.request<{ stage: string; message: string; running: boolean }>(`/projects/${this.project.id}/progress`).then(progress => { if (progress.running && !this.closed) this.status(progress.message || progress.stage); }).catch(() => undefined);
    }, 1200);
    try {
      const next = await this.request<CgProject>(`/projects/${this.project.id}/compile`, { revision: this.project.revision });
      if (keepMapSnapshotOnError && !next.candidate?.validation.valid) {
        await this.present(next, false);
        await this.resetScene(next.mapSnapshot, next.schemeSnapshot);
        this.renderDocument();
        this.draw();
      } else await this.present(next, true);
      if (next.candidate?.validation.valid) this.status(`编译与验证通过 · ${next.candidate.duration.toFixed(2)} 秒 · ${next.candidate.shots.length} 个镜头 · ${next.candidate.changedNodeIds.length} 个依赖节点更新。预览后可确认。`);
      else this.status('编译发现冲突，请查看诊断并调整。上次确认版本仍然保留。', true);
    } finally { clearInterval(this.progressId); this.progressId = 0; }
  }

  private async present(project: CgProject, activate = false): Promise<void> {
    if (this.closed) return;
    this.project = project;
    if (!project.document.actions.some(a => a.id === this.selectedBehavior)) this.selectedBehavior = '';
    if (!this.selectedBehavior && !project.document.shots.some(shot => shot.id === this.selectedShot)) this.selectedShot = project.document.shots[0]?.id ?? '';
    if (activate) {
      const candidate = project.candidate?.validation.valid ? project.candidate : project.confirmed;
      if (candidate && this.runtime) {
        await this.runtime.load(candidate);
        if (this.closed) return;
        this.bundle = candidate;
        this.manual = false;
        this.marking = false;
        this.runtime.setPathEditing(this.pathEditing, point => void this.commitPathEdit(point));
        this.root.classList.remove('cg-is-marking');
        this.time = Math.min(this.time, candidate.duration);
      } else await this.resetScene(project.mapSnapshot, project.schemeSnapshot);
    }
    this.text('source', project.mapSnapshot.name);
    this.renderDocument();
    this.renderMapSync();
    this.draw();
  }

  private async resetScene(map: EditableMap, scheme: RenderScheme | null): Promise<void> {
    this.bundle = null;
    this.time = 0;
    this.manual = false;
    this.marking = false;
    this.pathEditing = false;
    this.selectedPoint = null;
    this.root.classList.remove('cg-is-marking');
    this.text('point', '尚未标点。点击「场景标点」，再点击场景表面。');
    this.text('subtitle', '');
    this.text('view-label', '场景预览');
    await this.runtime?.reset(map, scheme);
  }

  private renderDocument(): void {
    const doc = this.document;
    this.text('shot-count', `${doc?.shots.length ?? 0} SHOTS`);
    this.text('resource-count', String(this.project?.resources.models.length ?? this.bundle?.resources.models.length ?? 0));
    this.el('shots').innerHTML = doc?.shots.map((shot, index) => `<button data-do="shot" data-id="${escape(shot.id)}" class="cg-shot ${shot.id === this.selectedShot ? 'selected' : ''}"><span class="cg-shot-number">${String(index + 1).padStart(2, '0')}</span><span><strong>${escape(shot.name)}</strong><small>${escape(movement[shot.camera.movement])} · ${escape(framing[shot.camera.framing])}${shot.camera.view ? ` · ${escape(cameraView[shot.camera.view])}` : ''}</small></span><span class="cg-shot-duration">${seconds(this.effectiveDuration(shot.id))}s</span></button>`).join('') || '<div class="cg-empty">写下导演意图，或体验内置演出。镜头与动作将在这里展开。</div>';
    this.el('entities').innerHTML = doc?.entities.map(entity => `<div><span class="cg-entity-icon">${entity.kind === 'actor' ? '♙' : '◇'}</span><span><strong>${escape(entity.name)}</strong><small>${entity.objectId ? '绑定地图物体' : entity.assetId ? '演出资源' : '待解析资源'}</small></span></div>`).join('') ?? '';
    this.renderPreparation();
    const shot = doc?.shots.find(value => value.id === this.selectedShot);
    this.el('selection').innerHTML = shot ? `<span class="cg-eyebrow">SHOT ${String((doc?.shots.indexOf(shot) ?? 0) + 1).padStart(2, '0')}</span><h2>${escape(shot.name)}</h2><p>${escape(shot.purpose)}</p><div class="cg-chips"><span>${escape(movement[shot.camera.movement])}</span><span>${escape(framing[shot.camera.framing])}</span>${shot.camera.view ? `<span>${escape(cameraView[shot.camera.view])}</span>` : ''}${shot.camera.aim ? `<span>${escape(cameraAim[shot.camera.aim])}</span>` : ''}<span>${seconds(this.effectiveDuration(shot.id))} 秒</span></div>` : '<h2>让意图成为演出</h2><p>选择镜头后，可以调整景别、节奏与机位。</p>';
    if (shot) this.el<HTMLInputElement>('duration').value = String(this.effectiveDuration(shot.id));
    const behavior = doc?.actions.find(a => a.id === this.selectedBehavior);
    if (behavior) this.el('selection').innerHTML = `<span class="cg-eyebrow">PERFORMANCE</span><h2>${escape(actionName[behavior.type])}</h2><p>${escape(behavior.purpose ?? behavior.id)}</p><small>行为时长 ${seconds(behavior.duration)} 秒 · 镜头不会改变行为时间</small>`;
    this.root.querySelectorAll<HTMLButtonElement>('[data-do="refine"]').forEach(button => { button.textContent = behavior ? '✦ 只修改所选行为' : '✦ 只修改所选镜头'; });
    const oldTarget = this.el<HTMLSelectElement>('lock-target').value;
    this.el('lock-target').innerHTML = (doc?.entities.map(entity => `<option value="entity:${escape(entity.id)}">${entity.kind === 'actor' ? '角色起点' : '道具位置'} · ${escape(entity.name)}</option>`).join('') ?? '') + (doc?.actions.filter(action => action.type === 'move').map(action => `<option value="action:${escape(action.id)}">移动终点 · ${escape(doc.entities.find(entity => entity.id === action.entityId)?.name ?? action.entityId)} (${escape(action.id)})</option>`).join('') ?? '');
    if ([...this.el<HTMLSelectElement>('lock-target').options].some(option => option.value === oldTarget)) this.el<HTMLSelectElement>('lock-target').value = oldTarget;
    const names: Record<string, string> = { 'entity-position': '位置', 'action-target': '终点', 'action-route': '走位控制点', 'camera-pose': '机位', 'camera-path': '摄影机轨迹', 'shot-duration': '时长', 'action-time': '开始时间' };
    this.el('constraints').innerHTML = doc?.constraints.map(constraint => `<div><span>⌑ ${escape(names[constraint.type])} · ${escape(doc.shots.find(value => value.id === constraint.targetId)?.name ?? doc.entities.find(value => value.id === constraint.targetId)?.name ?? constraint.targetId)}${constraint.seconds === undefined ? '' : ` · ${seconds(constraint.seconds)}s`}</span><button data-do="remove-constraint" data-id="${escape(constraint.id)}" title="移除此人工约束" ${!this.project ? 'disabled' : ''}>×</button></div>`).join('') ?? '';
    this.renderWorld();
    this.text('document', doc ? JSON.stringify(doc, null, 2) : '等待生成');
    const performance = this.project?.candidate?.performance ?? this.bundle?.performance;
    const candidate = this.project?.candidate ?? this.bundle;
    this.el('performance').innerHTML = performance && candidate ? `<p>演出时长 ${seconds(performance.duration)} 秒 · ${candidate.stage === 'performance' ? '行为阶段，镜头待编译' : '完整编译'}</p>${candidate.actions.filter(a => ['move', 'airborne', 'sit', 'dialogue', 'handoff', 'hold'].includes(a.type)).map(a => `<div><strong>${escape(actionName[a.type])} · ${escape(a.id)}</strong><small>${seconds(a.start)}–${seconds(a.end)} 秒${a.route ? ` · 道路 ${escape(a.route.guideIds.join(', '))}` : ''}${a.contact ? ` · 接触 ${escape(a.contact.objectId)}/${escape(a.contact.nodeId)}` : ''}</small></div>`).join('')}${candidate.shots.map(s => `<div><strong>${escape(s.id)}</strong><small>行为 ${escape(s.behaviorId ?? '未指定')} · 镜头 ${escape(s.skillId ?? '手工意图')}</small></div>`).join('')}` : '当前为旧版或尚未编译的演出。';
    const validation = this.project?.candidate?.validation ?? this.bundle?.validation;
    if (doc?.schemaVersion === 2) this.el('performance').insertAdjacentHTML('afterbegin', `<div class="cg-chips">${doc.actions.filter(a => ['move', 'airborne', 'sit', 'dialogue', 'handoff', 'hold'].includes(a.type)).map(a => `<button data-do="behavior" data-id="${escape(a.id)}">${escape(actionName[a.type])}</button>`).join('')}</div>`);
    const run = this.generationRun;
    const phaseNames: Record<string, string> = { 'world-bootstrap': '理解地图', preproduction: '分析剧情', 'world-deep-read': '核实位置', production: '准备角色、道具与动作', readiness: '检查准备门', 'director-final': '冻结导演文档', performance: '编排演出', camera: '设计镜头', negotiation: '导演仲裁', compile: '确定性编译', validate: '检查演出', preview: '可以预览' };
    this.el('agent-run').innerHTML = run ? `<p>Run ${escape(run.id)} · ${escape(run.status)}</p>${run.tasks.map(task => `<div><strong>${task.status === 'completed' ? '✓' : task.status === 'running' ? '●' : task.status === 'failed' ? '!' : '○'} ${escape(phaseNames[task.id] ?? task.label)}</strong><small>${escape(task.agent)}${task.error ? ` · ${escape(task.error.message)}` : ''}</small></div>`).join('')}${run.diagnostics.length ? `<p>${run.diagnostics.length} 条诊断已按 owner 分派。</p>` : ''}` : '等待生成。地图、资源、表演与摄影会按依赖顺序协作。';
    this.el('diagnostics').hidden = !validation?.diagnostics.length;
    this.el('diagnostics').innerHTML = validation?.diagnostics.map(item => `<div class="${item.severity === 'error' ? 'cg-error' : ''}"><strong>${item.severity === 'error' ? '错误' : '提示'} · ${escape(item.code)}</strong> ${escape(item.message)} <small>${escape(item.nodeIds.join(', '))}</small></div>`).join('') ?? '';
    this.renderTimeline();
    this.syncButtons();
  }

  private effectiveDuration(id: string): number {
    const doc = this.document, candidate = this.project?.candidate ?? this.bundle;
    const resolved = candidate?.documentRevision === doc?.revision ? candidate?.shots.find(s => s.id === id) : undefined;
    return doc?.constraints.find(c => c.type === 'shot-duration' && c.targetId === id)?.seconds ?? (resolved ? resolved.end - resolved.start : doc?.shots.find(s => s.id === id)?.duration ?? 0);
  }

  private renderPreparation(): void {
    const preparation = this.project?.preparation;
    this.el('preparation').innerHTML = preparation?.assets.length ? preparation.assets.map(asset => {
      const version = preparation.versions.find(item => item.id === asset.selectedVersionId);
      const capabilities = version ? [version.capabilities.locomotion ? '可移动' : '', version.capabilities.faceCloseup ? '可特写' : '', version.capabilities.sit === 'ready' ? '可坐下' : ''].filter(Boolean).join(' · ') : '';
      return `<div class="cg-prepared-asset"><span class="cg-entity-icon">${asset.kind === 'actor' ? '♙' : '◇'}</span><span><strong>${escape(asset.name)}</strong><small>${escape(asset.description)}</small><small>v${asset.versionIds.length}${capabilities ? ` · ${escape(capabilities)}` : ''}</small></span><button data-do="edit-prepared" data-id="${escape(asset.id)}" title="从 3d-generate 导出的 JSON 创建新版本">导入编辑结果</button></div>`;
    }).join('') : '<div class="cg-empty">还没有准备角色或道具。</div>';
    const select = this.el<HTMLSelectElement>('motion-asset');
    const previous = select.value;
    select.innerHTML = '<option value="">选择角色或道具</option>' + (preparation?.assets ?? []).map(asset => `<option value="${escape(asset.id)}">${asset.kind === 'actor' ? '角色' : '道具'} · ${escape(asset.name)}</option>`).join('');
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
    const motions = preparation?.motions ?? [];
    if (motions.length) this.el('preparation').insertAdjacentHTML('beforeend', `<div class="cg-prepared-motions"><small>已准备动作</small>${motions.map(motion => `<span>${escape(motion.name)} · ${seconds(motion.naturalDuration)} 秒${motion.loop ? ' · 循环' : ''}</span>`).join('')}</div>`);
  }

  private renderTimeline(): void {
    const bundle = this.bundle;
    if (!bundle) { this.el('tracks').innerHTML = '<div class="cg-timeline-empty">编译后，镜头和连续角色动作在这里对齐。</div>'; this.text('timeline-count', ''); return; }
    const duration = Math.max(bundle.duration, 0.01);
    this.el('tracks').innerHTML = `<div class="cg-track"><label>CAMERA</label><div class="cg-track-lane">${bundle.shots.map((shot, index) => `<button data-do="shot" data-id="${escape(shot.id)}" class="cg-track-shot ${shot.id === this.selectedShot ? 'selected' : ''}" style="left:${shot.start / duration * 100}%;width:${(shot.end - shot.start) / duration * 100}%">${String(index + 1).padStart(2, '0')} ${escape(bundle.document.shots.find(value => value.id === shot.id)?.name ?? shot.id)}</button>`).join('')}</div></div>` + bundle.bindings.map(binding => `<div class="cg-track"><label>${escape(bundle.document.entities.find(entity => entity.id === binding.entityId)?.name ?? binding.entityId)}</label><div class="cg-track-lane">${bundle.actions.filter(action => action.entityId === binding.entityId).map(action => `<span class="cg-track-action cg-action-${escape(action.type)}" style="left:${action.start / duration * 100}%;width:${Math.max(0.4, (action.end - action.start) / duration * 100)}%" title="${escape(action.id)} · ${seconds(action.start)}–${seconds(action.end)}s">${escape(actionName[action.type])}</span>`).join('')}</div></div>`).join('');
    this.text('timeline-count', `${bundle.actions.length} ACTIONS`);
    this.el<HTMLInputElement>('seek').max = String(bundle.duration);
  }

  private syncButtons(): void {
    const hasDoc = !!this.project?.document.shots.length;
    const allowed: Record<string, boolean> = { plan: !!this.runtime, demo: !!this.runtime, load: !!this.runtime, import: !!this.runtime, 'open-3d-editor': !!this.runtime, 'prepare-asset': !!this.runtime, 'prepare-motion': !!this.project?.preparation?.assets.length, 'sync-map': this.mapSyncState === 'changed', manual: !!this.runtime, paths: !!this.bundle && !!this.project, mark: !!this.runtime, 'reset-view': !!this.runtime, refine: hasDoc && !!(this.selectedBehavior || this.selectedShot), compile: hasDoc, confirm: this.current && !!this.project?.candidate?.validation.valid && this.project.candidate.stage !== 'performance' && !this.manual && !this.marking && !this.pathEditing, export: !!this.project?.confirmed, play: !!this.bundle, start: !!this.bundle, 'lock-camera': hasDoc && !!this.selectedShot, 'lock-duration': hasDoc && !!this.selectedShot, 'lock-point': hasDoc && !!this.selectedPoint, 'lock-time': hasDoc && this.el<HTMLSelectElement>('lock-target').value.startsWith('action:'), 'remove-constraint': !!this.project };
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button[data-do]')) {
      const action = button.dataset.do!;
      if (action !== 'close') button.disabled = this.busy || allowed[action] === false;
    }
    this.el<HTMLInputElement>('seek').disabled = !this.bundle || this.busy;
    this.root.querySelectorAll<HTMLButtonElement>('[data-do="play"]').forEach(button => { button.textContent = this.playing ? 'Ⅱ' : '▶'; button.setAttribute('aria-label', this.playing ? '暂停' : '播放'); });
    this.root.querySelectorAll('[data-do="manual"]').forEach(button => button.classList.toggle('active', this.manual));
    this.root.querySelectorAll('[data-do="paths"]').forEach(button => button.classList.toggle('active', this.pathEditing));
    const candidate = this.project?.candidate;
    const stages: Record<string, boolean> = { document: hasDoc, compile: !!candidate, validate: !!candidate?.validation.valid && this.current, preview: this.current, confirm: !!this.project?.confirmed && this.project.confirmed.id === this.bundle?.id };
    for (const element of this.root.querySelectorAll<HTMLElement>('[data-phase]')) element.classList.toggle('complete', stages[element.dataset.phase!] ?? false);
    this.text('revision', this.project ? `文档 r${this.project.document.revision}${this.bundle ? this.current ? ' · 当前预览' : ' · 预览为先前版本' : ''}` : this.bundle ? '导入演出 · 只读预览' : '未生成');
    this.renderMapSync();
  }

  private get worldMap(): EditableMap { return this.project?.mapSnapshot ?? this.bundle?.map ?? this.options.map; }
  private renderWorld(): void {
    this.el('world-semantics').innerHTML = renderWorldInspector(buildWorldSemanticIndex(this.worldMap), this.el<HTMLInputElement>('world-filter').value);
  }

  private get mapSyncState(): 'none' | 'different-map' | 'changed' | 'current' {
    if (!this.project) return 'none';
    if (this.project.mapSnapshot.id !== this.options.map.id) return 'different-map';
    return stableHash({ map: this.project.mapSnapshot, scheme: this.project.schemeSnapshot }) === stableHash({ map: this.options.map, scheme: this.options.scheme }) ? 'current' : 'changed';
  }

  private renderMapSync(): void {
    const state = this.mapSyncState;
    const container = this.el('map-sync');
    container.classList.toggle('cg-map-sync-changed', state === 'changed');
    container.classList.toggle('cg-map-sync-blocked', state === 'different-map');
    this.text('map-sync-text', state === 'changed' ? '检测到 WorldForge 地图有修改' : state === 'current' ? 'CG 已使用当前地图版本' : state === 'different-map' ? '该 CG 属于另一张地图' : '打开项目后检查地图版本');
  }

  private loop = (): void => {
    if (this.closed) return;
    const now = performance.now();
    if (this.playing && this.bundle) { this.time = Math.min(this.bundle.duration, this.time + Math.min(0.1, (now - this.lastFrame) / 1000)); if (this.time >= this.bundle.duration) { this.playing = false; this.syncButtons(); } }
    this.lastFrame = now;
    this.draw();
    this.frameId = requestAnimationFrame(this.loop);
  };

  private draw(): void {
    try {
      const frame = this.runtime?.sample(this.time);
      this.el<HTMLInputElement>('seek').value = String(this.time);
      this.text('time', `${seconds(this.time)} / ${seconds(this.bundle?.duration ?? 0)}`);
      if (frame && this.bundle) {
        const shot = this.bundle.document.shots.find(value => value.id === frame.shotId);
        this.text('view-label', this.manual ? '自由机位 · 人工摆放' : shot?.name ?? '演出预览');
        this.text('subtitle', shot?.subtitle ?? '');
        this.root.dataset.time = seconds(this.time);
        this.root.dataset.shot = frame.shotId;
        this.root.dataset.compileId = this.bundle.id;
        const observationKey = `${this.bundle.id}:${this.time.toFixed(2)}:${this.el('view').clientWidth}:${this.el('view').clientHeight}`;
        if (observationKey !== this.viewObservationKey) {
          this.viewObservationKey = observationKey;
          const observation = inspectCgView(this.bundle, this.time, Math.max(0.1, this.el('view').clientWidth / Math.max(1, this.el('view').clientHeight)));
          this.el('view-semantics').innerHTML = observation.items.slice(0, 8).map(item => `<div><strong>${escape(item.name)}</strong><small>${item.screenRegion === 'left' ? '画面左侧' : item.screenRegion === 'right' ? '画面右侧' : '画面中央'} · 覆盖 ${(item.coverage * 100).toFixed(1)}% · 可见 ${(item.visibleFraction * 100).toFixed(0)}%${item.occludedBy.length ? ` · 遮挡 ${escape(item.occludedBy.join(', '))}` : ''}</small></div>`).join('') || '<p>当前机位中没有可确认的地图物体。</p>';
        }
      }
      this.text('view-hint', this.marking ? '点击场景表面记录精确世界坐标' : this.pathEditing ? '动线视图 · 单击选线 · 双击编辑或加点 · Esc 退出点编辑' : this.manual || !this.bundle ? '拖动旋转 · 右键平移 · 滚轮缩放' : '演出机位 · 可随时暂停或拖动时间轴');
    } catch (error) { this.playing = false; this.status(`预览失败：${this.message(error)}`, true); }
  }

  private async commitPathEdit(point: CgEditablePathPoint): Promise<void> {
    await this.run('正在锁定路线控制点并重新编译…', async () => {
      if (!this.project) throw new Error('请先打开可编辑项目。');
      const operations: CgPatchOperation[] = [];
      if (point.kind === 'camera') {
        for (const constraint of this.document?.constraints.filter(value => value.type === 'camera-path' && value.targetId === point.targetId) ?? []) operations.push({ type: 'constraint.remove', id: constraint.id });
        for (const [index, position] of point.path.entries()) {
          const existingId = point.pointIds[index];
          const anchorId = existingId?.startsWith('user-') ? existingId : `user-camera-path-${point.targetId}-${index}`;
          operations.push(
            { type: 'anchor.upsert', anchor: { id: anchorId, name: `摄影机轨迹 ${index + 1}`, kind: 'point', position, space: 'world' } },
            { type: 'constraint.upsert', constraint: { id: `camera-path-${point.targetId}-${index}`, source: 'user', strength: 'hard', type: 'camera-path', targetId: point.targetId, anchorId, order: index } }
          );
        }
      } else {
        const indices = point.operation === 'insert' ? point.path.map((_, index) => index).slice(1) : [point.index];
        if (point.operation === 'insert') for (const constraint of this.document?.constraints.filter(value => ['action-route', 'action-target'].includes(value.type) && value.targetId === point.targetId) ?? []) operations.push({ type: 'constraint.remove', id: constraint.id });
        for (const index of indices) {
          const isEnd = index === point.count - 1;
          const existingId = point.pointIds[index];
          const anchorId = existingId?.startsWith('user-') ? existingId : `user-actor-route-${point.targetId}-${isEnd ? 'end' : index}`;
          const existingConstraint = this.document?.constraints.find(value => value.targetId === point.targetId && value.anchorId === existingId && value.type === (isEnd ? 'action-target' : 'action-route'));
          const constraintId = existingConstraint?.id ?? (isEnd ? `route-target-${point.targetId}` : `route-via-${point.targetId}-${anchorId}`);
          operations.push(
            { type: 'anchor.upsert', anchor: { id: anchorId, name: isEnd ? '用户指定移动终点' : `用户指定走位点 ${index + 1}`, kind: 'point', position: point.path[index], space: 'world' } },
            { type: 'constraint.upsert', constraint: { id: constraintId, source: 'user', strength: 'hard', type: isEnd ? 'action-target' : 'action-route', targetId: point.targetId, anchorId, ...(isEnd ? {} : { order: index }) } }
          );
        }
      }
      await this.present(await this.request<CgProject>(`/projects/${this.project.id}/patch`, { revision: this.project.revision, operations }));
      await this.compile();
      this.pathEditing = true;
      this.runtime?.setPathEditing(true, next => void this.commitPathEdit(next));
    });
  }

  private async refreshProjects(): Promise<void> {
    try {
      const result = await this.request<{ projects: CgProjectSummary[] }>('/projects');
      if (this.closed) return;
      this.el('projects').innerHTML = '<option value="">新建 · 当前地图</option>' + result.projects.map(project => `<option value="${escape(project.id)}">${project.confirmed ? '✓ ' : ''}${escape(project.title)}</option>`).join('');
      if (this.project) this.el<HTMLSelectElement>('projects').value = this.project.id;
    } catch (error) { this.status(`项目服务未连接：${this.message(error)}`, true); }
  }

  private async importBundle(): Promise<void> {
    const file = this.el<HTMLInputElement>('file').files?.[0];
    if (!file) return;
    await this.run('正在载入演出包…', async () => {
      if (file.size > 64 * 1024 * 1024) throw new Error('演出包超过 64 MB。');
      const bundle = JSON.parse(await file.text()) as CompiledCG;
      if (bundle.schemaVersion !== 1 || !bundle.document || !bundle.map || !Array.isArray(bundle.bindings) || !Array.isArray(bundle.shots) || !Array.isArray(bundle.actions) || !bundle.resources || !Number.isFinite(bundle.duration) || bundle.duration <= 0 || bundle.duration > 3600 || !bundle.validation?.valid) throw new Error('请选择 CGCreator 导出的、验证通过的演出 JSON。');
      await this.runtime!.load(bundle);
      if (this.closed) return;
      this.bundle = bundle;
      this.project = null;
      this.selectedShot = bundle.shots[0]?.id ?? '';
      this.time = 0;
      this.manual = false;
      this.text('source', bundle.map.name);
      this.renderDocument();
      this.status('演出包已载入，可离线播放与拖动回看。需要继续编辑时，请打开本地保存的项目。');
    });
    this.el<HTMLInputElement>('file').value = '';
  }

  private async importPreparedModel(): Promise<void> {
    const input = this.el<HTMLInputElement>('prepared-file');
    const file = input.files?.[0], assetId = this.pendingPreparedAssetId;
    input.value = '';
    this.pendingPreparedAssetId = '';
    if (!file || !assetId) return;
    await this.run('正在保存编辑后的模型版本…', async () => {
      if (!this.project) throw new Error('请先打开一个 CG 项目。');
      if (file.size > 24 * 1024 * 1024) throw new Error('模型 JSON 超过 24 MB。');
      const modelJson = JSON.parse(await file.text()) as unknown;
      const asset = this.project.preparation?.assets.find(item => item.id === assetId);
      if (!asset) throw new Error('准备资源不存在。');
      await this.present(await this.request<CgProject>(`/projects/${this.project.id}/save-prepared-version`, {
        revision: this.project.revision, assetId, modelJson, description: asset.description
      }), false);
      this.status('已保存为新的模型版本。相关演出需要重新编译和验证；已确认版本仍可回放。');
    });
  }

  private download(value: unknown, name: string): void {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = name.replace(/[\\/:*?"<>|]/g, '-'); link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    cancelAnimationFrame(this.frameId);
    clearInterval(this.progressId);
    this.resize?.disconnect();
    this.runtime?.dispose();
    this.root.remove();
    this.options.onClose?.();
  }
}
