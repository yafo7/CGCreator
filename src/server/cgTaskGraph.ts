import type { CgAgentTask, CgRunPhase } from '../shared/cgRunTypes';

const task = (id: string, label: string, agent: CgAgentTask['agent'], phase: CgRunPhase, dependencies: string[]): CgAgentTask => ({
  id, label, agent, phase, dependencies, status: 'pending', attempts: 0, inputRefs: [], outputRefs: []
});

export function createCgTaskGraph(): CgAgentTask[] {
  return [
    task('world-bootstrap', '理解地图基础语义', 'world', 'world-bootstrap', []),
    task('preproduction', '分析剧情与制作需求', 'director', 'preproduction-planning', ['world-bootstrap']),
    task('world-deep-read', '核实演出位置与关系', 'world', 'preparing-world', ['preproduction']),
    task('production', '准备角色、道具、装配与动作', 'production', 'preparing-resources', ['preproduction']),
    task('readiness', '检查演出准备门', 'director', 'readiness-check', ['world-deep-read', 'production']),
    task('director-final', '冻结正式导演文档', 'director', 'director-finalizing', ['readiness']),
    task('performance', '求解表演时间与走位', 'performance', 'performance-planning', ['director-final']),
    task('camera', '依据表演设计镜头', 'camera', 'camera-planning', ['performance']),
    task('negotiation', '仲裁表演与摄影请求', 'director', 'negotiating', ['camera']),
    task('compile', '确定性编译', 'compiler', 'compiling', ['negotiation']),
    task('validate', '验证演出与画面', 'validator', 'validating', ['compile']),
    task('preview', '生成可编辑预览', 'compiler', 'preview-ready', ['validate'])
  ];
}

export function assertTaskCanStart(tasks: CgAgentTask[], id: string): CgAgentTask {
  const target = tasks.find(item => item.id === id);
  if (!target) throw new Error(`Unknown task: ${id}`);
  if (target.status !== 'pending' && target.status !== 'failed') throw new Error(`Task ${id} is ${target.status}.`);
  const blocked = target.dependencies.filter(dependency => tasks.find(item => item.id === dependency)?.status !== 'completed');
  if (blocked.length) throw new Error(`Task ${id} is waiting for ${blocked.join(', ')}.`);
  return target;
}

export function downstreamTaskIds(tasks: CgAgentTask[], changedIds: string[]): string[] {
  const result = new Set(changedIds), queue = [...changedIds];
  while (queue.length) {
    const id = queue.shift()!;
    for (const dependent of tasks.filter(item => item.dependencies.includes(id))) if (!result.has(dependent.id)) { result.add(dependent.id); queue.push(dependent.id); }
  }
  return [...result];
}
