import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { agentColor, humanSize, timeAgo } from '../lib/utils';
import { Modal } from '../components/ui/Modal';
import { EmptyState, EMPTY_ICONS } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { toast } from '../components/ui/Toast';
import type { Artifact } from '../lib/types';

export default function ArtifactsTab() {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState('');
  const [modalContent, setModalContent] = useState('');

  const loadArtifacts = useCallback(async () => {
    try {
      const r = await api<{ artifacts: Artifact[] }>('/artifacts');
      setArtifacts(r.artifacts || []);
    } catch {
      toast('Failed to load artifacts', true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadArtifacts();
  }, [loadArtifacts]);

  const openArtifact = async (key: string) => {
    try {
      const a = await api<Artifact>('/artifacts/' + encodeURIComponent(key));
      const content = String(a.content || '');
      const truncated = content.length > 2000;
      const shown = truncated
        ? content.slice(0, 2000) + '\n\n...(truncated, ' + content.length + ' chars total)'
        : content;
      setModalTitle(`${a.key}  (${a.contentType}, ${humanSize(a.size)})`);
      setModalContent(shown);
      setModalOpen(true);
    } catch {
      toast('Failed to load artifact', true);
    }
  };

  if (loading) {
    return (
      <div className="panel p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Artifacts</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="panel p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Artifacts</h2>
          <button className="btn-ghost" onClick={loadArtifacts}>Refresh</button>
        </div>

        {artifacts.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICONS.artifacts}
            title="No artifacts yet"
            description="Use save_artifact via MCP to store files, code, or reports that agents produce."
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {artifacts.map((a) => (
              <div
                key={a.key}
                className="art-card"
                onClick={() => openArtifact(a.key)}
              >
                <div className="text-sm font-medium text-gray-200 mb-1.5 truncate">{a.key}</div>
                <div className="flex items-center gap-2 text-[11px] text-gray-500 mb-2">
                  <span className="px-1.5 py-0.5 bg-surface-0 rounded text-gray-400 font-mono text-[10px]">
                    {a.contentType}
                  </span>
                  <span>{humanSize(a.size)}</span>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span style={{ color: agentColor(a.createdBy) }}>{a.createdBy}</span>
                  <span className="text-gray-600">{timeAgo(a.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={modalTitle}>
        {modalContent}
      </Modal>
    </>
  );
}
