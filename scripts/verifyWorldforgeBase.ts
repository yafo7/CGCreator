import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = JSON.parse(readFileSync(new URL('../worldforge-base.json', import.meta.url), 'utf8')) as {
  repository: string;
  branch: string;
  commit: string;
  integrationFiles: Record<string, string>;
};
const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const paths = (output: string): string[] => output.split('\0').filter(Boolean);

// Compare the current checkout (including uncommitted work) to an immutable upstream baseline.
// This is an explicit maintenance check; production installs do not need Git.
try {
  if (!/^[a-f0-9]{40}$/.test(baseline.commit)) throw new Error('WorldForge baseline must be a full commit hash.');
  git('merge-base', '--is-ancestor', baseline.commit, 'HEAD');
  const upstreamFiles = new Set(paths(git('ls-tree', '-r', '--name-only', '-z', baseline.commit)));
  const changed = paths(git('diff', '--no-renames', '--name-only', '-z', baseline.commit, '--'));
  const untracked = paths(git('ls-files', '--others', '--exclude-standard', '-z'));
  const allowedAddition = (file: string): boolean => (
    /^src\/(client|server|shared)\/cg[^/]+$/.test(file)
    || /^tests\/cg[^/]+\.test\.ts$/.test(file)
    || /^skills\/cg-[^/]+\//.test(file)
    || /^docs\/cgcreator-[^/]+\.md$/.test(file)
    || file === 'worldforge-base.json'
    || file === 'scripts/verifyWorldforgeBase.ts'
  );
  const unexpected = [...new Set([...changed, ...untracked])].filter((file) => (
    upstreamFiles.has(file) ? !Object.hasOwn(baseline.integrationFiles, file) : !allowedAddition(file)
  ));
  if (unexpected.length) throw new Error(`Unexpected changes outside CG integration boundaries:\n${unexpected.join('\n')}`);
  const integrations = changed.filter((file) => upstreamFiles.has(file));
  console.log(`WorldForge ${baseline.branch} baseline: ${baseline.commit}`);
  console.log(`Verified ${upstreamFiles.size} upstream files; ${integrations.length} documented integration files differ.`);
  for (const file of integrations) console.log(`  ${file}: ${baseline.integrationFiles[file]}`);
  console.log('All other upstream files match. Additional files are confined to CGCreator modules and maintenance metadata.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
