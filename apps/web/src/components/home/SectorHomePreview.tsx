'use client';

/**
 * Onda 17.52 — Prévia compacta da home (balões) de um setor.
 *
 * Mostra no editor de usuário "o que essa pessoa vai ver" ao escolher o setor —
 * read-only, atualiza junto com a seleção do card de setor. Reaproveita a config
 * única (sectors.config.ts via getSector) e o mesmo visual da home: ícone em
 * círculo laranja Clinicorp + título + descrição.
 */
import {
  Calendar, Zap, Users, MessageSquare, RotateCcw, FileText, LineChart,
  Workflow, CheckCheck, Layers, Receipt, PieChart, Wallet, UserCog,
  Megaphone, Settings, Cake, type LucideIcon,
} from 'lucide-react';
import { getSector, resolveHomeActions, type Sector, type Permission } from '@crm/shared';

const ICONS: Record<string, LucideIcon> = {
  Calendar, Zap, Users, MessageSquare, RotateCcw, FileText, LineChart,
  Workflow, CheckCheck, Layers, Receipt, PieChart, Wallet, UserCog,
  Megaphone, Settings, Cake,
};

export function SectorHomePreview({
  sector,
  extraGrants = [],
  extraRevokes = [],
}: {
  sector: Sector;
  extraGrants?: Permission[];
  extraRevokes?: Permission[];
}) {
  const meta = getSector(sector);
  // Onda 17.52 — reflete as permissões EFETIVAS (concedidas/revogadas), não só
  // os defaults do setor: granted extra adiciona o balão; revogada remove.
  const actions = resolveHomeActions(sector, extraGrants, extraRevokes);
  const isAdmin = meta.id === 'admin';

  return (
    <div className="space-y-1.5">
      <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider ml-1">
        Prévia da home
        <span className="text-muted-foreground/60 normal-case font-medium"> — o que esse usuário vai ver</span>
      </label>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3 border border-border rounded-xl bg-background/50">
        {actions.map((a) => {
          const Icon = a.lucide ? ICONS[a.lucide] : undefined;
          return (
            <div key={a.label} className="bg-card border border-border rounded-lg p-2.5">
              <span
                className="w-8 h-8 rounded-full flex items-center justify-center text-white"
                style={{ background: '#F26C1B' }}
              >
                {Icon ? <Icon size={15} strokeWidth={2} /> : <span className="text-sm">{a.icon}</span>}
              </span>
              <div className="text-[12px] font-bold text-foreground mt-1.5 leading-tight">{a.label}</div>
              {a.desc && (
                <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">{a.desc}</div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-muted-foreground/70 ml-1 leading-tight">
        {isAdmin
          ? 'O Adm Geral também mantém a barra lateral completa, além desses balões.'
          : 'Essa é a tela inicial (balões) que esse setor vê — sem barra lateral.'}
      </p>
    </div>
  );
}
