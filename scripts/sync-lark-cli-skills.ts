import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const containerDir = path.join(projectRoot, 'container');
const skillsDir = path.join(containerDir, 'skills');
const sourceUrl = 'https://github.com/larksuite/cli';
const overrideMarker = '## NanoClaw 身份隔离覆盖规则';

function fail(message: string): never {
  throw new Error(`sync-lark-cli-skills: ${message}`);
}

function readPinnedVersion(): string {
  const tools = JSON.parse(fs.readFileSync(path.join(containerDir, 'cli-tools.json'), 'utf8')) as Array<{
    name: string;
    version: string;
  }>;
  const cli = tools.find((tool) => tool.name === '@larksuite/cli');
  if (!cli) fail('@larksuite/cli is missing from container/cli-tools.json');
  return cli.version;
}

function parseSourceArg(): string | undefined {
  const args = process.argv.slice(2);
  if (args.length === 0) return undefined;
  if (args.length !== 2 || args[0] !== '--source') {
    fail('usage: pnpm exec tsx scripts/sync-lark-cli-skills.ts [--source <larksuite-cli-checkout>]');
  }
  return path.resolve(args[1]);
}

function checkoutSource(version: string): { root: string; cleanup?: string } {
  const supplied = parseSourceArg();
  if (supplied) return { root: supplied };

  const cleanup = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-lark-cli-'));
  execFileSync('git', ['clone', '--depth', '1', '--branch', `v${version}`, sourceUrl, cleanup], {
    stdio: 'inherit',
  });
  return { root: cleanup, cleanup };
}

function injectNanoClawOverride(sharedSkillPath: string): void {
  const official = fs.readFileSync(sharedSkillPath, 'utf8');
  if (official.includes(overrideMarker)) fail('upstream lark-shared unexpectedly contains the NanoClaw override');

  const insertionPoint = '\n## 配置初始化\n';
  if (!official.includes(insertionPoint)) fail('cannot find the lark-shared override insertion point');

  const override = fs.readFileSync(path.join(containerDir, 'lark-cli-shared-override.md'), 'utf8').trim();
  fs.writeFileSync(sharedSkillPath, official.replace(insertionPoint, `\n${override}\n${insertionPoint}`));
}

function main(): void {
  const version = readPinnedVersion();
  const checkout = checkoutSource(version);

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(checkout.root, 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
    };
    if (pkg.name !== '@larksuite/cli' || pkg.version !== version) {
      fail(`source is ${pkg.name ?? 'unknown'}@${pkg.version ?? 'unknown'}, expected @larksuite/cli@${version}`);
    }

    const sourceSkillsDir = path.join(checkout.root, 'skills');
    const officialSkills = fs
      .readdirSync(sourceSkillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    if (officialSkills.length === 0 || officialSkills.some((name) => !name.startsWith('lark-'))) {
      fail('source skills directory is empty or contains a non-lark skill');
    }
    if (officialSkills.includes('lark-cli-user')) fail('upstream conflicts with the NanoClaw lark-cli-user skill');

    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('lark-') && entry.name !== 'lark-cli-user') {
        fs.rmSync(path.join(skillsDir, entry.name), { recursive: true, force: true });
      }
    }
    for (const skill of officialSkills) {
      fs.cpSync(path.join(sourceSkillsDir, skill), path.join(skillsDir, skill), { recursive: true });
    }

    injectNanoClawOverride(path.join(skillsDir, 'lark-shared', 'SKILL.md'));

    const commit = execFileSync('git', ['-C', checkout.root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    const manifest = {
      source: sourceUrl,
      tag: `v${version}`,
      commit,
      package: '@larksuite/cli',
      version,
      skills: officialSkills,
    };
    fs.writeFileSync(path.join(containerDir, 'lark-cli-skills.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Synced ${officialSkills.length} Lark skills from v${version} (${commit.slice(0, 12)}).`);
  } finally {
    if (checkout.cleanup) fs.rmSync(checkout.cleanup, { recursive: true, force: true });
  }
}

main();
