'use client';

/**
 * Onda 17.50/17.52/17.58 — Home "MÓDULOS por papel".
 *
 * Header escuro (breadcrumb + chip do papel + "Boa tarde, X") + grade de cards
 * "MÓDULOS": ícone em quadrado arredondado (canto sup. esq., cor por tone),
 * badge de contagem ao vivo no canto sup. dir. (GET /home/module-badges via
 * useModuleBadges), título e descrição. Cada card navega direto (Link).
 *
 * 100% dirigido por papel: os cards vêm de resolveHomeActions(setor, grants,
 * revokes), então UM componente cobre os 6 setores. Home sempre clara fora do
 * header (paleta fixa no CSS, decisão do usuário).
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
  userName?: string;
  /** @deprecated mantido por compat — nao e mais renderizado */
  skySlot?: React.ReactNode;
  allowSwitch?: boolean;
  /** Permissões individuais do usuário — refletem nos cards (Onda 17.52) */
  extraGrants?: Permission[];
  extraRevokes?: Permission[];
}

const DEFAULT_HOUR = 12; // estado neutro pro SSR

const ICONS: Record<string, LucideIcon> = {
  Calendar, Zap, Users, MessageSquare, RotateCcw, FileText, LineChart,
  Workflow, CheckCheck, Layers, Receipt, PieChart, Wallet, UserCog,
  Megaphone, Settings, Cake,
};

function greetingFor(hour: number): string {
  if (hour >= 5  && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

export default function HomeBySector({ sector, userName, allowSwitch = false, extraGrants = [], extraRevokes = [] }: Props) {
  const [hour, setHour] = useState(DEFAULT_HOUR);
  const [previewSector, setPreviewSector] = useState<Sector>(sector);

  useEffect(() => {
    setHour(new Date().getHours());
    const t = setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { setPreviewSector(sector); }, [sector]);

  const active    = previewSector;
  const meta      = getSector(active);
  const greeting  = greetingFor(hour);
  const firstName = userName?.trim().split(' ')[0] || 'visitante';
  const isPreview = active !== sector;
  // Cards EFETIVOS (com grants/revokes do usuário). Só aplica os ajustes no setor
  // REAL; no preview do admin (switcher) mostra só o padrão.
  const actions   = resolveHomeActions(
    active,
    active === sector ? extraGrants : [],
    active === sector ? extraRevokes : [],
  );
  const setorLabel = meta.home.persona;

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

      {/* Header escuro */}
      <header className="hb-hero">
        <div className="hb-crumb">Início <b>›</b> {setorLabel}</div>
        <span className="hb-sector-chip">
          {setorLabel}
          {isPreview && <em className="hb-preview-tag">prévia</em>}
        </span>
        <h1 className="hb-greeting">
          {greeting}, <span className="hb-greeting-name">{firstName}</span>
        </h1>
        <p className="hb-sub">{meta.home.subtitle}</p>
      </header>

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
