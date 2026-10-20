import { cx } from './cx';
import { initialsOf } from './initials';

interface AvatarProps {
  name: string;
  size?: number;
  className?: string;
}

export function Avatar({ name, size = 32, className }: AvatarProps) {
  return (
    <span
      className={cx('ek-avatar', className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      role="img"
      aria-label={name}
      title={name}
    >
      {initialsOf(name) || '?'}
    </span>
  );
}
