'use client';

/**
 * Out/2026 — "Boas-vindas" da Minha agenda (pedido do dono).
 *
 * Botão discreto ao lado do nome do paciente abre esta tela CHEIA, feita pra
 * dentista virar pro paciente: foto grande, saudação pelo nome e um resumo breve
 * (o de hoje, as etapas do tratamento e o próximo passo).
 *
 * - Neutra e multi-clínica: paleta clara FIXA (independe do tema do app); a única
 *   cor é a da clínica (Tenant.theme_color — anel da foto, traço e barra), e o
 *   logo/nome vêm do cadastro da clínica. Sem cor cadastrada = cinza.
 * - Sem valores, contato nem alergia (a tela fica de frente pro paciente). O
 *   resumo vem de GET /patients/:id/welcome (carteira do dentista barrada na API).
 * - Setas (botões ou ←/→) passam pros outros pacientes do dia; Esc fecha.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import api from '@/lib/api';
import { useTenant } from '@/lib/useTenant';
import { PatientAvatar } from '@/components/PatientAvatar';
import './boas-vindas.css';

export interface BoasVindasEvento {
  id: string;
  type: string;
  title: string | null;
  patient?: { id: string; name: string; avatar_url?: string | null } | null;
  lead?: { id: string; name: string | null; profile_picture_url?: string | null } | null;
  appointment_type?: { name?: string | null } | null;
}

interface WelcomeSummary {
  gender: string | null;
  since: string;
  previous_visits: number;
  today: string[];
  plan: { done: number; total: number; next: string | null } | null;
}

interface Props {
  events: BoasVindasEvento[];
  startId: string;
  dentistName: string | null;
  onClose: () => void;
}

const TYPE_LABEL: Record<string, string> = {
  CONSULTA: 'Consulta', PROCEDIMENTO: 'Procedimento', RETORNO: 'Retorno', ORTODONTIA: 'Ortodontia',
};
const DAYS_PT = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const MONTHS_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const NEUTRAL = '#6B7280';

/** Cor da clínica legível no fundo claro: sem cor (ou inválida) = cinza; clara demais = escurece. */
function accentFrom(hex: string | null | undefined): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return NEUTRAL;
  const n = parseInt(m[1], 16);
  let [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum > 0.62) [r, g, b] = [r, g, b].map((c) => Math.round(c * 0.62));
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** "Maria Aparecida Santos" → "Maria Aparecida"; "Ana de Souza" → "Ana de Souza". */
function welcomeName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  const take = parts.length > 2 && /^(d[aeo]s?|e)$/i.test(parts[1]) ? 3 : 2;
  return parts.slice(0, take).join(' ') || full;
}

function greeting(s: WelcomeSummary | null, first: boolean): string {
  const g = s?.gender;
  if (first) return g === 'F' ? 'Bem-vinda' : g === 'M' ? 'Bem-vindo' : 'Olá';
  return g === 'F' ? 'Bem-vinda de volta' : g === 'M' ? 'Bem-vindo de volta' : 'Que bom te ver de novo';
}

/** Tamanho da foto pela largura da tela (o PatientAvatar recebe px). Até 900px a
 *  tela empilha (foto em cima do texto), então a foto pode ocupar mais da largura. */
function usePhotoSize() {
  const fit = (w: number) => (w < 900
    ? Math.min(340, Math.max(180, w * 0.5))
    : Math.min(440, Math.max(200, w * 0.3)));
  const calc = () => (typeof window === 'undefined' ? 400 : Math.round(fit(window.innerWidth)));
  const [size, setSize] = useState(calc);
  useEffect(() => {
    const on = () => setSize(calc());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function BoasVindasPaciente({ events, startId, dentistName, onClose }: Props) {
  const tenant = useTenant();
  const photo = usePhotoSize();
  const now = useClock();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const [idx, setIdx] = useState(() => Math.max(0, events.findIndex((e) => e.id === startId)));
  const ev = events[idx] ?? events[0];
  const [summaries, setSummaries] = useState<Record<string, WelcomeSummary | null>>({});
  const summary = ev ? summaries[ev.id] : undefined;

  useEffect(() => {
    if (!ev || ev.id in summaries) return;
    // Sem cadastro de paciente (só lead) = ainda não veio à clínica: primeira visita.
    if (!ev.patient) { setSummaries((m) => ({ ...m, [ev.id]: null })); return; }
    let alive = true;
    api.get<WelcomeSummary>(`/patients/${ev.patient.id}/welcome`, { params: { eventId: ev.id } })
      .then((r) => { if (alive) setSummaries((m) => ({ ...m, [ev.id]: r.data })); })
      .catch(() => { if (alive) setSummaries((m) => ({ ...m, [ev.id]: null })); });
    return () => { alive = false; };
  }, [ev, summaries]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setIdx((i) => (i + 1) % events.length);
      else if (e.key === 'ArrowLeft') setIdx((i) => (i + events.length - 1) % events.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [events.length, onClose]);

  const accent = useMemo(() => accentFrom(tenant?.theme_color), [tenant?.theme_color]);

  if (!mounted || !ev) return null;

  const fullName = ev.patient?.name || ev.lead?.name || ev.title || 'Paciente';
  const loaded = summary !== undefined;
  const first = !summary || summary.previous_visits === 0;
  const plan = summary?.plan ?? null;
  const pct = plan && plan.total ? Math.round((plan.done / plan.total) * 100) : 0;
  const what = ev.appointment_type?.name || TYPE_LABEL[ev.type] || ev.type;
  const today = summary?.today?.length
    ? summary.today[0] + (summary.today.length > 1 ? ` +${summary.today.length - 1}` : '')
    : what;
  const line = first
    ? 'É a sua primeira vez aqui. Hoje a gente vai conhecer o seu sorriso e montar, junto com você, o melhor plano.'
    : `Que bom ter você de volta. Esta é a sua ${summary!.previous_visits + 1}ª visita.` +
      (plan && pct >= 50 && pct < 100 ? ' Você já passou da metade do tratamento.' : '');
  const badge = first ? 'Primeira visita' : `Paciente desde ${new Date(summary!.since).getFullYear()}`;
  const dateLabel = `${DAYS_PT[now.getDay()]}, ${now.getDate()} de ${MONTHS_PT[now.getMonth()]}`;
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const style = { '--bv-accent': accent } as CSSProperties;

  return createPortal(
    <div className="bv" style={style} role="dialog" aria-modal="true" aria-label={`Boas-vindas a ${fullName}`}>
      <div className="bv-deco-a" aria-hidden />
      <div className="bv-deco-b" aria-hidden />

      <header className="bv-top">
        <div className="bv-brand">
          {tenant?.logo_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={tenant.logo_url} alt={tenant.name || 'Logo da clínica'} className="bv-logo" />
          ) : (
            <span className="bv-logo bv-logo-mark">{(tenant?.name || 'C').charAt(0)}</span>
          )}
          {tenant?.name && <span className="bv-brand-name">{tenant.name}</span>}
        </div>
        <div className="bv-top-right">
          <div className="bv-when">
            <span>{dateLabel}</span>
            <b>{clock}</b>
          </div>
          <button type="button" className="bv-round" onClick={onClose} aria-label="Fechar boas-vindas" title="Fechar (Esc)">
            <X size={20} />
          </button>
        </div>
      </header>

      <main className="bv-main" key={ev.id}>
        <div className="bv-photo-col bv-in">
          <div className="bv-halo">
            <div className="bv-ring">
              <PatientAvatar
                patientId={ev.patient?.id ?? ev.lead?.id ?? ev.id}
                patientName={fullName}
                avatarUrl={ev.patient?.avatar_url ?? null}
                fallbackPhotoUrl={ev.lead?.profile_picture_url}
                size={photo}
                shape="circle"
              />
            </div>
          </div>
          {loaded && <span className="bv-badge"><i aria-hidden />{badge}</span>}
        </div>

        <div className="bv-text">
          <p className="bv-hello bv-in">{loaded ? `${greeting(summary ?? null, first)},` : ' '}</p>
          <h1 className="bv-name bv-in2">{welcomeName(fullName)}</h1>
          <div className="bv-bar bv-in2" aria-hidden />
          {loaded ? (
            <>
              <p className="bv-line bv-in3">{line}</p>
              <div className="bv-cards bv-in3">
                <div className="bv-card">
                  <span className="bv-card-label">Hoje</span>
                  <span className="bv-card-value">{today}</span>
                </div>
                {(plan || first) && (
                  <div className="bv-card">
                    <span className="bv-card-label">Seu tratamento</span>
                    {plan ? (
                      <>
                        <span className="bv-card-value">{plan.done} de {plan.total} {plan.total === 1 ? 'etapa' : 'etapas'}</span>
                        <span className="bv-progress"><span style={{ width: `${pct}%` }} /></span>
                      </>
                    ) : (
                      <span className="bv-card-value">Vamos montar juntos</span>
                    )}
                  </div>
                )}
                {(plan?.next || (first && !plan)) && (
                  <div className="bv-card">
                    <span className="bv-card-label">Próximo passo</span>
                    <span className="bv-card-value">{plan?.next || 'Plano sob medida'}</span>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="bv-loading" aria-hidden><span /><span /></div>
          )}
        </div>
      </main>

      <footer className="bv-foot">
        {dentistName ? (
          <div className="bv-dentist">
            <span className="bv-dentist-mark">{dentistName.replace(/^(dra?\.?\s+)/i, '').charAt(0).toUpperCase()}</span>
            <div>
              <span>Seu atendimento hoje é com</span>
              <b>{dentistName}</b>
            </div>
          </div>
        ) : <span />}
        {events.length > 1 && (
          <div className="bv-nav">
            <button type="button" className="bv-round" onClick={() => setIdx((i) => (i + events.length - 1) % events.length)} aria-label="Paciente anterior">
              <ChevronLeft size={18} />
            </button>
            <span>paciente {idx + 1} de {events.length}</span>
            <button type="button" className="bv-round" onClick={() => setIdx((i) => (i + 1) % events.length)} aria-label="Próximo paciente">
              <ChevronRight size={18} />
            </button>
          </div>
        )}
      </footer>
    </div>,
    document.body,
  );
}
