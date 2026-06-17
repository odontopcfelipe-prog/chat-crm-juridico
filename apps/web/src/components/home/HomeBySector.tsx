'use client';

/**
 * Onda 17.50 — Home "balões por papel" (rev 4 — alinhada ao skill home-por-setor).
 *
 * Visual fiel ao protótipo Clinicorp (assets/preview-todos-setores.html):
 *   breadcrumb "Início › Setor" → chip laranja do setor → "Bom dia, X · N balões"
 *   → tira fina de KPIs ao vivo → grade de balões (card branco, canto 8px, ícone
 *   CÍRCULO laranja sólido, título + descrição).
 *
 * A home é SEMPRE CLARA (launcher Clinicorp), independente do tema do app —
 * decisão confirmada com o usuário. Por isso o CSS usa paleta fixa (não tokens
 * de tema). Mantém allowSwitch (admin compara perspectivas) e os chips ao vivo
 * (useHomeHighlights). skySlot é aceito por compat mas não é mais renderizado.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Calendar, Zap, Users, MessageSquare, RotateCcw, FileText, LineChart,
  Workflow, CheckCheck, Layers, Receipt, PieChart, Wallet, UserCog,
  Megaphone, Settings, type LucideIcon,
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
  Calendar, Zap, Users, MessageSquare, RotateCcw, FileText, LineChart,
  Workflow, CheckCheck, Layers, Receipt, PieChart, Wallet, UserCog,
  Megaphone, Settings,
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
  const setorLabel = meta.home.persona;

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

      {/* Cabeçalho — breadcrumb + chip do setor + saudação */}
      <div className="hb-crumb">Início <b>›</b> {setorLabel}</div>
      <span className="hb-sector-chip">
        {setorLabel}
        {isPreview && <em className="hb-preview-tag">prévia</em>}
      </span>
      <h1 className="hb-greeting">
        {greeting}, {firstName}
        <span className="hb-count">· {actions.length} {actions.length === 1 ? 'balão' : 'balões'}</span>
      </h1>
      <p className="hb-sub">{meta.home.subtitle}</p>

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
            <span key={i} className="hb-chip">
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

      {/* Grade de balões (estilo Clinicorp) */}
      <div className="hb-grid">
        {actions.map((a) => {
          const Icon = a.lucide ? ICONS[a.lucide] : undefined;
          return (
            <Link key={a.label} href={a.href} className="hb-balao">
              <span className="hb-balao-ico">
                {Icon ? <Icon size={22} strokeWidth={2} /> : <span style={{ fontSize: 20 }}>{a.icon}</span>}
              </span>
              <h3 className="hb-balao-title">{a.label}</h3>
              {a.desc && <p className="hb-balao-desc">{a.desc}</p>}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
