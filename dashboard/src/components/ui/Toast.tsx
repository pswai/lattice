import { useEffect, useState, useCallback } from 'react';
import { cn } from '../../lib/utils';

interface ToastMessage {
  id: number;
  message: string;
  isError?: boolean;
}

let toastId = 0;
let addToastFn: ((msg: string, isError?: boolean) => void) | null = null;

export function toast(msg: string, isError?: boolean) {
  addToastFn?.(msg, isError);
}

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = useCallback((message: string, isError?: boolean) => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, isError }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  useEffect(() => {
    addToastFn = addToast;
    return () => { addToastFn = null; };
  }, [addToast]);

  return (
    <div className="fixed bottom-5 right-5 z-[80] flex flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className={cn('toast', t.isError && 'err')}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
