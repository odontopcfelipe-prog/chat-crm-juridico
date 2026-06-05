'use client';

/**
 * Onda 17.32.77 — Layout do admin SaaS (SUPER_ADMIN only).
 *
 * Rotas /admin/* sao cross-tenant — so quem tem role SUPER_ADMIN entra.
 * Se nao for, redireciona pro /atendimento ou login.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ShieldCheck, Building2, ArrowLeft } from 'lucide-react';
import { useRole } from '@/lib/useRole';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const role = useRole();
  const isSuperAdmin = !!role?.isSuperAdmin;

  useEffect(() => {
    // Gate: se nao for SUPER_ADMIN, manda pra /atendimento
    if (typeof window === 'undefined') return;
    const token = localStorage.getItem('token');
    if (!token) {
      router.replace('/atendimento/login');
      return;
    }
    if (role && !isSuperAdmin) {
      router.replace('/atendimento');
    }
  }, [role, isSuperAdmin, router]);

  if (role && !isSuperAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 text-center">
        <div>
          <ShieldCheck size={48} className="mx-auto mb-3 text-muted-foreground" />
          <p className="text-base font-bold mb-2">Area restrita</p>
          <p className="text-sm text-muted-foreground mb-4">Esta area eh acessivel apenas pra SUPER_ADMIN.</p>
          <Link href="/atendimento" className="text-sm font-bold text-primary hover:underline">Voltar pro sistema</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <Link href="/atendimento" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs">
            <ArrowLeft size={14} />
            Voltar
          </Link>
          <span className="text-muted-foreground">·</span>
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-violet-600" />
            <span className="text-sm font-bold text-foreground">Admin SaaS</span>
          </div>
        </div>
        <nav className="flex items-center gap-1">
          <Link href="/admin/tenants" className="text-xs font-semibold px-3 py-1.5 rounded-md hover:bg-accent/40 inline-flex items-center gap-1.5">
            <Building2 size={12} />
            Tenants
          </Link>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}
