import { useEffect, type ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-box">
        <div className="flex items-center justify-between p-4 border-b border-surface-3">
          <div className="text-sm font-semibold">{title}</div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200 text-lg leading-none">
            &times;
          </button>
        </div>
        <div className="p-4 overflow-auto text-xs font-mono" style={{ whiteSpace: 'pre-wrap' }}>
          {children}
        </div>
      </div>
    </div>
  );
}
