'use client';

/**
 * Onda 17.50/17.52 — Home "balões por papel" (Clinicorp) com PRÉVIA ao clicar.
 *
 * Visual fiel ao protótipo (assets/preview-todos-setores.html): breadcrumb +
 * chip do setor + "Bom dia, X · N balões" + tira de KPIs + grade de balões
 * (card branco, canto 8px, ícone CÍRCULO laranja).
 *
 * Onda 17.52 — Balões cuja rota está em PREVIEW_BY_HREF, ao clicar, expandem
 * uma PRÉVIA inline (top-5 itens reais via GET /home/preview), com "Abrir" pra
 * entrar de vez e "voltar" pra grade. Os demais navegam direto (Link).
 *
 * Home SEMPRE CLARA (paleta fixa no CSS), decisão do usuário. skySlot é aceito
 * por compat mas não é mais renderizado.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Calendar, Zap, Users, MessageSquare, RotateCcw, FileText, LineChart,
  Workflow, CheckCheck, Layers, Receipt, PieChart, Wallet, UserCog,
  Megaphone, Settings, ArrowLeft, ArrowRight, Loader2, type LucideIcon,
} from 'lucide-react';
import { getSector, SECTORS, type Sector } from '@crm/shared';
// Onda 17.32.126 — Chips com dados reais (com fallback pro mock)
import { useHomeHighlights } from '@/lib/useHomeHighlights';
import api from '@/lib/api';
import './home-por-setor.css';

interface Props {
  sector: Sector;
  userName?: string;
  /** @deprecated mantido por compat — nao e mais renderizado */
  skySlot?: React.ReactNode;
  allowSwitch?: boolean;
}

const DEFAULT_HOUR = 12; // estado neutro pro SSR

const ICONS: Record<string, LucideIcon> = {
  Calendar, Zap, Users, MessageSquare, RotateCcw, FileText, LineChart,
  Workflow, CheckCheck, Layers, Receipt, PieChart, Wallet, UserCog,
  Megaphone, Settings,
};

// Onda 17.52 — href do balão -> chave de prévia (GET /home/preview?key=).
// Só os balões cuja rota está aqui ganham prévia ao clicar; o resto navega.
const PREVIEW_BY_HREF: Record<string, string> = {
  '/atendimento/crm': 'crc',
  '/atendimento/return-alerts': 'return-alerts',
  '/atendimento/orcamentos?status=SENT': 'propostas',
  '/atendimento': 'whatsapp',
};

interface PreviewItem { title: string; subtitle: string }
interface PreviewResp { key: string; items: PreviewItem[]; cta?: { label: string; href: string } }

function greetingFor(hour: number): string {
  if (hour >= 5  && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

export default function HomeBySector({ sector, userName, allowSwitch = false }: Props) {
  const router = useRouter();
  const [hour, setHour] = useState(DEFAULT_HOUR);
  const [previewSector, setPreviewSector] = useState<Sector>(sector);

  // ─── Prévia ao clicar ──────────────────────────────────────────
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [openMeta, setOpenMeta] = useState<{ label: string; href: string; lucide?: string } | null>(null);
  const [previewData, setPreviewData] = useState<PreviewResp | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

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
  const actions   = meta.home.actions;
  const setorLabel = meta.home.persona;

  // Fecha a prévia ao trocar de setor (seletor do admin)
  useEffect(() => { setOpenKey(null); setOpenMeta(null); }, [active]);

  const openPreview = async (key: string, a: { label: string; href: string; lucide?: string }) => {
    setOpenKey(key);
    setOpenMeta(a);
    setPreviewData(null);
    setPreviewLoading(true);
    try {
      const r = await api.get<PreviewResp>('/home/preview', { params: { key } });
      setPreviewData(r.data);
    } catch {
      setPreviewData({ key, items: [] });
    } finally {
      setPreviewLoading(false);
    }
  };

  const { data: liveHighlights, loading: highlightsLoading } = useHomeHighlights(active);
  const chips = liveHighlights?.chips?.length ? liveHighlights.chips : meta.home.highlight.chips;
  const highlightCta = liveHighlights?.cta ?? meta.home.highlight.cta;

  const OpenIcon = openMeta?.lucide ? ICONS[openMeta.lucide] : undefined;

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

      {/* Cabeçalho */}
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
          {highlightsLoading && !liveHighlights && <span className="hb-kpis-loading" aria-hidden="true" />}
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
          <Link href={highlightCta.href} className="hb-kpis-cta">{highlightCta.label} →</Link>
        )}
      </div>

      {/* Prévia (ao clicar num balão) OU grade de balões */}
      {openKey && openMeta ? (
        <div className="hb-preview">
          <button type="button" className="hb-preview-back" onClick={() => { setOpenKey(null); setOpenMeta(null); }}>
            <ArrowLeft size={15} /> voltar aos balões
          </button>
          <div className="hb-preview-card">
            <div className="hb-preview-head">
              <span className="hb-balao-ico">
                {OpenIcon ? <OpenIcon size={20} strokeWidth={2} /> : null}
              </span>
              <div className="hb-preview-headtext">
                <span className="hb-preview-title">Prévia · {openMeta.label}</span>
                <span className="hb-preview-sub">
                  {previewLoading ? 'carregando…' : `${previewData?.items.length ?? 0} ${(previewData?.items.length ?? 0) === 1 ? 'item' : 'itens'}`}
                </span>
              </div>
              <button type="button" className="hb-preview-open" onClick={() => router.push(openMeta.href)}>
                Abrir {openMeta.label} <ArrowRight size={14} />
              </button>
            </div>

            {previewLoading ? (
              <div className="hb-preview-loading"><Loader2 size={16} className="hb-spin" /> Carregando…</div>
            ) : previewData && previewData.items.length > 0 ? (
              <ul className="hb-preview-list">
                {previewData.items.map((it, i) => (
                  <li key={i} className="hb-preview-item">
                    <span className="hb-preview-item-title">{it.title}</span>
                    <span className="hb-preview-item-sub">{it.subtitle}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hb-preview-empty">Nada por aqui agora. 🎉</p>
            )}
          </div>
        </div>
      ) : (
        <div className="hb-grid">
          {actions.map((a) => {
            const Icon = a.lucide ? ICONS[a.lucide] : undefined;
            const pk = PREVIEW_BY_HREF[a.href];
            const inner = (
              <>
                <span className="hb-balao-ico">
                  {Icon ? <Icon size={22} strokeWidth={2} /> : <span style={{ fontSize: 20 }}>{a.icon}</span>}
                </span>
                <h3 className="hb-balao-title">{a.label}</h3>
                {a.desc && <p className="hb-balao-desc">{a.desc}</p>}
              </>
            );
            return pk ? (
              <button
                key={a.label}
                type="button"
                className="hb-balao hb-balao-btn"
                onClick={() => openPreview(pk, { label: a.label, href: a.href, lucide: a.lucide })}
              >
                {inner}
                <span className="hb-balao-peek">prévia ao clicar</span>
              </button>
            ) : (
              <Link key={a.label} href={a.href} className="hb-balao">{inner}</Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
