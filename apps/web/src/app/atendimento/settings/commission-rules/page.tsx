'use client';

import { useCallback, useEffect, useState } from 'react';
import { Percent, Loader2, Plus, X, Trash2, Edit2 } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface CommissionRule {
  id: string;
  professional_user_id: string;
  procedure_id: string | null;
  procedure_category: string | null;
  percentage: string | null;
  fixed_value: string | null;
  trigger: string;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  notes: string | null;
  professional?: { id: string; name: string } | null;
}

interface User {
  id: string;
  name: string;
  email: string;
}

interface Procedure {
  id: string;
  name: string;
  category: string | null;
}

const fmtPct = (v: string | null) => v ? `${parseFloat(v).toFixed(1)}%` : '—';
const fmtMoney = (v: string | null) =>
  v ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(parseFloat(v)) : '—';

export default function CommissionRulesSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [rules, setRules] = useState<CommissionRule[]>([]);
  const [editing, setEditing] = useState<CommissionRule | null>(null);
  const [openModal, setOpenModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<CommissionRule[]>('/commission-rules');
      setRules(data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar regras');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const archive = async (id: string) => {
    if (!confirm('Arquivar esta regra? Comissoes ja geradas sao preservadas.')) return;
    try {
      await api.delete(`/commission-rules/${id}`);
      showSuccess('Regra arquivada');
      load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro');
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 max-w-5xl mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Percent size={26} className="text-primary" /> Regras de comissao
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Define como cada profissional ganha comissao por procedimento executado.
            Prioridade: regra por procedimento {'>'}por categoria {'>'}sem escopo (geral).
          </p>
        </div>
        <button
          onClick={() => { setEditing(null); setOpenModal(true); }}
          className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90"
        >
          <Plus size={16} /> Nova regra
        </button>
      </div>

      {loading ? (
        <div className="p-12 flex items-center justify-center text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
        </div>
      ) : rules.length === 0 ? (
        <div className="p-12 text-center text-sm text-muted-foreground">
          <Percent size={28} className="mx-auto mb-2 opacity-50" />
          Nenhuma regra cadastrada.
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2">Profissional</th>
                <th className="px-3 py-2">Escopo</th>
                <th className="px-3 py-2 text-right">Comissao</th>
                <th className="px-3 py-2">Trigger</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Acoes</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0 hover:bg-accent/30">
                  <td className="px-3 py-2 font-medium">{r.professional?.name || '—'}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.procedure_id && (
                      <span className="text-primary">Procedimento especifico</span>
                    )}
                    {!r.procedure_id && r.procedure_category && (
                      <span>Categoria: <span className="text-primary">{r.procedure_category}</span></span>
                    )}
                    {!r.procedure_id && !r.procedure_category && (
                      <span className="text-muted-foreground">Geral (todos)</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {r.percentage && fmtPct(r.percentage)}
                    {r.fixed_value && fmtMoney(r.fixed_value)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.trigger === 'ON_PAYMENT' ? (
                      <span className="text-green-700">Quando paciente paga</span>
                    ) : (
                      <span className="text-amber-700">Na execucao</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.active ? (
                      <span className="text-green-700">Ativa</span>
                    ) : (
                      <span className="text-muted-foreground">Arquivada</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex gap-1">
                      <button
                        onClick={() => { setEditing(r); setOpenModal(true); }}
                        className="p-1.5 rounded hover:bg-accent"
                        title="Editar"
                      >
                        <Edit2 size={14} />
                      </button>
                      {r.active && (
                        <button
                          onClick={() => archive(r.id)}
                          className="p-1.5 rounded hover:bg-destructive/10 text-destructive"
                          title="Arquivar"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openModal && (
        <RuleModal
          rule={editing}
          onClose={() => { setOpenModal(false); setEditing(null); }}
          onSaved={() => { setOpenModal(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function RuleModal({
  rule, onClose, onSaved,
}: { rule: CommissionRule | null; onClose: () => void; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);

  const [professionalUserId, setProfessionalUserId] = useState(rule?.professional_user_id || '');
  const [scope, setScope] = useState<'GENERAL' | 'CATEGORY' | 'PROCEDURE'>(
    rule?.procedure_id ? 'PROCEDURE' : rule?.procedure_category ? 'CATEGORY' : 'GENERAL',
  );
  const [procedureId, setProcedureId] = useState(rule?.procedure_id || '');
  const [procedureCategory, setProcedureCategory] = useState(rule?.procedure_category || '');
  const [type, setType] = useState<'PCT' | 'FIXED'>(rule?.percentage ? 'PCT' : 'FIXED');
  const [percentage, setPercentage] = useState(rule?.percentage || '');
  const [fixedValue, setFixedValue] = useState(rule?.fixed_value || '');
  const [trigger, setTrigger] = useState(rule?.trigger || 'ON_PAYMENT');

  useEffect(() => {
    (async () => {
      try {
        const [u, p] = await Promise.all([
          api.get<User[]>('/users'),
          api.get<{ data?: Procedure[] } | Procedure[]>('/procedures?limit=200'),
        ]);
        setUsers(Array.isArray(u.data) ? u.data : []);
        const procData = Array.isArray(p.data) ? p.data : (p.data as any).data || [];
        setProcedures(procData);
      } catch {
        // ignora
      }
    })();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!professionalUserId) {
      showError('Selecione um profissional');
      return;
    }
    if (type === 'PCT' && (!percentage || parseFloat(percentage) <= 0)) {
      showError('Percentual invalido');
      return;
    }
    if (type === 'FIXED' && (!fixedValue || parseFloat(fixedValue) <= 0)) {
      showError('Valor fixo invalido');
      return;
    }
    setSaving(true);
    try {
      const payload: any = {
        professional_user_id: professionalUserId,
        trigger,
        procedure_id: scope === 'PROCEDURE' ? procedureId : undefined,
        procedure_category: scope === 'CATEGORY' ? procedureCategory : undefined,
        percentage: type === 'PCT' ? parseFloat(percentage) : undefined,
        fixed_value: type === 'FIXED' ? parseFloat(fixedValue) : undefined,
      };
      if (rule) {
        await api.patch(`/commission-rules/${rule.id}`, payload);
        showSuccess('Regra atualizada');
      } else {
        await api.post('/commission-rules', payload);
        showSuccess('Regra criada');
      }
      onSaved();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  // Categorias unicas dos procedimentos para autocomplete
  const categories = Array.from(new Set(procedures.map((p) => p.category).filter(Boolean))) as string[];

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Percent size={20} className="text-primary" /> {rule ? 'Editar regra' : 'Nova regra de comissao'}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 space-y-3 overflow-y-auto">
          <div>
            <label className="block text-xs font-medium mb-1">Profissional *</label>
            <select
              value={professionalUserId}
              onChange={(e) => setProfessionalUserId(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="">— escolha —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Escopo</label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { v: 'GENERAL', l: 'Geral' },
                { v: 'CATEGORY', l: 'Por categoria' },
                { v: 'PROCEDURE', l: 'Procedimento' },
              ].map((o) => (
                <button
                  type="button"
                  key={o.v}
                  onClick={() => setScope(o.v as any)}
                  className={`px-3 py-2 rounded-lg border text-sm font-medium ${
                    scope === o.v ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-accent'
                  }`}
                >
                  {o.l}
                </button>
              ))}
            </div>
          </div>

          {scope === 'CATEGORY' && (
            <div>
              <label className="block text-xs font-medium mb-1">Categoria do procedimento</label>
              <input
                type="text"
                value={procedureCategory}
                onChange={(e) => setProcedureCategory(e.target.value)}
                list="proc-categories"
                placeholder="HOF, ORTODONTIA, IMPLANTE..."
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <datalist id="proc-categories">
                {categories.map((c) => <option key={c} value={c} />)}
              </datalist>
            </div>
          )}

          {scope === 'PROCEDURE' && (
            <div>
              <label className="block text-xs font-medium mb-1">Procedimento especifico</label>
              <select
                value={procedureId}
                onChange={(e) => setProcedureId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">— escolha —</option>
                {procedures.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.category ? ` (${p.category})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Tipo</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as any)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="PCT">Percentual (%)</option>
                <option value="FIXED">Valor fixo (R$)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {type === 'PCT' ? 'Percentual' : 'Valor fixo (R$)'}
              </label>
              <input
                type="number"
                step="0.01"
                value={type === 'PCT' ? percentage : fixedValue}
                onChange={(e) => type === 'PCT' ? setPercentage(e.target.value) : setFixedValue(e.target.value)}
                placeholder={type === 'PCT' ? '30.00' : '50.00'}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1">Quando libera comissao</label>
            <select
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="ON_PAYMENT">Quando o paciente paga (recomendado)</option>
              <option value="ON_EXECUTION">Na execucao do procedimento</option>
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              {trigger === 'ON_PAYMENT'
                ? 'Alinha incentivo do profissional a saude financeira da clinica.'
                : 'Comissao gerada imediatamente — usa quando confianca total no recebimento.'}
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              {rule ? 'Atualizar' : 'Criar regra'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
