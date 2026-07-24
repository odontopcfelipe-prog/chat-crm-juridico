'use client';

// Onda 18.x — Busca CONTEXTUAL do header pras seções que não são "paciente":
//   - agenda  → GET /calendar/search?q= (casa título/desc/nome do paciente/lead) →
//               abre o evento via sessionStorage 'open_event_id' + push /agenda.
//   - contact → GET /leads?search= → abre a conversa em /atendimento/chat/:leadId.
// (Pacientes e Financeiro usam o PatientLocatorModal, mais rico.) Modal enxuto:
// campo + lista de resultados; click navega. Reusa <PatientAvatar> quando o
// resultado tem paciente vinculado (foto autenticada).

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { X, Search, Loader2, CalendarClock, MessageCircle } from 'lucide-react';
import api from '@/lib/api';
import { PatientAvatar } from '@/components/PatientAvatar';

export type SearchKind = 'agenda' | 'contact';

interface ResultItem {
  id: string;
  title: string;
  subtitle: string;
  patientId?: string | null;      // vinculado a paciente → PatientAvatar (foto autenticada)
  avatarUrl?: string | null;      // avatar_url do paciente (pro blob)
  photoUrl?: string | null;       // foto direta (WhatsApp) p/ lead
  onSelect: () => void;
}

const CONFIG: Record<SearchKind, { title: string; placeholder: string; hint: string }> = {
  agenda: { title: 'Localizar na agenda', placeholder: 'Buscar por paciente ou evento…', hint: 'Digite o nome do paciente ou do evento' },
  contact: { title: 'Localizar contato', placeholder: 'Buscar por nome, telefone ou e-mail…', hint: 'Digite o nome, telefone ou e-mail do contato' },
};

// Horário/data em UTC "naive" (mesma convenção da agenda: campos UTC = hora local).
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
function fmtPhone(raw?: string | null): string {
  if (!raw) return '';
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('55') && d.length > 11) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return raw;
}

export function ContextualSearchModal({ open, onClose, kind }: { open: boolean; onClose: () => void; kind: SearchKind }) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ResultItem[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cfg = CONFIG[kind];

  useEffect(() => { setMounted(true); }, []);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setResults([]);
    setTimeout(() => inputRef.current?.focus(), 60);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open, onClose]);

  const runSearch = useCallback(async (q: string): Promise<ResultItem[]> => {
    if (kind === 'agenda') {
      const res = await api.get('/calendar/search', { params: { q } });
      const events = (res.data || []) as any[];
      return events.map((e): ResultItem => {
        const name = e.patient?.name || e.lead?.name || e.title || 'Evento';
        const proc = e.appointment_type?.name || e.title;
        return {
          id: e.id,
          title: name,
          subtitle:
            `${fmtDayMonth(e.start_at)} · ${fmtTime(e.start_at)}` +
            (proc && proc !== name ? ` — ${proc}` : '') +
            (e.assigned_user?.name ? ` · ${e.assigned_user.name}` : ''),
          patientId: e.patient?.id ?? null,
          avatarUrl: e.patient?.avatar_url ?? null,
          photoUrl: e.lead?.profile_picture_url ?? null,
          onSelect: () => {
            try { sessionStorage.setItem('open_event_id', e.id); } catch { /* ignore */ }
            router.push('/atendimento/agenda');
            onClose();
          },
        };
      });
    }
    // contact
    const res = await api.get('/leads', { params: { search: q, limit: 8 } });
    const leads = ((res.data?.data ?? res.data ?? []) as any[]);
    return leads.map((l): ResultItem => ({
      id: l.id,
      title: l.name || fmtPhone(l.phone) || 'Contato',
      subtitle: fmtPhone(l.phone) || l.email || 'sem telefone',
      patientId: null,
      photoUrl: l.profile_picture_url ?? null,
      onSelect: () => { router.push(`/atendimento/chat/${l.id}`); onClose(); },
    }));
  }, [kind, router, onClose]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) { setResults([]); setLoading(false); return; }
    setLoading(true);
    debounceRef.current = setTimeout(() => {
      runSearch(q).then(setResults).catch(() => setResults([])).finally(() => setLoading(false));
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, runSearch]);

  if (!open || !mounted) return null;
  const q = query.trim();

  const modal = (
    <div className="fixed inset-0 z-[200] flex items-start justify-center pt-[8vh] px-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative bg-card border border-border rounded-2xl shadow-2xl overflow-hidden w-full max-w-xl flex flex-col"
        style={{ animation: 'fadeInScale 120ms ease-out' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 className="text-lg font-semibold text-muted-foreground">{cfg.title}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent transition-colors">
            <X size={18} />
          </button>
        </div>
        <div className="px-5 pb-3">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={cfg.placeholder}
              className="w-full pl-9 pr-3 py-2 rounded-lg bg-card border border-border text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary"
            />
            {loading && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground animate-spin" />}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-4 min-h-[200px] max-h-[62vh]">
          {q.length < 2 ? (
            <Hint icon={kind === 'agenda' ? <CalendarClock size={22} /> : <MessageCircle size={22} />} text={cfg.hint} />
          ) : loading && results.length === 0 ? (
            <Hint icon={<Loader2 size={22} className="animate-spin" />} text="Buscando…" />
          ) : results.length === 0 ? (
            <Hint icon={<Search size={22} />} text={`Nada encontrado para "${q}"`} />
          ) : (
            results.map((r) => (
              <button
                key={r.id}
                onClick={r.onSelect}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-accent/60 transition-colors"
              >
                {r.patientId ? (
                  <PatientAvatar patientId={r.patientId} patientName={r.title} avatarUrl={r.avatarUrl} fallbackPhotoUrl={r.photoUrl} size={38} shape="circle" />
                ) : (
                  <SimpleAvatar name={r.title} photo={r.photoUrl} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold text-foreground truncate">{r.title}</p>
                  <p className="text-xs text-muted-foreground truncate">{r.subtitle}</p>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function Hint({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-foreground/60">
      {icon}
      <p className="text-sm">{text}</p>
    </div>
  );
}

function SimpleAvatar({ name, photo }: { name: string; photo?: string | null }) {
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
