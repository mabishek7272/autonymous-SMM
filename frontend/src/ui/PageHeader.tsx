import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="ek-page-header">
      <div>
        <h1 className="ek-page-header__title">{title}</h1>
        {subtitle && <p className="ek-page-header__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="ek-page-header__actions">{actions}</div>}
    </div>
  );
}
