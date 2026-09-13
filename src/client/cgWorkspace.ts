import type { EditableMap } from '../shared/map';
import type { RenderScheme } from '../shared/renderScheme';
import type { CgPatchOperation, CgProject, CgProjectSummary, CgVec3, CompiledCG, DirectorDocument } from '../shared/cgTypes';
import { CgPlaybackRuntime } from './cgRuntime';
import { serverHttpBase } from './serverEndpoint';
import './cgWorkspace.css';

export interface CgWorkspaceOptions { map: EditableMap; scheme: RenderScheme | null; onClose?: () => void }

const escape = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
const seconds = (value: number): string => Number.isFinite(value) ? value.toFixed(2) : '0.00';
const movement: Record<string, string> = { static: '固定', dolly: '推镜', tracking: '跟拍', orbit: '环绕' };
const framing: Record<string, string> = { wide: '全景', medium: '中景', 'close-up': '特写', 'over-shoulder': '越肩' };
const cameraView: Record<string, string> = { front: '正面', 'front-three-quarter': '前侧 3/4', side: '侧面', 'rear-three-quarter': '后侧 3/4', rear: '背面' };
const cameraAim: Record<string, string> = { body: '全身构图', 'upper-body': '上半身构图', face: '面部对焦', eyes: '眼部对焦', interaction: '互动构图' };
const actionName: Record<string, string> = { move: '移动', face: '朝向', animate: '动作', visibility: '显隐', effect: '特效', attach: '附着', detach: '分离' };

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
  private bundle: CompiledCG | null = null;
  private selectedShot = '';
  private selectedPoint: [number, number, number] | null = null;
  private time = 0;
  private playing = false;
  private manual = false;
  private marking = false;
  private busy = false;
  private closed = false;
  private frameId = 0;
  private lastFrame = 0;
  private resize: ResizeObserver | null = null;
  private progressId = 0;
  private abort = new AbortController();

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
        <div class="cg-header-actions"><button data-do="import">导入演出</button><button data-do="export" disabled>导出已确认</button><button data-do="close" class="cg-close">返回地图 ↗</button></div>
      </header>
      <div class="cg-body">
        <aside class="cg-story"><div class="cg-panel-heading"><span>01 / 导演意图</span><span class="cg-muted">DIRECT</span></div>
          <label class="cg-label" for="cg-project-select">演出项目</label><div class="cg-project-row"><select id="cg-project-select" data-cg="projects"><option value="">新建 · 当前地图</option></select><button data-do="load" title="打开所选项目">打开</button></div>
          <label class="cg-label" for="cg-prompt">描述这一段故事</label><textarea id="cg-prompt" data-cg="prompt" rows="5" placeholder="角色走向场景中央，镜头缓缓跟随。角色停下后，切到面部特写，停留片刻。"></textarea>
          <button data-do="plan" class="cg-primary cg-full">✦ 生成导演文档</button>
          <button data-do="demo" class="cg-demo cg-full">体验内置演出 · 无需 AI 服务</button>
          <p class="cg-help">从当前地图开始。角色、道具和运镜被编译成可编辑的实时演出。</p>
          <div class="cg-panel-heading cg-divider"><span>镜头列表</span><span data-cg="shot-count" class="cg-muted">0 SHOTS</span></div>
          <div data-cg="shots" class="cg-shot-list"><div class="cg-empty">写下导演意图，或体验内置演出。镜头与动作将在这里展开。</div></div>
          <div class="cg-panel-heading cg-divider"><span>角色与资源</span><span data-cg="resource-count" class="cg-muted">0</span></div><div data-cg="entities" class="cg-entities"></div>
        </aside>
        <main class="cg-center">
          <div class="cg-view" data-cg="view"><canvas data-cg="canvas" aria-label="可交互的 3D 演出预览"></canvas>
            <div class="cg-view-top"><span class="cg-live">● REALTIME</span><span data-cg="view-label">场景预览</span><span data-cg="revision" class="cg-revision">未生成</span></div>
            <div class="cg-view-tools"><button data-do="manual" title="用鼠标旋转、平移和缩放摄影机">自由机位</button><button data-do="mark" title="在可见场景表面点击标点">＋ 场景标点</button><button data-do="reset-view">回到演出机位</button></div>
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
          <details class="cg-document"><summary>查看结构化导演文档</summary><pre data-cg="document">等待生成</pre></details>
        </aside>
      </div>
      <footer class="cg-footer"><div class="cg-pipeline"><span data-phase="document">导演文档</span><b>→</b><span data-phase="compile">Compile</span><b>→</b><span data-phase="validate">Validate</span><b>→</b><span data-phase="preview">Preview</span><b>→</b><span data-phase="confirm">Confirm</span></div><div class="cg-footer-actions"><button data-do="compile" disabled>编译并预览</button><button data-do="confirm" class="cg-primary" disabled>确认此版本</button></div></footer>
      <div data-cg="status" class="cg-status" role="status">当前地图已作为演出起点；源地图保持独立。</div><div data-cg="diagnostics" class="cg-diagnostics" hidden></div>
      <input type="file" data-cg="file" accept="application/json,.json" hidden>
    `;
    document.body.append(this.root);
    this.root.focus();
    this.text('source', this.options.map.name);
    this.root.addEventListener('click', event => { const button = (event.target as Element).closest<HTMLButtonElement>('[data-do]'); if (button && !button.disabled) void this.handle(button.dataset.do!, button); });
    this.el<HTMLInputElement>('seek').addEventListener('input', event => { this.playing = false; this.time = Number((event.target as HTMLInputElement).value); this.syncButtons(); this.draw(); });
    this.el<HTMLSelectElement>('lock-target').addEventListener('change', () => this.syncButtons());
    this.el<HTMLInputElement>('file').addEventListener('change', () => void this.importBundle());
    this.el<HTMLCanvasElement>('canvas').addEventListener('pointerdown', event => {
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
    this.root.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Escape' && this.marking) { this.marking = false; this.root.classList.remove('cg-is-marking'); this.runtime?.setManual(this.manual); } });
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
    if (action === 'close') { this.close(); return; }
    if (action === 'play') { this.manual = false; this.runtime?.setManual(false); if (this.time >= (this.bundle?.duration ?? 0)) this.time = 0; this.playing = !this.playing; this.syncButtons(); return; }
    if (action === 'start') { this.time = 0; this.playing = false; this.syncButtons(); this.draw(); return; }
    if (action === 'manual') { this.playing = false; this.manual = !this.manual; this.runtime?.setManual(this.manual); this.status(this.manual ? '自由机位：左键旋转，右键平移，滚轮缩放。摆好后点击「锁定当前机位」。' : '已回到演出摄影机。'); this.syncButtons(); this.draw(); return; }
    if (action === 'reset-view') { this.manual = false; this.runtime?.setManual(false); this.syncButtons(); this.draw(); return; }
    if (action === 'mark') { this.playing = false; this.marking = !this.marking; this.root.classList.toggle('cg-is-marking', this.marking); if (this.runtime) this.runtime.controls.enabled = this.marking ? false : this.manual || !this.bundle; this.status(this.marking ? '点击场景中的可见表面。Esc 取消标点。' : '已取消标点。'); this.syncButtons(); return; }
    if (action === 'shot') { this.selectedShot = button.dataset.id!; this.time = this.bundle?.shots.find(shot => shot.id === this.selectedShot)?.start ?? this.time; this.playing = false; this.renderDocument(); this.draw(); return; }
    if (action === 'import') { this.el<HTMLInputElement>('file').click(); return; }
    if (action === 'load') { await this.run('正在打开已保存的演出…', async () => {
      const id = this.el<HTMLSelectElement>('projects').value;
      if (!id) { await this.resetScene(this.options.map, this.options.scheme); this.project = null; this.selectedShot = ''; this.text('source', this.options.map.name); this.renderDocument(); this.status('已切换为新建项目；下一次生成将使用进入工作区时的地图快照。'); return; }
      await this.present(await this.request<CgProject>(`/projects/${encodeURIComponent(id)}`), true);
      this.status('项目已恢复。导演文档、资源和已确认版本均保存在本地。');
    }); return; }
    if (action === 'plan' || action === 'demo') { await this.run(action === 'demo' ? '正在创建内置演出…' : '正在理解剧情与地图…', async () => {
      const prompt = this.el<HTMLTextAreaElement>('prompt').value.trim();
      if (action === 'plan' && !prompt) throw new Error('请先描述剧情或导演意图。');
      if (!this.project) this.project = await this.request<CgProject>('/projects', { map: this.options.map, scheme: this.options.scheme, title: prompt.slice(0, 32) || '内置演出' });
      const project = await this.request<CgProject>(`/projects/${this.project.id}/plan`, { revision: this.project.revision, prompt: prompt || '角色走向场景中央，跟拍后切换特写。', demo: action === 'demo' });
      await this.present(project);
      await this.compile();
      await this.refreshProjects();
    }); return; }
    if (action === 'compile') { await this.run('正在编译演出…', () => this.compile()); return; }
    if (action === 'refine') { await this.run('正在精修所选镜头…', async () => {
      const prompt = this.el<HTMLTextAreaElement>('refine').value.trim();
      if (!prompt) throw new Error('请描述要修改的内容。');
      const result = await this.request<{ project: CgProject; operations: CgPatchOperation[] }>(`/projects/${this.project!.id}/refine`, { revision: this.project!.revision, prompt, targetId: this.selectedShot });
      await this.present(result.project);
      await this.compile();
      this.el<HTMLTextAreaElement>('refine').value = '';
    }); return; }
    if (action === 'confirm') { await this.run('正在确认当前预览版本…', async () => {
      const candidate = this.project!.candidate!;
      await this.present(await this.request<CgProject>(`/projects/${this.project!.id}/confirm`, { revision: this.project!.revision, compileId: candidate.id, inputHash: candidate.inputHash }));
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

  private async compile(): Promise<void> {
    if (!this.project) throw new Error('请先生成导演文档。');
    this.progressId = window.setInterval(() => {
      if (!this.project || this.closed) return;
      void this.request<{ stage: string; message: string; running: boolean }>(`/projects/${this.project.id}/progress`).then(progress => { if (progress.running && !this.closed) this.status(progress.message || progress.stage); }).catch(() => undefined);
    }, 1200);
    try {
      const next = await this.request<CgProject>(`/projects/${this.project.id}/compile`, { revision: this.project.revision });
      await this.present(next, true);
      if (next.candidate?.validation.valid) this.status(`编译与验证通过 · ${next.candidate.duration.toFixed(2)} 秒 · ${next.candidate.shots.length} 个镜头 · ${next.candidate.changedNodeIds.length} 个依赖节点更新。预览后可确认。`);
      else this.status('编译发现冲突，请查看诊断并调整。上次确认版本仍然保留。', true);
    } finally { clearInterval(this.progressId); this.progressId = 0; }
  }

  private async present(project: CgProject, activate = false): Promise<void> {
    if (this.closed) return;
    this.project = project;
    if (!project.document.shots.some(shot => shot.id === this.selectedShot)) this.selectedShot = project.document.shots[0]?.id ?? '';
    if (activate) {
      const candidate = project.candidate?.validation.valid ? project.candidate : project.confirmed;
      if (candidate && this.runtime) {
        await this.runtime.load(candidate);
        if (this.closed) return;
        this.bundle = candidate;
        this.manual = false;
        this.marking = false;
        this.root.classList.remove('cg-is-marking');
        this.time = Math.min(this.time, candidate.duration);
      } else await this.resetScene(project.mapSnapshot, project.schemeSnapshot);
    }
    this.text('source', project.mapSnapshot.name);
    this.renderDocument();
    this.draw();
  }

  private async resetScene(map: EditableMap, scheme: RenderScheme | null): Promise<void> {
    this.bundle = null;
    this.time = 0;
    this.manual = false;
    this.marking = false;
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
    const shot = doc?.shots.find(value => value.id === this.selectedShot);
    this.el('selection').innerHTML = shot ? `<span class="cg-eyebrow">SHOT ${String((doc?.shots.indexOf(shot) ?? 0) + 1).padStart(2, '0')}</span><h2>${escape(shot.name)}</h2><p>${escape(shot.purpose)}</p><div class="cg-chips"><span>${escape(movement[shot.camera.movement])}</span><span>${escape(framing[shot.camera.framing])}</span>${shot.camera.view ? `<span>${escape(cameraView[shot.camera.view])}</span>` : ''}${shot.camera.aim ? `<span>${escape(cameraAim[shot.camera.aim])}</span>` : ''}<span>${seconds(this.effectiveDuration(shot.id))} 秒</span></div>` : '<h2>让意图成为演出</h2><p>选择镜头后，可以调整景别、节奏与机位。</p>';
    if (shot) this.el<HTMLInputElement>('duration').value = String(this.effectiveDuration(shot.id));
    const oldTarget = this.el<HTMLSelectElement>('lock-target').value;
    this.el('lock-target').innerHTML = (doc?.entities.map(entity => `<option value="entity:${escape(entity.id)}">${entity.kind === 'actor' ? '角色起点' : '道具位置'} · ${escape(entity.name)}</option>`).join('') ?? '') + (doc?.actions.filter(action => action.type === 'move').map(action => `<option value="action:${escape(action.id)}">移动终点 · ${escape(doc.entities.find(entity => entity.id === action.entityId)?.name ?? action.entityId)} (${escape(action.id)})</option>`).join('') ?? '');
    if ([...this.el<HTMLSelectElement>('lock-target').options].some(option => option.value === oldTarget)) this.el<HTMLSelectElement>('lock-target').value = oldTarget;
    const names: Record<string, string> = { 'entity-position': '位置', 'action-target': '终点', 'camera-pose': '机位', 'shot-duration': '时长', 'action-time': '开始时间' };
    this.el('constraints').innerHTML = doc?.constraints.map(constraint => `<div><span>⌑ ${escape(names[constraint.type])} · ${escape(doc.shots.find(value => value.id === constraint.targetId)?.name ?? doc.entities.find(value => value.id === constraint.targetId)?.name ?? constraint.targetId)}${constraint.seconds === undefined ? '' : ` · ${seconds(constraint.seconds)}s`}</span><button data-do="remove-constraint" data-id="${escape(constraint.id)}" title="移除此人工约束" ${!this.project ? 'disabled' : ''}>×</button></div>`).join('') ?? '';
    this.text('document', doc ? JSON.stringify(doc, null, 2) : '等待生成');
    const validation = this.project?.candidate?.validation ?? this.bundle?.validation;
    this.el('diagnostics').hidden = !validation?.diagnostics.length;
    this.el('diagnostics').innerHTML = validation?.diagnostics.map(item => `<div class="${item.severity === 'error' ? 'cg-error' : ''}"><strong>${item.severity === 'error' ? '错误' : '提示'} · ${escape(item.code)}</strong> ${escape(item.message)} <small>${escape(item.nodeIds.join(', '))}</small></div>`).join('') ?? '';
    this.renderTimeline();
    this.syncButtons();
  }

  private effectiveDuration(id: string): number { const doc = this.document; return doc?.constraints.find(constraint => constraint.type === 'shot-duration' && constraint.targetId === id)?.seconds ?? doc?.shots.find(shot => shot.id === id)?.duration ?? 0; }

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
    const allowed: Record<string, boolean> = { plan: !!this.runtime, demo: !!this.runtime, load: !!this.runtime, import: !!this.runtime, manual: !!this.runtime, mark: !!this.runtime, 'reset-view': !!this.runtime, refine: hasDoc && !!this.selectedShot, compile: hasDoc, confirm: this.current && !!this.project?.candidate?.validation.valid && !this.manual && !this.marking, export: !!this.project?.confirmed, play: !!this.bundle, start: !!this.bundle, 'lock-camera': hasDoc && !!this.selectedShot, 'lock-duration': hasDoc && !!this.selectedShot, 'lock-point': hasDoc && !!this.selectedPoint, 'lock-time': hasDoc && this.el<HTMLSelectElement>('lock-target').value.startsWith('action:'), 'remove-constraint': !!this.project };
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('button[data-do]')) {
      const action = button.dataset.do!;
      if (action !== 'close') button.disabled = this.busy || allowed[action] === false;
    }
    this.el<HTMLInputElement>('seek').disabled = !this.bundle || this.busy;
    this.root.querySelectorAll<HTMLButtonElement>('[data-do="play"]').forEach(button => { button.textContent = this.playing ? 'Ⅱ' : '▶'; button.setAttribute('aria-label', this.playing ? '暂停' : '播放'); });
    this.root.querySelectorAll('[data-do="manual"]').forEach(button => button.classList.toggle('active', this.manual));
    const candidate = this.project?.candidate;
    const stages: Record<string, boolean> = { document: hasDoc, compile: !!candidate, validate: !!candidate?.validation.valid && this.current, preview: this.current, confirm: !!this.project?.confirmed && this.project.confirmed.id === this.bundle?.id };
    for (const element of this.root.querySelectorAll<HTMLElement>('[data-phase]')) element.classList.toggle('complete', stages[element.dataset.phase!] ?? false);
    this.text('revision', this.project ? `文档 r${this.project.document.revision}${this.bundle ? this.current ? ' · 当前预览' : ' · 预览为先前版本' : ''}` : this.bundle ? '导入演出 · 只读预览' : '未生成');
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
      }
      this.text('view-hint', this.marking ? '点击场景表面记录精确世界坐标' : this.manual || !this.bundle ? '拖动旋转 · 右键平移 · 滚轮缩放' : '演出机位 · 可随时暂停或拖动时间轴');
    } catch (error) { this.playing = false; this.status(`预览失败：${this.message(error)}`, true); }
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
