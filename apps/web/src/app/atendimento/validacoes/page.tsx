'use client';

/**
 * Atendimentos a validar (Fase 23 PR2).
 *
 * Dashboard para o dentista logado validar atendimentos passados que
 * ainda não foram clinicamente atestados. Pensado para "limpeza fim de
 * dia" — abre, vê tudo que ficou pendente, valida em sequência.
 *
 * Admin pode alternar entre "só meus" e "todos os dentistas" pra
 * supervisão.
 */
import { useCallback, useEffect, useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  Shield, Loader2, Calendar, User, Phone, Clock, X, ExternalLink,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useRole } from '@/lib/useRole';

interface PendingEvent {
  id: string;
  type: 'CONSULTA' | 'PROCEDIMENTO' | 'RETORNO' | 'ORTODONTIA';
  title: string;
  status: string;
  start_at: string;
  end_at: string | null;
  assigned_user_id: string | null;
  assigned_user: { id: string; name: string } | null;
  patient: { id: string; name: string | null; phone: string | null } | null;
  lead: { id: string; name: string | null; phone: string } | null;
}

const TYPE_LABEL: Record<PendingEvent['type'], string> = {
  CONSULTA: 'Consulta',
  PROCEDIMENTO: 'Procedimento',
  RETORNO: 'Retorno',
  ORTODONTIA: 'Ortodontia',
};

const TYPE_COLOR: Record<PendingEvent['type'], string> = {
  CONSULTA: 'bg-purple-500/10 text-purple-600 border-purple-500/20',
  PROCEDIMENTO: 'bg-teal-500/10 text-teal-600 border-teal-500/20',
  RETORNO: 'bg-sky-500/10 text-sky-600 border-sky-500/20',
  ORTODONTIA: 'bg-pink-500/10 text-pink-600 border-pink-500/20',
};

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC',
  });
}

function dayKey(iso: string) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function formatDayHeader(key: string) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long', timeZone: 'UTC',
  });
}

export default function ValidacoesPage() {
  const router = useRouter();
  const role = useRole();
  const [list, setList] = useState<PendingEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [onlyMine, setOnlyMine] = useState(true); // default: só meus (segurança)
  const [daysBack, setDaysBack] = useState<number>(30);
  const [validateModal, setValidateModal] = useState<PendingEvent | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('onlyMine', String(onlyMine));
      params.set('daysBack', String(daysBack));
      const { data } = await api.get<PendingEvent[]>(`/calendar/events/pending-validation?${params}`);
      setList(data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar atendimentos');
    } finally {
      setLoading(false);
    }
  }, [onlyMine, daysBack]);

  useEffect(() => { load(); }, [load]);

  // Agrupa por dia (mais recente primeiro — backend ordena desc)
  const grouped = list.reduce<Record<string, PendingEvent[]>>((acc, ev) => {
    const k = dayKey(ev.start_at);
    if (!acc[k]) acc[k] = [];
    acc[k].push(ev);
    return acc;
  }, {});

  const groupedEntries = Object.entries(grouped);

  return (
    <div className="h-full overflow-y-auto p-6 w-full">
      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Shield size={26} className="text-emerald-600" /> Atendimentos a validar
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Atestação clínica de que os atendimentos realmente aconteceram.
            Apenas o dentista responsável (ou admin) pode validar.
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        {/* Toggle "Só meus" — só admin vê, pra alternar pra "todos" */}
        {role.isAdmin && (
          <div className="flex gap-1 bg-card border border-border rounded-lg p-1">
            <button
              onClick={() => setOnlyMine(true)}
              className={`px-3 py-1.5 rounded text-xs font-medium ${
                onlyMine
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Só meus
            </button>
            <button
              onClick={() => setOnlyMine(false)}
              className={`px-3 py-1.5 rounded text-xs font-medium ${
                !onlyMine
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Todos os dentistas
            </button>
          </div>
        )}

        {/* Range de dias */}
        <select
          value={daysBack}
          onChange={(e) => setDaysBack(Number(e.target.value))}
          className="px-3 py-2 rounded-lg bg-card border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value={7}>Últimos 7 dias</option>
          <option value={15}>Últimos 15 dias</option>
          <option value={30}>Últimos 30 dias</option>
          <option value={60}>Últimos 60 dias</option>
          <option value={90}>Últimos 90 dias</option>
        </select>

        <span className="ml-auto text-xs text-muted-foreground">
          {list.length} atendimento(s) pendente(s)
        </span>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : list.length === 0 ? (
        <div className="p-12 text-center bg-card border border-border rounded-xl">
          <Shield size={28} className="mx-auto mb-2 text-emerald-600/50" />
          <p className="text-sm text-foreground font-medium">
            Tudo em dia! 🎉
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Nenhum atendimento {onlyMine ? 'seu ' : ''}pendente de validação nos últimos {daysBack} dias.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {groupedEntries.map(([key, events]) => (
            <div key={key}>
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-2">
                <span>{formatDayHeader(key)}</span>
                <span className="text-[10px] font-normal opacity-70">
                  {events.length} atendimento(s)
                </span>
                <span className="flex-1 h-px bg-border" />
              </h3>

              <ul className="space-y-2">
                {events.map((ev) => {
                  const contact = ev.patient || ev.lead;
                  return (
                    <li
                      key={ev.id}
                      className="bg-card border border-border rounded-xl p-4 hover:border-primary/40 transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-1">
                            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${TYPE_COLOR[ev.type]}`}>
                              {TYPE_LABEL[ev.type]}
                            </span>
                            <span className="font-medium text-foreground">{ev.title}</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <Clock size={11} /> {formatDateTime(ev.start_at)}
                            </span>
                            {ev.assigned_user && (
                              <span className="flex items-center gap-1">
                                <User size={11} /> Dr(a). {ev.assigned_user.name}
                              </span>
                            )}
                            {contact && (
                              <button
                                onClick={() =>
                                  ev.patient
                                    ? router.push(`/atendimento/pacientes/${ev.patient.id}`)
                                    : null
                                }
                                className="flex items-center gap-1 hover:text-primary"
                                title={ev.patient ? 'Abrir ficha' : ''}
                              >
                                <User size={11} /> {contact.name || 'Sem nome'}
                                {ev.patient && <ExternalLink size={9} />}
                              </button>
                            )}
                            {contact?.phone && (
                              <span className="flex items-center gap-1">
                                <Phone size={11} /> {contact.phone}
                              </span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => setValidateModal(ev)}
                          className="text-xs inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium shrink-0"
                        >
                          <Shield size={12} /> Validar
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {validateModal && (
        <ValidateModal
          event={validateModal}
          onClose={() => setValidateModal(null)}
          onValidated={() => { setValidateModal(null); load(); }}
        />
      )}
    </div>
  );
}

// ─── Modal compartilhado de validacao ─────────────────────

function ValidateModal({
  event, onClose, onValidated,
}: { event: PendingEvent; onClose: () => void; onValidated: () => void }) {
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/calendar/events/${event.id}/validate`, {
        notes: notes.trim() || undefined,
      });
      showSuccess('Atendimento validado');
      onValidated();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao validar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Shield size={18} className="text-emerald-600" />
            <h2 className="text-base font-semibold">Validar atendimento</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={submit} className="p-4 space-y-4">
          <div className="bg-background border border-border rounded-lg p-3 text-sm space-y-1">
            <div className="font-medium text-foreground">{event.title}</div>
            <div className="text-xs text-muted-foreground flex flex-wrap gap-2">
              <span>{formatDateTime(event.start_at)}</span>
              {event.assigned_user && <span>· Dr(a). {event.assigned_user.name}</span>}
              {(event.patient || event.lead) && (
                <span>· {(event.patient || event.lead)?.name}</span>
              )}
            </div>
          </div>
          <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 text-xs text-amber-700">
            <strong>Você está atestando que este atendimento aconteceu.</strong>{' '}
            Apenas um administrador pode reverter depois.
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Notas clínicas (opcional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Observações sobre o atendimento, intercorrências, próximos passos..."
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg border border-border text-sm hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
              Validar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
