import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';

export type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
  label: string;
  hint?: string;
  error?: string;
  leadingIcon?: ReactNode;
  trailingAction?: ReactNode;
  hideLabel?: boolean;
};

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField({
  label,
  hint,
  error,
  leadingIcon,
  trailingAction,
  hideLabel = false,
  id,
  className = '',
  ...props
}, ref) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const supportId = `${inputId}-support`;
  return (
    <div className={`tada-field ${className}`.trim()}>
      <label className={hideLabel ? 'tada-visually-hidden' : 'tada-field__label'} htmlFor={inputId}>{label}</label>
      <span className={`tada-field__shell${error ? ' tada-field__shell--error' : ''}`}>
        {leadingIcon && <span className="tada-field__leading" aria-hidden="true">{leadingIcon}</span>}
        <input
          {...props}
          ref={ref}
          id={inputId}
          className="tada-field__input"
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={(hint || error) ? supportId : undefined}
        />
        {trailingAction && <span className="tada-field__trailing">{trailingAction}</span>}
      </span>
      {(hint || error) && (
        <span id={supportId} className={`tada-field__support${error ? ' tada-field__support--error' : ''}`}>
          {error ?? hint}
        </span>
      )}
    </div>
  );
});

export function SearchField(props: TextFieldProps) {
  return <TextField type="search" {...props} />;
}
