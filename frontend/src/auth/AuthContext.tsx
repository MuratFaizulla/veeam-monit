import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../api/client';
import type { SessionUser } from '../api/types';

interface AuthState {
  user: SessionUser | null;
  /** True until the initial /auth/me probe settles. */
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;

    // A page reload keeps the cookie, so ask the backend who we are.
    api
      .me()
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(
    async (username: string, password: string) => {
      const me = await api.login(username, password);
      queryClient.clear();
      setUser(me);
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
      queryClient.clear();
    }
  }, [queryClient]);

  useEffect(() => {
    // Any query that comes back with 401 means the backend session died
    // (idle timeout, backend restart). Drop the user so the router shows login.
    return queryClient.getQueryCache().subscribe((event) => {
      const error = event.query.state.error;
      if (error instanceof ApiError && error.isUnauthenticated) {
        setUser(null);
      }
    });
  }, [queryClient]);

  const value = useMemo<AuthState>(
    () => ({ user, loading, login, logout }),
    [user, loading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return context;
}
