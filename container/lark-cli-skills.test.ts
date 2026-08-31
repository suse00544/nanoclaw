import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tools = JSON.parse(readFileSync(join(here, 'cli-tools.json'), 'utf8')) as Array<{
  name: string;
  version: string;
}>;
const manifest = JSON.parse(readFileSync(join(here, 'lark-cli-skills.json'), 'utf8')) as {
  package: string;
  version: string;
  tag: string;
  commit: string;
  skills: string[];
};
const skillsDir = join(here, 'skills');

describe('bundled lark-cli skills', () => {
  it('stays pinned to the installed lark-cli version', () => {
    const cli = tools.find((tool) => tool.name === '@larksuite/cli');
    expect(cli).toBeDefined();
    expect(manifest.package).toBe('@larksuite/cli');
    expect(manifest.version).toBe(cli?.version);
    expect(manifest.tag).toBe(`v${cli?.version}`);
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('contains every official skill recorded in the source manifest', () => {
    expect(manifest.skills.length).toBeGreaterThan(0);
    expect(new Set(manifest.skills).size).toBe(manifest.skills.length);

    for (const skill of manifest.skills) {
      expect(skill).toMatch(/^lark-/);
      expect(existsSync(join(skillsDir, skill, 'SKILL.md')), `${skill} is missing SKILL.md`).toBe(true);
    }

    const bundled = readdirSync(skillsDir)
      .filter((name) => name.startsWith('lark-') && name !== 'lark-cli-user')
      .sort();
    expect(bundled).toEqual([...manifest.skills].sort());
  });

  it('keeps the NanoClaw per-user auth boundary in front of official auth instructions', () => {
    const shared = readFileSync(join(skillsDir, 'lark-shared', 'SKILL.md'), 'utf8');
    const userBoundary = readFileSync(join(skillsDir, 'lark-cli-user', 'SKILL.md'), 'utf8');
    const standingInstructions = readFileSync(join(skillsDir, 'lark-cli-user', 'instructions.md'), 'utf8');

    expect(shared).toContain('NanoClaw 身份隔离覆盖规则');
    expect(shared).toContain('../lark-cli-user/SKILL.md');
    expect(shared).toContain('lark-cli-user setup start|status');
    expect(userBoundary).toContain('only works in a private Feishu conversation');
    expect(standingInstructions).toContain('matching official `lark-*` skill');
    expect(standingInstructions).toContain('Use `lark-approval` for reimbursement');
  });
});
