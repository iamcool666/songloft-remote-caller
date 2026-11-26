import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = process.env.GITHUB_REPOSITORY;
if (!repository) throw new Error('GITHUB_REPOSITORY is required');
if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Release requires main');

function run(command, args, cwd = root, extraEnv = {}) {
  execFileSync(command, args, {
    cwd, stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
}
function capture(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}
function readJSON(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function writeJSON(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); }
function isVersionCommit(author, subject) {
  return author === 'github-actions[bot]' && subject.startsWith('chore(release): bump to v');
}
function hasPackageChanges(paths) {
  return paths.some(path =>
    !/^docs\//.test(path) &&
    !/\.mdx?$/i.test(path) &&
    path !== 'plugin.json' &&
    path !== 'manifest.json' &&
    path !== 'scripts/release-plugin.mjs' &&
    path !== 'scripts/gen-icons.mjs' &&
    !path.startsWith('.github/workflows/'));
}
function nextVersion(current) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current || '');
  if (!match) throw new Error(`Unsupported Remote Caller version: ${current}`);
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3]) + 1}`;
}
function releaseSource(body = '') {
  return /^Source commit: ([a-f0-9]{40})$/m.exec(body)?.[1];
}

const sharpDir = join(tmpdir(), 'remote-caller-sharp');
mkdirSync(sharpDir, { recursive: true });

function build(snapshot, source, version) {
  const pluginPath = join(snapshot, 'plugin.json');
  const plugin = readJSON(pluginPath);
  plugin.version = version;
  plugin.homepage = `https://github.com/${repository}`;
  plugin.updateUrl = `https://raw.githubusercontent.com/${repository}/main/manifest.json`;
  delete plugin.download_url;
  plugin.releaseSource = source;
  writeJSON(pluginPath, plugin);

  const packagePath = join(snapshot, 'package.json');
  const pkg = readJSON(packagePath);
  pkg.version = version;
  writeJSON(packagePath, pkg);

  run('npm', ['install', '--no-package-lock', '--no-audit', '--no-fund'], snapshot);
  run('npm', ['install', '--prefix', sharpDir, '--no-audit', '--no-fund', 'sharp'], snapshot);
  run('node', ['scripts/gen-icons.mjs'], snapshot, { SHARP_DIR: sharpDir });
  run('npm', ['run', 'build'], snapshot);

  const zipPath = join(snapshot, 'dist', `${plugin.entryPath}.jsplugin.zip`);
  if (!existsSync(zipPath)) throw new Error(`Build did not produce ${zipPath}`);

  const buildMetaPath = join(snapshot, 'dist', '_build', 'plugin.json');
  if (existsSync(buildMetaPath)) {
    const built = readJSON(buildMetaPath);
    if (built.entryHash) plugin.entryHash = built.entryHash;
    if (built.zipHash) plugin.zipHash = built.zipHash;
  }
  if (!plugin.entryHash) {
    const entryPath = join(snapshot, 'dist', 'main.js');
    if (existsSync(entryPath)) plugin.entryHash = createHash('sha256').update(readFileSync(entryPath)).digest('hex');
  }
  if (!plugin.zipHash) {
    plugin.zipHash = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  }
  writeJSON(pluginPath, plugin);

  // validate requires the freshly generated hashes to be present in plugin.json.
  run('npm', ['run', 'validate'], snapshot);
  return { plugin, zipPath };
}

function markPublished(source, version, publishedPlugin) {
  for (let attempt = 0; attempt < 3; attempt++) {
    run('git', ['fetch', 'origin', 'main'], root);
    run('git', ['checkout', '--detach', 'origin/main'], root);

    const pluginPath = join(root, 'plugin.json');
    const current = readJSON(pluginPath);
    Object.assign(current, {
      version,
      releaseSource: source,
      homepage: `https://github.com/${repository}`,
      updateUrl: `https://raw.githubusercontent.com/${repository}/main/manifest.json`,
      entryHash: publishedPlugin.entryHash || current.entryHash || '',
      zipHash: publishedPlugin.zipHash || current.zipHash || '',
    });
    delete current.download_url;
    writeJSON(pluginPath, current);

    const packagePath = join(root, 'package.json');
    const pkg = readJSON(packagePath);
    pkg.version = version;
    writeJSON(packagePath, pkg);

    const updateManifest = {
      version,
      download_url: `https://github.com/${repository}/releases/download/v${version}/${current.entryPath}.jsplugin.zip`,
    };
    writeJSON(join(root, 'manifest.json'), updateManifest);

    run('git', ['add', 'plugin.json', 'package.json', 'manifest.json'], root);
    run('git', ['commit', '-m', `chore(release): bump to v${version}\n\nSource commit: ${source}`], root);
    try {
      run('git', ['push', 'origin', 'HEAD:main'], root);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

function listReleases() {
  return JSON.parse(capture('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`])).flat();
}
function releaseExistsForVersion(releases, version) {
  return releases.some(item => item.tag_name === `v${version}` && !item.draft && !item.prerelease);
}
function publish(source, version, snapshot) {
  const { plugin, zipPath } = build(snapshot, source, version);
  run('git', ['add', 'plugin.json', 'package.json'], snapshot);
  run('git', ['-c', 'user.name=github-actions[bot]', '-c',
    'user.email=github-actions[bot]@users.noreply.github.com',
    'commit', '-m', `chore(release): bump to v${version}\n\nSource commit: ${source}`], snapshot);

  const tag = `v${version}`;
  run('git', ['push', 'origin', `HEAD:refs/tags/${tag}`], snapshot);
  run('gh', ['release', 'create', tag, zipPath,
    '--repo', repository, '--verify-tag', '--latest', '--title', tag,
    '--notes', `自动构建的 Remote Caller 插件 ${tag}\n\nSource commit: ${source}`], snapshot);
  markPublished(source, version, plugin);
}

run('git', ['config', 'user.name', 'github-actions[bot]']);
run('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
run('git', ['fetch', 'origin', 'main', '--tags']);

let mainPlugin = JSON.parse(capture('git', ['show', 'origin/main:plugin.json']));
const baseVersion = mainPlugin.version;
const baseSource = mainPlugin.releaseSource;
const releases = listReleases();

// 首次接管：先为同步进来的上游基线版本补发 Fork 自己的 Release。
if (!releaseExistsForVersion(releases, baseVersion)) {
  if (!/^[a-f0-9]{40}$/.test(baseSource || '')) {
    throw new Error('Missing releaseSource; sync workflow must initialize the upstream baseline first');
  }
  run('git', ['merge-base', '--is-ancestor', baseSource, 'origin/main']);
  const snapshot = join(tmpdir(), `remote-caller-bootstrap-${baseSource}`);
  run('git', ['worktree', 'add', '--detach', snapshot, baseSource]);
  try {
    publish(baseSource, baseVersion, snapshot);
  } finally {
    run('git', ['worktree', 'remove', '--force', snapshot]);
  }
}

while (true) {
  run('git', ['fetch', 'origin', 'main', '--tags']);
  mainPlugin = JSON.parse(capture('git', ['show', 'origin/main:plugin.json']));
  const base = mainPlugin.releaseSource || capture('git', ['rev-parse', `v${mainPlugin.version}^{commit}`]);
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error('Invalid release source');
  run('git', ['merge-base', '--is-ancestor', base, 'origin/main']);

  const pending = capture('git', ['log', '--first-parent', '--reverse',
    '--format=%H%x09%an%x09%s', `${base}..origin/main`])
    .split('\n').filter(Boolean).map(line => line.split('\t'))
    .filter(([source, author, subject]) => !isVersionCommit(author, subject) &&
      hasPackageChanges(capture('git', ['diff', '--name-only', '--no-renames',
        `${source}^`, source]).split('\n').filter(Boolean)));

  if (!pending.length) break;
  const [source] = pending[0];
  const existing = listReleases().find(item =>
    !item.draft && !item.prerelease && releaseSource(item.body) === source);
  if (existing) {
    const existingPlugin = JSON.parse(capture('git', ['show', `${existing.tag_name}:plugin.json`]));
    markPublished(source, existingPlugin.version, existingPlugin);
    continue;
  }

  const version = nextVersion(mainPlugin.version);
  const snapshot = join(tmpdir(), `remote-caller-${source}`);
  run('git', ['worktree', 'add', '--detach', snapshot, source]);
  try {
    publish(source, version, snapshot);
  } finally {
    run('git', ['worktree', 'remove', '--force', snapshot]);
  }
}

console.log('Remote Caller release queue is up to date.');
