import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Stack of active traps so that only the top-most dialog reacts to Tab/Escape. */
const stack: symbol[] = [];

export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.closest('[inert], [hidden]')) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

interface Options {
  onEscape?: () => void;
  /** Element to focus on open instead of the first focusable one. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** CSS selector: when no initialFocus is given, prefer the first focusable element inside the first match. */
  preferWithin?: string;
}

/**
 * Traps Tab inside `ref`, calls onEscape on Esc, moves focus in on activation and restores it on cleanup.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, options: Options = {}) {
  const onEscapeRef = useRef(options.onEscape);
  useEffect(() => {
    onEscapeRef.current = options.onEscape;
  });
  const initialFocus = options.initialFocus;
  const preferWithin = options.preferWithin;

  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const id = Symbol('trap');
    stack.push(id);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const preferred = preferWithin ? root.querySelector<HTMLElement>(preferWithin) : null;
    const target = initialFocus?.current ?? (preferred ? focusableWithin(preferred)[0] : undefined) ?? focusableWithin(root)[0] ?? root;
    if (target === root && !root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
    target.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onEscapeRef.current?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusableWithin(root);
      if (items.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (!root.contains(current)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && current === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const idx = stack.indexOf(id);
      if (idx >= 0) stack.splice(idx, 1);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [active, ref, initialFocus, preferWithin]);
}
