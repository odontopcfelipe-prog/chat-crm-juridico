'use client';

/**
 * Aba "Agendamentos" — campanhas de envio (recorrente OU data única).
 * Define: template, destinatários (filtro + manual), quando enviar.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Plus, Loader2, Pencil, Trash2, Calendar, Play, Pause,
  PlayCircle, ChevronRight, Users as UsersIcon,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import ModalBase from '@/components/ModalBase';
import { inputCls, Field } from './ui-shared';
import type { MessageTemplate } from './templates-tab';
import type { Influencer } from './list-tab';

type ScheduleType = 'ONCE' | 'RECURRING';
type Recurrence = 'DAILY' | 'WEEKLY' | 'MONTHLY';
type Status = 'ATIVO' | 'PAUSADO' | 'INATIVO';
type Platform = 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE' | 'OUTRO';

interface Schedule {
  id: string;
  name: string;
  template_id: string;
  template: { id: string; name: string };
  active: boolean;
  schedule_type: ScheduleType;
  run_at: string | null;
  recurrence: Recurrence | null;
  weekdays: number[];
  day_of_month: number | null;
  hour: number | null;
  minute: number | null;
  filter_status: Status[];
  filter_platform: Platform[];
  filter_niche: string | null;
  manual_recipient_ids: string[];
  last_run_at: string | null;
  next_run_at: string | null;
}

interface FormState {
  name: string;
  template_id: string;
  active: boolean;
  schedule_type: ScheduleType;
  run_at: string; // datetime-local format
  recurrence: Recurrence | '';
  weekdays: number[];
  day_of_month: string;
  hour: string;
  minute: string;
  filter_status: Status[];
  filter_platform: Platform[];
  filter_niche: string;
  manual_recipient_ids: string[];
}

const EMPTY_FORM: FormState = {
  name: '', template_id: '', active: true,
  schedule_type: 'RECURRING',
  run_at: '',
  recurrence: 'WEEKLY',
  weekdays: [1, 3, 5], // seg, qua, sex
  day_of_month: '1',
  hour: '10', minute: '0',
  filter_status: ['ATIVO'],
  filter_platform: [],
  filter_niche: '',
  manual_recipient_ids: [],
};

const WEEKDAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function formatNextRun(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function describeSchedule(s: Schedule): string {
  if (s.schedule_type === 'ONCE') {
    return s.run_at ? `Uma vez · ${formatNextRun(s.run_at)}` : 'Uma vez (sem data)';
  }
  const time = `${String(s.hour ?? 0).padStart(2, '0')}:${String(s.minute ?? 0).padStart(2, '0')}`;
  if (s.recurrence === 'DAILY') return `Todo dia às ${time}`;
  if (s.recurrence === 'WEEKLY') {
    const days = (s.weekdays || []).map(d => WEEKDAY_LABELS[d]).join(', ');
    return `${days || '(sem dias)'} às ${time}`;
  }
  if (s.recurrence === 'MONTHLY') return `Dia ${s.day_of_month ?? '?'} de cada mês às ${time}`;
  return '—';
}

function describeRecipients(s: Schedule | FormState): string {
  const parts: string[] = [];
  if (s.filter_status?.length) parts.push(`status: ${s.filter_status.join(', ')}`);
  if (s.filter_platform?.length) parts.push(`plataforma: ${s.filter_platform.join(', ')}`);
  if (s.filter_niche) parts.push(`nicho: "${s.filter_niche}"`);
  if (s.manual_recipient_ids?.length) parts.push(`+ ${s.manual_recipient_ids.length} manual`);
  return parts.length ? parts.join(' · ') : 'Sem destinatários (não dispara)';
}

export function SchedulesTab() {
  const [items, setItems] = useState<Schedule[]>([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [influencers, setInfluencers] = useState<Influencer[]>([]);
  const [loading, setLoading] = useState(true);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [schedRes, tplRes, infRes] = await Promise.all([
        api.get<Schedule[]>('/influencers/schedules'),
        api.get<MessageTemplate[]>('/influencers/templates'),
        api.get<Influencer[]>('/influencers'),
      ]);
      setItems(Array.isArray(schedRes.data) ? schedRes.data : []);
      setTemplates(Array.isArray(tplRes.data) ? tplRes.data : []);
      setInfluencers(Array.isArray(infRes.data) ? infRes.data : []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar agendamentos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const openCreate = () => {
    if (templates.length === 0) {
      showError('Crie ao menos um template antes de agendar.');
      return;
    }
    setEditing(null);
    setForm({ ...EMPTY_FORM, template_id: templates[0]?.id || '' });
    setModalOpen(true);
  };

  const openEdit = (s: Schedule) => {
    setEditing(s);
    setForm({
      name: s.name,
      template_id: s.template_id,
      active: s.active,
      schedule_type: s.schedule_type,
      run_at: s.run_at ? new Date(s.run_at).toISOString().slice(0, 16) : '',
      recurrence: s.recurrence || '',
      weekdays: s.weekdays || [],
      day_of_month: s.day_of_month != null ? String(s.day_of_month) : '',
      hour: s.hour != null ? String(s.hour) : '',
      minute: s.minute != null ? String(s.minute) : '',
      filter_status: s.filter_status || [],
      filter_platform: s.filter_platform || [],
      filter_niche: s.filter_niche || '',
      manual_recipient_ids: s.manual_recipient_ids || [],
    });
    setModalOpen(true);
  };

  const toggleArr = <T,>(arr: T[], v: T): T[] =>
    arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];

  const handleSave = async () => {
    if (!form.name.trim()) { showError('Nome é obrigatório'); return; }
    if (!form.template_id) { showError('Template é obrigatório'); return; }

    const payload: any = {
      name: form.name.trim(),
      template_id: form.template_id,
      active: form.active,
      schedule_type: form.schedule_type,
      filter_status: form.filter_status,
      filter_platform: form.filter_platform,
      filter_niche: form.filter_niche.trim() || null,
      manual_recipient_ids: form.manual_recipient_ids,
    };

    if (form.schedule_type === 'ONCE') {
      if (!form.run_at) { showError('Data e hora são obrigatórias pra envio único'); return; }
      payload.run_at = new Date(form.run_at).toISOString();
    } else {
      if (!form.recurrence) { showError('Selecione a frequência'); return; }
      payload.recurrence = form.recurrence;
      payload.hour = Number(form.hour);
      payload.minute = Number(form.minute);
      if (form.recurrence === 'WEEKLY') payload.weekdays = form.weekdays;
      if (form.recurrence === 'MONTHLY') payload.day_of_month = Number(form.day_of_month);
    }

    setSaving(true);
    try {
      if (editing) {
        await api.patch(`/influencers/schedules/${editing.id}`, payload);
        showSuccess('Agendamento atualizado');
      } else {
        await api.post('/influencers/schedules', payload);
        showSuccess('Agendamento criado');
      }
      setModalOpen(false);
      fetchAll();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (s: Schedule) => {
    if (!confirm(`Remover agendamento "${s.name}"?`)) return;
    try {
      await api.delete(`/influencers/schedules/${s.id}`);
      showSuccess('Agendamento removido');
      fetchAll();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  const handleToggleActive = async (s: Schedule) => {
    try {
      await api.patch(`/influencers/schedules/${s.id}`, { active: !s.active });
      showSuccess(s.active ? 'Agendamento pausado' : 'Agendamento ativado');
      fetchAll();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao alterar');
    }
  };

  const handleRunNow = async (s: Schedule) => {
    if (!confirm(`Disparar "${s.name}" agora? Será enviado no próximo minuto pelos destinatários configurados.`)) return;
    try {
      await api.post(`/influencers/schedules/${s.id}/run-now`);
      showSuccess('Disparo programado pra próximo minuto');
      fetchAll();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao disparar');
    }
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <p className="text-xs text-muted-foreground">
          Campanhas de envio automático. Worker dispara WhatsApp pelos destinatários no horário configurado.
        </p>
        <button
          onClick={openCreate}
          disabled={templates.length === 0}
          title={templates.length === 0 ? 'Crie ao menos 1 template primeiro' : ''}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 text-sm font-medium shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={16} strokeWidth={2.5} /> Novo agendamento
        </button>
      </div>

      {templates.length === 0 && (
        <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-xs flex items-center gap-2">
          <span>📝</span>
          <span>Você precisa criar pelo menos um template na aba <strong>Templates</strong> antes de agendar envios.</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 bg-card border border-dashed border-border rounded-xl">
          <Calendar size={36} className="mx-auto mb-3 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground mb-1">Nenhum agendamento criado ainda.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(s => (
            <div key={s.id} className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold text-foreground truncate">{s.name}</h3>
                    {!s.active && (
                      <span className="shrink-0 px-2 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px] font-bold uppercase tracking-wider">
                        Pausado
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                    <span>Template:</span>
                    <span className="text-foreground font-medium">{s.template?.name || '(removido)'}</span>
                  </p>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => handleRunNow(s)}
                    className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-500/10"
                    title="Disparar agora (teste)"
                    disabled={!s.active}
                  >
                    <PlayCircle size={14} />
                  </button>
                  <button
                    onClick={() => handleToggleActive(s)}
                    className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent"
                    title={s.active ? 'Pausar' : 'Ativar'}
                  >
                    {s.active ? <Pause size={14} /> : <Play size={14} />}
                  </button>
                  <button
                    onClick={() => openEdit(s)}
                    className="p-1.5 rounded-lg text-muted-foreground hover:bg-accent"
                    title="Editar"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(s)}
                    className="p-1.5 rounded-lg text-destructive hover:bg-destructive/10"
                    title="Remover"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                <div className="bg-background rounded-lg px-3 py-2 border border-border">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-0.5">Quando</p>
                  <p className="text-foreground">{describeSchedule(s)}</p>
                </div>
                <div className="bg-background rounded-lg px-3 py-2 border border-border">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-0.5">Destinatários</p>
                  <p className="text-foreground">{describeRecipients(s)}</p>
                </div>
                <div className="bg-background rounded-lg px-3 py-2 border border-border">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-0.5">Próximo envio</p>
                  <p className="text-foreground">{s.active ? formatNextRun(s.next_run_at) : '— pausado —'}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <ModalBase
        open={modalOpen}
        onClose={() => !saving && setModalOpen(false)}
        title={editing ? 'Editar agendamento' : 'Novo agendamento'}
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setModalOpen(false)}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !form.name.trim() || !form.template_id}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 text-sm font-medium disabled:opacity-50"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              {editing ? 'Salvar' : 'Criar'}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <fieldset className="space-y-3">
            <legend className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Geral</legend>
            <Field label="Nome da campanha *">
              <input
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="ex: Lembrete sextou"
                className={inputCls}
              />
            </Field>
            <Field label="Template de mensagem *">
              <select
                value={form.template_id}
                onChange={e => setForm({ ...form, template_id: e.target.value })}
                className={inputCls}
              >
                <option value="">— Selecione —</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </Field>
          </fieldset>

          {/* ─── Quando ─── */}
          <fieldset className="space-y-3 pt-3 border-t border-border">
            <legend className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Quando enviar</legend>

            <div className="flex gap-2">
              {(['RECURRING', 'ONCE'] as ScheduleType[]).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setForm({ ...form, schedule_type: t })}
                  className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium ${
                    form.schedule_type === t
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card text-muted-foreground border-border hover:bg-accent/50'
                  }`}
                >
                  {t === 'RECURRING' ? 'Recorrente' : 'Data única'}
                </button>
              ))}
            </div>

            {form.schedule_type === 'ONCE' && (
              <Field label="Data e hora do envio *">
                <input
                  type="datetime-local"
                  value={form.run_at}
                  onChange={e => setForm({ ...form, run_at: e.target.value })}
                  className={inputCls}
                />
              </Field>
            )}

            {form.schedule_type === 'RECURRING' && (
              <>
                <Field label="Frequência *">
                  <div className="flex gap-2">
                    {(['DAILY', 'WEEKLY', 'MONTHLY'] as Recurrence[]).map(r => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setForm({ ...form, recurrence: r })}
                        className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium ${
                          form.recurrence === r
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-card text-muted-foreground border-border hover:bg-accent/50'
                        }`}
                      >
                        {r === 'DAILY' ? 'Todo dia' : r === 'WEEKLY' ? 'Semanal' : 'Mensal'}
                      </button>
                    ))}
                  </div>
                </Field>

                {form.recurrence === 'WEEKLY' && (
                  <Field label="Dias da semana *">
                    <div className="flex gap-1">
                      {WEEKDAY_LABELS.map((lbl, idx) => (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => setForm({ ...form, weekdays: toggleArr(form.weekdays, idx) })}
                          className={`flex-1 px-1 py-2 rounded-lg border text-xs font-medium ${
                            form.weekdays.includes(idx)
                              ? 'bg-primary text-primary-foreground border-primary'
                              : 'bg-card text-muted-foreground border-border hover:bg-accent/50'
                          }`}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                  </Field>
                )}

                {form.recurrence === 'MONTHLY' && (
                  <Field
                    label="Dia do mês *"
                    hint="Se o mês não tiver esse dia (ex: 31 em fev), usa o último dia do mês."
                  >
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={form.day_of_month}
                      onChange={e => setForm({ ...form, day_of_month: e.target.value })}
                      className={inputCls}
                    />
                  </Field>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <Field label="Hora">
                    <input
                      type="number"
                      min={0}
                      max={23}
                      value={form.hour}
                      onChange={e => setForm({ ...form, hour: e.target.value })}
                      className={inputCls}
                    />
                  </Field>
                  <Field label="Minuto">
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={form.minute}
                      onChange={e => setForm({ ...form, minute: e.target.value })}
                      className={inputCls}
                    />
                  </Field>
                </div>
              </>
            )}
          </fieldset>

          {/* ─── Destinatários ─── */}
          <fieldset className="space-y-3 pt-3 border-t border-border">
            <legend className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1">Quem recebe</legend>

            <Field
              label="Filtro automático"
              hint="Influenciadores que baterem TODOS os critérios marcados serão incluídos."
            >
              <div className="space-y-2">
                <div>
                  <p className="text-[10px] text-muted-foreground mb-1">Status:</p>
                  <div className="flex gap-1.5 flex-wrap">
                    {(['ATIVO', 'PAUSADO', 'INATIVO'] as Status[]).map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setForm({ ...form, filter_status: toggleArr(form.filter_status, s) })}
                        className={`px-2.5 py-1 rounded-md border text-[11px] font-medium ${
                          form.filter_status.includes(s)
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-card text-muted-foreground border-border hover:bg-accent/50'
                        }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground mb-1">Plataforma:</p>
                  <div className="flex gap-1.5 flex-wrap">
                    {(['INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'OUTRO'] as Platform[]).map(p => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setForm({ ...form, filter_platform: toggleArr(form.filter_platform, p) })}
                        className={`px-2.5 py-1 rounded-md border text-[11px] font-medium ${
                          form.filter_platform.includes(p)
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-card text-muted-foreground border-border hover:bg-accent/50'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <input
                    value={form.filter_niche}
                    onChange={e => setForm({ ...form, filter_niche: e.target.value })}
                    placeholder="Filtrar por nicho (contém texto)..."
                    className={inputCls}
                  />
                </div>
              </div>
            </Field>

            <Field
              label={
                <>Seleção manual — <span className="text-muted-foreground">{form.manual_recipient_ids.length} selecionado(s)</span></>
              }
              hint="Adiciona destinatários específicos além dos do filtro automático."
            >
              <div className="max-h-48 overflow-y-auto bg-background border border-border rounded-lg divide-y divide-border">
                {influencers.length === 0 && (
                  <p className="p-3 text-xs text-muted-foreground text-center">Nenhum influenciador cadastrado.</p>
                )}
                {influencers.map(inf => {
                  const checked = form.manual_recipient_ids.includes(inf.id);
                  return (
                    <label key={inf.id} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent/30 text-xs">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setForm({
                          ...form,
                          manual_recipient_ids: toggleArr(form.manual_recipient_ids, inf.id),
                        })}
                        className="rounded"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-foreground font-medium truncate">{inf.name}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {inf.handle ? `@${inf.handle}` : '(sem @)'} · {inf.phone || 'sem telefone'}
                        </p>
                      </div>
                      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[9px] font-bold ${
                        inf.status === 'ATIVO' ? 'bg-emerald-500/10 text-emerald-600' :
                        inf.status === 'PAUSADO' ? 'bg-amber-500/10 text-amber-600' :
                        'bg-muted text-muted-foreground'
                      }`}>
                        {inf.status}
                      </span>
                    </label>
                  );
                })}
              </div>
            </Field>

            <div className="text-xs bg-muted/30 border border-border rounded-lg p-3">
              <p className="text-foreground font-medium mb-1 flex items-center gap-1">
                <UsersIcon size={12} /> Resumo: <ChevronRight size={12} className="text-muted-foreground" />
              </p>
              <p className="text-muted-foreground">{describeRecipients(form as any)}</p>
            </div>
          </fieldset>

          <fieldset className="pt-3 border-t border-border">
            <Field label="Status">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, active: true })}
                  className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium ${
                    form.active
                      ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30'
                      : 'bg-card text-muted-foreground border-border'
                  }`}
                >
                  Ativo
                </button>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, active: false })}
                  className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium ${
                    !form.active
                      ? 'bg-amber-500/10 text-amber-600 border-amber-500/30'
                      : 'bg-card text-muted-foreground border-border'
                  }`}
                >
                  Pausado
                </button>
              </div>
            </Field>
          </fieldset>
        </div>
      </ModalBase>
    </div>
  );
}
