import { randomUUID } from 'node:crypto';
import type { CgProject } from '../shared/cgTypes';
import type { CgGenerationRun, CgArtifactRef } from '../shared/cgRunTypes';
import type { ValidationDiagnostic } from '../shared/cgAgentTypes';
import { buildTimelineComposition } from '../shared/cgTimelineTypes';
import { stableHash } from '../shared/cgValidation';
import { CgArtifactStore, type CreateArtifactInput } from './cgArtifactStore';
import { CgRunStore } from './cgRunStore';
import { assertTaskCanStart, createCgTaskGraph, downstreamTaskIds } from './cgTaskGraph';
import { CgHttpError } from './cgStore';
import { CgWorldAgent } from './cgWorldAgent';
import { CgDirectorAgent } from './cgDirectorAgent';
import { CgProductionPlanningAgent } from './cgProductionPlanningAgent';
import { CgPerformanceAgent } from './cgPerformanceAgent';
import { CgCameraAgent } from './cgCameraAgent';
import { CgValidatorAgent } from './cgValidatorAgent';
import type { CgService } from './cgService';

export interface CgGenerationResult { run: CgGenerationRun; project: CgProject }

/** Durable coordinator. Agents author typed plans; only CgService's existing
 * compiler/resource adapters are allowed to mutate a project. */
export class CgOrchestrator {
  readonly runs: CgRunStore;
  readonly artifacts: CgArtifactStore;
  private readonly active = new Set<string>();
  private readonly world = new CgWorldAgent();
  private readonly director = new CgDirectorAgent();
  private readonly production = new CgProductionPlanningAgent();
  private readonly performance = new CgPerformanceAgent();
  private readonly camera = new CgCameraAgent();
  private readonly validator = new CgValidatorAgent();

  constructor(private readonly service: CgService) {
    this.runs = new CgRunStore(service.store.rootDir);
    this.artifacts = new CgArtifactStore(service.store.rootDir);
  }

  async start(projectId: string, revision: number, prompt: string, demo = false): Promise<CgGenerationResult> {
    const project = await this.service.store.read(projectId);
    if (project.revision !== revision) throw new CgHttpError(409, 'revision_conflict', '项目已更新，请重新打开最新版本后重试。');
    const now = Date.now();
    const run: CgGenerationRun = {
      schemaVersion: 1, id: `run_${randomUUID()}`, projectId, projectRevision: revision,
      mapId: project.mapSnapshot.id, mapVersion: project.mapSnapshot.version, prompt, demo,
      status: 'active', phase: 'world-bootstrap', tasks: createCgTaskGraph(), artifacts: [], diagnostics: [],
      negotiationRound: 0, maxNegotiationRounds: 2, repairAttempt: 0, maxRepairAttempts: 2,
      createdAt: now, updatedAt: now
    };
    await this.runs.create(run);
    return this.execute(run.id);
  }

  async resume(runId: string): Promise<CgGenerationResult> {
    const run = await this.runs.read(runId);
    if (this.active.has(runId)) throw new CgHttpError(409, 'run_active', '这个生成 Run 仍在执行。');
    if (!['failed', 'cancelled'].includes(run.status)) throw new CgHttpError(409, 'run_not_resumable', '只有失败或已取消的 Run 可以恢复。');
    if (run.repairAttempt >= run.maxRepairAttempts) throw new CgHttpError(409, 'repair_limit_reached', '这个 Run 已达到定向修复次数上限，请根据 RepairPlan 修改输入后新建 Run。');
    const project = await this.service.store.read(run.projectId);
    await this.runs.update(runId, value => {
      value.status = 'active'; value.phase = 'world-bootstrap'; value.projectRevision = project.revision;
      value.diagnostics = []; value.negotiationRound = 0;
      for (const task of value.tasks) Object.assign(task, { status: 'pending', inputRefs: [], outputRefs: [], error: undefined, startedAt: undefined, completedAt: undefined });
    });
    return this.execute(runId);
  }

  async cancel(runId: string): Promise<CgGenerationRun> {
    return this.runs.update(runId, run => {
      if (['preview-ready', 'confirmed', 'failed'].includes(run.status)) return;
      run.status = 'cancelled'; run.phase = 'cancelled'; run.completedAt = Date.now();
      for (const task of run.tasks) if (task.status === 'pending') task.status = 'cancelled';
    });
  }

  async invalidate(projectId: string, changedTaskIds: string[]): Promise<void> {
    const [latest] = await this.runs.list(projectId);
    if (!latest || latest.status === 'active') return;
    const affected = new Set(downstreamTaskIds(latest.tasks, changedTaskIds));
    await this.runs.update(latest.id, run => {
      for (const task of run.tasks) if (affected.has(task.id)) Object.assign(task, { status: 'pending', inputRefs: [], outputRefs: [], error: undefined, startedAt: undefined, completedAt: undefined });
      run.status = 'failed'; run.phase = 'failed'; delete run.completedAt;
    });
  }

  async markConfirmed(projectId: string, compileId: string): Promise<void> {
    const candidates = (await this.runs.list(projectId)).filter(run => run.status === 'preview-ready');
    for (const candidate of candidates) {
      const compiledRefs = candidate.artifacts.filter(ref => ref.kind === 'compiled-cg');
      const matches = (await Promise.all(compiledRefs.map(ref => this.artifacts.read<{ id?: string }>(ref.id)))).some(artifact => artifact.content.id === compileId);
      if (!matches) continue;
      await this.runs.update(candidate.id, run => { run.status = 'confirmed'; run.phase = 'confirmed'; run.completedAt = Date.now(); });
      return;
    }
  }

  private async execute(runId: string): Promise<CgGenerationResult> {
    this.active.add(runId);
    let currentTask = 'world-bootstrap';
    try {
      let run = await this.runs.read(runId);
      this.assertNotCancelled(run);
      let project = await this.service.store.read(run.projectId);

      currentTask = 'world-bootstrap';
      const bootstrap = await this.task(runId, currentTask, project, [], async () => this.world.read(project));

      currentTask = 'preproduction';
      await this.startTask(runId, currentTask, [bootstrap.ref.id]);
      project = await this.service.plan(project.id, project.revision, run.prompt, run.demo);
      const preproduction = this.director.preproduction(project, run.prompt);
      const preproductionRef = await this.writeArtifact(runId, project, { kind: 'preproduction-plan', producer: 'director', inputRefs: [bootstrap.ref.id], provenance: [{ source: 'director-document', sourceId: project.document.id, hash: stableHash(project.document) }], content: preproduction });
      await this.completeTask(runId, currentTask, [preproductionRef], project.revision);

      this.assertNotCancelled(await this.runs.read(runId));
      currentTask = 'world-deep-read';
      await this.startTask(runId, 'world-deep-read', [preproductionRef.id]);
      await this.startTask(runId, 'production', [preproductionRef.id]);
      const plannedProject = structuredClone(project);
      const [worldResult, preparedProject] = await Promise.all([
        (async () => {
          try {
            const content = this.world.read(plannedProject, preproduction);
            const ref = await this.writeArtifact(runId, plannedProject, { kind: 'world-knowledge', producer: 'world', inputRefs: [preproductionRef.id], provenance: [{ source: 'worldforge', sourceId: content.mapId, hash: content.sourceHash }], content });
            await this.completeTask(runId, 'world-deep-read', [ref], plannedProject.revision);
            return { content, ref };
          } catch (error) { await this.failTask(runId, 'world-deep-read', error); throw error; }
        })(),
        (async () => {
          try {
            const next = await this.service.prepareResources(plannedProject.id, plannedProject.revision);
            const content = this.production.package(next, preproduction);
            const ref = await this.writeArtifact(runId, next, { kind: 'production-package', producer: 'production', inputRefs: [preproductionRef.id], provenance: [{ source: '3d-generate', sourceId: 'resource-package', hash: stableHash(next.resources) }], content });
            await this.completeTask(runId, 'production', [ref], next.revision);
            return { project: next, content, ref };
          } catch (error) { await this.failTask(runId, 'production', error); throw error; }
        })()
      ]);
      project = preparedProject.project;

      currentTask = 'readiness';
      const readiness = this.director.readiness(preproduction, worldResult.content, preparedProject.content);
      const readinessResult = await this.task(runId, currentTask, project, [worldResult.ref.id, preparedProject.ref.id], async () => readiness, 'readiness-gate', 'director');
      if (!readiness.ready) {
        const diagnostics: ValidationDiagnostic[] = readiness.checks.filter(check => check.status === 'blocked').map(check => ({ severity: 'error', code: 'readiness_blocked', message: `${check.requirementId}: ${check.message}`, nodeIds: [check.requirementId], owner: check.requirementId.startsWith('world:') ? 'world' : check.requirementId.startsWith('model:') || check.requirementId.startsWith('motion:') || check.requirementId.startsWith('assembly:') ? 'production' : 'director', phase: 'readiness', repairable: true }));
        await this.failWithRepair(runId, project, diagnostics);
        throw new CgHttpError(422, 'readiness_blocked', diagnostics.map(item => item.message).join('\n'));
      }

      currentTask = 'director-final';
      const finalPackage = this.director.finalize(project.document, readinessResult.ref.id, worldResult.ref.id, preparedProject.ref.id);
      const finalResult = await this.task(runId, currentTask, project, [readinessResult.ref.id], async () => finalPackage, 'director-document', 'director');

      currentTask = 'performance';
      const performance = this.performance.plan(project);
      const performanceResult = await this.task(runId, currentTask, project, [finalResult.ref.id], async () => performance.plan, 'performance-plan', 'performance');
      if (performance.plan.diagnostics.some(item => item.severity === 'error')) {
        await this.failWithRepair(runId, project, performance.plan.diagnostics);
        throw new CgHttpError(422, 'performance_invalid', performance.plan.diagnostics.map(item => item.message).join('\n'));
      }

      currentTask = 'camera';
      await this.startTask(runId, currentTask, [performanceResult.ref.id]);
      project = await this.service.prepareCameraCoverage(project.id, project.revision);
      const camera = this.camera.plan(project.document, performance.bundle);
      const cameraRef = await this.writeArtifact(runId, project, { kind: 'camera-plan', producer: 'camera', inputRefs: [performanceResult.ref.id], provenance: [{ source: 'director-document', sourceId: project.document.id, hash: stableHash(project.document.shots) }], content: camera });
      await this.completeTask(runId, currentTask, [cameraRef], project.revision);
      const cameraResult = { content: camera, ref: cameraRef };

      currentTask = 'negotiation';
      const negotiationRound = camera.stagingRequests.length ? 1 : 0;
      const negotiation = { schemaVersion: 1 as const, round: negotiationRound, maxRounds: 2, requests: camera.stagingRequests, decisions: camera.stagingRequests.map(request => ({ requestId: request.id, decision: 'rejected' as const, reason: '摄影 Agent 不能直接修改表演；保留已验证表演并要求摄影方案自行适配。' })) };
      const negotiationResult = await this.task(runId, currentTask, project, [cameraResult.ref.id, performanceResult.ref.id], async () => negotiation, 'negotiation', 'director');
      if (negotiationRound) await this.runs.update(runId, value => { value.negotiationRound = negotiationRound; });

      currentTask = 'compile';
      await this.startTask(runId, currentTask, [negotiationResult.ref.id]);
      project = await this.service.compile(project.id, project.revision);
      if (!project.candidate) throw new CgHttpError(422, 'compile_missing', '编译没有产生候选演出。');
      const compiledRef = await this.writeArtifact(runId, project, { kind: 'compiled-cg', producer: 'compiler', inputRefs: [negotiationResult.ref.id], provenance: [{ source: 'compiler', sourceId: project.candidate.id, hash: project.candidate.inputHash }], content: project.candidate });
      await this.completeTask(runId, currentTask, [compiledRef], project.revision);

      currentTask = 'validate';
      const diagnostics = this.validator.validate(project.candidate);
      const validationResult = await this.task(runId, currentTask, project, [compiledRef.id], async () => ({ schemaVersion: 1 as const, valid: !diagnostics.some(item => item.severity === 'error'), diagnostics }), 'validation-report', 'validator');
      await this.runs.update(runId, value => { value.diagnostics = structuredClone(diagnostics); });
      if (diagnostics.some(item => item.severity === 'error')) {
        await this.failWithRepair(runId, project, diagnostics, validationResult.ref.id);
        throw new CgHttpError(422, 'validation_failed', diagnostics.map(item => item.message).join('\n'));
      }

      currentTask = 'preview';
      const timeline = buildTimelineComposition(project.candidate);
      await this.task(runId, currentTask, project, [validationResult.ref.id, compiledRef.id], async () => timeline, 'timeline', 'compiler');
      run = await this.runs.update(runId, value => { value.status = 'preview-ready'; value.phase = 'preview-ready'; value.projectRevision = project.revision; value.completedAt = Date.now(); });
      this.service.progress.set(project.id, { stage: 'ready', message: '完整多 Agent 流程已通过，可以预览并确认', running: false });
      return { run, project };
    } catch (error) {
      const run = await this.runs.read(runId).catch(() => null);
      if (run?.status === 'active') await this.runs.update(runId, value => {
        value.status = 'failed'; value.phase = 'failed'; value.completedAt = Date.now();
        const task = value.tasks.find(item => item.id === currentTask);
        if (task && task.status !== 'completed') { task.status = 'failed'; task.completedAt = Date.now(); task.error = { code: error instanceof CgHttpError ? error.code : 'agent_failed', message: error instanceof Error ? error.message : String(error) }; }
      });
      throw error;
    } finally { this.active.delete(runId); }
  }

  private async task<T>(runId: string, taskId: string, project: CgProject, inputRefs: string[], work: () => Promise<T> | T, kind?: CreateArtifactInput<T>['kind'], producer?: CreateArtifactInput<T>['producer']): Promise<{ content: T; ref: CgArtifactRef }> {
    await this.startTask(runId, taskId, inputRefs);
    const content = await work();
    const task = (await this.runs.read(runId)).tasks.find(item => item.id === taskId)!;
    const ref = await this.writeArtifact(runId, project, { kind: kind ?? taskId as CreateArtifactInput<T>['kind'], producer: producer ?? task.agent, inputRefs, content });
    await this.completeTask(runId, taskId, [ref], project.revision);
    return { content, ref };
  }

  private async startTask(runId: string, taskId: string, inputRefs: string[]): Promise<void> {
    await this.runs.update(runId, run => {
      this.assertNotCancelled(run);
      const task = assertTaskCanStart(run.tasks, taskId);
      task.status = 'running'; task.attempts += 1; task.startedAt = Date.now(); task.inputRefs = [...inputRefs]; delete task.error;
      run.phase = task.phase;
      this.service.progress.set(run.projectId, { stage: task.phase, message: task.label, running: true });
    });
  }

  private async completeTask(runId: string, taskId: string, refs: CgArtifactRef[], projectRevision: number): Promise<void> {
    await this.runs.update(runId, run => {
      const task = run.tasks.find(item => item.id === taskId)!;
      task.status = 'completed'; task.completedAt = Date.now(); task.outputRefs = refs.map(ref => ref.id);
      run.artifacts.push(...refs.filter(ref => !run.artifacts.some(existing => existing.id === ref.id)));
      run.projectRevision = Math.max(run.projectRevision, projectRevision);
    });
  }

  private async failTask(runId: string, taskId: string, error: unknown): Promise<void> {
    await this.runs.update(runId, run => {
      const task = run.tasks.find(item => item.id === taskId);
      if (!task || task.status === 'completed') return;
      task.status = 'failed'; task.completedAt = Date.now();
      task.error = { code: error instanceof CgHttpError ? error.code : 'agent_failed', message: error instanceof Error ? error.message : String(error) };
    });
  }

  private async writeArtifact<T>(runId: string, project: CgProject, input: Omit<CreateArtifactInput<T>, 'runId' | 'projectId' | 'projectRevision' | 'mapId' | 'mapVersion'>): Promise<CgArtifactRef> {
    return this.artifacts.create({ ...input, runId, projectId: project.id, projectRevision: project.revision, mapId: project.mapSnapshot.id, mapVersion: project.mapSnapshot.version });
  }

  private async failWithRepair(runId: string, project: CgProject, diagnostics: ValidationDiagnostic[], inputRef?: string): Promise<void> {
    const run = await this.runs.read(runId), attempt = run.repairAttempt + 1;
    const repair = this.director.repair(diagnostics, attempt);
    const ref = await this.writeArtifact(runId, project, { kind: 'repair-plan', producer: 'director', inputRefs: inputRef ? [inputRef] : [], content: repair });
    await this.runs.update(runId, value => { value.diagnostics = structuredClone(diagnostics); value.repairAttempt = attempt; value.artifacts.push(ref); });
  }

  private assertNotCancelled(run: CgGenerationRun): void {
    if (run.status === 'cancelled') throw new CgHttpError(409, 'run_cancelled', '生成 Run 已取消。');
  }
}
