'use client';

/**
 * Onda 17.50 — Home "balões por papel" (rev 3 — alinhada ao mockup do usuário).
 *
 * Layout plano (estilo mockup):
 *   cabeçalho compacto (badge do papel + saudação + "N balões" + subtítulo)
 *   → tira fina de KPIs ao vivo
 *   → grade de balões (ícone laranja + título + descrição), cada um leva
 *     direto pra rota do módulo.
 *
 * Mantém: allowSwitch (admin troca de perspectiva pra comparar) e os chips
 * ao vivo (useHomeHighlights, com fallback pro mock). skySlot é aceito por
 * compatibilidade com os call-sites antigos, mas não é mais renderizado
 * (a home virou plana, sem o banner roxo).
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Calendar, Zap, Users, MessageSquare, Bell, FileText, ClipboardList,
  Briefcase, Sparkles, Handshake, Layers, BarChart3, Receipt, PieChart,
  Wallet, UserCog, Megaphone, Settings, type LucideIcon,
} from 'lucide-react';
import { getSector, SECTORS, type Sector } from '@crm/shared';
// Onda 17.32.126 — Chips com dados reais (com fallback pro mock)
import { useHomeHighlights } from '@/lib/useHomeHighlights';
import './home-por-setor.css';

interface Props {
  /** Setor do usuario logado (ja resolvido) */
  sector: Sector;
  /** Primeiro nome do usuario pra saudacao */
  userName?: string;
  /** @deprecated mantido por compat — nao e mais renderizado */
  skySlot?: React.ReactNode;
  /** Se true, mostra seletor "Visualizando como" pra trocar de perspectiva (UX only) */
  allowSwitch?: boolean;
}

const DEFAULT_HOUR = 12; // estado neutro pro SSR

// Mapa nome→componente lucide (os ícones referenciados em sectors.config.ts).
// Mantido aqui (e não no shared) pra não acoplar o pacote shared ao React.
const ICONS: Record<string, LucideIcon> = {
  Calendar, Zap, Users, MessageSquare, Bell, FileText, ClipboardList,
  Briefcase, Sparkles, Handshake, Layers, BarChart3, Receipt, PieChart,
  Wallet, UserCog, Megaphone, Settings,
};

function greetingFor(hour: number): string {
  if (hour >= 5  && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

export default function HomeBySector({ sector, userName, allowSwitch = false }: Props) {
  const [hour, setHour] = useState(DEFAULT_HOUR);
  const [previewSector, setPreviewSector] = useState<Sector>(sector);

  useEffect(() => {
    setHour(new Date().getHours());
    const t = setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Quando o setor real muda (props), reseta a preview
  useEffect(() => { setPreviewSector(sector); }, [sector]);

  const active    = previewSector;
  const meta      = getSector(active);
  const greeting  = greetingFor(hour);
  const firstName = userName?.trim().split(' ')[0] || 'visitante';
  const isPreview = active !== sector;
  const actions   = meta.home.actions;

  // Onda 17.32.126 — Chips reais via API; cai no mock se falhar/loading
  const { data: liveHighlights, loading: highlightsLoading } = useHomeHighlights(active);
  const chips = liveHighlights?.chips?.length
    ? liveHighlights.chips
    : meta.home.highlight.chips;
  const highlightCta = liveHighlights?.cta ?? meta.home.highlight.cta;

  return (
    <div className="home-bs" data-sector={meta.id}>
      {/* Seletor de visualização — só pra SUPER_ADMIN/ADMIN comparar */}
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

      {/* Cabeçalho compacto */}
      <header className="hb-head">
        <span className="hb-persona-badge">
          <span aria-hidden="true" style={{ fontSize: 12 }}>{meta.icon}</span>
          {meta.home.persona}
          {isPreview && <span className="hb-preview-tag">prévia</span>}
        </span>
        <h1 className="hb-greeting">
          {greeting}, <em>{firstName}</em>
          <span className="hb-count">· {actions.length} {actions.length === 1 ? 'balão' : 'balões'}</span>
        </h1>
        <p className="hb-subtitle">{meta.home.subtitle}</p>
      </header>

      {/* Tira fina de KPIs ao vivo */}
      <div className="hb-kpis">
        <span className="hb-kpis-title">
          <span aria-hidden="true">{meta.home.highlight.icon}</span>
          {meta.home.highlight.title}
          {highlightsLoading && !liveHighlights && (
            <span className="hb-kpis-loading" aria-hidden="true" />
          )}
        </span>
        <div className="hb-chips">
          {chips.map((c, i) => (
            <span key={i} className="hb-chip" data-tone={c.tone ?? 'violet'}>
              <span className="hb-chip-value">{c.value}</span>
              <span className="hb-chip-label">{c.label}</span>
            </span>
          ))}
        </div>
        {highlightCta && (
          <Link href={highlightCta.href} className="hb-kpis-cta">
            {highlightCta.label} →
          </Link>
        )}
      </div>

      {/* Grade de balões */}
      <div className="hb-actions">
        {actions.map((a) => {
          const Icon = a.lucide ? ICONS[a.lucide] : undefined;
          return (
            <Link key={a.label} href={a.href} className="hb-action">
              <span className="hb-action-icon">
                {Icon ? <Icon size={22} strokeWidth={2} /> : <span style={{ fontSize: 20 }}>{a.icon}</span>}
              </span>
              <span className="hb-action-text">
                <span className="hb-action-label">{a.label}</span>
                {a.desc && <span className="hb-action-desc">{a.desc}</span>}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
