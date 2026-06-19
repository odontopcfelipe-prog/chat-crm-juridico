'use client';

/**
 * Modal de configuracao de lembretes — Onda 5e v27 (Fase 25).
 *
 * Admin gerencia:
 *  - Antecedencias padrao (quais lembretes vem pre-preenchidos no modal de evento)
 *  - Templates de mensagem por faixa (24h+, 1h-23h, <1h)
 *
 * Persiste via PUT /calendar/reminders/config (GlobalSetting JSON).
 *
 * Variaveis suportadas nos templates: {nome}, {nome_completo}, {dentista},
 * {dentista_completo}, {data}, {hora}, {local}, {clinica}, {antecedencia}.
 *
 * Preview ao vivo substitui variaveis com dados de exemplo conforme o
 * template eh editado.
 */

import { useEffect, useState } from 'react';
import {
  X, Plus, Trash2, Save, Loader2, RefreshCw, Eye, MessageSquare, Clock, Settings, Variable,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Antecedencia {
  minutes_before: number;
  channel: string;
}

interface Templates {
  consulta_24h: string;
  consulta_1h: string;
  consulta_15min: string;
}

interface ReminderConfig {
  default_antecedencias: Antecedencia[];
  templates: Templates;
}

const ANTECEDENCIA_OPTIONS = [
  { value: 5, label: '5 minutos antes' },
  { value: 15, label: '15 minutos antes' },
  { value: 30, label: '30 minutos antes' },
  { value: 60, label: '1 hora antes' },
  { value: 120, label: '2 horas antes' },
  { value: 360, label: '6 horas antes' },
  { value: 1440, label: '1 dia antes' },
  { value: 2880, label: '2 dias antes' },
  { value: 4320, label: '3 dias antes' },
  { value: 10080, label: '1 semana antes' },
];

const CHANNEL_OPTIONS = [
  { value: 'WHATSAPP', label: 'WhatsApp' },
  { value: 'EMAIL', label: 'Email' },
  { value: 'PUSH', label: 'Push (app)' },
];

const VARIABLES = [
  { key: 'nome', desc: 'Primeiro nome do paciente' },
  { key: 'nome_completo', desc: 'Nome inteiro' },
  { key: 'dentista', desc: 'Dra. Suellen (encurta)' },
  { key: 'dentista_completo', desc: 'Dra. Suellen Passos' },
  { key: 'data', desc: 'ter 06/05/2026 14:00' },
  { key: 'hora', desc: '14:00' },
  { key: 'local', desc: 'Endereço da consulta' },
  { key: 'antecedencia', desc: '1 dia / 1 hora / 15 min' },
];

const TEMPLATE_INFO = [
  {
    key: 'consulta_24h' as const,
    title: 'Lembrete de 24h+ antes',
    sub: 'Geralmente convite a confirmar (lembrete 1 dia antes)',
    icon: Clock,
  },
  {
    key: 'consulta_1h' as const,
    title: 'Lembrete entre 1h e 23h antes',
    sub: 'Lembrete prático (chegar com folga)',
    icon: Clock,
  },
  {
    key: 'consulta_15min' as const,
    title: 'Lembrete < 1h antes',
    sub: '"Estamos te esperando!" (último lembrete)',
    icon: Clock,
  },
];

// Exemplo pra preview ao vivo
const PREVIEW_VARS = {
  nome: 'Felipe',
  nome_completo: 'Felipe Passos',
  dentista: 'Dra. Suellen',
  dentista_completo: 'Dra. Suellen Passos',
  data: 'ter 06/05/2026 14:00',
  hora: '14:00',
  local: 'Rua das Acácias, 123 — Sala 4',
  antecedencia: '1 dia',
};

function applyPreview(template: string, vars: Record<string, string>): string {
  // Mesma logica do backend applyTemplate (resumida)
  const localLine = vars.local ? `📍 ${vars.local}\n` : '';
  let result = template.replace(/\{local_line\}/g, localLine);
  result = result.replace(/\{(\w+)\}/g, (m, key) => vars[key] ?? '');
  result = result.replace(/\n{3,}/g, '\n\n').trim();
  return result;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Onda 17.55 — renderiza o formulário INLINE (sem overlay de modal), pra usar
   *  como painel de configuração dentro da página Disparos e Lembretes. */
  embedded?: boolean;
}

export function RemindersConfigModal({ open, onClose, embedded = false }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<ReminderConfig | null>(null);
  // textareas: refs por template pra inserir variavel na posicao do cursor
  const [textareaRefs] = useState<Record<string, HTMLTextAreaElement | null>>({});

  useEffect(() => {
    if (!open) return;
    const load = async () => {
      setLoading(true);
      try {
        const res = await api.get('/calendar/reminders/config');
        setConfig(res.data);
      } catch (e: any) {
        showError(e?.response?.data?.message || 'Falha ao carregar configurações');
        onClose();
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [open, onClose]);

  const handleSave = async () => {
    if (!config) return;
    if (config.default_antecedencias.length === 0) {
      showError('Defina ao menos uma antecedência padrão');
      return;
    }
    setSaving(true);
    try {
      const res = await api.put('/calendar/reminders/config', config);
      setConfig(res.data);
      showSuccess('Configurações salvas — próximos eventos vão usar essas regras');
      onClose();
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao salvar configurações');
    } finally {
      setSaving(false);
    }
  };

  const handleRestore = async () => {
    if (!confirm('Restaurar as configurações padrão? Suas customizações serão perdidas.')) return;
    setSaving(true);
    try {
      // Manda config vazia → backend devolve defaults
      const res = await api.put('/calendar/reminders/config', {
        default_antecedencias: undefined,
        templates: undefined,
      });
      setConfig(res.data);
      showSuccess('Restaurado para os padrões');
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao restaurar');
    } finally {
      setSaving(false);
    }
  };

  const addAntecedencia = () => {
    if (!config) return;
    setConfig({
      ...config,
      default_antecedencias: [
        ...config.default_antecedencias,
        { minutes_before: 30, channel: 'WHATSAPP' },
      ],
    });
  };

  const removeAntecedencia = (idx: number) => {
    if (!config) return;
    setConfig({
      ...config,
      default_antecedencias: config.default_antecedencias.filter((_, i) => i !== idx),
    });
  };

  const updateAntecedencia = (idx: number, patch: Partial<Antecedencia>) => {
    if (!config) return;
    const next = [...config.default_antecedencias];
    next[idx] = { ...next[idx], ...patch };
    setConfig({ ...config, default_antecedencias: next });
  };

  const insertVariable = (templateKey: keyof Templates, variable: string) => {
    if (!config) return;
    const ta = textareaRefs[templateKey];
    if (!ta) {
      // fallback: append no fim
      setConfig({
        ...config,
        templates: { ...config.templates, [templateKey]: config.templates[templateKey] + ` {${variable}}` },
      });
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const current = config.templates[templateKey];
    const insertion = `{${variable}}`;
    const next = current.slice(0, start) + insertion + current.slice(end);
    setConfig({
      ...config,
      templates: { ...config.templates, [templateKey]: next },
    });
    // reposiciona cursor depois da insercao
    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(start + insertion.length, start + insertion.length);
    }, 0);
  };

  if (!open && !embedded) return null;

  const content = (
    <>
        {/* Header */}
        <div className="sticky top-0 bg-card border-b border-border px-5 py-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-2">
            <Settings size={18} className="text-primary" />
            <h2 className="text-base font-bold">Configurações de Lembrete</h2>
          </div>
          {!embedded && (
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-accent transition-colors" aria-label="Fechar">
              <X size={16} />
            </button>
          )}
        </div>

        {loading || !config ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="p-5 space-y-5">
            {/* Seção 1: Antecedências padrão */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
                  <Clock size={14} className="text-primary" />
                  Antecedências padrão
                </h3>
                <button
                  type="button"
                  onClick={addAntecedencia}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-primary hover:bg-primary/10 rounded-lg transition-colors"
                >
                  <Plus size={12} /> Adicionar
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground mb-3">
                Ao criar evento novo, esses lembretes vêm pré-preenchidos. Operador pode adicionar/remover livremente no modal do evento.
              </p>
              <div className="space-y-2">
                {config.default_antecedencias.length === 0 && (
                  <p className="text-xs italic text-amber-600 dark:text-amber-400 p-2 rounded bg-amber-500/10 border border-amber-500/30">
                    ⚠️ Sem antecedências, nenhum lembrete vai disparar automaticamente. Recomendamos pelo menos 1.
                  </p>
                )}
                {config.default_antecedencias.map((a, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <select
                      value={a.minutes_before}
                      onChange={(e) => updateAntecedencia(idx, { minutes_before: parseInt(e.target.value) })}
                      className="flex-1 px-3 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
                    >
                      {ANTECEDENCIA_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                      {/* Inclui valor custom se nao bater com options */}
                      {!ANTECEDENCIA_OPTIONS.some((o) => o.value === a.minutes_before) && (
                        <option value={a.minutes_before}>{a.minutes_before} min antes (custom)</option>
                      )}
                    </select>
                    <select
                      value={a.channel}
                      onChange={(e) => updateAntecedencia(idx, { channel: e.target.value })}
                      className="w-32 px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
                    >
                      {CHANNEL_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => removeAntecedencia(idx)}
                      className="p-1.5 rounded text-destructive hover:bg-destructive/10 transition-colors"
                      title="Remover"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <hr className="border-border" />

            {/* Seção 2: Templates */}
            <div>
              <h3 className="text-sm font-bold text-foreground flex items-center gap-2 mb-2">
                <MessageSquare size={14} className="text-primary" />
                Mensagens enviadas ao paciente
              </h3>
              <p className="text-[11px] text-muted-foreground mb-3">
                Personalize o texto enviado pra cada faixa de antecedência. Use as variáveis abaixo (clique pra inserir no cursor).
              </p>

              {/* Variáveis disponíveis (chips clicáveis) */}
              <div className="mb-4 p-3 rounded-xl bg-muted/30 border border-border">
                <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                  <Variable size={11} /> Variáveis disponíveis
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {VARIABLES.map((v) => (
                    <span
                      key={v.key}
                      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-mono bg-primary/10 text-primary border border-primary/20"
                      title={v.desc}
                    >
                      {`{${v.key}}`}
                    </span>
                  ))}
                </div>
                <p className="text-[10px] text-muted-foreground mt-2 italic">
                  💡 Dica: use <code className="bg-muted/50 px-1 rounded">{'{local_line}'}</code> em vez de <code>{'{local}'}</code> sozinho — ele já adiciona o emoji 📍 e quebra de linha automática.
                </p>
              </div>

              {/* Templates */}
              {TEMPLATE_INFO.map((info) => {
                const Icon = info.icon;
                const value = config.templates[info.key];
                const preview = applyPreview(value, PREVIEW_VARS);
                return (
                  <div key={info.key} className="mb-4 last:mb-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <Icon size={12} className="text-muted-foreground" />
                      <h4 className="text-xs font-bold text-foreground">{info.title}</h4>
                      <span className="text-[10px] text-muted-foreground italic">— {info.sub}</span>
                    </div>

                    {/* Botoes pra inserir variavel rapida */}
                    <div className="flex flex-wrap gap-1 mb-1.5">
                      {VARIABLES.slice(0, 5).map((v) => (
                        <button
                          key={v.key}
                          type="button"
                          onClick={() => insertVariable(info.key, v.key)}
                          className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors"
                          title={`Inserir ${v.key}`}
                        >
                          + {`{${v.key}}`}
                        </button>
                      ))}
                    </div>

                    <textarea
                      ref={(el) => { textareaRefs[info.key] = el; }}
                      value={value}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          templates: { ...config.templates, [info.key]: e.target.value },
                        })
                      }
                      rows={5}
                      maxLength={1500}
                      className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary/40 resize-y"
                      placeholder="Texto da mensagem com variáveis..."
                    />
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-1">
                      <span>{value.length}/1500 caracteres</span>
                    </div>

                    {/* Preview */}
                    <div className="mt-2 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 mb-1.5 flex items-center gap-1">
                        <Eye size={11} /> Preview (como o paciente vai receber)
                      </div>
                      <div className="text-xs text-foreground whitespace-pre-wrap">
                        {preview || <em className="text-muted-foreground">(template vazio)</em>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Footer */}
        {!loading && config && (
          <div className="sticky bottom-0 bg-card border-t border-border px-5 py-3 flex items-center justify-between gap-2">
            <button
              onClick={handleRestore}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-accent rounded-lg transition-colors disabled:opacity-50"
              title="Volta pros templates default da clínica"
            >
              <RefreshCw size={12} /> Restaurar padrão
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-5 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors shadow-md disabled:opacity-50"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                Salvar configurações
              </button>
            </div>
          </div>
        )}
    </>
  );

  if (embedded) {
    return (
      <div className="bg-card text-foreground rounded-2xl border border-border overflow-hidden">
        {content}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-card text-foreground rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto border border-border"
        onClick={(e) => e.stopPropagation()}
      >
        {content}
      </div>
    </div>
  );
}
