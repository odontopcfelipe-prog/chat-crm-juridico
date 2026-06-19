'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Pencil, Trash2, X, UserCog, Phone, Loader2, Clock, ChevronDown, ChevronUp, ShieldCheck, Sparkles } from 'lucide-react';
import api from '@/lib/api';
// Onda 17.32.117 — Setores + permissoes (catalogo compartilhado)
import { SECTORS, PERMISSIONS, type Sector, type Permission } from '@crm/shared';
import { SectorHomePreview } from '@/components/home/SectorHomePreview';
// Onda 5e v10 (Fase 25) — editor de horarios reusavel
import {
  ScheduleEditor,
  type DaySchedule,
  defaultWeekSchedule,
  apiScheduleToDays,
  daysToApiSlots,
} from '@/components/ScheduleEditor';

// Especialidades odontológicas — alinhadas com os funis ativos (PIPELINE_TEMPLATES
// em apps/api/src/pipelines/pipelines.service.ts) + função "Orçamentista".
//
// "Orçamentista" é a FUNÇÃO do dentista que faz a primeira AVALIAÇÃO/ORÇAMENTO
// do paciente — usado pelo sistema pra direcionar agendamentos de avaliação
// (a IA Sophia, ao confirmar slot via scheduling_action, prioriza dentistas
// com essa especialidade). Um dentista pode acumular: Orçamentista + sua
// especialidade clínica (ex: ["Orçamentista", "Implantes"]).
//
// Demais especialidades correspondem a funis dedicados pra rotear leads
// pela IA (ex: lead pedindo lente de porcelana → dentista com especialidade
// "Lentes de Porcelana" pega o caso na 2ª consulta).
const SPECIALTY_SUGGESTIONS = [
  'Orçamentista',
  'Odontologia Clínica',
  'Implantes',
  'Ortodontia',
  'Estética Facial',
  'Prótese',
  'Facetas em Resina',
  'Clareamento',
  'Lentes de Porcelana',
];

// Roles canônicos aceitos pelo sistema. DEVEM bater com AppRole em apps/web/src/lib/useRole.ts
// e com os checks do backend (Guards/Roles). Qualquer valor fora dessa lista quebra permissões.
type RoleKey = 'ADMIN' | 'DENTIST' | 'OPERADOR' | 'COMERCIAL' | 'ASSISTANT' | 'FINANCEIRO';

const ROLE_OPTIONS: { key: RoleKey; label: string; emoji: string; description: string }[] = [
  { key: 'ADMIN', label: 'Administrador', emoji: '🛡️', description: 'Acesso total ao sistema' },
  { key: 'DENTIST', label: 'Dentista', emoji: '🦷', description: 'Atendimento clínico, prontuários, prescrições' },
  { key: 'OPERADOR', label: 'Operador', emoji: '💬', description: 'Atendimento no chat e CRC' },
  { key: 'COMERCIAL', label: 'Comercial', emoji: '💼', description: 'Captação e pré-venda' },
  { key: 'ASSISTANT', label: 'Assistente', emoji: '🧑‍⚕️', description: 'Auxilia dentistas em procedimentos e atendimento' },
  { key: 'FINANCEIRO', label: 'Financeiro', emoji: '💰', description: 'Honorários e receitas' },
];

// Onda 17.51 — Setor -> perfil de acesso técnico (1:1). O SETOR é a única
// escolha de cadastro; o perfil (role) é derivado daqui pra manter a
// autorização do backend (RolesGuard) funcionando, sem o usuário ter que
// escolher os dois (era contraditório). Multi-papel continua possível no
// bloco "Avançado".
const SECTOR_ROLE: Record<Sector, RoleKey> = {
  recepcao:   'OPERADOR',
  dentista:   'DENTIST',
  acd_asb:    'ASSISTANT',
  crc:        'COMERCIAL',
  financeiro: 'FINANCEIRO',
  admin:      'ADMIN',
};

// Mapeia rótulos legados (nomes de departamento ou roles jurídicos) para o enum canônico
// odontológico. Aceita ADVOGADO/ESTAGIARIO porque o banco pré-migração pode conter esses
// valores — o frontend normaliza para DENTIST/ASSISTANT até a migration SQL rodar.
function normalizeLegacyRole(raw: string): RoleKey {
  if (!raw) return 'OPERADOR';
  const upper = raw.toUpperCase().trim();
  if (upper === 'ADMIN') return 'ADMIN';
  if (upper === 'ADVOGADO' || upper === 'ADVOGADOS' || upper === 'DENTIST' || upper === 'DENTISTS') return 'DENTIST';
  if (upper === 'OPERADOR' || upper === 'OPERADORES') return 'OPERADOR';
  if (upper === 'COMERCIAL' || upper === 'ATENDENTE COMERCIAL') return 'COMERCIAL';
  if (upper === 'ESTAGIARIO' || upper === 'ESTAGIÁRIO' || upper === 'ESTAGIARIOS' || upper === 'ESTAGIÁRIOS' || upper === 'ASSISTANT' || upper === 'ASSISTANTS') return 'ASSISTANT';
  if (upper === 'FINANCEIRO') return 'FINANCEIRO';
  return 'OPERADOR';
}

function roleBadges(roles: string[] | undefined | null) {
  const normalized = (roles && roles.length > 0 ? roles : ['OPERADOR']).map(normalizeLegacyRole);
  // Dedup mantendo ordem
  const seen = new Set<string>();
  const unique = normalized.filter(r => (seen.has(r) ? false : seen.add(r)));
  return (
    <div className="flex flex-wrap gap-1">
      {unique.map(r => {
        const opt = ROLE_OPTIONS.find(o => o.key === r);
        const cls =
          r === 'ADMIN'
            ? 'bg-red-900/30 text-red-300 border-red-800/30'
            : r === 'FINANCEIRO'
              ? 'bg-emerald-900/30 text-emerald-300 border-emerald-800/30'
              : r === 'DENTIST'
                ? 'bg-violet-900/30 text-violet-300 border-violet-800/30'
                : r === 'ASSISTANT'
                  ? 'bg-amber-900/30 text-amber-300 border-amber-800/30'
                  : 'bg-primary/10 text-primary border-primary/20';
        return (
          <span key={r} className={`px-2 py-0.5 text-[10px] font-bold rounded-lg border ${cls}`}>
            {opt?.emoji} {opt?.label ?? r}
          </span>
        );
      })}
    </div>
  );
}

interface UserForm {
  name: string;
  email: string;
  phone: string;
  password: string;
  roles: RoleKey[];
  inboxIds: string[];
  specialties: string[];
  supervisorIds: string[];
  cro_number: string;
  cro_uf: string;
  // Onda 17.32.117 — Setor + overrides de permissoes
  sector: Sector | '';
  extra_grants: Permission[];
  extra_revokes: Permission[];
}

const UF_OPTIONS = ['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO'];

const emptyForm: UserForm = { name: '', email: '', phone: '', password: '', roles: [], inboxIds: [], specialties: [], supervisorIds: [], cro_number: '', cro_uf: 'AL', sector: '', extra_grants: [], extra_revokes: [] };

export default function UsersSettingsPage() {
  const router = useRouter();
  const [users, setUsers] = useState<any[]>([]);
  const [inboxes, setInboxes] = useState<any[]>([]);
  const [lawyers, setLawyers] = useState<{ id: string; name: string; specialties: string[] }[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<UserForm>(emptyForm);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [specialtyInput, setSpecialtyInput] = useState('');
  // Onda 5e v10 (Fase 25) — horarios de atendimento integrados ao modal
  // de criar/editar dentista. Aparece colapsavel quando role inclui DENTIST.
  // Salvo via PUT /calendar/schedule/:userId DEPOIS de criar o user (pra
  // ter o id) ou junto com o PATCH se for edicao.
  const [schedule, setSchedule] = useState<DaySchedule[]>(defaultWeekSchedule());
  const [scheduleExpanded, setScheduleExpanded] = useState(false);
  // Onda 17.52 — true só quando o horário REAL veio do backend (GET ok) ou o
  // admin mexeu no editor. Em edição, o save só persiste o schedule se isto for
  // true — senão uma falha na GET sobrescreveria a agenda real pelo padrão.
  const [scheduleLoaded, setScheduleLoaded] = useState(false);
  // Onda 17.32.172 — reenvio do e-mail de confirmacao
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [resentId, setResentId] = useState<string | null>(null);

  const handleResendVerification = async (id: string) => {
    setResendingId(id);
    try {
      await api.post(`/users/${id}/resend-verification`);
      setResentId(id);
      setTimeout(() => setResentId((cur) => (cur === id ? null : cur)), 4000);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Falha ao reenviar o e-mail de confirmação.');
    } finally {
      setResendingId(null);
    }
  };

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      router.push('/atendimento/login');
      return;
    }
    fetchData();
  }, [router]);

  const fetchData = async () => {
    fetchUsers();
    fetchInboxes();
    fetchLawyers();
  };

  const fetchInboxes = async () => {
    try {
      const res = await api.get('/inboxes');
      setInboxes(res.data);
    } catch (e) {
      console.error('Erro ao buscar inboxes:', e);
    }
  };

  const fetchLawyers = async () => {
    try {
      const res = await api.get('/users/lawyers');
      setLawyers(res.data || []);
    } catch (e) {
      console.error('Erro ao buscar dentistas:', e);
    }
  };

  const fetchUsers = async () => {
    try {
      const res = await api.get('/users');
      setUsers(res.data);
    } catch (e: any) {
      // 401 is handled globally by api.ts interceptor
      if (e.response?.status === 403) {
        setError('Você não tem permissão para acessar esta página.');
      }
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setSpecialtyInput('');
    setError('');
    // v10: reseta horarios pra padrao (Seg-Sex, 2 turnos)
    setSchedule(defaultWeekSchedule());
    // v11: ABRE expandido por default no cadastro pra deixar claro que e
    // OBRIGATORIO pro DENTIST configurar horarios — sem isso a IA nao
    // consegue propor agendamento autonomo. Como a secao so aparece quando
    // role inclui DENTIST/ADMIN, deixar expandido nao polui pra outros.
    setScheduleExpanded(true);
    setShowModal(true);
  };

  const openEdit = async (user: any) => {
    setEditingId(user.id);
    // Backend pode devolver `roles` (array canônico) ou `role` (legado). Normaliza e deduplica.
    const rawRoles: string[] = Array.isArray(user.roles) && user.roles.length > 0
      ? user.roles
      : user.role ? [user.role] : [];
    const normalized = rawRoles.map(normalizeLegacyRole);
    const uniqueRoles = Array.from(new Set(normalized)) as RoleKey[];
    setForm({
      name: user.name,
      email: user.email,
      phone: user.phone || '',
      password: '',
      roles: uniqueRoles,
      inboxIds: user.inboxes?.map((i: any) => i.id) || [],
      specialties: user.specialties || [],
      supervisorIds: user.supervisors?.map((s: any) => s.id) || [],
      cro_number: user.cro_number || '',
      cro_uf: user.cro_uf || 'AL',
      // Onda 17.32.117 — Setor + overrides
      sector: (user.sector || '') as Sector | '',
      extra_grants:  (user.extra_grants  || []) as Permission[],
      extra_revokes: (user.extra_revokes || []) as Permission[],
    });
    setSpecialtyInput('');
    setError('');
    // v11: ao editar, abre expandido se for DENTIST — facilita ver/ajustar
    // horarios sem precisar clicar no toggle
    setScheduleExpanded(uniqueRoles.includes('DENTIST'));
    // v10: carrega horarios atuais do dentista (se houver)
    setSchedule(defaultWeekSchedule());
    setScheduleLoaded(false); // só vira true se a GET responder (ok com/sem dados)
    if (uniqueRoles.includes('DENTIST')) {
      try {
        const res = await api.get(`/calendar/schedule/${user.id}`);
        if (res.data && res.data.length > 0) {
          setSchedule(apiScheduleToDays(res.data));
        }
        // GET respondeu (com ou sem dados) — estado confiável, pode persistir.
        setScheduleLoaded(true);
      } catch {
        // GET falhou (rede/5xx) — NÃO marca loaded; o save preserva a agenda real
        // em vez de sobrescrever pelo padrão Seg-Sex.
      }
    }
    setShowModal(true);
  };

  // Onda 17.51 — Seletor de "Perfil de acesso" REMOVIDO do formulário: o papel
  // técnico (role) é 100% derivado do SETOR escolhido (ver SECTOR_ROLE + o
  // onClick dos cards). Não há mais toggle manual de roles — era redundante e
  // contraditório com o card de setor.

  const addSpecialty = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || form.specialties.includes(trimmed)) return;
    setForm(f => ({ ...f, specialties: [...f.specialties, trimmed] }));
    setSpecialtyInput('');
  };

  const removeSpecialty = (s: string) => {
    setForm(f => ({ ...f, specialties: f.specialties.filter(x => x !== s) }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    if (form.roles.length === 0) {
      setError('Selecione o setor do usuário (ou um perfil no Avançado).');
      setLoading(false);
      return;
    }

    try {
      let savedUserId: string | undefined = editingId || undefined;
      if (editingId) {
        const payload: any = {
          name: form.name,
          email: form.email,
          phone: form.phone || null,
          roles: form.roles,
          inboxIds: form.inboxIds,
          specialties: form.specialties,
          cro_number: form.cro_number || null,
          cro_uf: form.cro_uf || null,
          // Onda 17.32.117 — Setor + overrides
          sector:        form.sector || null,
          extra_grants:  form.extra_grants,
          extra_revokes: form.extra_revokes,
        };
        if (form.password) payload.password = form.password;
        await api.patch(`/users/${editingId}`, payload);
        // Salvar vínculo de supervisores
        await api.patch(`/users/${editingId}/supervisors`, { lawyerIds: form.supervisorIds });
      } else {
        if (!form.password) {
          setError('Senha é obrigatória para novos usuários.');
          setLoading(false);
          return;
        }
        const res = await api.post('/users', {
          name: form.name,
          email: form.email,
          phone: form.phone || null,
          password: form.password,
          roles: form.roles,
          inboxIds: form.inboxIds,
          specialties: form.specialties,
          cro_number: form.cro_number || null,
          cro_uf: form.cro_uf || null,
          // Onda 17.32.117 — Setor + overrides
          sector:        form.sector || null,
          extra_grants:  form.extra_grants,
          extra_revokes: form.extra_revokes,
        });
        savedUserId = res.data?.id;
        // Salvar vínculo de supervisores para novo usuário
        if (form.supervisorIds.length > 0 && savedUserId) {
          await api.patch(`/users/${savedUserId}/supervisors`, { lawyerIds: form.supervisorIds });
        }
      }

      // v10: salva horarios SE o user eh dentista (criados ou editados).
      // Onda 17.52 — em EDIÇÃO só persiste se o horário real foi carregado da GET
      // (scheduleLoaded) ou o admin mexeu no editor; senão uma falha na GET faria
      // o save sobrescrever a agenda real pelo padrão Seg-Sex (perda de dado +
      // IA propondo horários inexistentes). Em criação (!editingId) sempre salva.
      const needsSchedule = form.roles.includes('DENTIST');
      if (needsSchedule && savedUserId && (!editingId || scheduleLoaded)) {
        try {
          await api.put(`/calendar/schedule/${savedUserId}`, {
            slots: daysToApiSlots(schedule),
          });
        } catch (scheduleErr) {
          // eslint-disable-next-line no-console
          console.warn('Falha ao salvar horarios — user persistido sem schedule', scheduleErr);
        }
      }

      setShowModal(false);
      fetchUsers();
    } catch (e: any) {
      setError(e.response?.data?.message || 'Erro ao salvar usuário.');
    } finally {
      setLoading(false);
    }
  };

  // ── Modal de exclusão com transferência ──
  const [deleteModal, setDeleteModal] = useState<{ id: string; name: string } | null>(null);
  const [deleteSummary, setDeleteSummary] = useState<{ cases: number; conversations: number; tasks: number; events: number; leads: number } | null>(null);
  const [deleteTransferTo, setDeleteTransferTo] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const handleDelete = async (id: string, name: string) => {
    setDeleteModal({ id, name });
    setDeleteTransferTo('');
    setDeleteError('');
    setDeleting(false);
    setDeleteSummary(null);
    try {
      const res = await api.get(`/users/${id}/transfer-summary`);
      setDeleteSummary(res.data);
    } catch {}
  };

  const confirmDelete = async () => {
    if (!deleteModal) return;
    const hasData = deleteSummary && (deleteSummary.cases > 0 || deleteSummary.conversations > 0 || deleteSummary.tasks > 0 || deleteSummary.leads > 0);
    if (hasData && !deleteTransferTo) {
      setDeleteError('Selecione para quem transferir antes de excluir.');
      return;
    }
    setDeleting(true);
    setDeleteError('');
    try {
      await api.delete(`/users/${deleteModal.id}`, {
        data: deleteTransferTo ? { transferToId: deleteTransferTo } : undefined,
      });
      setDeleteModal(null);
      fetchUsers();
    } catch (e: any) {
      setDeleteError(e.response?.data?.message || 'Erro ao remover usuário.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col pt-8 overflow-hidden bg-background">
      <header className="px-8 mb-6 shrink-0 flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">Usuários & Perfis</h1>
          <p className="text-[13px] text-muted-foreground mt-1">Gerencie os usuários do sistema e seus perfis de acesso.</p>
        </div>
        <button
          onClick={openCreate}
          className="px-5 py-2.5 btn-primary font-medium rounded-xl flex items-center shadow-lg shadow-primary/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
        >
          <Plus className="w-5 h-5 mr-2" />
          Novo Usuário
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-8 pb-8">
        {error && !showModal && (
          <div className="mb-6 p-4 bg-destructive/10 border border-destructive/20 rounded-xl text-destructive text-[13px] font-medium">
            {error}
          </div>
        )}

        {/* Tabela de Usuários */}
        <div className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
          {users.length === 0 && !error ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground opacity-40">
              <UserCog className="w-12 h-12 mb-4 stroke-[1.5]" />
              <p className="text-sm font-medium">Nenhum usuário cadastrado</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-foreground/[0.02] border-b border-border">
                    <th className="px-6 py-4 text-[11px] font-bold text-muted-foreground uppercase tracking-wider">Nome</th>
                    <th className="px-6 py-4 text-[11px] font-bold text-muted-foreground uppercase tracking-wider">Email</th>
                    <th className="px-6 py-4 text-[11px] font-bold text-muted-foreground uppercase tracking-wider">Telefone</th>
                    <th className="px-6 py-4 text-[11px] font-bold text-muted-foreground uppercase tracking-wider">Inboxes (Chat)</th>
                    <th className="px-6 py-4 text-[11px] font-bold text-muted-foreground uppercase tracking-wider">Especialidades</th>
                    <th className="px-6 py-4 text-[11px] font-bold text-muted-foreground uppercase tracking-wider">Supervisores</th>
                    <th className="px-6 py-4 text-[11px] font-bold text-muted-foreground uppercase tracking-wider">Criado em</th>
                    <th className="px-6 py-4 text-[11px] font-bold text-muted-foreground uppercase tracking-wider text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-foreground/[0.04]">
                  {users.map((user) => (
                    <tr key={user.id} className="hover:bg-foreground/[0.02] transition-colors group">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold text-xs border border-primary/20 shadow-sm shrink-0">
                            {user.name?.charAt(0)?.toUpperCase()}
                          </div>
                          <div>
                            <span className="text-[14px] font-semibold text-foreground tracking-tight">{user.name}</span>
                            <div className="mt-0.5">{roleBadges(user.roles || (user.role ? [user.role] : []))}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-[13px] text-muted-foreground">
                        <div>{user.email}</div>
                        {/* Onda 17.32.172 — status da confirmacao de e-mail */}
                        <div className="mt-1">
                          {user.email_verified_at ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-500/10 text-emerald-600 text-[10px] font-bold rounded-lg border border-emerald-500/20">
                              ✓ E-mail confirmado
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="px-2 py-0.5 bg-amber-500/10 text-amber-600 text-[10px] font-bold rounded-lg border border-amber-500/20">
                                Aguardando confirmação
                              </span>
                              <button
                                onClick={() => handleResendVerification(user.id)}
                                disabled={resendingId === user.id}
                                className="text-[10px] font-bold text-primary hover:underline disabled:opacity-50"
                                title="Reenviar e-mail de confirmação"
                              >
                                {resendingId === user.id ? 'Enviando…' : resentId === user.id ? 'Enviado!' : 'Reenviar'}
                              </button>
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-[13px] text-muted-foreground">
                        {user.phone ? (
                          <span className="inline-flex items-center gap-1">
                            <Phone className="w-3 h-3 text-green-400" />
                            {user.phone}
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground opacity-50">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap gap-1">
                          {user.inboxes?.map((inbox: any) => (
                            <span key={inbox.id} className="px-2 py-0.5 bg-primary/5 text-primary text-[10px] font-bold rounded-lg border border-primary/10">
                              {inbox.name}
                            </span>
                          ))}
                          {!user.inboxes?.length && <span className="text-[10px] text-muted-foreground opacity-50">Nenhum</span>}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap gap-1">
                          {user.specialties?.map((s: string) => (
                            <span key={s} className="px-2 py-0.5 bg-violet-500/10 text-violet-400 text-[10px] font-bold rounded-lg border border-violet-500/20">
                              {s}
                            </span>
                          ))}
                          {!user.specialties?.length && <span className="text-[10px] text-muted-foreground opacity-50">—</span>}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap gap-1">
                          {user.supervisors?.map((s: any) => (
                            <span key={s.id} className="px-2 py-0.5 bg-indigo-500/10 text-indigo-400 text-[10px] font-bold rounded-lg border border-indigo-500/20">
                              {s.name}
                            </span>
                          ))}
                          {!user.supervisors?.length && <span className="text-[10px] text-muted-foreground opacity-50">—</span>}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-[13px] text-muted-foreground opacity-70">
                        {new Date(user.created_at).toLocaleDateString('pt-BR')}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => openEdit(user)}
                            className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-lg transition-all"
                            title="Editar"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDelete(user.id, user.name)}
                            className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-all"
                            title="Remover"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Modal Criar/Editar — Onda 17.32.117: full-screen (era max-w-md
        com modal central). Layout em 2 colunas a partir de lg: form
        a esquerda, setor+permissoes a direita. Mobile vira stack. */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[100] animate-in fade-in duration-200 dark p-2 sm:p-4 lg:p-6">
          <div className="bg-card border border-border rounded-2xl shadow-2xl w-full h-full mx-auto overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-w-[1400px]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-foreground/[0.02] shrink-0">
              <h2 className="text-lg font-bold text-foreground tracking-tight">
                {editingId ? 'Editar Usuário' : 'Novo Usuário'}
              </h2>
              <button
                onClick={() => setShowModal(false)}
                className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] transition-all rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
              <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-6 overflow-y-auto flex-1"><div className="space-y-4">
              {error && (
                <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-xl text-destructive text-[13px] font-medium">
                  {error}
                </div>
              )}
              <div className="space-y-1.5">
                <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider ml-1">Nome</label>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={e => setForm({ ...form, name: e.target.value })}
                  className="w-full px-4 py-2.5 border border-border rounded-xl bg-background text-foreground focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all placeholder:text-muted-foreground/50"
                  placeholder="Nome completo"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider ml-1">Email</label>
                <input
                  type="email"
                  required
                  value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  className="w-full px-4 py-2.5 border border-border rounded-xl bg-background text-foreground focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all placeholder:text-muted-foreground/50"
                  placeholder="email@exemplo.com"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider ml-1">Telefone (WhatsApp)</label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={e => setForm({ ...form, phone: e.target.value })}
                  className="w-full px-4 py-2.5 border border-border rounded-xl bg-background text-foreground focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all placeholder:text-muted-foreground/50"
                  placeholder="5582999999999"
                />
                <p className="text-[10px] text-muted-foreground opacity-70 ml-1">
                  Formato: código do país + DDD + número (ex: 5582999999999). Usado para lembretes via WhatsApp.
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider ml-1">
                  Senha {editingId && <span className="text-[11px] font-normal lowercase opacity-60">(deixe em branco para manter)</span>}
                </label>
                <input
                  type="password"
                  required={!editingId}
                  value={form.password}
                  onChange={e => setForm({ ...form, password: e.target.value })}
                  className="w-full px-4 py-2.5 border border-border rounded-xl bg-background text-foreground focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all placeholder:text-muted-foreground/50"
                  placeholder="••••••••"
                />
              </div>
              {/* Onda 17.51 — Sem seletor de "Perfil de acesso": o papel vem do
                  setor (coluna ao lado). Só mostra um aviso enquanto nada foi
                  escolhido. */}
              {form.roles.length === 0 && (
                <p className="text-[11px] text-amber-500 ml-1">
                  Escolha o <strong>setor</strong> do usuário (na coluna ao lado) — ele
                  define o perfil de acesso e as permissões.
                </p>
              )}

              {/* CRO — registro no Conselho Regional de Odontologia (só dentistas;
                  mantém visível se já houver um número salvo, pra não esconder dado). */}
              {(form.roles.includes('DENTIST') || form.cro_number) && (
                <div className="space-y-1.5">
                  <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider ml-1">Registro CRO</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={form.cro_number}
                      onChange={e => setForm({ ...form, cro_number: e.target.value.replace(/\D/g, '') })}
                      className="flex-1 px-4 py-2.5 border border-border rounded-xl bg-background text-foreground focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all placeholder:text-muted-foreground/50"
                      placeholder="Número CRO (ex: 12345)"
                      maxLength={10}
                    />
                    <select
                      value={form.cro_uf}
                      onChange={e => setForm({ ...form, cro_uf: e.target.value })}
                      className="w-20 px-2 py-2.5 border border-border rounded-xl bg-background text-foreground focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all"
                    >
                      {UF_OPTIONS.map(uf => <option key={uf} value={uf}>{uf}</option>)}
                    </select>
                  </div>
                  <p className="text-[10px] text-muted-foreground opacity-70 ml-1">
                    Registro no Conselho Regional de Odontologia do dentista.
                  </p>
                </div>
              )}

              {/* Onda 5e v12 (Fase 25) — HORÁRIOS DE ATENDIMENTO POSICIONADOS
                  LOGO APOS CRO pra alta visibilidade. So aparece pra DENTIST/
                  ADMIN. Aberto por default. Badge OBRIGATORIO + texto explicando
                  que IA depende disso pra agendar. Permite dentistas que so
                  trabalham 2 dias na semana, ou turnos parciais (so manha, etc). */}
              {form.roles.includes('DENTIST') && (
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={() => setScheduleExpanded((v) => !v)}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-xl border-2 border-primary/40 bg-primary/10 hover:bg-primary/15 transition-colors"
                  >
                    <span className="flex items-center gap-2 text-[12px] font-bold text-foreground uppercase tracking-wider">
                      <Clock size={14} className="text-primary" />
                      Dias e Horários de Atendimento
                      <span className="px-1.5 py-0.5 text-[9px] font-bold bg-red-500/15 text-red-600 dark:text-red-400 rounded">
                        OBRIGATÓRIO
                      </span>
                    </span>
                    {scheduleExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                  {scheduleExpanded && (
                    <div className="p-3 rounded-xl border border-primary/20 bg-background/50">
                      <p className="text-[11px] text-foreground/80 mb-2 leading-relaxed">
                        Marque <strong>somente os dias</strong> em que o dentista atende. Pra cada dia,
                        defina um ou mais turnos (ex: só manhã, ou manhã + tarde, ou plantão à noite).
                        Dentistas que atendem apenas 2 dias por semana? Desmarque os outros 5.
                      </p>
                      <ScheduleEditor
                        value={schedule}
                        onChange={(s) => { setSchedule(s); setScheduleLoaded(true); }}
                        showHelp={false}
                        compact={true}
                      />
                      <p className="text-[11px] text-muted-foreground mt-3 italic">
                        💡 <strong>Importante:</strong> A IA usa esses horários pra propor agendamentos automaticamente quando um lead pede uma avaliação. Sem turnos cadastrados, esse dentista não recebe agendamentos pela IA.
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider ml-1">Caixas de WhatsApp <span className="text-muted-foreground/60 normal-case font-medium">(acesso ao chat)</span></label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3 border border-border rounded-xl bg-background/50">
                  {inboxes.map(inbox => (
                    <label key={inbox.id} className="flex items-center gap-2 cursor-pointer group min-w-0">
                      <input
                        type="checkbox"
                        checked={form.inboxIds.includes(inbox.id)}
                        onChange={(e) => {
                          const ids = e.target.checked
                            ? [...form.inboxIds, inbox.id]
                            : form.inboxIds.filter(id => id !== inbox.id);
                          setForm({ ...form, inboxIds: ids });
                        }}
                        className="w-4 h-4 shrink-0 rounded border-border text-primary focus:ring-primary/20"
                      />
                      <span className="text-[13px] text-foreground group-hover:text-primary transition-colors truncate">{inbox.name}</span>
                    </label>
                  ))}
                  {inboxes.length === 0 && (
                    <p className="col-span-2 text-[11px] text-muted-foreground italic text-center py-2">Nenhuma caixa de WhatsApp cadastrada.</p>
                  )}
                </div>
              </div>

              {/* Onda 17.52 — Prévia da home do setor escolhido: mostra os balões
                  que esse usuário vai ver, atualizando junto com o card de setor. */}
              {form.sector && (
                <SectorHomePreview
                  sector={form.sector as Sector}
                  extraGrants={form.extra_grants}
                  extraRevokes={form.extra_revokes}
                />
              )}

              {/* Onda 17.51 — Especialidades são atributo clínico do DENTISTA (como
                  CRO/horário). Não faz sentido pra recepção/admin/financeiro. Mantém
                  visível se já houver especialidade salva, pra não esconder dado. */}
              {(form.roles.includes('DENTIST') || form.specialties.length > 0) && (
                <div className="space-y-1.5">
                  <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider ml-1">
                    🦷 Especialidades Odontológicas
                  </label>
                  {form.specialties.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {form.specialties.map(s => (
                        <span key={s} className="inline-flex items-center gap-1 px-2.5 py-1 bg-violet-500/10 border border-violet-500/20 text-violet-300 text-[11px] font-bold rounded-lg">
                          {s}
                          <button type="button" onClick={() => removeSpecialty(s)} className="hover:text-red-400 transition-colors ml-0.5">×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={specialtyInput}
                      onChange={e => setSpecialtyInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSpecialty(specialtyInput); } }}
                      placeholder="Digite e pressione Enter..."
                      className="flex-1 px-3 py-2 border border-border rounded-xl bg-background text-foreground text-sm focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500/50 outline-none transition-all placeholder:text-muted-foreground/50"
                    />
                    <button
                      type="button"
                      onClick={() => addSpecialty(specialtyInput)}
                      className="px-3 py-2 bg-violet-500/10 border border-violet-500/20 text-violet-300 rounded-xl text-sm font-bold hover:bg-violet-500/20 transition-colors"
                    >
                      +
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {SPECIALTY_SUGGESTIONS.filter(s => !form.specialties.includes(s)).map(s => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => addSpecialty(s)}
                        className="px-2 py-0.5 bg-muted/50 border border-border text-muted-foreground text-[10px] rounded-lg hover:bg-violet-500/10 hover:border-violet-500/20 hover:text-violet-300 transition-colors"
                      >
                        + {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Supervisores (Dentistas) — Onda 17.51: a seção vincula o usuário
                  como ASSISTENTE de dentistas, então só faz sentido pro papel
                  Assistente (ACD/ASB). Antes aparecia pra todos. Mantém visível se
                  já houver vínculo salvo, pra não esconder dado. */}
              {(form.roles.includes('ASSISTANT') || form.supervisorIds.length > 0) && lawyers.length > 0 && (
                <div className="space-y-1.5">
                  <label className="text-[12px] font-bold text-muted-foreground uppercase tracking-wider ml-1">
                    🦷 Supervisores (Dentistas)
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-3 border border-border rounded-xl bg-background/50">
                    {lawyers.map(lawyer => (
                      <label key={lawyer.id} className="flex items-center gap-2 cursor-pointer group min-w-0">
                        <input
                          type="checkbox"
                          checked={form.supervisorIds.includes(lawyer.id)}
                          onChange={(e) => {
                            const ids = e.target.checked
                              ? [...form.supervisorIds, lawyer.id]
                              : form.supervisorIds.filter(id => id !== lawyer.id);
                            setForm({ ...form, supervisorIds: ids });
                          }}
                          className="w-4 h-4 shrink-0 rounded border-border text-indigo-500 focus:ring-indigo-500/20"
                        />
                        <div className="min-w-0 truncate">
                          <span className="text-[13px] text-foreground group-hover:text-indigo-400 transition-colors">{lawyer.name}</span>
                          {lawyer.specialties?.length > 0 && (
                            <span className="ml-1 text-[9px] text-muted-foreground">({lawyer.specialties.join(', ')})</span>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground opacity-70 ml-1">
                    Vincule este usuário como assistente de um ou mais dentistas.
                  </p>
                </div>
              )}

              </div>{/* fim da coluna 1 — form principal */}

              {/* ─── Coluna 2: Setor + Permissões (Onda 17.32.117) ─── */}
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-bold text-foreground flex items-center gap-2 mb-1">
                    <ShieldCheck size={14} className="text-violet-600" />
                    Setor e permissões
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Escolha o setor — é a <strong>única</strong> escolha de cadastro.
                    Ele define o <strong>perfil de acesso</strong>, qual{' '}
                    <strong>home (balões)</strong> aparece e quais permissões já vêm
                    marcadas. A barra lateral completa é exclusiva do{' '}
                    <strong>Adm Geral</strong> (ADMIN). Você pode ajustar permissões
                    individualmente abaixo.
                  </p>
                </div>

                {/* Cards dos 5 setores */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {SECTORS.map((s) => {
                    const selected = form.sector === s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setForm(f => ({ ...f, sector: s.id, roles: [SECTOR_ROLE[s.id]], extra_grants: [], extra_revokes: [] }))}
                        className={`text-left p-3 rounded-xl border-2 transition-all ${
                          selected
                            ? 'bg-violet-500/10 border-violet-500/50 ring-2 ring-violet-500/20'
                            : 'bg-card border-border hover:border-violet-500/30'
                        }`}
                      >
                        <div className="text-lg mb-1">{s.icon}</div>
                        <div className={`text-xs font-bold ${selected ? 'text-violet-300' : 'text-foreground'}`}>
                          {s.name}
                        </div>
                        <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                          {s.description}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Permissões — agrupadas por grupo */}
                {form.sector && (() => {
                  const sectorMeta = SECTORS.find(s => s.id === form.sector);
                  const defaults = new Set(sectorMeta?.defaultPermissions ?? []);
                  const groups: Record<string, typeof PERMISSIONS> = {};
                  // Onda 17.52 — esconde 'admin_saas' (cross-tenant, só SUPER_ADMIN):
                  // é decidido pela role, não por permissão — o checkbox era inerte.
                  for (const p of PERMISSIONS) {
                    if (p.key === 'admin_saas') continue;
                    (groups[p.group] ??= []).push(p);
                  }
                  const GROUP_LABEL: Record<string, string> = {
                    paciente: '👤 Paciente', agenda: '📅 Agenda',
                    chat: '💬 Chat / WhatsApp', clinico: '🏥 Clínico',
                    financeiro: '💰 Financeiro', marketing: '📢 Marketing',
                    sistema: '⚙ Sistema',
                  };
                  return (
                    <div className="space-y-3">
                      {Object.keys(groups).map(group => (
                        <div key={group} className="bg-muted/30 rounded-xl p-3 space-y-1.5">
                          <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                            {GROUP_LABEL[group] ?? group}
                          </p>
                          {groups[group].map(p => {
                            const isDefault = defaults.has(p.key);
                            const granted   = form.extra_grants.includes(p.key);
                            const revoked   = form.extra_revokes.includes(p.key);
                            const active    = (isDefault && !revoked) || granted;
                            // Cor/badge do estado
                            const stateLabel =
                              !isDefault && granted ? { text: '+ extra',     cls: 'text-emerald-300 bg-emerald-500/15 border-emerald-500/30' } :
                              isDefault && revoked  ? { text: '− removida',  cls: 'text-red-300     bg-red-500/15     border-red-500/30'     } :
                              isDefault             ? { text: 'do setor',    cls: 'text-violet-300  bg-violet-500/10  border-violet-500/20'  } :
                                                       null;
                            return (
                              <label
                                key={p.key}
                                className="flex items-start gap-2.5 p-2 rounded-lg hover:bg-card cursor-pointer transition-colors"
                              >
                                <input
                                  type="checkbox"
                                  checked={active}
                                  onChange={(e) => {
                                    const want = e.target.checked;
                                    setForm(f => {
                                      let grants  = f.extra_grants.filter(x => x !== p.key);
                                      let revokes = f.extra_revokes.filter(x => x !== p.key);
                                      if (want && !isDefault) grants.push(p.key);
                                      if (!want && isDefault) revokes.push(p.key);
                                      return { ...f, extra_grants: grants, extra_revokes: revokes };
                                    });
                                  }}
                                  className="mt-0.5 shrink-0 w-4 h-4 accent-violet-600 cursor-pointer"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xs font-bold text-foreground">{p.label}</span>
                                    {stateLabel && (
                                      <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${stateLabel.cls}`}>
                                        {stateLabel.text}
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-[10px] text-muted-foreground leading-tight">{p.description}</p>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  );
                })()}

                {!form.sector && (
                  <div className="flex items-center gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-900 dark:text-amber-300">
                    <Sparkles size={14} className="shrink-0" />
                    <p className="text-xs">Selecione um setor acima pra ver e ajustar as permissões.</p>
                  </div>
                )}
              </div>
              </div>{/* fim do grid 2 colunas */}

              <div className="flex justify-end space-x-3 px-6 py-4 border-t border-border shrink-0">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-5 py-2.5 text-muted-foreground font-semibold hover:bg-foreground/[0.05] hover:text-foreground rounded-xl transition-all"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-6 py-2.5 btn-primary disabled:opacity-50 font-bold rounded-xl transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-primary/20"
                >
                  {loading ? 'Salvando...' : editingId ? 'Salvar' : 'Criar Usuário'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal de exclusão com transferência */}
      {deleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !deleting && setDeleteModal(null)} />
          <div className="relative z-10 w-full max-w-md bg-card border border-border rounded-2xl shadow-2xl p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-red-500/15 flex items-center justify-center">
                <Trash2 size={18} className="text-red-400" />
              </div>
              <div>
                <p className="text-[14px] font-bold text-foreground">Excluir {deleteModal.name}</p>
                <p className="text-[11px] text-muted-foreground">Esta ação não pode ser desfeita.</p>
              </div>
            </div>

            {deleteSummary && (deleteSummary.cases > 0 || deleteSummary.conversations > 0 || deleteSummary.tasks > 0 || deleteSummary.leads > 0) ? (
              <>
                <div className="rounded-xl bg-amber-500/5 border border-amber-500/20 p-3 space-y-1.5">
                  <p className="text-[11px] font-bold text-amber-400">Este usuário possui:</p>
                  {deleteSummary.cases > 0 && <p className="text-[11px] text-muted-foreground">🦷 {deleteSummary.cases} caso(s) como dentista</p>}
                  {deleteSummary.conversations > 0 && <p className="text-[11px] text-muted-foreground">💬 {deleteSummary.conversations} conversa(s) atribuída(s)</p>}
                  {deleteSummary.tasks > 0 && <p className="text-[11px] text-muted-foreground">📋 {deleteSummary.tasks} tarefa(s)/evento(s)</p>}
                  {deleteSummary.leads > 0 && <p className="text-[11px] text-muted-foreground">👤 {deleteSummary.leads} lead(s) como responsável</p>}
                </div>

                <div>
                  <label className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                    Transferir tudo para *
                  </label>
                  <select
                    value={deleteTransferTo}
                    onChange={e => setDeleteTransferTo(e.target.value)}
                    className="w-full text-[12px] bg-accent/40 border border-border rounded-xl px-3 py-2.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    <option value="">Selecione o destinatário...</option>
                    {users.filter(u => u.id !== deleteModal.id).map(u => (
                      <option key={u.id} value={u.id}>{u.name} ({u.email})</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Processos, conversas, tarefas e leads serão transferidos para este usuário.
                  </p>
                </div>
              </>
            ) : deleteSummary ? (
              <p className="text-[12px] text-muted-foreground">
                Este usuário não possui dados vinculados. Pode ser excluído diretamente.
              </p>
            ) : (
              <div className="flex items-center gap-2 py-2">
                <Loader2 size={14} className="animate-spin text-muted-foreground" />
                <p className="text-[11px] text-muted-foreground">Verificando dados do usuário...</p>
              </div>
            )}

            {deleteError && (
              <p className="text-[11px] text-red-400 bg-red-500/5 border border-red-500/20 rounded-lg px-3 py-2">{deleteError}</p>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => setDeleteModal(null)}
                disabled={deleting}
                className="flex-1 py-2.5 rounded-xl bg-accent hover:bg-accent/80 text-foreground text-[12px] font-medium transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting || !deleteSummary}
                className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-[12px] font-bold transition-colors disabled:opacity-50"
              >
                {deleting ? 'Excluindo...' : 'Excluir e Transferir'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
