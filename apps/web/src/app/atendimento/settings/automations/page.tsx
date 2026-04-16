'use client';
import { useState, useEffect } from 'react';
import { Zap, Plus, Trash2 } from 'lucide-react';
import { showSuccess, showError } from '@/lib/toast';
import api from '@/lib/api';

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

export default function AutomationsPage() {
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
      showError('Erro ao carregar automações');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRules();
  }, []);

  const addRule = async () => {
    if (!newRule.name.trim() || !newRule.action_value.trim()) return;
    try {
      await api.post('/automations', newRule);
      await loadRules();
      setNewRule({ name: '', trigger: 'NEW_LEAD', action: 'ADD_TAG', action_value: '' });
      setShowNew(false);
      showSuccess('Automação criada');
    } catch {
      showError('Erro ao criar automação');
    }
  };

  const toggleRule = async (rule: AutomationRule) => {
    try {
      await api.patch(`/automations/${rule.id}`, { enabled: !rule.enabled });
      await loadRules();
    } catch {
      showError('Erro ao atualizar automação');
    }
  };

  const deleteRule = async (id: string) => {
    try {
      await api.delete(`/automations/${id}`);
      await loadRules();
    } catch {
      showError('Erro ao remover automação');
    }
  };

  const getTriggerLabel = (v: string) => TRIGGERS.find(t => t.value === v);
  const getActionLabel = (v: string) => ACTIONS.find(a => a.value === v);

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Zap size={20} className="text-primary" />
            Automações de Workflow
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Regras automáticas acionadas por eventos no CRM</p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-bold hover:bg-primary/90 transition-colors"
        >
          <Plus size={15} />
          Nova automação
        </button>
      </div>

      {/* New rule form */}
      {showNew && (
        <div className="bg-card border border-primary/30 rounded-xl p-5 space-y-4">
          <h3 className="font-bold text-foreground text-sm">Nova automação</h3>
          <div className="grid grid-cols-1 gap-3">
            <div>
              <label className="text-[11px] font-bold text-muted-foreground uppercase mb-1.5 block">Nome da regra</label>
              <input
                value={newRule.name}
                onChange={e => setNewRule(p => ({ ...p, name: e.target.value }))}
                placeholder="Ex: Alertar líder quando lead para 24h"
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-bold text-muted-foreground uppercase mb-1.5 block">Quando (gatilho)</label>
                <select
                  value={newRule.trigger}
                  onChange={e => setNewRule(p => ({ ...p, trigger: e.target.value }))}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
                >
                  {TRIGGERS.map(t => <option key={t.value} value={t.value}>{t.emoji} {t.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[11px] font-bold text-muted-foreground uppercase mb-1.5 block">Fazer (ação)</label>
                <select
                  value={newRule.action}
                  onChange={e => setNewRule(p => ({ ...p, action: e.target.value }))}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
                >
                  {ACTIONS.map(a => <option key={a.value} value={a.value}>{a.emoji} {a.label}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="text-[11px] font-bold text-muted-foreground uppercase mb-1.5 block">
                {newRule.action === 'ADD_TAG' ? 'Etiqueta a adicionar' :
                 newRule.action === 'SEND_INTERNAL_NOTE' ? 'Texto da nota interna' :
                 newRule.action === 'CREATE_TASK' ? 'Título da tarefa a criar' :
                 'Valor da ação'}
              </label>
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
                placeholder={
                  newRule.action === 'ADD_TAG' ? 'ex: urgente' :
                  newRule.action === 'SEND_INTERNAL_NOTE' ? 'ex: Cliente sem resposta há 24h — verificar' :
                  newRule.action === 'CREATE_TASK' ? 'ex: Entrar em contato com o lead' :
                  ''
                }
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary/40"
              />
              {newRule.action === 'CREATE_TASK' && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  A tarefa será criada automaticamente com prazo de 48h vinculada ao lead/conversa.
                </p>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowNew(false)}
              className="px-4 py-2 text-sm font-bold text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancelar
            </button>
            <button
              onClick={addRule}
              className="px-4 py-2 text-sm font-bold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 transition-colors"
            >
              Salvar
            </button>
          </div>
        </div>
      )}

      {/* Rules list */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Carregando...</div>
      ) : rules.length === 0 && !showNew ? (
        <div className="text-center py-12 text-muted-foreground">
          <Zap size={32} className="mx-auto mb-3 opacity-20" />
          <p className="font-medium text-sm">Nenhuma automação configurada</p>
          <p className="text-xs mt-1">Crie regras para automatizar tarefas repetitivas</p>
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
                    <span className="font-medium text-foreground">{rule.action_value}</span>
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
                  {rule.enabled ? 'Ativo' : 'Pausado'}
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
    </div>
  );
}
