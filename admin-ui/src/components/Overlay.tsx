import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react';
import { IconButton } from './Button';

type OverlayProps = {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  kind?: 'dialog' | 'sheet';
  closeIcon?: ReactNode;
};

export function Overlay({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  kind = 'dialog',
  closeIcon = <span className="tada-icon-mask tada-icon-mask--close" />,
}: OverlayProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const requestClose = useCallback(() => {
    restoreRef.current?.focus();
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement;
    queueMicrotask(() => panelRef.current?.querySelector<HTMLElement>('button, input, [tabindex="0"]')?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      restoreRef.current?.focus();
    };
  }, [open, requestClose]);

  if (!open) return null;
  return (
    <div className="tada-overlay" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <div
        ref={panelRef}
        className={`tada-overlay__panel tada-overlay__panel--${kind}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <header className="tada-overlay__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <IconButton variant="tertiary" label="关闭" icon={closeIcon} onClick={requestClose} />
        </header>
        <div className="tada-overlay__body">{children}</div>
        {footer && <footer className="tada-overlay__footer">{footer}</footer>}
      </div>
    </div>
  );
}

export function Dialog(props: Omit<OverlayProps, 'kind'>) {
  return <Overlay {...props} kind="dialog" />;
}

export function Sheet(props: Omit<OverlayProps, 'kind'>) {
  return <Overlay {...props} kind="sheet" />;
}
