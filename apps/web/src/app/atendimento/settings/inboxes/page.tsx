'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  Building2,
  Plus,
  Trash2,
  UserPlus,
  Users,
  RefreshCw,
  MessageSquare,
  Link2,
  ShieldCheck,
  Zap,
  Layout,
  X,
  Check,
  Bot,
} from 'lucide-react';
import api from '@/lib/api';

interface InboxInstance {
  id: string;
  name: string;
  type: string;
}

interface Inbox {
  id: string;
  name: string;
  color: string | null;
  auto_route: boolean;
  users: Array<{ id: string; name: string; email: string }>;
  instances: InboxInstance[];
  _count: {
    users: number;
    conversations: number;
  };
}

interface SystemUser {
  id: string;
  name: string;
  email: string;
  roles?: string[];
}

interface EvolutionInstance {
  instanceName: string;
  status: string;
}

// Paleta de cores do sistema (tailwind-500). Fixa em 7 para forçar consistência visual
// entre setores e evitar que duas clínicas escolham tons quase idênticos.
const COLOR_PALETTE = [
  { hex: '#ef4444', label: 'Vermelho' },
  { hex: '#f97316', label: 'Laranja' },
  { hex: '#eab308', label: 'Amarelo' },
  { hex: '#22c55e', label: 'Verde' },
  { hex: '#3b82f6', label: 'Azul' },
  { hex: '#a855f7', label: 'Roxo' },
  { hex: '#ec4899', label: 'Rosa' },
];

// Roles que podem ser operadores de um setor. Qualquer papel humano pode operar um setor
// — estagiário transferindo para advogado, financeiro atendendo cobrança, etc.
const OPERATOR_ROLES = ['ADMIN', 'ADVOGADO', 'OPERADOR', 'COMERCIAL', 'ESTAGIARIO', 'FINANCEIRO'];

export default function InboxesSettingsPage() {
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [allUsers, setAllUsers] = useState<SystemUser[]>([]);
  const [whatsappInstances, setWhatsappInstances] = useState<EvolutionInstance[]>([]);
  const [loading, setLoading] = useState(true);

  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({
    name: '',
    color: COLOR_PALETTE[4].hex, // azul por padrão
    instanceName: '' as string | '',
    operatorIds: [] as string[],
    autoRoute: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const fetchData = async () => {
    setLoading(true);
    try {
      const [inboxesRes, usersRes, waRes] = await Promise.all([
        api.get('/inboxes'),
        api.get('/users'),
        api.get('/whatsapp/instances'),
      ]);
      setInboxes(inboxesRes.data);
      setAllUsers(usersRes.data);
      setWhatsappInstances(waRes.data);
    } catch (error) {
      console.error('Erro ao buscar dados:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const operatorCandidates = useMemo(
    () => allUsers.filter(u => (u.roles ?? []).some(r => OPERATOR_ROLES.includes(r))),
    [allUsers],
  );

  const linkedInstanceNames = useMemo(() => {
    const s = new Set<string>();
    inboxes.forEach(i => (i.instances || []).forEach(inst => s.add(inst.name)));
    return s;
  }, [inboxes]);

  const availableInstances = useMemo(
    () => whatsappInstances.filter(wi => !linkedInstanceNames.has(wi.instanceName)),
    [whatsappInstances, linkedInstanceNames],
  );

  const openCreate = () => {
    setForm({
      name: '',
      color: COLOR_PALETTE[4].hex,
      instanceName: '',
      operatorIds: [],
      autoRoute: false,
    });
    setFormError('');
    setShowModal(true);
  };

  const closeModal = () => {
    if (submitting) return;
    setShowModal(false);
  };

  const toggleOperator = (id: string) => {
    setForm(f => ({
      ...f,
      operatorIds: f.operatorIds.includes(id)
        ? f.operatorIds.filter(x => x !== id)
        : [...f.operatorIds, id],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setFormError('Informe o nome do setor.');
      return;
    }
    setSubmitting(true);
    setFormError('');
    try {
      await api.post('/inboxes/full', {
        name: form.name.trim(),
        color: form.color,
        autoRoute: form.autoRoute,
        instanceName: form.instanceName || null,
        instanceType: 'whatsapp',
        operatorIds: form.operatorIds,
      });
      setShowModal(false);
      fetchData();
    } catch (error: any) {
      setFormError(error?.response?.data?.message || 'Erro ao criar setor.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteInbox = async (id: string) => {
    if (!confirm('Tem certeza que deseja excluir este setor? As conversas e instâncias ficarão sem vínculo.')) return;
    try {
      await api.delete(`/inboxes/${id}`);
      fetchData();
    } catch (error) {
      alert('Erro ao excluir setor');
    }
  };

  const handleRemoveOperator = async (inboxId: string, userId: string) => {
    try {
      await api.delete(`/inboxes/${inboxId}/users/${userId}`);
      fetchData();
    } catch {
      alert('Erro ao remover operador');
    }
  };

  const handleAddOperator = async (inboxId: string, userId: string) => {
    try {
      await api.post(`/inboxes/${inboxId}/users`, { userId });
      fetchData();
    } catch {
      alert('Erro ao adicionar operador');
    }
  };

  const handleUnlinkInstance = async (inboxId: string, name: string) => {
    if (!confirm(`Desvincular a instância "${name}" deste setor? A instância continua existindo.`)) return;
    try {
      await api.delete(`/inboxes/${inboxId}/instances/${encodeURIComponent(name)}`);
      fetchData();
    } catch {
      alert('Erro ao desvincular instância');
    }
  };

  const handleLinkInstance = async (inboxId: string, name: string) => {
    try {
      await api.post(`/inboxes/${inboxId}/instances`, { name, type: 'whatsapp' });
      fetchData();
    } catch (e: any) {
      alert(e?.response?.data?.message || 'Erro ao vincular instância');
    }
  };

  const handleToggleAutoRoute = async (inbox: Inbox) => {
    try {
      await api.put(`/inboxes/${inbox.id}`, { auto_route: !inbox.auto_route });
      fetchData();
    } catch {
      alert('Erro ao atualizar roteamento automático');
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-background">
      <header className="p-8 border-b border-border bg-card/30 backdrop-blur-md">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center">
              <Layout size={24} />
            </div>
            <h1 className="text-3xl font-bold text-foreground tracking-tight">Setores</h1>
          </div>
          <p className="text-muted-foreground">
            Crie setores, vincule o canal de WhatsApp e escolha os operadores. Setores sem canal servem apenas para transferências internas.
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
        <div className="max-w-6xl mx-auto space-y-8">

          <div className="flex justify-between items-center">
            <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
              <ShieldCheck className="text-primary" size={20} />
              Setores cadastrados
            </h2>
            <button
              onClick={openCreate}
              className="bg-primary text-primary-foreground px-4 py-2 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-primary/90 transition-all shadow-lg shadow-primary/20"
            >
              <Plus size={18} />
              Novo Setor
            </button>
          </div>

          {loading ? (
            <div className="py-20 flex flex-col items-center gap-4 text-muted-foreground">
              <RefreshCw className="animate-spin" size={40} />
              <p>Carregando setores...</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-6">
              {inboxes.map((inbox) => {
                const color = inbox.color || '#6b7280';
                return (
                  <div
                    key={inbox.id}
                    className="bg-card border border-border rounded-2xl shadow-sm overflow-hidden group hover:border-primary/20 transition-all relative"
                  >
                    {/* Faixa colorida lateral que identifica o setor */}
                    <div className="absolute left-0 top-0 bottom-0 w-1.5" style={{ backgroundColor: color }} />

                    <div className="p-6 pl-8">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-12 h-12 rounded-2xl flex items-center justify-center"
                            style={{ backgroundColor: `${color}20`, color }}
                          >
                            <Building2 size={24} />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <h3 className="text-2xl font-black text-foreground">{inbox.name}</h3>
                              {inbox.auto_route && (
                                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-violet-500/10 text-violet-500 border border-violet-500/20 flex items-center gap-1">
                                  <Bot size={10} /> Auto
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-4 text-xs font-bold text-muted-foreground uppercase tracking-wider mt-1">
                              <span className="flex items-center gap-1"><Users size={12} /> {inbox._count.users} Operadores</span>
                              <span className="flex items-center gap-1"><MessageSquare size={12} /> {inbox._count.conversations} Chats</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => handleToggleAutoRoute(inbox)}
                            className={`px-3 py-1.5 text-[11px] font-bold rounded-lg transition-all ${
                              inbox.auto_route
                                ? 'bg-violet-500/10 text-violet-500 border border-violet-500/20'
                                : 'text-muted-foreground hover:text-foreground'
                            }`}
                            title={inbox.auto_route ? 'IA roteia automaticamente' : 'Roteamento manual'}
                          >
                            <Bot size={14} className="inline mr-1" />
                            {inbox.auto_route ? 'IA ativada' : 'Ativar IA'}
                          </button>
                          <button
                            onClick={() => handleDeleteInbox(inbox.id)}
                            className="p-2 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-all opacity-0 group-hover:opacity-100"
                            title="Excluir setor"
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-8">
                        {/* Canal de WhatsApp */}
                        <div className="space-y-4">
                          <label className="text-[10px] font-black text-muted-foreground uppercase tracking-[0.2em] flex items-center gap-2">
                            <Zap size={10} className="text-amber-500" /> Canal de WhatsApp
                          </label>
                          <div className="flex flex-wrap gap-2">
                            {inbox.instances?.length === 0 && (
                              <span className="text-[11px] text-muted-foreground italic">
                                Setor interno — sem canal vinculado.
                              </span>
                            )}
                            {inbox.instances?.map((inst) => (
                              <div
                                key={inst.id}
                                className="bg-emerald-500/10 text-emerald-600 border border-emerald-500/20 px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-2"
                              >
                                <Link2 size={14} />
                                {inst.name}
                                <span className="opacity-50 font-normal">({inst.type})</span>
                                <button
                                  onClick={() => handleUnlinkInstance(inbox.id, inst.name)}
                                  className="ml-1 hover:text-red-500"
                                  title="Desvincular"
                                >
                                  ×
                                </button>
                              </div>
                            ))}

                            {inbox.instances?.length === 0 && availableInstances.length > 0 && (
                              <select
                                onChange={(e) => {
                                  if (e.target.value) handleLinkInstance(inbox.id, e.target.value);
                                  e.target.value = '';
                                }}
                                className="bg-muted border border-border hover:border-primary/30 rounded-xl px-3 py-1.5 text-xs font-bold transition-all cursor-pointer outline-none"
                              >
                                <option value="">+ Vincular WhatsApp</option>
                                {availableInstances.map((wi) => (
                                  <option key={wi.instanceName} value={wi.instanceName}>
                                    {wi.instanceName}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        </div>

                        {/* Operadores */}
                        <div className="space-y-4">
                          <label className="text-[10px] font-black text-muted-foreground uppercase tracking-[0.2em] flex items-center gap-2">
                            <UserPlus size={10} className="text-primary" /> Operadores do setor
                          </label>
                          <div className="flex flex-wrap gap-2">
                            {inbox.users?.map((user) => (
                              <div
                                key={user.id}
                                className="bg-primary/10 text-primary border border-primary/20 px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-2"
                              >
                                <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center text-[10px]">
                                  {user.name[0]}
                                </div>
                                {user.name}
                                <button
                                  onClick={() => handleRemoveOperator(inbox.id, user.id)}
                                  className="ml-1 hover:text-red-500"
                                  title="Remover do setor"
                                >
                                  ×
                                </button>
                              </div>
                            ))}

                            <select
                              onChange={(e) => {
                                if (e.target.value) handleAddOperator(inbox.id, e.target.value);
                                e.target.value = '';
                              }}
                              className="bg-muted border border-border hover:border-primary/30 rounded-xl px-3 py-1.5 text-xs font-bold transition-all cursor-pointer outline-none"
                            >
                              <option value="">+ Adicionar operador</option>
                              {operatorCandidates
                                .filter((au) => !inbox.users?.some((u) => u.id === au.id))
                                .map((au) => (
                                  <option key={au.id} value={au.id}>
                                    {au.name}
                                  </option>
                                ))}
                            </select>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}

              {inboxes.length === 0 && (
                <div className="py-20 border-2 border-dashed border-border rounded-3xl flex flex-col items-center justify-center text-center px-6">
                  <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
                    <Building2 size={32} className="text-muted-foreground opacity-30" />
                  </div>
                  <h3 className="text-xl font-bold text-foreground mb-2">Nenhum setor configurado</h3>
                  <p className="text-muted-foreground max-w-sm mb-6">
                    Crie seu primeiro setor (ex: Comercial, Financeiro, Recepção) e vincule a ele o canal de WhatsApp e os operadores responsáveis.
                  </p>
                  <button
                    onClick={openCreate}
                    className="bg-primary text-primary-foreground px-5 py-2.5 rounded-xl font-bold text-sm inline-flex items-center gap-2"
                  >
                    <Plus size={16} /> Criar primeiro setor
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ─── Modal: Novo Setor ─────────────────────────────────────── */}
      {showModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={closeModal} />
          <div className="relative z-10 w-full max-w-lg bg-card border border-border rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 py-5 border-b border-border bg-foreground/[0.02] shrink-0">
              <h2 className="text-lg font-bold text-foreground tracking-tight">Novo Setor</h2>
              <button
                onClick={closeModal}
                disabled={submitting}
                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-all rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
              <div className="p-6 space-y-5 overflow-y-auto flex-1">
                {formError && (
                  <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-xl text-destructive text-[13px] font-medium">
                    {formError}
                  </div>
                )}

                {/* Nome */}
                <div className="space-y-1.5">
                  <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider ml-1">
                    Nome do setor
                  </label>
                  <input
                    type="text"
                    required
                    autoFocus
                    value={form.name}
                    onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="Ex: Comercial, Financeiro, Recepção..."
                    className="w-full px-4 py-2.5 border border-border rounded-xl bg-background text-foreground focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all placeholder:text-muted-foreground/50"
                  />
                </div>

                {/* Cor */}
                <div className="space-y-2">
                  <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider ml-1">
                    Cor
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {COLOR_PALETTE.map((c) => {
                      const selected = form.color === c.hex;
                      return (
                        <button
                          key={c.hex}
                          type="button"
                          onClick={() => setForm(f => ({ ...f, color: c.hex }))}
                          title={c.label}
                          className={`w-9 h-9 rounded-full flex items-center justify-center transition-all ${
                            selected ? 'ring-2 ring-offset-2 ring-offset-card scale-110' : 'hover:scale-105'
                          }`}
                          style={{ backgroundColor: c.hex, ['--tw-ring-color' as any]: c.hex }}
                        >
                          {selected && <Check className="w-4 h-4 text-white" strokeWidth={3} />}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Canal de WhatsApp */}
                <div className="space-y-1.5">
                  <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider ml-1">
                    Canal de WhatsApp
                  </label>
                  <select
                    value={form.instanceName}
                    onChange={(e) => setForm(f => ({ ...f, instanceName: e.target.value }))}
                    className="w-full px-4 py-2.5 border border-border rounded-xl bg-background text-foreground focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                  >
                    <option value="">— Nenhum (setor interno, só transferências)</option>
                    {availableInstances.map((wi) => (
                      <option key={wi.instanceName} value={wi.instanceName}>
                        {wi.instanceName} {wi.status === 'CONNECTED' || wi.status === 'open' ? '(conectada)' : '(desconectada)'}
                      </option>
                    ))}
                  </select>
                  <p className="text-[10px] text-muted-foreground opacity-70 ml-1">
                    Só aparecem instâncias que ainda não estão vinculadas a outro setor. Crie instâncias novas em <b>Integrações → WhatsApp</b>.
                  </p>
                </div>

                {/* Operadores */}
                <div className="space-y-1.5">
                  <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider ml-1">
                    Operadores
                  </label>
                  {operatorCandidates.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground italic py-2">
                      Nenhum usuário elegível. Cadastre usuários em <b>Equipe & Acesso → Usuários</b>.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3 border border-border rounded-xl bg-background/50 max-h-48 overflow-y-auto">
                      {operatorCandidates.map((u) => {
                        const checked = form.operatorIds.includes(u.id);
                        return (
                          <label
                            key={u.id}
                            className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-all ${
                              checked
                                ? 'border-primary/40 bg-primary/5'
                                : 'border-border/60 hover:border-border hover:bg-accent/30'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleOperator(u.id)}
                              className="w-4 h-4 rounded border-border text-primary focus:ring-primary/20"
                            />
                            <span className="text-[13px] text-foreground truncate">{u.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Auto-route */}
                <div className="pt-2">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.autoRoute}
                      onChange={(e) => setForm(f => ({ ...f, autoRoute: e.target.checked }))}
                      className="w-4 h-4 mt-0.5 rounded border-border text-primary focus:ring-primary/20"
                    />
                    <div>
                      <span className="text-[13px] font-bold text-foreground flex items-center gap-1.5">
                        <Bot size={14} className="text-violet-500" /> Roteamento automático por IA
                      </span>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Quando ativado, a IA escolhe automaticamente o melhor operador deste setor para cada conversa.
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              <div className="flex justify-end gap-3 px-6 py-4 border-t border-border shrink-0 bg-foreground/[0.02]">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={submitting}
                  className="px-5 py-2.5 text-muted-foreground font-semibold hover:bg-foreground/[0.05] hover:text-foreground rounded-xl transition-all"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-6 py-2.5 bg-primary text-primary-foreground font-bold rounded-xl transition-all shadow-lg shadow-primary/20 disabled:opacity-50 flex items-center gap-2"
                >
                  {submitting && <RefreshCw size={16} className="animate-spin" />}
                  {submitting ? 'Criando...' : 'Criar Setor'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
