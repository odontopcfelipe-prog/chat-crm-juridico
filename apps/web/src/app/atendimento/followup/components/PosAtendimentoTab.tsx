'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Heart, Loader2, Settings, ThumbsUp, ThumbsDown, Minus, RefreshCw, AlertTriangle, MessageCircle, X, Save,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

type Sentiment = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
type Status = 'PENDING' | 'SENT' | 'RESPONDED' | 'FAILED' | 'SKIPPED';
type InitialChoice = 'descontraido' | 'formal' | 'breve' | 'custom';

interface Survey {
  id: string;
  status: Status;
  sentiment: Sentiment | null;
  score: number | null;
  comment: string | null;
  trigger_at: string;
  sent_at: string | null;
  responded_at: string | null;
  escalated_at: string | null;
  procedure_summary: string | null;
  patient: { id: string; name: string; phone: string | null };
  dentist: { id: string; name: string } | null;
  appointment: { id: string; title: string; start_at: string } | null;
}

interface Stats {
  total: number; sent: number; responded: number; response_rate: number;
  positive: number; negative: number; neutral: number;
  avg_score: number | null; nps: number | null;
  pending: number; failed: number;
}

interface PostCareConfig {
  enabled: boolean;
  delay_hours: number;
  initial_choice: InitialChoice;
  initial_custom: string;
  thanks_text: string;
  apology_text: string;
  send_thanks_on_positive: boolean;
  send_apology_on_negative: boolean;
  _meta?: {
    choices: { value: InitialChoice; label: string; preview: string }[];
    defaults: { initial: Record<string, string>; thanks: string; apology: string };
  };
}

const SENT_CFG: Record<Sentiment, { label: string; cls: string; Icon: typeof ThumbsUp }> = {
  POSITIVE: { label: 'Positivo', cls: 'bg-green-500/10 text-green-700 border-green-500/30', Icon: ThumbsUp },
  NEGATIVE: { label: 'Negativo', cls: 'bg-destructive/10 text-destructive border-destructive/30', Icon: ThumbsDown },
  NEUTRAL:  { label: 'Neutro',   cls: 'bg-gray-500/10 text-gray-700 border-gray-500/30', Icon: Minus },
};

const STATUS_CFG: Record<Status, { label: string; cls: string }> = {
  PENDING:   { label: 'Aguardando',   cls: 'bg-amber-500/10 text-amber-700 border-amber-500/30' },
  SENT:      { label: 'Enviado',      cls: 'bg-blue-500/10 text-blue-700 border-blue-500/30' },
  RESPONDED: { label: 'Respondido',   cls: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30' },
  FAILED:    { label: 'Falhou',       cls: 'bg-destructive/10 text-destructive border-destructive/30' },
  SKIPPED:   { label: 'Pulado',       cls: 'bg-gray-500/10 text-gray-700 border-gray-500/30' },
};

export function PosAtendimentoTab() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterSentiment, setFilterSentiment] = useState<string>('');
  const [showConfig, setShowConfig] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterStatus) params.set('status', filterStatus);
      if (filterSentiment) params.set('sentiment', filterSentiment);
      params.set('days', '30');
      const [statsRes, listRes] = await Promise.all([
        api.get<Stats>(`/post-care/stats?days=30`),
        api.get<Survey[]>(`/post-care/surveys?${params.toString()}`),
      ]);
      setStats(statsRes.data);
      setSurveys(listRes.data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar pos-atendimento');
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterSentiment]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Heart size={18} className="text-primary" /> Pós-atendimento
          </h2>
          <p className="text-xs text-muted-foreground">
            Pesquisa de satisfação automática enviada após cada consulta concluída
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={load}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-accent"
          >
            <RefreshCw size={14} /> Atualizar
          </button>
          <button
            onClick={() => setShowConfig(true)}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
          >
            <Settings size={14} /> Configurar
          </button>
        </div>
      </div>

      {/* KPIs */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <KpiCard label="Enviados (30d)"   value={stats.sent.toString()}                    color="text-blue-700" />
          <KpiCard label="Respondidos"      value={stats.responded.toString()}               color="text-emerald-700" sub={`${stats.response_rate}% taxa`} />
          <KpiCard label="NPS"              value={stats.nps != null ? `${stats.nps}` : '—'} color={stats.nps != null && stats.nps >= 50 ? 'text-emerald-700' : stats.nps != null && stats.nps >= 0 ? 'text-amber-700' : 'text-destructive'} />
          <KpiCard label="Negativos"        value={stats.negative.toString()}                color="text-destructive" sub={stats.negative > 0 ? '⚠️ atenção' : 'tudo ok'} />
        </div>
      )}

      {/* Filtros */}
      <div className="flex items-center gap-2 flex-wrap">
        <FilterPill label="Todos"   active={!filterStatus && !filterSentiment} onClick={() => { setFilterStatus(''); setFilterSentiment(''); }} />
        <FilterPill label="Pendentes" active={filterStatus === 'PENDING'} onClick={() => { setFilterStatus('PENDING'); setFilterSentiment(''); }} />
        <FilterPill label="Respondidos" active={filterStatus === 'RESPONDED'} onClick={() => { setFilterStatus('RESPONDED'); setFilterSentiment(''); }} />
        <FilterPill label="Negativos" active={filterSentiment === 'NEGATIVE'} onClick={() => { setFilterSentiment('NEGATIVE'); setFilterStatus(''); }} variant="danger" />
        <FilterPill label="Positivos" active={filterSentiment === 'POSITIVE'} onClick={() => { setFilterSentiment('POSITIVE'); setFilterStatus(''); }} variant="success" />
        <FilterPill label="Falhas"   active={filterStatus === 'FAILED'} onClick={() => { setFilterStatus('FAILED'); setFilterSentiment(''); }} variant="danger" />
      </div>

      {/* Lista */}
      {loading ? (
        <div className="py-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={18} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : surveys.length === 0 ? (
        <div className="bg-card border border-dashed border-border rounded-xl p-8 text-center">
          <Heart size={28} className="mx-auto text-muted-foreground/60 mb-2" />
          <p className="text-sm text-muted-foreground">Nenhuma pesquisa de satisfação ainda.</p>
          <p className="text-xs text-muted-foreground mt-1">
            As pesquisas são criadas automaticamente {stats?.pending ? '(há ' + stats.pending + ' pendentes)' : ''} quando uma consulta vira "Concluída".
          </p>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-semibold">Paciente</th>
                <th className="px-3 py-2 font-semibold">Dentista</th>
                <th className="px-3 py-2 font-semibold">Procedimento</th>
                <th className="px-3 py-2 font-semibold">Disparo</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Resposta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {surveys.map((s) => {
                const sCfg = STATUS_CFG[s.status];
                const seCfg = s.sentiment ? SENT_CFG[s.sentiment] : null;
                return (
                  <tr key={s.id} className="hover:bg-accent/20">
                    <td className="px-3 py-2">
                      <p className="font-medium">{s.patient.name}</p>
                      {s.patient.phone && <p className="text-[11px] text-muted-foreground">{s.patient.phone}</p>}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {s.dentist?.name || '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {s.procedure_summary || '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {new Date(s.trigger_at).toLocaleDateString('pt-BR')}
                      {' '}
                      {new Date(s.trigger_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center text-[11px] px-2 py-0.5 rounded border ${sCfg.cls}`}>
                        {sCfg.label}
                      </span>
                      {s.escalated_at && (
                        <span className="ml-1 inline-flex items-center text-[10px] text-destructive">
                          <AlertTriangle size={10} className="inline" /> escalado
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 max-w-[250px]">
                      {seCfg && (
                        <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border mr-1 ${seCfg.cls}`}>
                          <seCfg.Icon size={10} /> {seCfg.label}
                          {s.score != null && <span className="ml-0.5 font-mono">({s.score})</span>}
                        </span>
                      )}
                      {s.comment && (
                        <p className="text-[11px] text-muted-foreground italic mt-1 truncate" title={s.comment}>
                          <MessageCircle size={9} className="inline mr-1" />
                          {s.comment}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="px-3 py-2 text-[11px] text-muted-foreground border-t border-border">
            {surveys.length} pesquisas
          </div>
        </div>
      )}

      {showConfig && <PostCareConfigModal onClose={() => setShowConfig(false)} onSaved={() => { setShowConfig(false); load(); }} />}
    </div>
  );
}

// ─── Sub-componentes ─────────────────────────────────────────────────────────

function KpiCard({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3">
      <div className="text-[10px] uppercase font-semibold tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  );
}

function FilterPill({
  label, active, onClick, variant = 'default',
}: { label: string; active: boolean; onClick: () => void; variant?: 'default' | 'success' | 'danger' }) {
  const cls = active
    ? variant === 'success' ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30'
    : variant === 'danger' ? 'bg-destructive/10 text-destructive border-destructive/30'
    : 'bg-primary/10 text-primary border-primary/30'
    : 'bg-background text-muted-foreground border-border hover:bg-accent';
  return (
    <button onClick={onClick} className={`text-xs px-3 py-1 rounded-full border ${cls}`}>
      {label}
    </button>
  );
}

// ─── Modal Configurar ────────────────────────────────────────────────────────

function PostCareConfigModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [cfg, setCfg] = useState<PostCareConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<PostCareConfig>('/post-care/config')
      .then(({ data }) => setCfg(data))
      .catch((err) => showError(err?.response?.data?.message || 'Erro ao carregar config'))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    try {
      const { _meta, ...payload } = cfg;
      await api.patch('/post-care/config', payload);
      showSuccess('Configurações salvas');
      onSaved();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-card border border-border rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="sticky top-0 bg-card border-b border-border p-4 flex items-center justify-between">
          <h3 className="font-bold flex items-center gap-2">
            <Settings size={18} /> Configurar Pós-atendimento
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        {loading || !cfg ? (
          <div className="p-12 text-center text-muted-foreground">
            <Loader2 size={20} className="animate-spin mx-auto" />
          </div>
        ) : (
          <div className="p-4 space-y-4">
            {/* On/Off */}
            <label className="flex items-center justify-between bg-background border border-border rounded-lg p-3 cursor-pointer">
              <div>
                <p className="font-medium text-sm">Pós-atendimento ativo</p>
                <p className="text-xs text-muted-foreground">
                  Envia pesquisa de satisfação automaticamente após cada consulta concluída.
                </p>
              </div>
              <input
                type="checkbox"
                checked={cfg.enabled}
                onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
                className="w-5 h-5 accent-primary"
              />
            </label>

            {/* Delay */}
            <div>
              <label className="block text-xs font-medium mb-1">
                Quando enviar (horas após o atendimento)
              </label>
              <input
                type="number"
                min={1}
                max={48}
                value={cfg.delay_hours}
                onChange={(e) => setCfg({ ...cfg, delay_hours: Math.min(48, Math.max(1, Number(e.target.value) || 2)) })}
                className="w-32 px-3 py-2 rounded-lg bg-background border border-border text-sm"
              />
              <span className="text-xs text-muted-foreground ml-2">(default: 2h)</span>
            </div>

            {/* Mensagem inicial — escolha entre 3 estilos + custom */}
            <div>
              <p className="text-xs font-medium mb-2">Mensagem inicial enviada ao paciente</p>
              <div className="space-y-2">
                {(cfg._meta?.choices || []).map((opt) => (
                  <label
                    key={opt.value}
                    className={`block border rounded-lg p-3 cursor-pointer transition-colors ${
                      cfg.initial_choice === opt.value
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-accent/30'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="initial_choice"
                        checked={cfg.initial_choice === opt.value}
                        onChange={() => setCfg({ ...cfg, initial_choice: opt.value })}
                        className="mt-0.5 accent-primary"
                      />
                      <div className="flex-1">
                        <p className="text-sm font-semibold">{opt.label}</p>
                        {opt.value !== 'custom' ? (
                          <p className="text-xs text-muted-foreground mt-0.5 italic">"{opt.preview}"</p>
                        ) : (
                          cfg.initial_choice === 'custom' && (
                            <textarea
                              value={cfg.initial_custom}
                              onChange={(e) => setCfg({ ...cfg, initial_custom: e.target.value })}
                              placeholder="Sua mensagem... use {patient_name}, {dentist_name}, {procedure}"
                              rows={3}
                              className="w-full mt-2 px-2 py-1.5 rounded bg-background border border-border text-xs resize-y"
                            />
                          )
                        )}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                Variáveis disponíveis: <code>{'{patient_name}'}</code>, <code>{'{dentist_name}'}</code>, <code>{'{procedure}'}</code>
              </p>
            </div>

            {/* Resposta automática positiva */}
            <div>
              <label className="flex items-center gap-2 text-xs font-medium mb-1">
                <input
                  type="checkbox"
                  checked={cfg.send_thanks_on_positive}
                  onChange={(e) => setCfg({ ...cfg, send_thanks_on_positive: e.target.checked })}
                  className="accent-primary"
                />
                Responder automaticamente quando feedback for positivo
              </label>
              <textarea
                value={cfg.thanks_text}
                onChange={(e) => setCfg({ ...cfg, thanks_text: e.target.value })}
                rows={3}
                disabled={!cfg.send_thanks_on_positive}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm disabled:opacity-50 resize-y"
              />
            </div>

            {/* Resposta automática negativa */}
            <div>
              <label className="flex items-center gap-2 text-xs font-medium mb-1">
                <input
                  type="checkbox"
                  checked={cfg.send_apology_on_negative}
                  onChange={(e) => setCfg({ ...cfg, send_apology_on_negative: e.target.checked })}
                  className="accent-primary"
                />
                Responder automaticamente quando feedback for negativo
              </label>
              <textarea
                value={cfg.apology_text}
                onChange={(e) => setCfg({ ...cfg, apology_text: e.target.value })}
                rows={3}
                disabled={!cfg.send_apology_on_negative}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm disabled:opacity-50 resize-y"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Independente desta opção, todos os admins recebem notificação interna quando o feedback é negativo.
              </p>
            </div>
          </div>
        )}

        <div className="sticky bottom-0 bg-card border-t border-border p-3 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-border text-sm hover:bg-accent"
          >
            Cancelar
          </button>
          <button
            onClick={save}
            disabled={saving || loading || !cfg}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}
