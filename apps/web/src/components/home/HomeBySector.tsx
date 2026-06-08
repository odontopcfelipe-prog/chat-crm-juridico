'use client';

/**
 * Onda 17.32.121 — Home dirigida por setor (rev 2 da Fase 4).
 *
 * Mudancas vs rev 1:
 *  - Bloco em destaque (chips/filas/KPIs) entre subtitulo e acoes
 *  - SectorSwitcher opcional no topo (pra SUPER_ADMIN/ADMIN comparar
 *    como cada setor ve sem trocar de user)
 *  - Cards de acoes maiores em grid 3x2 (era 2x2 minusculo)
 *  - Subtitulo melhorado (acompanha hora — "Boa noite! Hora de revisar")
 *
 * HIDRATACAO: hora fixa inicial + useEffect (sem mismatch).
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  getSector, SECTORS,
  type Sector,
} from '@crm/shared';
// Onda 17.32.126 — Chips com dados reais (com fallback pro mock)
import { useHomeHighlights } from '@/lib/useHomeHighlights';
import './home-por-setor.css';

interface Props {
  /** Setor do usuario logado (ja resolvido no servidor) */
  sector: Sector;
  /** Primeiro nome do usuario pra saudacao */
  userName?: string;
  /** Slot opcional pra reusar o <SkyBackdrop/> de producao */
  skySlot?: React.ReactNode;
  /** Se true, mostra seletor "Visualizando como" pra trocar de perspectiva (UX only) */
  allowSwitch?: boolean;
}

const DEFAULT_HOUR = 12; // estado neutro pro SSR

function greetingFor(hour: number): string {
  if (hour >= 5  && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

export default function HomeBySector({ sector, userName, skySlot, allowSwitch = false }: Props) {
  const [hour, setHour] = useState(DEFAULT_HOUR);
  const [previewSector, setPreviewSector] = useState<Sector>(sector);

  useEffect(() => {
    setHour(new Date().getHours());
    const t = setInterval(() => setHour(new Date().getHours()), 60_000);
    return () => clearInterval(t);
  }, []);

  // Quando o setor real muda (props), reseta a preview
  useEffect(() => { setPreviewSector(sector); }, [sector]);

  const active   = previewSector;
  const meta     = getSector(active);
  const greeting = greetingFor(hour);
  const firstName = userName?.trim().split(' ')[0] || 'visitante';
  const isPreview = active !== sector;

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

      {/* Hero — usa <skySlot/> de producao como fundo */}
      <section className="hb-hero">
        {skySlot}
        <div className="hb-hero-content">
          <span className="hb-persona-chip">
            <span style={{ fontSize: 13 }}>{meta.icon}</span>
            {meta.home.persona}
            {isPreview && <span className="hb-preview-tag">prévia</span>}
          </span>
          <h1 className="hb-greeting">
            {greeting}, <em>{firstName}</em> 👋
          </h1>
          <p className="hb-subtitle">{meta.home.subtitle}</p>
        </div>
      </section>

      {/* Bloco em destaque (chips/KPIs/filas) */}
      <div className="hb-highlight">
        <div className="hb-highlight-head">
          <span className="hb-highlight-title">
            <span aria-hidden="true">{meta.home.highlight.icon}</span>
            {meta.home.highlight.title}
            {highlightsLoading && !liveHighlights && (
              <span className="hb-highlight-loading" aria-hidden="true" />
            )}
          </span>
          {highlightCta && (
            <Link href={highlightCta.href} className="hb-highlight-cta">
              {highlightCta.label} →
            </Link>
          )}
        </div>
        <div className="hb-chips">
          {chips.map((c, i) => (
            <div key={i} className="hb-chip" data-tone={c.tone ?? 'violet'}>
              <span className="hb-chip-value">{c.value}</span>
              <span className="hb-chip-label">{c.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Pergunta + grade de acoes */}
      <div className="hb-actions-wrap">
        <h2 className="hb-actions-title">O que vamos fazer agora?</h2>
        <div className="hb-actions">
          {meta.home.actions.map((a) => (
            <Link
              key={a.label}
              href={a.href}
              className="hb-action"
              data-tone={a.tone ?? 'violet'}
            >
              <span className="hb-action-icon">{a.icon}</span>
              <span className="hb-action-label">{a.label}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
