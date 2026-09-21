'use client';

/**
 * Onda 17.50/17.52/17.58 — Home "MÓDULOS por papel".
 *
 * Grade de cards "MÓDULOS" (o header escuro de saudacao/breadcrumb foi
 * removido): ícone em quadrado arredondado (canto sup. esq., cor por tone),
 * badge de contagem ao vivo no canto sup. dir. (GET /home/module-badges via
 * useModuleBadges), título e descrição. Cada card navega direto (Link).
 *
 * 100% dirigido por papel: os cards vêm de resolveHomeActions(setor, grants,
 * revokes), então UM componente cobre os 6 setores. Home sempre clara
 * (paleta fixa no CSS, decisão do usuário).
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Calendar, Zap, Users, MessageSquare, RotateCcw, FileText, LineChart,
  Workflow, CheckCheck, Layers, Receipt, PieChart, Wallet, UserCog,
  Megaphone, Settings, Cake, type LucideIcon,
} from 'lucide-react';
import { getSector, resolveHomeActions, SECTORS, type Sector, type Permission } from '@crm/shared';
import { useModuleBadges } from '@/lib/useModuleBadges';
import './home-por-setor.css';

interface Props {
  sector: Sector;
  /** @deprecated mantido por compat — header de saudacao foi removido */
  userName?: string;
  /** @deprecated mantido por compat — nao e mais renderizado */
  skySlot?: React.ReactNode;
  allowSwitch?: boolean;
  /** Permissões individuais do usuário — refletem nos cards (Onda 17.52) */
  extraGrants?: Permission[];
  extraRevokes?: Permission[];
}

const ICONS: Record<string, LucideIcon> = {
  Calendar, Zap, Users, MessageSquare, RotateCcw, FileText, LineChart,
  Workflow, CheckCheck, Layers, Receipt, PieChart, Wallet, UserCog,
  Megaphone, Settings, Cake,
};

export default function HomeBySector({ sector, allowSwitch = false, extraGrants = [], extraRevokes = [] }: Props) {
  const [previewSector, setPreviewSector] = useState<Sector>(sector);

  useEffect(() => { setPreviewSector(sector); }, [sector]);

  const active    = previewSector;
  const meta      = getSector(active);
  // Cards EFETIVOS (com grants/revokes do usuário). Só aplica os ajustes no setor
  // REAL; no preview do admin (switcher) mostra só o padrão.
  const actions   = resolveHomeActions(
    active,
    active === sector ? extraGrants : [],
    active === sector ? extraRevokes : [],
  );

  const { data: badgesData } = useModuleBadges(active);

  return (
    <div className="home-bs" data-sector={meta.id}>
      {allowSwitch && (
        <div className="hb-switcher">
          <span className="hb-switcher-label">Visualizando a home como:</span>
          <div className="hb-switcher-tabs">
            {SECTORS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`hb-switcher-tab ${active === s.id ? 'is-active' : ''}`}
                onClick={() => setPreviewSector(s.id as Sector)}
              >
                {s.name.replace(' (Atendimento)', '')}
              </button>
            ))}
          </div>
          <span className="hb-switcher-hint">
            ↑ Cada setor vê só o que tem permissão. Troque para comparar.
          </span>
        </div>
      )}

      {/* Grade de MÓDULOS */}
      <div className="hb-section-label">Módulos</div>
      <div className="hb-grid">
        {actions.map((a) => {
          const Icon = a.lucide ? ICONS[a.lucide] : undefined;
          const badge = a.badgeKey ? badgesData?.badges?.[a.badgeKey] : undefined;
          return (
            <Link key={a.label} href={a.href} className="hb-balao">
              <span className="hb-balao-ico" data-tone={a.tone}>
                {Icon ? <Icon size={22} strokeWidth={2} /> : <span style={{ fontSize: 20 }}>{a.icon}</span>}
              </span>
              {badge && (
                <span className="hb-badge" data-tone={badge.tone ?? a.tone}>{badge.value}</span>
              )}
              <h3 className="hb-balao-title">{a.label}</h3>
              {a.desc && <p className="hb-balao-desc">{a.desc}</p>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
