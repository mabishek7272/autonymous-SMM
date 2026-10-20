import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './auth/AuthContext';
import { createQueryClient } from './services/queryClient';
import { ConfirmProvider, ToastProvider } from './ui';

/** Query client, toasts, confirm dialog and auth session. Router is provided by the caller (main.tsx / tests). */
export function AppProviders({ children, client }: { children: ReactNode; client?: QueryClient }) {
  const [queryClient] = useState(() => client ?? createQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ConfirmProvider>
          <AuthProvider>{children}</AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
