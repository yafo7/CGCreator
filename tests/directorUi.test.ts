import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const editor = readFileSync(new URL('../src/client/mapEditor.ts', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/server/mapHttp.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('director editor UI', () => {
  it('offers CG as a third workspace backed by the current map', () => {
    expect(editor).toContain("type EditorStage = 'map' | 'render' | 'director'");
    expect(editor.match(/<button data-stage="director"[^>]*>([^<]+)<\/button>/)?.[1]).toBe('CG 导演');
    expect(editor).toContain('id="director-inspector"');
  });

  it('submits the short brief to the map-scoped director endpoint', () => {
    expect(editor).toContain('/director/plan`');
    expect(editor).toContain('一句话生成 CG 策划');
    expect(server).toContain("parts[4] === 'director' && parts[5] === 'plan'");
    expect(server).toContain('normalizeDirectorReferences(body.references)');
  });

  it('styles shot cards and future reference requirements', () => {
    expect(styles).toContain('.director-shot-card');
    expect(styles).toContain('.director-reference-needs');
  });
});
