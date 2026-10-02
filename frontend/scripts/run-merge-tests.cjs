/**
 * 把 src/merge/__tests__ 下的 node:test 用 esbuild 打成单个 CJS，
 * 注入 fake-indexeddb 全局后用 Node 内置 test runner 执行（不依赖浏览器 / jest）。
 */
const esbuild = require('esbuild');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

async function main() {
  const testDir0 = path.resolve(__dirname, '../src/merge/__tests__');
  const testOutDir = path.join(os.tmpdir(), 'gbshadowplay-tests');
  fs.rmSync(testOutDir, { recursive: true, force: true });
  const entries = fs
    .readdirSync(testDir0)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => path.join(testDir0, name));
  await esbuild.build({
    entryPoints: entries,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outdir: testOutDir,
    sourcemap: false,
    logLevel: 'warning',
  });
  const bundles = fs
    .readdirSync(testOutDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(testOutDir, name));
  const result = spawnSync(process.execPath, ['--test', ...bundles], { stdio: 'inherit' });
  fs.rmSync(testOutDir, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
