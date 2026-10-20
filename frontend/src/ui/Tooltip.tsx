import { useId, useState, type ReactNode } from 'react';

interface TooltipProps {
  content: string;
  children: ReactNode;
}

/** Hover/focus tooltip. The wrapped control keeps its own accessible name; this adds a description. */
export function Tooltip({ content, children }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span
      className="ek-tooltip"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open && (
        <span role="tooltip" id={id} className="ek-tooltip__tip">
          {content}
        </span>
      )}
    </span>
  );
}
