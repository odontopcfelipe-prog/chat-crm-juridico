'use client';

import axios from 'axios';

/**
 * Cliente HTTP separado para o portal do paciente.
 * Usa token proprio (localStorage 'portal_token') e nao colide com o
 * token de funcionario (localStorage 'token').
 */

const PORTAL_TOKEN_KEY = 'portal_token';

export const PORTAL_API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.host}/api` : '');

const portalApi = axios.create({ baseURL: PORTAL_API_BASE_URL });

portalApi.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem(PORTAL_TOKEN_KEY);
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

export function setPortalToken(jwt: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem(PORTAL_TOKEN_KEY, jwt);
  }
}

export function getPortalToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(PORTAL_TOKEN_KEY);
}

export function clearPortalToken() {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(PORTAL_TOKEN_KEY);
  }
}

export default portalApi;
