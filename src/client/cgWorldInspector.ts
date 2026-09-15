import type { WorldSemanticIndex } from '../shared/cgWorldSemantics';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const position = (p: number[]) => p.map(n => Number(n.toFixed(3))).join(', ');
const kindNames: Record<string, string> = { 'design-group': '功能区域', 'ecology-region': '生态区域', zone: '视觉区域', guide: '路径', focus: '焦点', viewpoint: '规划视点', water: '水体', grass: '草地', object: '对象', seam: '接缝' };
const precisionNames = { 'source-boundary': '原始边界', 'sampled-curve': '曲线采样范围', 'object-envelope': '对象包络 · 非原始区域边界', 'density-envelope': '密度包络 · 内部可能无草', 'terrain-mask': '海域范围 · 实际水面由地形裁切' };

export function renderWorldInspector(index: WorldSemanticIndex, filter = ''): string {
  const q = filter.trim().toLocaleLowerCase();
  const entities = index.entities.filter(e => e.kind !== 'model-part' && (!q || `${e.id} ${e.name} ${e.tags.join(' ')} ${e.description ?? ''}`.toLocaleLowerCase().includes(q)))
    .sort((a, b) => Number(a.kind === 'object') - Number(b.kind === 'object') || a.id.localeCompare(b.id));
  return `<p>${escape(index.sceneIntent || '地图未提供整体设计意图。')}</p>
    <div class="cg-semantic-summary"><span>${index.completeness.sourceRegionCount} 个明确区域</span><span>${index.completeness.inferredRegionCount} 个推导范围</span><span>${index.completeness.guideCount} 条路径</span></div>
    <p class="cg-help">当前地图 v${index.mapVersion} · Y 向上 · X/Z 为地面坐标（米）。代表点不等于入口或可行走点。</p>
    ${index.issues.length ? `<details><summary>${index.issues.length} 项语义提示</summary>${index.issues.map(i => `<p>${escape(i.message)} <small>${escape(i.entityIds.join(', '))}</small></p>`).join('')}</details>` : ''}
    <p>${entities.length} 个匹配项</p>
    ${entities.map(e => `<details class="cg-world-entry"><summary>${escape(e.name)} · ${escape(kindNames[e.kind] ?? e.kind)}</summary>
      <small>${escape(e.id)}</small>
      <p>${e.worldPosition ? `世界位置 [${position(e.worldPosition)}]` : '世界位置未知'}</p>
      ${e.spatial ? `<p>X：${position([e.spatial.bounds.min[0]])} ～ ${position([e.spatial.bounds.max[0]])}；Z：${position([e.spatial.bounds.min[1]])} ～ ${position([e.spatial.bounds.max[1]])}</p><small>${precisionNames[e.spatial.precision]}</small><pre>${escape(JSON.stringify(e.spatial.shape, null, 2))}</pre>` : ''}
      <p>${escape(e.description ?? e.tags.join(', '))}</p>
      <small>来源 ${escape(e.source.field)} · ${escape(e.source.confidence)}</small>
      ${index.relations.filter(r => r.from === e.id || r.to === e.id).map(r => `<small>${escape(r.kind)}：${escape(r.from)} → ${escape(r.to)}</small>`).join('')}
      ${e.spatial || e.worldPosition ? `<button data-do="world-focus" data-id="${escape(e.id)}">在地图中定位</button>` : ''}
    </details>`).join('')}`;
}
