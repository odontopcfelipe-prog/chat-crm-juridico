'use client';

/**
 * Lista de Espera (Fase 19) — UI de gerenciamento.
 *
 * Permite operador:
 *  - listar entradas filtradas por status
 *  - criar nova entrada (lead + dentista + preferências)
 *  - editar/remover/marcar-como-notificado
 *
 * Quando uma vaga abre na agenda (CalendarEvent CANCELADO/ADIADO), o backend
 * dispara `WaitlistService.notifySlotOpened` automaticamente — esta tela é o
 * fallback manual / visão de fila.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Hourglass, Loader2, Phone, User, Plus, Pencil, Trash2, Bell,
  X, Search, MessageCircle, Calendar,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { PatientAvatar } from '@/components/PatientAvatar';

interface WaitlistEntry {
  id: string;
  lead_id: string;
  dentist_id: string | null;
  preferred_date: string | null;
  preferred_weekday: number | null;
  preferred_period: 'MANHA' | 'TARDE' | 'NOITE' | 'QUALQUER' | null;
  earliest_date: string | null;
  status: 'AGUARDANDO' | 'NOTIFICADO' | 'AGENDADO' | 'DESISTIU' | 'EXPIROU';
  notes: string | null;
  notified_at: string | null;
  notify_count: number;
  created_at: string;
  lead?: { id: string; name: string | null; phone: string };
  dentist?: { id: string; name: string } | null;
}

interface LeadOption { id: string; name: string | null; phone: string }
interface UserOption { id: string; name: string }

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  AGUARDANDO: { label: 'Aguardando',  cls: 'bg-amber-500/10 text-amber-700 border-amber-500/20' },
  NOTIFICADO: { label: 'Notificado',  cls: 'bg-blue-500/10 text-blue-700 border-blue-500/20' },
  AGENDADO:   { label: 'Agendado',    cls: 'bg-green-500/10 text-green-700 border-green-500/20' },
  DESISTIU:   { label: 'Desistiu',    cls: 'bg-red-500/10 text-red-700 border-red-500/20' },
  EXPIROU:    { label: 'Expirou',     cls: 'bg-gray-500/10 text-gray-700 border-gray-500/20' },
};

const PERIOD_LABEL: Record<string, string> = {
  MANHA:    'Manhã (até 12h)',
  TARDE:    'Tarde (12-18h)',
  NOITE:    'Noite (após 18h)',
  QUALQUER: 'Qualquer horário',
};

const WEEKDAY_LABEL = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export default function WaitlistPage() {
  const [loading, setLoading] = useState(true);
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('AGUARDANDO');
  const [search, setSearch] = useState('');
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  // pickers
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      const r = await api.get<WaitlistEntry[]>(`/waitlist?${params}`);
      setEntries(r.data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar lista de espera');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  // Carregar pickers (leads + dentistas)
  useEffect(() => {
    api.get('/leads')
      .then(r => setLeads((r.data || []).map((l: any) => ({ id: l.id, name: l.name, phone: l.phone }))))
      .catch(() => {});
    // Onda 17.54 — /users/lawyers (não /users, que é ADMIN-only → 403 pra não-admin).
    // Acessível a qualquer logado, tenant-scoped, já filtra dentistas (+admin c/ especialidade).
    api.get('/users/lawyers').then(r => {
      const data: any[] = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.users || []);
      setUsers(data.map((u: any) => ({ id: u.id, name: u.name })));
    }).catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return entries;
    const q = search.trim().toLowerCase();
    return entries.filter(e =>
      e.lead?.name?.toLowerCase().includes(q) ||
      e.lead?.phone?.includes(q) ||
      e.dentist?.name?.toLowerCase().includes(q)
    );
  }, [entries, search]);

  const openEntry = entries.find((e) => e.id === openEntryId);

  return (
    <div className="h-full overflow-y-auto p-6 w-full">
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Hourglass size={26} className="text-primary" /> Lista de espera
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Pacientes que aguardam vaga. Quando um agendamento é cancelado, a IA notifica os
            primeiros da fila automaticamente. Você pode adicionar manualmente abaixo.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium"
        >
          <Plus size={16} /> Adicionar à fila
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="flex gap-1 bg-card border border-border rounded-lg p-1 flex-wrap">
          {(['AGUARDANDO', 'NOTIFICADO', 'AGENDADO', 'DESISTIU', 'EXPIROU', ''] as const).map((s) => (
            <button
              key={s || 'TODOS'}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded text-sm font-medium ${
                statusFilter === s
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {s ? STATUS_CFG[s].label : 'Todos'}
            </button>
          ))}
        </div>

        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por paciente, telefone ou dentista..."
            className="w-full pl-9 pr-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground">
          <Hourglass size={28} className="mx-auto mb-2 opacity-50" />
          {statusFilter === 'AGUARDANDO'
            ? 'Nenhum paciente aguardando vaga no momento.'
            : 'Nenhuma entrada com esse filtro.'}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((e, idx) => {
            const cfg = STATUS_CFG[e.status] || STATUS_CFG.AGUARDANDO;
            return (
              <div
                key={e.id}
                className="bg-card border border-border rounded-xl p-4 hover:border-primary/50 cursor-pointer"
                onClick={() => setOpenEntryId(e.id)}
              >
                <div className="flex items-start justify-between gap-4">
                  <PatientAvatar
                    patientId={e.lead?.id ?? e.id}
                    patientName={e.lead?.name ?? 'Sem nome'}
                    avatarUrl={null /* Lead nao tem avatar cadastrado — mostra iniciais coloridas */}
                    size={36}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      {e.status === 'AGUARDANDO' && (
                        <span className="text-xs font-mono px-2 py-0.5 rounded bg-muted text-muted-foreground">
                          #{idx + 1}
                        </span>
                      )}
                      <span className="font-semibold text-foreground">
                        {e.lead?.name || 'Sem nome'}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded border ${cfg.cls}`}>
                        {cfg.label}
                      </span>
                      {e.notify_count > 0 && (
                        <span className="text-xs px-2 py-0.5 rounded bg-blue-500/10 text-blue-700 flex items-center gap-1">
                          <Bell size={11} /> {e.notify_count}x
                        </span>
                      )}
                    </div>

                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <p className="flex items-center gap-3 flex-wrap">
                        {e.lead?.phone && (
                          <span className="flex items-center gap-1">
                            <Phone size={11} /> {e.lead.phone}
                          </span>
                        )}
                        {e.dentist ? (
                          <span className="flex items-center gap-1">
                            <User size={11} /> Dr(a). {e.dentist.name}
                          </span>
                        ) : (
                          <span className="italic">Qualquer dentista</span>
                        )}
                        <span className="flex items-center gap-1">
                          <Calendar size={11} />
                          Entrou em {new Date(e.created_at).toLocaleDateString('pt-BR')}
                        </span>
                      </p>
                      {(e.preferred_date || e.preferred_weekday !== null || e.preferred_period) && (
                        <p>
                          <strong>Preferência:</strong>{' '}
                          {e.preferred_date && `data ${new Date(e.preferred_date).toLocaleDateString('pt-BR')}; `}
                          {e.preferred_weekday !== null && `${WEEKDAY_LABEL[e.preferred_weekday]}; `}
                          {e.preferred_period && PERIOD_LABEL[e.preferred_period]}
                        </p>
                      )}
                      {e.notes && <p className="italic">"{e.notes}"</p>}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1 shrink-0">
                    {e.status === 'AGUARDANDO' && e.lead?.phone && (
                      <button
                        onClick={async (ev) => {
                          ev.stopPropagation();
                          if (!confirm('Marcar como notificado? (registra contato manual sem disparar WhatsApp)')) return;
                          try {
                            await api.post(`/waitlist/${e.id}/notified`);
                            showSuccess('Marcado como notificado');
                            load();
                          } catch (err: any) {
                            showError(err?.response?.data?.message || 'Erro ao marcar');
                          }
                        }}
                        className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
                      >
                        <MessageCircle size={12} /> Marcar contatado
                      </button>
                    )}
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setOpenEntryId(e.id);
                      }}
                      className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border hover:bg-accent"
                    >
                      <Pencil size={12} /> Editar
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modais */}
      {showCreate && (
        <EntryModal
          mode="create"
          leads={leads}
          users={users}
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); load(); }}
        />
      )}
      {openEntry && (
        <EntryModal
          mode="edit"
          entry={openEntry}
          leads={leads}
          users={users}
          onClose={() => setOpenEntryId(null)}
          onSaved={() => { setOpenEntryId(null); load(); }}
          onDeleted={() => { setOpenEntryId(null); load(); }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Modal de Criação / Edição
// ============================================================================

function EntryModal({
  mode, entry, leads, users, onClose, onSaved, onDeleted,
}: {
  mode: 'create' | 'edit';
  entry?: WaitlistEntry;
  leads: LeadOption[];
  users: UserOption[];
  onClose: () => void;
  onSaved: () => void;
  onDeleted?: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [leadSearch, setLeadSearch] = useState('');
  const [leadId, setLeadId] = useState(entry?.lead_id || '');
  const [dentistId, setDentistId] = useState(entry?.dentist_id || '');
  const [preferredDate, setPreferredDate] = useState(
    entry?.preferred_date ? entry.preferred_date.slice(0, 10) : ''
  );
  const [preferredWeekday, setPreferredWeekday] = useState<string>(
    entry?.preferred_weekday !== null && entry?.preferred_weekday !== undefined
      ? String(entry.preferred_weekday)
      : ''
  );
  const [preferredPeriod, setPreferredPeriod] = useState<string>(entry?.preferred_period || '');
  const [earliestDate, setEarliestDate] = useState(
    entry?.earliest_date ? entry.earliest_date.slice(0, 10) : ''
  );
  const [notes, setNotes] = useState(entry?.notes || '');
  const [status, setStatus] = useState(entry?.status || 'AGUARDANDO');

  const selectedLead = leads.find(l => l.id === leadId);
  const filteredLeads = useMemo(() => {
    if (!leadSearch.trim()) return leads.slice(0, 20);
    const q = leadSearch.trim().toLowerCase();
    return leads.filter(l =>
      l.name?.toLowerCase().includes(q) || l.phone?.includes(q)
    ).slice(0, 20);
  }, [leads, leadSearch]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!leadId) {
      showError('Selecione um paciente');
      return;
    }
    setSaving(true);
    try {
      const payload: any = {
        lead_id: leadId,
        dentist_id: dentistId || null,
        preferred_date: preferredDate || null,
        preferred_weekday: preferredWeekday !== '' ? Number(preferredWeekday) : null,
        preferred_period: preferredPeriod || null,
        earliest_date: earliestDate || null,
        notes: notes.trim() || null,
      };
      if (mode === 'create') {
        await api.post('/waitlist', payload);
        showSuccess('Adicionado à lista de espera');
      } else {
        payload.status = status;
        await api.patch(`/waitlist/${entry!.id}`, payload);
        showSuccess('Entrada atualizada');
      }
      onSaved();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!entry || !confirm('Remover esta entrada da lista de espera?')) return;
    setDeleting(true);
    try {
      await api.delete(`/waitlist/${entry.id}`);
      showSuccess('Entrada removida');
      onDeleted?.();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-lg shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border sticky top-0 bg-card">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Hourglass size={20} className="text-primary" />
            {mode === 'create' ? 'Adicionar à lista de espera' : 'Editar entrada'}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-3">
          {/* Lead picker */}
          <div>
            <label className="block text-xs font-medium mb-1">Paciente *</label>
            {selectedLead ? (
              <div className="flex items-center justify-between gap-2 p-2 rounded-lg border border-border bg-background">
                <div className="text-sm">
                  <div className="font-medium">{selectedLead.name || 'Sem nome'}</div>
                  <div className="text-xs text-muted-foreground">{selectedLead.phone}</div>
                </div>
                {mode === 'create' && (
                  <button
                    type="button"
                    onClick={() => { setLeadId(''); setLeadSearch(''); }}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Trocar
                  </button>
                )}
              </div>
            ) : (
              <>
                <input
                  value={leadSearch}
                  onChange={(e) => setLeadSearch(e.target.value)}
                  placeholder="Buscar paciente por nome ou telefone..."
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                {leadSearch && (
                  <div className="mt-1 max-h-40 overflow-y-auto border border-border rounded-lg bg-background">
                    {filteredLeads.length === 0 ? (
                      <div className="p-2 text-xs text-muted-foreground">Nenhum encontrado</div>
                    ) : (
                      filteredLeads.map(l => (
                        <button
                          type="button"
                          key={l.id}
                          onClick={() => setLeadId(l.id)}
                          className="w-full px-3 py-2 text-left text-sm hover:bg-accent border-b border-border last:border-0"
                        >
                          <div className="font-medium">{l.name || 'Sem nome'}</div>
                          <div className="text-xs text-muted-foreground">{l.phone}</div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Dentista */}
          <div>
            <label className="block text-xs font-medium mb-1">Dentista preferido (opcional)</label>
            <select
              value={dentistId}
              onChange={(e) => setDentistId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="">Qualquer dentista</option>
              {users.map(u => (
                <option key={u.id} value={u.id}>Dr(a). {u.name}</option>
              ))}
            </select>
          </div>

          {/* Preferências de horário */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium mb-1">Data preferida</label>
              <input
                type="date"
                value={preferredDate}
                onChange={(e) => setPreferredDate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">A partir de</label>
              <input
                type="date"
                value={earliestDate}
                onChange={(e) => setEarliestDate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium mb-1">Dia da semana</label>
              <select
                value={preferredWeekday}
                onChange={(e) => setPreferredWeekday(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Qualquer</option>
                {WEEKDAY_LABEL.map((w, i) => (
                  <option key={i} value={i}>{w}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Período</label>
              <select
                value={preferredPeriod}
                onChange={(e) => setPreferredPeriod(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Qualquer</option>
                {Object.entries(PERIOD_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Status (só na edição) */}
          {mode === 'edit' && (
            <div>
              <label className="block text-xs font-medium mb-1">Status</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as any)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {Object.entries(STATUS_CFG).map(([v, c]) => (
                  <option key={v} value={v}>{c.label}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                Marcar como AGENDADO/DESISTIU/EXPIROU encerra a entrada e libera espaço na fila.
              </p>
            </div>
          )}

          {/* Notas */}
          <div>
            <label className="block text-xs font-medium mb-1">Observações</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Ex: prefere falar pela manhã, tem urgência por dor de dente..."
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          {/* Footer */}
          <div className="flex justify-between gap-2 pt-2">
            {mode === 'edit' ? (
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 text-sm disabled:opacity-50"
              >
                <Trash2 size={14} /> Remover
              </button>
            ) : <span />}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-2 rounded-lg border border-border hover:bg-accent text-sm"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium disabled:opacity-50 inline-flex items-center gap-1"
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                {mode === 'create' ? 'Adicionar' : 'Salvar'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
