import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { App } from './App';

const snapshot = {
  generatedAt: '2026-08-12T02:00:00.000Z', window: '7d',
  runtime: { agentGroups: 3, messagingGroups: 5, users: 7, sessions: 9, activeSessions: 8, runningContainers: 2, wirings: 5 },
  outcomes: { completed: 12, failed: 1, pending: 2, delivered: 10, processing: 1, successRate: 92.3, unreadableSessionDbs: 0, daily: [{ date: '2026-08-12', completed: 12, failed: 1 }], recentFailures: [] },
  skills: { total: 2, groupCount: 3, items: [
    { name: 'lark-approval', description: '审批操作', version: '1.2.0', source: '飞书官方', enabledGroupCount: 3 },
    { name: 'welcome', description: '新用户引导', version: null, source: 'NanoClaw', enabledGroupCount: 2 },
  ] },
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => snapshot }));
});

afterEach(() => vi.unstubAllGlobals());

it('renders operational counts from the existing snapshot API', async () => {
  render(<App />);
  expect(await screen.findByText('Agent groups')).toBeInTheDocument();
  expect(screen.getByText('成功率 92.3%')).toBeInTheDocument();
  expect(screen.getByText('lark-approval')).toBeInTheDocument();
});

it('filters the baseline skill inventory locally', async () => {
  render(<App />);
  await screen.findByText('lark-approval');
  fireEvent.change(screen.getByPlaceholderText('搜索技能名称、能力或来源'), { target: { value: 'welcome' } });
  await waitFor(() => expect(screen.queryByText('lark-approval')).not.toBeInTheDocument());
  expect(screen.getByText('welcome')).toBeInTheDocument();
});
