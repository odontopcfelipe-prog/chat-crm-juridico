'use client';

import { useRouter } from 'next/navigation';
import { MessageSquare, Calendar, Briefcase, Settings, LayoutDashboard, HelpCircle } from 'lucide-react';
import type { RoleInfo } from '@/lib/useRole';

const ALL_ACTIONS = [
  { label: 'Atendimento', icon: MessageSquare, href: '/atendimento', color: 'text-blue-500 bg-blue-500/10', roles: ['ADMIN', 'OPERADOR', 'COMERCIAL', 'DENTIST'] },
  { label: 'Agenda', icon: Calendar, href: '/atendimento/agenda', color: 'text-rose-500 bg-rose-500/10', roles: ['ADMIN', 'DENTIST', 'OPERADOR', 'COMERCIAL', 'ASSISTANT'] },
  { label: 'CRM', icon: Briefcase, href: '/atendimento/crm', color: 'text-sky-400 bg-sky-500/10', roles: ['ADMIN', 'OPERADOR', 'COMERCIAL'] },
  { label: 'Financeiro', icon: Settings, href: '/atendimento/financeiro', color: 'text-emerald-500 bg-emerald-500/10', roles: ['ADMIN', 'FINANCEIRO'] },
  { label: 'Manual', icon: HelpCircle, href: '/atendimento/manual', color: 'text-violet-500 bg-violet-500/10', roles: ['ADMIN', 'DENTIST', 'OPERADOR', 'COMERCIAL', 'ASSISTANT', 'FINANCEIRO'] },
  { label: 'Ajustes', icon: Settings, href: '/atendimento/settings', color: 'text-gray-400 bg-gray-500/10', roles: ['ADMIN'] },
];

interface Props {
  roleInfo: RoleInfo;
}

export function QuickActions({ roleInfo }: Props) {
  const router = useRouter();
  const actions = roleInfo.role
    ? ALL_ACTIONS.filter((a) => a.roles.includes(roleInfo.role!))
    : ALL_ACTIONS.slice(0, 6);

  return (
    <div>
      <h2 className="text-sm font-bold text-foreground mb-3 flex items-center gap-2">
        <LayoutDashboard size={15} className="text-primary" />
        Acesso Rapido
      </h2>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <button
              key={action.label}
              onClick={() => router.push(action.href)}
              className="bg-card border border-border rounded-xl p-3 flex flex-col items-center gap-1.5 hover:border-primary/40 hover:shadow-md hover:shadow-primary/5 transition-all group"
            >
              <div className={`w-8 h-8 rounded-lg ${action.color} flex items-center justify-center group-hover:scale-110 transition-transform`}>
                <Icon size={16} />
              </div>
              <span className="text-[10px] font-semibold text-muted-foreground group-hover:text-foreground transition-colors">{action.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
