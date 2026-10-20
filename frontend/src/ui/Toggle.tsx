interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Hide the visible text but keep it as the accessible name. */
  hideLabel?: boolean;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, hideLabel, disabled }: ToggleProps) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="ek-toggle" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="ek-toggle__track" aria-hidden="true">
        <span className="ek-toggle__thumb" />
      </span>
      <span className={hideLabel ? 'ek-sr-only' : undefined}>{label}</span>
    </button>
  );
}
