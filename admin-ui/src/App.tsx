import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button, SearchField } from './components';

type WindowRange = '24h' | '7d' | '30d';

interface DashboardSnapshot {
  generatedAt: string;
  window: WindowRange;
  runtime: {
    agentGroups: number;
    messagingGroups: number;
    users: number;
    sessions: number;
    activeSessions: number;
    runningContainers: number;
    wirings: number;
  };
  outcomes: {
    completed: number;
    failed: number;
    pending: number;
    delivered: number;
    processing: number;
    successRate: number | null;
    unreadableSessionDbs: number;
    daily: Array<{ date: string; completed: number; failed: number }>;
    recentFailures: Array<{
      sessionId: string;
      agentGroupId: string;
      agentGroupName: string;
      timestamp: string;
      tries: number;
    }>;
  };
  skills: {
    total: number;
    groupCount: number;
    items: Array<{
      name: string;
      description: string;
      version: string | null;
      source: '飞书官方' | 'NanoClaw';
      enabledGroupCount: number;
    }>;
  };
}

const RANGE_LABELS: Record<WindowRange, string> = { '24h': '24小时', '7d': '7天', '30d': '30天' };

function Icon({ name, className = '' }: { name: string; className?: string }) {
  return <span className={`semantic-icon icon-${name} ${className}`.trim()} aria-hidden="true" />;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

function LoadingState() {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="loading-line" /><span className="loading-line" /><span className="loading-line loading-line--short" />
      <span className="tada-visually-hidden">正在读取运行数据</span>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: number | string; detail?: string }) {
  return (
    <div className="metric-cell">
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      {detail && <span className="metric-detail">{detail}</span>}
    </div>
  );
}

function OutcomeChart({ daily }: { daily: DashboardSnapshot['outcomes']['daily'] }) {
  const max = Math.max(1, ...daily.map((item) => item.completed + item.failed));
  if (daily.length === 0) return <div className="empty-inline">这个时间段还没有已完成的处理记录</div>;
  return (
    <div className="outcome-chart" aria-label="每日处理结果">
      {daily.map((item) => {
        const totalHeight = Math.max(8, ((item.completed + item.failed) / max) * 112);
        const failedHeight = item.completed + item.failed === 0 ? 0 : (item.failed / (item.completed + item.failed)) * totalHeight;
        return (
          <div className="chart-column" key={item.date} title={`${item.date}：成功 ${item.completed}，失败 ${item.failed}`}>
            <div className="chart-bar" style={{ height: totalHeight }}>
              <span className="chart-failed" style={{ height: failedHeight }} />
            </div>
            <span>{item.date.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function App() {
  const [range, setRange] = useState<WindowRange>('7d');
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/snapshot?window=${range}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSnapshot(await response.json() as DashboardSnapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '未知错误');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { void load(); }, [load]);

  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!snapshot || !normalized) return snapshot?.skills.items ?? [];
    return snapshot.skills.items.filter((skill) =>
      `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(normalized),
    );
  }, [query, snapshot]);

  return (
    <div className="dashboard-shell">
      <aside id="navigation" className="side-navigation" data-spatial-anchor="navigation" data-spatial-group="navigation-content" data-spatial-region="navigation" data-separation="tinted-plane" data-plane-role="context">
        <div className="product-lockup" data-tada-product-identity>
          <span className="beacon-mark" aria-hidden="true">B</span>
          <div><strong>beacon</strong><span>运营控制台</span></div>
        </div>
        <nav aria-label="后台导航">
          <a href="#runtime-summary"><span className="nav-marker" />运行概览</a>
          <a href="#outcome-summary"><Icon name="loading" />处理结果</a>
          <a href="#skill-inventory"><Icon name="skill" />预置技能</a>
        </nav>
        <div className="service-state"><span className="live-dot" />本机只读</div>
      </aside>

      <main className="dashboard-main">
        <header className="dashboard-header" data-spatial-anchor="dashboard-header">
          <div>
            <p className="eyebrow">beacon</p>
            <h1>运营控制台</h1>
          </div>
          <div className="header-actions">
            <span className="updated-at">{snapshot ? `更新于 ${formatTime(snapshot.generatedAt)}` : '正在连接'}</span>
            <Button variant="tertiary" onClick={() => void load()} disabled={loading}>刷新</Button>
          </div>
        </header>

        {error && (
          <div className="error-banner" role="alert">
            <Icon name="warning" /><span>数据读取失败：{error}</span><button type="button" onClick={() => void load()}>重试</button>
          </div>
        )}

        <section id="runtime-summary" className="dashboard-section" aria-labelledby="runtime-title" data-spatial-anchor="runtime-summary" data-spatial-region="runtime-summary">
          <div className="section-heading"><div><p className="section-kicker">01 / 运行</p><h2 id="runtime-title">当前实体与容器</h2></div><span className="section-note">直接读取 v2 中央库</span></div>
          {loading && !snapshot ? <LoadingState /> : snapshot && (
            <div className="metric-grid" data-spatial-anchor="runtime-metrics" data-spatial-group="runtime-metric-group" data-spatial-region="runtime-summary" data-separation="line" data-plane-role="base">
              <Metric label="Agent groups" value={snapshot.runtime.agentGroups} />
              <Metric label="Messaging groups" value={snapshot.runtime.messagingGroups} />
              <Metric label="用户" value={snapshot.runtime.users} />
              <Metric label="会话" value={snapshot.runtime.sessions} detail={`${snapshot.runtime.activeSessions} 个活跃`} />
              <Metric label="运行中容器" value={snapshot.runtime.runningContainers} />
              <Metric label="绑定关系" value={snapshot.runtime.wirings} />
            </div>
          )}
        </section>

        <section id="outcome-summary" className="dashboard-section" aria-labelledby="outcome-title" data-spatial-anchor="outcome-summary" data-spatial-region="outcome-summary">
          <div className="section-heading section-heading--controls">
            <div><p className="section-kicker">02 / 结果</p><h2 id="outcome-title">处理结果与异常</h2></div>
            <div className="range-control" role="group" aria-label="统计时间范围">
              {(Object.keys(RANGE_LABELS) as WindowRange[]).map((item) => <button key={item} type="button" aria-pressed={range === item} onClick={() => setRange(item)}>{RANGE_LABELS[item]}</button>)}
            </div>
          </div>
          {loading && !snapshot ? <LoadingState /> : snapshot && (
            <>
              <div className="outcome-layout" data-spatial-anchor="outcome-metrics" data-spatial-group="outcome-metric-group" data-spatial-region="outcome-summary" data-separation="line" data-plane-role="base">
                <div className="outcome-numbers">
                  <Metric label="处理成功" value={snapshot.outcomes.completed} detail={snapshot.outcomes.successRate === null ? '暂无成功率' : `成功率 ${snapshot.outcomes.successRate}%`} />
                  <Metric label="处理失败" value={snapshot.outcomes.failed} />
                  <Metric label="等待处理" value={snapshot.outcomes.pending} detail={`${snapshot.outcomes.processing} 个正在执行`} />
                  <Metric label="消息已投递" value={snapshot.outcomes.delivered} />
                </div>
                <div className="chart-panel"><div className="chart-legend"><span><i className="legend-success" />成功</span><span><i className="legend-failure" />失败</span></div><OutcomeChart daily={snapshot.outcomes.daily} /></div>
              </div>
              <div className="failure-list">
                <div className="subsection-title"><h3>最近失败</h3>{snapshot.outcomes.unreadableSessionDbs > 0 && <span className="warning-label"><Icon name="warning" />{snapshot.outcomes.unreadableSessionDbs} 个数据库无法读取</span>}</div>
                {snapshot.outcomes.recentFailures.length === 0 ? <div className="empty-inline"><Icon name="check" />当前范围内没有失败记录</div> : (
                  <div className="failure-table" role="table" aria-label="最近失败记录">
                    {snapshot.outcomes.recentFailures.map((failure) => (
                      <div className="failure-row" role="row" key={`${failure.sessionId}-${failure.timestamp}`}>
                        <span className="failure-signal"><Icon name="warning" /></span>
                        <span><strong>{failure.agentGroupName}</strong><small>{failure.sessionId}</small></span>
                        <span>重试 {failure.tries} 次</span><time dateTime={failure.timestamp}>{formatTime(failure.timestamp)}</time>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </section>

        <section id="skill-inventory" className="dashboard-section" aria-labelledby="skills-title" data-spatial-anchor="skill-inventory" data-spatial-region="skill-inventory">
          <div className="section-heading"><div><p className="section-kicker">03 / 配置</p><h2 id="skills-title">预置技能</h2></div><span className="section-note">{snapshot ? `${snapshot.skills.total} 个技能 · ${snapshot.skills.groupCount} 个 Agent group` : '读取中'}</span></div>
          <div className="skill-search" data-spatial-anchor="skill-search-shell" data-spatial-group="skill-search-group" data-spatial-region="skill-inventory" data-separation="line" data-plane-role="base">
            <div data-spatial-anchor="skill-search-leading"><SearchField label="搜索预置技能" hideLabel value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能名称、能力或来源" leadingIcon={<Icon name="search" className="search-leading" />} /></div>
            <span className="search-count" data-spatial-anchor="skill-search-trailing">{filteredSkills.length} 项</span>
          </div>
          {loading && !snapshot ? <LoadingState /> : snapshot && (
            <div className="skill-table" data-spatial-anchor="skill-table" data-spatial-group="skill-table-group" data-spatial-region="skill-inventory" data-separation="line" data-plane-role="base">
              <div className="skill-row skill-row--header"><span>技能</span><span>来源</span><span>覆盖</span></div>
              {filteredSkills.map((skill) => (
                <div className="skill-row" key={skill.name}>
                  <span className="skill-identity"><Icon name="skill" /><span><strong>{skill.name}</strong><small>{skill.description || '未提供说明'}</small></span></span>
                  <span><span className={`source-tag ${skill.source === '飞书官方' ? 'source-tag--official' : ''}`}>{skill.source}</span>{skill.version && <small className="version">v{skill.version}</small>}</span>
                  <span className="coverage"><strong>{skill.enabledGroupCount}/{snapshot.skills.groupCount}</strong><span><i style={{ width: snapshot.skills.groupCount ? `${(skill.enabledGroupCount / snapshot.skills.groupCount) * 100}%` : '0%' }} /></span></span>
                </div>
              ))}
              {filteredSkills.length === 0 && <div className="empty-inline">没有匹配的预置技能</div>}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
