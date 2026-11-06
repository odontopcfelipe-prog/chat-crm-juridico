'use client';
import { useState, useEffect } from 'react';
import { Zap, Plus, Trash2 } from 'lucide-react';
import { showSuccess, showError } from '@/lib/toast';
import api from '@/lib/api';
import { isLab } from '@crm/shared';
import { useBusinessType } from '@/lib/useBusinessType';
import LabSequencias, { type LabSequence } from './LabSequencias';
import { LAB_AUTOMACOES, LAB_GATILHOS, LAB_ACOES, LAB_VALOR_ACAO } from './lab-automacoes-textos';

const TRIGGERS = [
  { value: 'NEW_LEAD', label: 'Novo lead criado', emoji: '🆕' },
  { value: 'STAGE_CHANGE', label: 'Lead mudou de etapa', emoji: '🔄' },
  { value: 'NO_RESPONSE_24H', label: 'Sem resposta há 24h', emoji: '⏰' },
  { value: 'NO_RESPONSE_48H', label: 'Sem resposta há 48h', emoji: '🔴' },
  { value: 'PAYMENT_OVERDUE', label: 'Pagamento vencido', emoji: '💰' },
];

const ACTIONS = [
  { value: 'ADD_TAG', label: 'Adicionar etiqueta', emoji: '🏷️' },
  { value: 'SEND_INTERNAL_NOTE', label: 'Criar nota interna', emoji: '📝' },
  { value: 'CHANGE_STAGE', label: 'Mover etapa do lead', emoji: '➡️' },
  { value: 'CREATE_TASK', label: 'Criar tarefa automaticamente', emoji: '✅' },
];

interface AutomationRule {
  id: string;
  name: string;
  trigger: string;
  action: string;
  action_value: string;
  enabled: boolean;
}

interface OpcaoRegra { value: string; label: string; emoji: string }

export default function AutomationsPage() {
  const lab = isLab(useBusinessType());
  const triggers: readonly OpcaoRegra[] = lab ? LAB_GATILHOS : TRIGGERS;
  const actions: readonly OpcaoRegra[] = lab ? LAB_ACOES : ACTIONS;
  // Laboratório: sequências da própria conta (só as ligadas podem ser escolhidas numa regra).
  const [sequences, setSequences] = useState<LabSequence[]>([]);
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newRule, setNewRule] = useState({ name: '', trigger: 'NEW_LEAD', action: 'ADD_TAG', action_value: '' });

  const loadRules = async () => {
    try {
      setLoading(true);
      const res = await api.get('/automations');
      setRules(res.data);
    } catch {
      showError(lab ? LAB_AUTOMACOES.erroCarregar : 'Erro ao carregar automações');
    } finally {
      setLoading(false);
    }
  };

  const loadSequences = async () => {
    if (!lab) return;
    try {
      const res = await api.get<LabSequence[]>('/followup/sequences');
      setSequences(Array.isArray(res.data) ? res.data : []);
    } catch {
      setSequences([]);
    }
  };

  useEffect(() => {
    loadRules();
  }, []);

  useEffect(() => {
    loadSequences();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lab]);

  const addRule = async () => {
    if (!newRule.name.trim() || !newRule.action_value.trim()) return;
    if (lab && newRule.action === 'ENROLL_FOLLOWUP' && !sequences.some(q => q.active && q.id === newRule.action_value)) return;
    try {
      await api.post('/automations', newRule);
      await loadRules();
      setNewRule({ name: '', trigger: 'NEW_LEAD', action: 'ADD_TAG', action_value: '' });
      setShowNew(false);
      showSuccess(lab ? LAB_AUTOMACOES.criada : 'Automação criada');
    } catch {
      showError(lab ? LAB_AUTOMACOES.erroCriar : 'Erro ao criar automação');
    }
  };

  const toggleRule = async (rule: AutomationRule) => {
    try {
      await api.patch(`/automations/${rule.id}`, { enabled: !rule.enabled });
      await loadRules();
    } catch {
      showError(lab ? LAB_AUTOMACOES.erroAtualizar : 'Erro ao atualizar automação');
    }
  };

  const deleteRule = async (id: string) => {
    try {
      await api.delete(`/automations/${id}`);
      await loadRules();
    } catch {
      showError(lab ? LAB_AUTOMACOES.erroRemover : 'Erro ao remover automação');
    }
  };

  const getTriggerLabel = (v: string) => triggers.find(t => t.value === v);
  const getActionLabel = (v: string) => actions.find(a => a.value === v);
  const sequenciasLigadas = sequences.filter(q => q.active);
  const nomeDaSequencia = (id: string) => sequences.find(q => q.id === id)?.name ?? LAB_VALOR_ACAO.sequenciaRemovida;

  return (
    <div className="h-full overflow-y-auto p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Zap size={20} className="text-primary" />
            {lab ? LAB_AUTOMACOES.titulo : 'Automações de Workflow'}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{lab ? LAB_AUTOMACOES.subtitulo : 'Regras automáticas acionadas por eventos no CRC'}</p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-bold hover:bg-primary/90 transition-colors"
        >
          <Plus size={15} />
          {lab ? LAB_AUTOMACOES.novaAutomacao : 'Nova automação'}
        </button>
      </div>

      {/* New rule form */}
      {showNew && (
        <div className="bg-card border border-primary/30 rounded-xl p-5 space-y-4">
          <h3 className="font-bold text-foreground text-sm">{lab ? LAB_AUTOMACOES.novaAutomacao : 'Nova automação'}</h3>
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="text-[11px] font-bold text-muted-foreground uppercase mb-1.5 block">{lab ? LAB_AUTOMACOES.nomeDaRegra : 'Nome da regra'}</label>
              <input
                value={newRule.name}
                onChange={e => setNewRule(p => ({ ...p, name: e.target.value }))}
                placeholder={lab ? LAB_AUTOMACOES.nomeExemplo : 'Ex: Alertar líder quando lead para 24h'}
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-bold text-muted-foreground uppercase mb-1.5 block">{lab ? LAB_AUTOMACOES.quando : 'Quando (gatilho)'}</label>
                <select
                  value={newRule.trigger}
                  onChange={e => setNewRule(p => ({ ...p, trigger: e.target.value }))}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
                >
                  {triggers.map(t => <option key={t.value} value={t.value}>{t.emoji} {t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[11px] font-bold text-muted-foreground uppercase mb-1.5 block">{lab ? LAB_AUTOMACOES.fazer : 'Fazer (ação)'}</label>
                <select
                  value={newRule.action}
                  onChange={e => setNewRule(p => ({ ...p, action: e.target.value, ...(lab ? { action_value: '' } : {}) }))}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
                >
                  {actions.map(a => <option key={a.value} value={a.value}>{a.emoji} {a.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-[11px] font-bold text-muted-foreground uppercase mb-1.5 block">
                {lab ? (
                  newRule.action === 'ADD_TAG' ? LAB_VALOR_ACAO.etiqueta :
                  newRule.action === 'SEND_INTERNAL_NOTE' ? LAB_VALOR_ACAO.nota :
                  newRule.action === 'CREATE_TASK' ? LAB_VALOR_ACAO.tarefa :
                  newRule.action === 'ENROLL_FOLLOWUP' ? LAB_VALOR_ACAO.sequencia :
                  LAB_VALOR_ACAO.padrao
                ) : (
                  newRule.action === 'ADD_TAG' ? 'Etiqueta a adicionar' :
                  newRule.action === 'SEND_INTERNAL_NOTE' ? 'Texto da nota interna' :
                  newRule.action === 'CREATE_TASK' ? 'Título da tarefa a criar' :
                  'Valor da ação'
                )}
              </label>
              {lab && newRule.action === 'ENROLL_FOLLOWUP' ? (
                <>
                  <select
                    value={newRule.action_value}
                    onChange={e => setNewRule(p => ({ ...p, action_value: e.target.value }))}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
                  >
                    <option value="">{LAB_VALOR_ACAO.escolherSequencia}</option>
                    {sequenciasLigadas.map(q => <option key={q.id} value={q.id}>{q.name}</option>)}
                  </select>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {sequenciasLigadas.length === 0 ? LAB_VALOR_ACAO.semSequenciaLigada : LAB_VALOR_ACAO.sequenciaAjuda}
                  </p>
                </>
              ) : (
              <input
                value={newRule.action === 'CREATE_TASK'
                  ? (() => { try { return JSON.parse(newRule.action_value).title ?? newRule.action_value; } catch { return newRule.action_value; } })()
                  : newRule.action_value
                }
                onChange={e => {
                  const v = e.target.value;
                  setNewRule(p => ({
                    ...p,
                    action_value: p.action === 'CREATE_TASK'
                      ? JSON.stringify({ title: v, due_hours: 48 })
                      : v,
                  }));
                }}
                placeholder={lab ? (
                  newRule.action === 'ADD_TAG' ? LAB_VALOR_ACAO.exemploEtiqueta :
                  newRule.action === 'SEND_INTERNAL_NOTE' ? LAB_VALOR_ACAO.exemploNota :
                  newRule.action === 'CREATE_TASK' ? LAB_VALOR_ACAO.exemploTarefa :
                  ''
                ) : (
                  newRule.action === 'ADD_TAG' ? 'ex: urgente' :
                  newRule.action === 'SEND_INTERNAL_NOTE' ? 'ex: Cliente sem resposta há 24h — verificar' :
                  newRule.action === 'CREATE_TASK' ? 'ex: Entrar em contato com o lead' :
                  ''
                )}
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              )}
              {newRule.action === 'CREATE_TASK' && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  {lab ? LAB_VALOR_ACAO.tarefaAjuda : 'A tarefa será criada automaticamente com prazo de 48h vinculada ao lead/conversa.'}
                </p>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowNew(false)}
              className="px-4 py-2 text-sm font-bold text-muted-foreground hover:text-foreground transition-colors"
            >
              {lab ? LAB_AUTOMACOES.cancelar : 'Cancelar'}
            </button>
            <button
              onClick={addRule}
              className="px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-colors"
            >
              {lab ? LAB_AUTOMACOES.salvar : 'Salvar'}
            </button>
          </div>
        </div>
      )}

      {/* Rules list */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground text-sm">{lab ? LAB_AUTOMACOES.carregando : 'Carregando...'}</div>
      ) : rules.length === 0 && !showNew ? (
        <div className="text-center py-12 text-muted-foreground">
          <Zap size={32} className="mx-auto mb-3 opacity-20" />
          <p className="font-medium text-sm">{lab ? LAB_AUTOMACOES.vazioTitulo : 'Nenhuma automação configurada'}</p>
          <p className="text-xs mt-1">{lab ? LAB_AUTOMACOES.vazioTexto : 'Crie regras para automatizar tarefas repetitivas'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rules.map(rule => {
            const trigger = getTriggerLabel(rule.trigger);
            const action = getActionLabel(rule.action);
            return (
              <div
                key={rule.id}
                className={`flex items-center gap-4 p-4 bg-card border rounded-xl transition-all ${rule.enabled ? 'border-border' : 'border-border/40 opacity-60'}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-foreground">{rule.name}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {trigger?.emoji} {trigger?.label} → {action?.emoji} {action?.label}:{' '}
                    <span className="font-medium text-foreground">{lab && rule.action === 'ENROLL_FOLLOWUP' ? nomeDaSequencia(rule.action_value) : rule.action_value}</span>
                  </p>
                </div>
                <button
                  onClick={() => toggleRule(rule)}
                  className={`text-sm font-bold px-3 py-1 rounded-lg border transition-colors ${
                    rule.enabled
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20'
                      : 'bg-muted text-muted-foreground border-border hover:bg-muted/80'
                  }`}
                >
                  {rule.enabled ? (lab ? LAB_AUTOMACOES.ativo : 'Ativo') : (lab ? LAB_AUTOMACOES.pausado : 'Pausado')}
                </button>
                <button
                  onClick={() => deleteRule(rule.id)}
                  className="p-1.5 text-muted-foreground hover:text-red-400 transition-colors rounded-lg hover:bg-red-500/10"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {lab && <LabSequencias onChanged={loadSequences} />}
    </div>
  );
}
