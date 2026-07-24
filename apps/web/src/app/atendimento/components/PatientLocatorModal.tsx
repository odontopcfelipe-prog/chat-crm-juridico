'use client';

// Onda 18.x — "Localizar um paciente" (estilo Clinicorp/Dental Office).
// Abre pela busca do topo: lista os ATENDIMENTOS DO DIA (foto + horário) à
// esquerda + campo de pesquisa; ao clicar num paciente, o RESUMO abre no card
// da direita (foto 3 do pedido). Reusa endpoints existentes:
//   - GET /calendar/events?start&end   (agendamentos do dia; já vem role-scoped)
//   - GET /patients?search=            (busca textual)
//   - GET /patients/:id                (ficha p/ o card da direita)
// Fotos servidas pelo <PatientAvatar> (blob autenticado + fallback WhatsApp).

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  X, Search, ChevronDown, Loader2, CalendarClock,
  ArrowUpRight, MessageCircle, MessageSquare, Video,
} from 'lucide-react';
import api from '@/lib/api';
import { PatientAvatar } from '@/components/PatientAvatar';

// ─── Tipos ────────────────────────────────────────────────────────────────
interface ApptEvent {
  id: string;
  title?: string | null;
  type: string;
  status: string;
  start_at: string;
  end_at?: string | null;
  patient?: { id: string; name: string | null; phone: string | null; avatar_url?: string | null } | null;
  lead?: { id: string; name: string | null; phone: string | null; profile_picture_url?: string | null } | null;
  assigned_user?: { id: string; name: string } | null;
  appointment_type?: { name?: string | null } | null;
}
interface PatientHit {
  id: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}
interface PatientDetail {
  id: string;
  name: string;
  cpf?: string | null;
  rg?: string | null;
  birth_date?: string | null;
  phone?: string | null;
  email?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_phone?: string | null;
  avatar_url?: string | null;
  lead?: { profile_picture_url?: string | null } | null;
  primary_dentist?: { name?: string | null } | null;
}

// ─── Cores de status (ALINHADAS à agenda — EVENT_STATUSES) ──────────────────
const STATUS_COLOR: Record<string, string> = {
  AGENDADO: '#E91E63',
  CONFIRMADO: '#22c55e',
  COMPARECEU: '#0ea5e9',
  EM_ATENDIMENTO: '#f97316',
  CONCLUIDO: '#15803d',
  CANCELADO: '#eab308',
  NO_SHOW: '#991b1b',
};
const statusColor = (s?: string) => STATUS_COLOR[s || ''] || '#E91E63';

// ─── Helpers ────────────────────────────────────────────────────────────────
// "Hoje" no fuso de Maceió (mesma convenção naive-UTC da agenda: campos UTC
// guardam a hora local). Date.now()-3h → data local de Maceió.
function maceioTodayStr(): string {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
// Horário do evento (naive-UTC → ler em UTC pra não deslocar pela tz do browser).
function fmtTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function fmtDayMonth(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function ageFrom(birth?: string | null): number | null {
  if (!birth) return null;
  const b = new Date(birth);
  if (isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}
function fmtBirth(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}
// Formatação de telefone SÓ pra exibição (não mexe no número salvo/envio).
function fmtPhone(raw?: string | null): string {
  if (!raw) return '';
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('55') && d.length > 11) d = d.slice(2); // tira DDI só na exibição
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return raw;
}
// Link click-to-chat do WhatsApp (navegação; não passa pelo nosso pipeline de envio).
function waLink(raw?: string | null): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, '');
  if (!d) return null;
  return `https://wa.me/${d.startsWith('55') ? d : '55' + d}`;
}

// ─── Componente ─────────────────────────────────────────────────────────────
export function PatientLocatorModal({ open, onClose, financialMode = false }: { open: boolean; onClose: () => void; financialMode?: boolean }) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState('');
  const [appts, setAppts] = useState<ApptEvent[]>([]);
  const [loadingAppts, setLoadingAppts] = useState(false);
  const [results, setResults] = useState<PatientHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [showAppts, setShowAppts] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PatientDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setMounted(true); }, []);

  // Reset + foco ao abrir; carrega os agendamentos do dia.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setSelectedId(null);
    setDetail(null);
    setShowAppts(true);
    setTimeout(() => inputRef.current?.focus(), 60);

    setLoadingAppts(true);
    const today = maceioTodayStr();
    api
      .get<ApptEvent[]>('/calendar/events', {
        params: { start: `${today}T00:00:00.000Z`, end: `${today}T23:59:59.999Z` },
      })
      .then((res) => {
        const list = (res.data || [])
          .filter((e) => e.patient || e.lead) // atendimentos (têm paciente/lead)
          .sort((a, b) => (a.start_at || '').localeCompare(b.start_at || ''));
        setAppts(list);
      })
      .catch(() => setAppts([]))
      .finally(() => setLoadingAppts(false));
  }, [open]);

  // Busca textual (debounced) — some os agendamentos quando há query.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      api
        .get<{ data: PatientHit[] }>(`/patients?search=${encodeURIComponent(q)}&limit=8`)
        .then((res) => setResults(res.data?.data ?? []))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  // Abre o resumo (card da direita) — busca a ficha do paciente.
  const selectPatient = useCallback((id: string) => {
    setSelectedId(id);
    setDetail(null);
    setLoadingDetail(true);
    api
      .get<PatientDetail>(`/patients/${id}`)
      .then((res) => setDetail(res.data))
      .catch(() => setDetail(null))
      .finally(() => setLoadingDetail(false));
  }, []);

  // Esc fecha.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open || !mounted) return null;

  const q = query.trim();
  const showingSearch = q.length >= 2;
  // Consulta do dia do paciente selecionado (pra "PRÓXIMA CONSULTA" do card).
  const selAppt = selectedId ? appts.find((a) => a.patient?.id === selectedId) : undefined;

  // ── Linha da lista (agendamento ou resultado de busca) ──
  const ApptRow = ({ a }: { a: ApptEvent }) => {
    const pid = a.patient?.id;
    const name = a.patient?.name || a.lead?.name || 'Sem nome';
    const phone = a.patient?.phone || a.lead?.phone;
    const active = pid && pid === selectedId;
    return (
      <button
        onClick={() => (pid ? selectPatient(pid) : router.push('/atendimento/agenda'))}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
          active ? 'bg-accent' : 'hover:bg-accent/60'
        }`}
      >
        <span
          className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold"
          style={{ color: statusColor(a.status), background: `${statusColor(a.status)}1a`, border: `1px solid ${statusColor(a.status)}55` }}
        >
          {fmtTime(a.start_at)}
          <ChevronDown size={10} className="opacity-60" />
        </span>
        {pid ? (
          <PatientAvatar patientId={pid} patientName={name} avatarUrl={a.patient?.avatar_url} fallbackPhotoUrl={a.lead?.profile_picture_url} size={38} shape="circle" />
        ) : (
          <LeadAvatar name={name} photo={a.lead?.profile_picture_url} />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold text-foreground truncate">{name}</p>
          <p className="text-xs text-muted-foreground truncate">
            {phone ? fmtPhone(phone) : 'sem telefone'} · sem e-mail
          </p>
        </div>
      </button>
    );
  };

  const HitRow = ({ h }: { h: PatientHit }) => (
    <button
      onClick={() => selectPatient(h.id)}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors ${
        h.id === selectedId ? 'bg-accent' : 'hover:bg-accent/60'
      }`}
    >
      <PatientAvatar patientId={h.id} patientName={h.name} avatarUrl={h.avatar_url} size={38} shape="circle" />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold text-foreground truncate">{h.name}</p>
        <p className="text-xs text-muted-foreground truncate">
          {h.phone ? fmtPhone(h.phone) : 'sem telefone'} · {h.email || 'sem e-mail'}
        </p>
      </div>
    </button>
  );

  const modal = (
    <div className="fixed inset-0 z-[200] flex items-start justify-center pt-[8vh] px-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className={`relative bg-card border border-border rounded-2xl shadow-2xl overflow-hidden flex w-full transition-all ${
          selectedId ? 'max-w-4xl' : 'max-w-xl'
        }`}
        style={{ animation: 'fadeInScale 120ms ease-out' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── ESQUERDA: título + busca + lista ── */}
        <div className={`flex flex-col ${selectedId ? 'w-[440px] border-r border-border' : 'w-full'} shrink-0`}>
          <div className="flex items-center justify-between px-5 pt-4 pb-2">
            <h2 className="text-lg font-semibold text-muted-foreground">Localizar um paciente</h2>
            <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent transition-colors">
              <X size={18} />
            </button>
          </div>

          {/* Campo de pesquisa */}
          <div className="px-5 pb-3">
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Localizar paciente (nome, telefone, CPF)"
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-card border border-border text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
              />
              {searching && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground animate-spin" />}
            </div>
          </div>

          {/* Cabeçalho de seção */}
          <button
            onClick={() => !showingSearch && setShowAppts((v) => !v)}
            className="flex items-center gap-1.5 px-5 pb-1.5 text-left"
          >
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
              {showingSearch ? 'Resultados da busca' : 'Próximos atendimentos do dia'}
            </span>
            {!showingSearch && (
              <ChevronDown size={13} className={`text-muted-foreground transition-transform ${showAppts ? '' : '-rotate-90'}`} />
            )}
          </button>

          {/* Lista */}
          <div className="flex-1 overflow-y-auto px-3 pb-4 min-h-[240px] max-h-[62vh]">
            {showingSearch ? (
              searching && results.length === 0 ? (
                <EmptyHint icon={<Loader2 size={22} className="animate-spin" />} text="Buscando…" />
              ) : results.length === 0 ? (
                <EmptyHint icon={<Search size={22} />} text={`Nenhum paciente para "${q}"`} />
              ) : (
                results.map((h) => <HitRow key={h.id} h={h} />)
              )
            ) : !showAppts ? null : loadingAppts ? (
              <EmptyHint icon={<Loader2 size={22} className="animate-spin" />} text="Carregando o dia…" />
            ) : appts.length === 0 ? (
              <EmptyHint icon={<CalendarClock size={22} />} text="Nenhum atendimento hoje" />
            ) : (
              appts.map((a) => <ApptRow key={a.id} a={a} />)
            )}
          </div>
        </div>

        {/* ── DIREITA: card de PERFIL ── */}
        {selectedId && (
          <div className="w-[360px] shrink-0 flex flex-col bg-background/40">
            <div className="flex items-center justify-between px-5 pt-4 pb-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Perfil</span>
              <button onClick={() => { setSelectedId(null); setDetail(null); }} className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent transition-colors">
                <X size={16} />
              </button>
            </div>

            {loadingDetail || !detail ? (
              <div className="flex-1 flex items-center justify-center text-muted-foreground">
                <Loader2 size={24} className="animate-spin" />
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto px-5 pb-4 max-h-[70vh]">
                {/* Foto + identificação */}
                <div className="flex gap-3">
                  <PatientAvatar patientId={detail.id} patientName={detail.name} avatarUrl={detail.avatar_url} fallbackPhotoUrl={detail.lead?.profile_picture_url} size={96} shape="rounded" />
                  <div className="min-w-0 flex-1 pt-1">
                    <p className="text-sm font-bold text-foreground uppercase leading-tight">{detail.name}</p>
                    <dl className="mt-2 space-y-1 text-xs">
                      {ageFrom(detail.birth_date) != null && (
                        <Field label="Nascimento" value={`${fmtBirth(detail.birth_date)} (${ageFrom(detail.birth_date)} anos)`} />
                      )}
                      {detail.cpf && <Field label="CPF" value={detail.cpf} />}
                      {detail.rg && <Field label="RG" value={detail.rg} />}
                    </dl>
                  </div>
                </div>

                {/* Contatos */}
                <div className="mt-5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Contatos</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <Field label="Celular" value={detail.phone ? fmtPhone(detail.phone) : 'não informado'} />
                    <Field label="Emergência" value={detail.emergency_contact_phone ? fmtPhone(detail.emergency_contact_phone) : 'não informado'} />
                    <div className="col-span-2">
                      <Field label="E-mail" value={detail.email || 'não informado'} />
                    </div>
                  </div>
                </div>

                {/* Próxima consulta (do agendamento de hoje, se houver) */}
                {selAppt && (
                  <div className="mt-5">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">Próxima consulta</p>
                    <div className="rounded-lg border-l-4 pl-3 py-2 pr-2 bg-card border border-border" style={{ borderLeftColor: statusColor(selAppt.status) }}>
                      {selAppt.assigned_user?.name && (
                        <p className="text-sm font-semibold text-foreground">com {selAppt.assigned_user.name}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {fmtDayMonth(selAppt.start_at)} · {fmtTime(selAppt.start_at)}
                        {(selAppt.appointment_type?.name || selAppt.title) ? ` — ${selAppt.appointment_type?.name || selAppt.title}` : ''}
                      </p>
                    </div>
                  </div>
                )}

                {/* Ações */}
                <div className="mt-6 flex items-center gap-2">
                  <button
                    onClick={() => { router.push(`/atendimento/pacientes/${detail.id}${financialMode ? '?tab=financial' : ''}`); onClose(); }}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
                  >
                    {financialMode ? 'Abrir financeiro' : 'Abrir ficha'} <ArrowUpRight size={15} />
                  </button>
                  {waLink(detail.phone) && (
                    <a
                      href={waLink(detail.phone)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Abrir no WhatsApp"
                      className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-border text-emerald-600 hover:bg-emerald-500/10 transition-colors"
                    >
                      <MessageCircle size={16} />
                    </a>
                  )}
                  <button
                    onClick={() => { router.push(`/atendimento/pacientes/${detail.id}`); onClose(); }}
                    title="Mensagens"
                    className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-border text-muted-foreground hover:bg-accent transition-colors"
                  >
                    <MessageSquare size={16} />
                  </button>
                  <button
                    disabled
                    title="Teleconsulta (em breve)"
                    className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-border text-muted-foreground/40 cursor-not-allowed"
                  >
                    <Video size={16} />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

// ─── Sub-componentes ──────────────────────────────────────────────────────
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground/70">{label}</dt>
      <dd className="text-foreground font-medium break-words">{value}</dd>
    </div>
  );
}
function EmptyHint({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-muted-foreground/60">
      {icon}
      <p className="text-sm">{text}</p>
    </div>
  );
}
// Avatar simples pra agendamento de LEAD (sem paciente): foto do WhatsApp ou iniciais.
function LeadAvatar({ name, photo }: { name: string; photo?: string | null }) {
  const [err, setErr] = useState(false);
  const initials = (name || '?').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  if (photo && !err) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={photo} alt="" onError={() => setErr(true)} className="w-[38px] h-[38px] rounded-full object-cover shrink-0" />;
  }
  return (
    <span className="w-[38px] h-[38px] rounded-full shrink-0 flex items-center justify-center bg-muted text-muted-foreground text-xs font-bold">
      {initials}
    </span>
  );
}
