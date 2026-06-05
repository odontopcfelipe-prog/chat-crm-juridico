'use client';

/**
 * Onda 17.32.79 — Widget de uso do plano (SaaS Fase 4).
 *
 * Mostra barras de progresso de uso (X/Y) pra cada categoria do
 * plano: usuarios, pacientes, inboxes, cobrancas no mes.
 *
 * Quando >= 80% pinta de amber. >= 100% pinta de red e mostra CTA
 * "Atualizar plano".
 *
 * Renderiza so se ADMIN (operador comum nao precisa ver). E so se
 * o plano tiver limites (CUSTOM nao mostra).
 */
import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, TrendingUp, Users, HeartPulse, MessageSquare, Receipt } from 'lucide-react';
import api from '@/lib/api';
import { useRole } from '@/lib/useRole';

interface UsageData {
  plan: string;
  status: string;
  usage: { users: number; patients: number; inboxes: number; charges_this_month: number };
  limits: { max_users: number; max_patients: number; max_inboxes: number; max_charges_per_month: number };
  usage_pct: { users: number; patients: number; inboxes: number; charges_this_month: number };
}

export function PlanUsageWidget() {
  const role = useRole();
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!role?.isAdmin && !role?.isSuperAdmin) return;
    api.get<UsageData>('/tenants/me/usage')
      .then(({ data }) => setData(data))
      .catch(() => { /* silencioso */ })
      .finally(() => setLoading(false));
  }, [role?.isAdmin, role?.isSuperAdmin]);

  if (!role?.isAdmin && !role?.isSuperAdmin) return null;
  if (loading) {
    return (
      <div className="bg-card border border-border rounded-xl p-4 flex items-center justify-center text-muted-foreground text-xs">
        <Loader2 size={12} className="animate-spin mr-1.5" />
        Carregando uso...
      </div>
    );
  }
  if (!data) return null;
  // CUSTOM nao mostra barras (ilimitado em tudo)
  if (data.plan === 'CUSTOM') return null;

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <TrendingUp size={14} className="text-violet-600" />
          <h3 className="text-sm font-bold text-foreground">Uso do plano</h3>
          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-violet-500/15 text-violet-700">
            {data.plan}
          </span>
        </div>
      </div>
      <div className="space-y-2.5">
        <UsageBar label="Usuários" current={data.usage.users} max={data.limits.max_users} pct={data.usage_pct.users} icon={<Users size={11} />} />
        <UsageBar label="Pacientes" current={data.usage.patients} max={data.limits.max_patients} pct={data.usage_pct.patients} icon={<HeartPulse size={11} />} />
        <UsageBar label="Inboxes WhatsApp" current={data.usage.inboxes} max={data.limits.max_inboxes} pct={data.usage_pct.inboxes} icon={<MessageSquare size={11} />} />
        <UsageBar label="Cobranças no mês" current={data.usage.charges_this_month} max={data.limits.max_charges_per_month} pct={data.usage_pct.charges_this_month} icon={<Receipt size={11} />} />
      </div>
      {/* CTA upgrade quando algum >= 80% */}
      {Object.values(data.usage_pct).some((p) => p >= 80) && (
        <div className="mt-3 pt-3 border-t border-border flex items-center gap-2">
          <AlertTriangle size={12} className="text-amber-600 shrink-0" />
          <p className="text-[11px] text-amber-700 flex-1">
            Você está perto do limite do plano <strong>{data.plan}</strong>. Considere atualizar.
          </p>
        </div>
      )}
    </div>
  );
}

function UsageBar({ label, current, max, pct, icon }: {
  label: string; current: number; max: number; pct: number; icon: React.ReactNode;
}) {
  const isUnlimited = max < 0;
  const tone = pct >= 100 ? 'red' : pct >= 80 ? 'amber' : 'emerald';
  const barCls = {
    red: 'bg-red-500',
    amber: 'bg-amber-500',
    emerald: 'bg-emerald-500',
  }[tone];

  return (
    <div>
      <div className="flex items-center justify-between text-[11px] mb-1">
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className="font-bold tabular-nums text-foreground">
          {current}
          {!isUnlimited && <span className="text-muted-foreground">/{max}</span>}
          {isUnlimited && <span className="text-emerald-700"> · ∞</span>}
        </span>
      </div>
      {!isUnlimited && (
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div className={`h-full ${barCls} transition-all`} style={{ width: `${Math.min(pct, 100)}%` }} />
        </div>
      )}
    </div>
  );
}
