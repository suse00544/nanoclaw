import { useEffect, useRef, useState, type ReactNode } from 'react';

export type DropdownMenuItem = {
  id: string;
  label: string;
  disabled?: boolean;
  tone?: 'neutral' | 'warning';
  onSelect: () => void;
};

export function DropdownMenu({
  label,
  trigger,
  items,
}: {
  label: string;
  trigger: ReactNode;
  items: DropdownMenuItem[];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const enabledIndex = (start: number, direction: 1 | -1) => {
    for (let offset = 1; offset <= items.length; offset += 1) {
      const index = (start + direction * offset + items.length) % items.length;
      if (!items[index]?.disabled) return index;
    }
    return start;
  };
  const close = () => {
    triggerRef.current?.focus();
    setOpen(false);
  };
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);
  return (
    <div className="tada-dropdown" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="tada-dropdown__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            queueMicrotask(() => menuRef.current?.focus());
          }
        }}
      >{trigger}</button>
      {open && (
        <div
          ref={menuRef}
          className="tada-dropdown__menu"
          role="menu"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') close();
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((current) => enabledIndex(current, event.key === 'ArrowDown' ? 1 : -1));
            }
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              const item = items[activeIndex];
              if (item && !item.disabled) { item.onSelect(); close(); }
            }
          }}
        >
          {items.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={`tada-dropdown__item${item.tone === 'warning' ? ' tada-dropdown__item--warning' : ''}${index === activeIndex ? ' is-active' : ''}`}
              onMouseEnter={() => !item.disabled && setActiveIndex(index)}
              onClick={() => { item.onSelect(); close(); }}
            >{item.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}
