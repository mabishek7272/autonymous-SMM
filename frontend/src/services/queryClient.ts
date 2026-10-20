import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './http';

/** Retry only when the request never reached the server (network error); never on 4xx/5xx responses. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  return isApiError(error) && error.isNetworkError && failureCount < 2;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 15_000, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}
