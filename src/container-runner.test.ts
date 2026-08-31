import fs from 'fs';
import path from 'path';
import os from 'os';
import { afterEach, describe, expect, it } from 'vitest';

import { extractFeishuSenderId, hardeningArgs, resolveProviderName, syncSkillSymlinks } from './container-runner.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Feishu user credential isolation', () => {
  it('extracts and namespaces the trusted sender identity', () => {
    expect(extractFeishuSenderId(JSON.stringify({ senderId: 'fs:ou_abc' }))).toBe('fs:ou_abc');
    expect(extractFeishuSenderId(JSON.stringify({ sender: 'ou_abc' }))).toBe('fs:ou_abc');
    expect(extractFeishuSenderId(JSON.stringify({ author: { userId: 'ou_abc' } }))).toBe('fs:ou_abc');
    expect(extractFeishuSenderId('not json')).toBeNull();
  });

  it('mounts one selected profile for DMs and a read-only bot profile elsewhere', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain("hostPath: path.join(userHome, '.lark-cli')");
    expect(src).toContain("hostPath: path.join(userHome, '.local', 'share', 'lark-cli')");
    expect(src).toContain('const botHome = larkCliBotHome()');
    expect(src).toMatch(/hostPath: path\.join\(botHome, '\.lark-cli'\)[\s\S]*?readonly: true/);
    expect(src).toMatch(/hostPath: path\.join\(botHome, '\.local', 'share', 'lark-cli'\)[\s\S]*?readonly: true/);
    expect(src).not.toContain("containerPath: '/home/node/.lark-cli-users'");
  });
});

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('buildContainerArgs ordering invariant (structural)', () => {
  // The OneCLI gateway apply (SDK applyContainerConfig) appends credential-stub
  // mounts — e.g. the codex auth.json sentinel nested INSIDE our RW
  // /home/node/.codex mount. Docker applies binds in argument order, so the
  // stub must land AFTER its parent mount or the parent shadows it and the
  // agent silently degrades to loginless auth. Driving the real
  // buildContainerArgs needs a live gateway + container runtime, so this
  // guards the invariant structurally: the gateway apply must appear after
  // the volume-mounts loop in the source.
  it('applies the OneCLI gateway after the volume mounts', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const mountsLoop = src.indexOf('for (const mount of mounts)');
    const gatewayApply = src.indexOf('onecli.applyContainerConfig');
    expect(mountsLoop).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(-1);
    expect(gatewayApply).toBeGreaterThan(mountsLoop);
  });
});

describe('provider-specific model credential grants', () => {
  it('uses the provider-contributed Anthropic endpoint for OneCLI grants', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('ensureModelSecretGrant(agentIdentifier, providerContribution.env?.ANTHROPIC_BASE_URL)');
    expect(src).toContain('contributedBaseUrl || process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL');
    expect(src).toContain('secrets.filter((row) => row.hostPattern && hostMatchesPattern(host, row.hostPattern))');
    expect(src).toContain('for (const secret of matchingSecrets)');
  });
});

describe('per-container resource limits (structural)', () => {
  // CONTAINER_CPU_LIMIT / CONTAINER_MEMORY_LIMIT pass through to `docker run` as
  // --cpus / --memory, but only when set. The default is empty string → no flag →
  // today's unbounded behavior (don't OOM existing OSS workloads). Swap is not
  // managed here (a swapless host makes --memory a hard cap). buildContainerArgs
  // needs a live gateway to drive, so guard the wiring structurally: the flags
  // must be pushed, and each must be guarded by its env knob so empty emits nothing.
  it('reads both limit knobs from config', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('CONTAINER_CPU_LIMIT');
    expect(src).toContain('CONTAINER_MEMORY_LIMIT');
  });

  it('guards --cpus behind a truthy CONTAINER_CPU_LIMIT', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_CPU_LIMIT\)[\s\S]*?args\.push\('--cpus', CONTAINER_CPU_LIMIT\)/);
  });

  it('guards --memory behind a truthy CONTAINER_MEMORY_LIMIT (and sets no swap flag)', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toMatch(/if \(CONTAINER_MEMORY_LIMIT\) args\.push\('--memory', CONTAINER_MEMORY_LIMIT\)/);
    expect(src).not.toContain('--memory-swap');
  });

  it('defaults both knobs to empty string in config (no flag = unbounded)', () => {
    const cfg = fs.readFileSync(path.join(process.cwd(), 'src', 'config.ts'), 'utf-8');
    expect(cfg).toContain(
      "CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT || envConfig.CONTAINER_CPU_LIMIT || ''",
    );
    expect(cfg).toContain(
      "CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT || envConfig.CONTAINER_MEMORY_LIMIT || ''",
    );
  });
});

describe('container boot-failure tripwire (structural)', () => {
  // A container that dies at boot (unknown provider, missing CLI binary, bad
  // config) explains itself only on stderr — which logs at debug, below the
  // default level. The spawn handler must keep a stderr tail and surface it
  // at warn on a non-zero exit, or the operator sees only "exited code 1" on
  // repeat. Driving a real failing spawn needs a container runtime, so this
  // guards the wiring structurally, matching the invariant test above.
  it('surfaces the stderr tail when the container exits non-zero', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    expect(src).toContain('stderrTail.push(line)');
    expect(src).toMatch(/Container exited non-zero.*stderrTail/s);
  });
});

describe('syncSkillSymlinks blocked-entry warning (structural)', () => {
  // Real directories in .claude-shared/skills/ block the managed symlinks:
  // the prune loop only removes symlinks and the create loop skips any
  // existing entry. Template overlays depend on surviving that (see
  // src/group-skills.ts); stale pre-refactor skill copies (#3001) get served
  // forever with no trace. Driving syncSkillSymlinks needs a real group
  // filesystem, and importing more of the module pulls the provider side
  // effects, so guard the wiring structurally: the create loop must warn
  // when a non-symlink entry occupies a desired skill path.
  it('warns instead of silently skipping when a real entry blocks a desired skill', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf-8');
    const createLoop = src.indexOf('// Create symlinks for desired skills');
    expect(createLoop).toBeGreaterThan(-1);
    const tail = src.slice(createLoop);
    expect(tail).toMatch(/else if \(!entry\.isSymbolicLink\(\)\)/);
    expect(tail).toMatch(/log\.warn\(\s*'Shared skill not symlinked/);
  });
});

describe('syncSkillSymlinks managed targets', () => {
  it('replaces a stale managed symlink with the shared container target', () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skill-links-'));
    tempDirs.push(claudeDir);
    const skillsDir = path.join(claudeDir, 'skills');
    fs.mkdirSync(skillsDir);
    const link = path.join(skillsDir, 'lark-approval');
    fs.symlinkSync('../../.agents/skills/lark-approval', link);

    syncSkillSymlinks(claudeDir, {
      skills: ['lark-approval'],
    } as Parameters<typeof syncSkillSymlinks>[1]);

    expect(fs.readlinkSync(link)).toBe('/app/skills/lark-approval');
  });

  it('does not overwrite a real skill directory', () => {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-skill-links-'));
    tempDirs.push(claudeDir);
    const localSkill = path.join(claudeDir, 'skills', 'lark-approval');
    fs.mkdirSync(localSkill, { recursive: true });
    fs.writeFileSync(path.join(localSkill, 'SKILL.md'), 'local overlay');

    syncSkillSymlinks(claudeDir, {
      skills: ['lark-approval'],
    } as Parameters<typeof syncSkillSymlinks>[1]);

    expect(fs.lstatSync(localSkill).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(localSkill, 'SKILL.md'), 'utf8')).toBe('local overlay');
  });
});

describe('hardeningArgs', () => {
  it('always emits the three unconditional flags', () => {
    const args = hardeningArgs('2048');
    expect(args).toContain('--cap-drop=ALL');
    expect(args.join(' ')).toContain('--security-opt no-new-privileges');
    expect(args).toContain('--init');
  });

  it('emits the pids limit when positive', () => {
    expect(hardeningArgs('2048').join(' ')).toContain('--pids-limit 2048');
  });

  // cgroups v2 rejects `--pids-limit 0` with EINVAL, killing the spawn.
  it('omits the pids limit for 0, negatives, blank and garbage', () => {
    for (const v of ['0', '-1', '', '   ', 'lots']) {
      expect(hardeningArgs(v).join(' ')).not.toContain('--pids-limit');
    }
  });

  it('floors fractional values', () => {
    expect(hardeningArgs('2048.7').join(' ')).toContain('--pids-limit 2048');
  });
});
