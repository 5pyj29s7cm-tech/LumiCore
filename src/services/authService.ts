import { apiFetch } from './apiClient';

export interface User {
  uid: string;
  username: string;
  role: string;
  phone?: string;
}

function storeToken(token: string) {
  try { localStorage.setItem('lumi_auth_token', token); } catch {}
}

export function getStoredToken(): string | null {
  try { return localStorage.getItem('lumi_auth_token'); } catch { return null; }
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
    if (data.token) storeToken(data.token);
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
    if (data.token) storeToken(data.token);
    return data;
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

export async function bootstrap(): Promise<{ success: boolean; user?: User; error?: string }> {
  try {
    const response = await apiFetch("/api/auth/bootstrap");
    const data = await response.json();
    if (data.token) storeToken(data.token);
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
}
