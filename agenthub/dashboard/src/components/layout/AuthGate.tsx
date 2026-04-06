import { useState, type ReactNode, type FormEvent } from 'react';
import { getApiKey, setApiKey } from '../../lib/api';

interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const [hasKey, setHasKey] = useState(() => !!getApiKey());
  const [input, setInput] = useState('');

  if (hasKey) return <>{children}</>;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const v = input.trim();
    if (!v) return;
    setApiKey(v);
    setHasKey(true);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'radial-gradient(ellipse at center, #12121a 0%, #0a0a0f 70%)' }}
    >
      <div className="panel p-8 w-full max-w-md" style={{ borderColor: '#2a2a38' }}>
        <div className="flex items-center gap-3 mb-6">
          <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 1L14.93 5.5V10.5L8 15L1.07 10.5V5.5L8 1Z" stroke="#6366f1" strokeWidth="1.5" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold">Lattice</h1>
        </div>
        <p className="text-sm text-gray-400 mb-6 leading-relaxed">
          Enter your workspace API key to connect. Keys are stored locally in your browser.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">API Key</label>
            <input
              type="password"
              placeholder="lt_..."
              autoComplete="off"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              className="w-full px-3 py-2.5 bg-surface-0 border border-surface-4 rounded-lg text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30 transition-all"
            />
          </div>
          <p className="text-xs text-gray-600 leading-relaxed">
            Need a key? Run{' '}
            <code className="px-1.5 py-0.5 bg-surface-0 rounded text-gray-400 font-mono text-[11px]">
              npx lattice init
            </code>{' '}
            or POST{' '}
            <code className="px-1.5 py-0.5 bg-surface-0 rounded text-gray-400 font-mono text-[11px]">
              /admin/teams/:id/keys
            </code>
          </p>
          <button type="submit" className="btn-primary w-full py-2.5">
            Connect
          </button>
        </form>
      </div>
    </div>
  );
}
