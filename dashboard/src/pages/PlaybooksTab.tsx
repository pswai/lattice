import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { agentColor } from '../lib/utils';
import { EmptyState, EMPTY_ICONS } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { toast } from '../components/ui/Toast';
import type { Playbook } from '../lib/types';

export default function PlaybooksTab() {
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningName, setRunningName] = useState<string | null>(null);

  const loadPlaybooks = useCallback(async () => {
    try {
      const r = await api<{ playbooks: Playbook[] }>('/playbooks');
      setPlaybooks(r.playbooks || []);
    } catch {
      toast('Failed to load playbooks', true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPlaybooks();
  }, [loadPlaybooks]);

  const runPlaybook = async (name: string) => {
    if (!confirm(`Run playbook "${name}"?\n\nThis will create new tasks from the playbook template and start a workflow run.`)) {
      return;
    }

    setRunningName(name);
    try {
      const r = await api<{ created_task_ids: number[]; workflow_run_id: number }>(
        '/playbooks/' + encodeURIComponent(name) + '/run',
        { method: 'POST' },
      );
      const n = (r.created_task_ids || []).length;
      toast(`Created ${n} tasks (workflow #${r.workflow_run_id})`);
      loadPlaybooks();
    } catch {
      toast('Failed to run playbook', true);
    } finally {
      setRunningName(null);
    }
  };

  if (loading) {
    return (
      <div className="panel p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Playbooks</h2>
        </div>
        <div className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      </div>
    );
  }

  return (
    <div className="panel p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Playbooks</h2>
        <button className="btn-ghost" onClick={loadPlaybooks}>Refresh</button>
      </div>

      {playbooks.length === 0 ? (
        <EmptyState
          icon={EMPTY_ICONS.playbooks}
          title="No playbooks yet"
          description="Define reusable task templates with define_playbook via MCP, then run them to create real tasks."
        />
      ) : (
        <div className="space-y-2">
          {playbooks.map((p) => (
            <div key={p.name} className="pb-row">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-gray-200">{p.name}</div>
                <div className="text-xs text-gray-400 mt-1 leading-relaxed">{p.description || ''}</div>
                <div className="text-[11px] text-gray-500 mt-1.5">
                  {(p.tasks || []).length} task(s) &middot; by{' '}
                  <span style={{ color: agentColor(p.createdBy) }}>{p.createdBy}</span>
                </div>
              </div>
              <button
                className="btn-primary text-xs"
                disabled={runningName === p.name}
                onClick={() => runPlaybook(p.name)}
              >
                {runningName === p.name ? 'Running...' : 'Run'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
