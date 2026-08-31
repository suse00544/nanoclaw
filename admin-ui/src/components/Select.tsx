import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

export type SelectOption = { value: string; label: string; disabled?: boolean };

export type SelectProps = {
  label: string;
  value: string;
  options: SelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  hideLabel?: boolean;
  chevronIcon?: ReactNode;
};

export function Select({
  label,
  value,
  options,
  onValueChange,
  disabled = false,
  hideLabel = false,
  chevronIcon,
}: SelectProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  const close = (restoreFocus = true) => {
    if (restoreFocus) triggerRef.current?.focus();
    setOpen(false);
  };

  const nextEnabled = (start: number, direction: 1 | -1) => {
    for (let offset = 1; offset <= options.length; offset += 1) {
      const index = (start + direction * offset + options.length) % options.length;
      if (!options[index]?.disabled) return index;
    }
    return start;
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const initial = event.key === 'End'
      ? options.length - 1
      : event.key === 'Home'
        ? 0
        : nextEnabled(selectedIndex, event.key === 'ArrowUp' ? -1 : 1);
    setActiveIndex(initial);
    setOpen(true);
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => nextEnabled(current, event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? 0 : options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const option = options[activeIndex];
      if (option && !option.disabled) {
        onValueChange(option.value);
        close();
      }
    }
  };

  const selected = options[selectedIndex];
  return (
    <div className="tada-select" ref={rootRef}>
      <span id={`${id}-label`} className={hideLabel ? 'tada-visually-hidden' : 'tada-select__label'}>{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className="tada-select__trigger"
        aria-labelledby={`${id}-label ${id}-value`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          setActiveIndex(selectedIndex);
          setOpen((current) => !current);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span id={`${id}-value`} className="tada-select__value">{selected?.label}</span>
        <span className="tada-select__affordance" aria-hidden="true">
          {chevronIcon ?? <span className="tada-icon-mask tada-icon-mask--chevron" />}
        </span>
      </button>
      {open && (
        <ul
          className="tada-select__listbox"
          role="listbox"
          aria-labelledby={`${id}-label`}
          aria-activedescendant={`${id}-option-${activeIndex}`}
          tabIndex={-1}
          onKeyDown={onListKeyDown}
          ref={(node) => node?.focus()}
        >
          {options.map((option, index) => (
            <li
              id={`${id}-option-${index}`}
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              className={index === activeIndex ? 'is-active' : ''}
              onMouseEnter={() => !option.disabled && setActiveIndex(index)}
              onClick={() => {
                if (option.disabled) return;
                onValueChange(option.value);
                close();
              }}
            >
              {option.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
