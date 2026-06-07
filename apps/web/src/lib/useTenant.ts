'use client';

/**
 * Onda 17.32.78 — Hook que retorna dados do Tenant logado.
 *
 * Cacheia em memoria por instancia da aplicacao (recarrega no login).
 * Usado pelo Sidebar, login e componentes que precisam de white-label
 * (logo, cor, nome).
 *
 * SSR: retorna null. Componentes devem ter fallback.
 */
import { useEffect, useState } from 'react';
import api from '@/lib/api';

export interface TenantBranding {
  id: string;
  name: string;
  slug: string | null;
  logo_url: string | null;
  theme_color: string | null; // hex ex "#7c3aed"
  // Onda 17.32.104 — Contatos da clinica (vieram do signup ou
  // /settings/identidade). Usados em headers, recibos, e-mails.
  phone: string | null;
  email: string | null;
  cpf_cnpj: string | null;
  custom_domain: string | null;
  status: string;
  plan: string;
  trial_ends_at: string | null;
}

// Cache em modulo — todas as instancias do hook compartilham.
let cached: TenantBranding | null = null;
let inflight: Promise<TenantBranding | null> | null = null;

async function fetchTenant(): Promise<TenantBranding | null> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { data } = await api.get<TenantBranding>('/tenants/me');
      cached = data || null;
      return cached;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Reseta o cache — chamar no logout/login. */
export function resetTenantCache() {
  cached = null;
}

export function useTenant(): TenantBranding | null {
  const [tenant, setTenant] = useState<TenantBranding | null>(cached);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const token = localStorage.getItem('token');
    if (!token) {
      setTenant(null);
      return;
    }
    void fetchTenant().then((t) => setTenant(t));
  }, []);

  return tenant;
}

/**
 * Aplica o theme_color como CSS custom property no <html>.
 * Use no AtendimentoLayout pra deixar branding global.
 */
export function applyTenantTheme(tenant: TenantBranding | null) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (tenant?.theme_color) {
    // Cor primaria custom — converte hex pra RGB pra ficar compativel
    // com Tailwind opacity (bg-primary/20 etc)
    const hex = tenant.theme_color.replace('#', '');
    if (hex.length === 6) {
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      root.style.setProperty('--tenant-primary', `${r} ${g} ${b}`);
      root.style.setProperty('--tenant-primary-hex', tenant.theme_color);
    }
  } else {
    root.style.removeProperty('--tenant-primary');
    root.style.removeProperty('--tenant-primary-hex');
  }
}
