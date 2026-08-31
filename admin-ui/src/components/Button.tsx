import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'warning';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'primary',
  leadingIcon,
  trailingIcon,
  className = '',
  children,
  type = 'button',
  ...props
}, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={`tada-button tada-button--${variant} ${className}`.trim()}
    >
      {leadingIcon && <span className="tada-button__icon" aria-hidden="true">{leadingIcon}</span>}
      <span className="tada-button__label">{children}</span>
      {trailingIcon && <span className="tada-button__icon" aria-hidden="true">{trailingIcon}</span>}
    </button>
  );
});

export type IconButtonProps = Omit<ButtonProps, 'children' | 'leadingIcon' | 'trailingIcon'> & {
  label: string;
  icon: ReactNode;
  dense?: boolean;
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  label,
  icon,
  dense = false,
  className = '',
  ...props
}, ref) {
  return (
    <Button
      {...props}
      ref={ref}
      aria-label={label}
      className={`tada-icon-button${dense ? ' tada-icon-button--dense' : ''} ${className}`.trim()}
    >
      <span aria-hidden="true">{icon}</span>
    </Button>
  );
});
