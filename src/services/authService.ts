import { apiFetch } from './apiClient';
import type { NativeClientIdentity } from '../../shared/native_client_identity';

export interface User {
  uid: string;
  username: string;
  role: string;
  phone?: string;
}

function storeToken(token: string) {
  try { localStorage.setItem('lumi_auth_token', token); } catch {}
}

function storeDesktopSessionProof(proof: string) {
  try { localStorage.setItem('lumi_desktop_session_proof', proof); } catch {}
}

export function getStoredToken(): string | null {
  try { return localStorage.getItem('lumi_auth_token'); } catch { return null; }
}

export function getDesktopSessionProof(): string | null {
  try { return localStorage.getItem('lumi_desktop_session_proof'); } catch { return null; }
}

export function isNativeDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const runtime = window as any;
  return Boolean(runtime.__TAURI_INTERNALS__ || runtime.__TAURI_IPC__ || runtime.__TAURI__);
}

async function refreshNativeDesktopSessionProof(): Promise<void> {
  if (!isNativeDesktopRuntime()) return;
  const { invoke } = await import('@tauri-apps/api/core');
  const session = await invoke<any>('bootstrap_local_identity', {
    existingToken: getStoredToken(),
  });
  if (session?.token) storeToken(session.token);
  if (session?.desktopSessionProof) storeDesktopSessionProof(session.desktopSessionProof);
}

export async function register(username: string, password: string, phone: string): Promise<{ success: boolean; user?: User; error?: string }> {
  try {
    const response = await apiFetch("/api/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password, phone }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Registration failed");
    if (data.token) {
      storeToken(data.token);
      try { await refreshNativeDesktopSessionProof(); } catch {}
    }
    return data;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function login(username: string, password: string): Promise<{ success: boolean; user?: User; error?: string }> {
  try {
    const response = await apiFetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username, password }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Login failed");
    if (data.token) {
      storeToken(data.token);
      try { await refreshNativeDesktopSessionProof(); } catch {}
    }
    return data;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function bootstrap(): Promise<{
  success: boolean;
  user?: User;
  token?: string;
  desktopSessionProof?: string;
  desktopSessionExpiresAt?: string;
  nativeClientIdentity?: NativeClientIdentity;
  error?: string;
}> {
  try {
    if (!isNativeDesktopRuntime()) {
      return { success: false, error: 'Silent bootstrap is available only in the Lumi desktop client' };
    }
    const { invoke } = await import('@tauri-apps/api/core');
    const data = await invoke<any>('bootstrap_local_identity', {
      existingToken: getStoredToken(),
    });
    if (data.token) storeToken(data.token);
    if (data.desktopSessionProof) storeDesktopSessionProof(data.desktopSessionProof);
    return data;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function getMe(): Promise<{ user: User } | null> {
  try {
    const response = await apiFetch("/api/auth/me");
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  await apiFetch("/api/auth/logout", { method: "POST" });
  try {
    localStorage.removeItem('lumi_auth_token');
    localStorage.removeItem('lumi_desktop_session_proof');
  } catch {}
}
