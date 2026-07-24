'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, Plus, Loader2, User, Phone, Archive, CheckCircle2, XCircle, Tag as TagIcon, SlidersHorizontal, Download, ImageDown } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useRole } from '@/lib/useRole';
import { formatPhone, formatCPF } from '@/lib/utils';
import NewPatientModal from './components/NewPatientModal';
import { Badge as TagBadge, type PatientTag } from './components/PatientTagsPicker';
import { PatientAvatar } from '@/components/PatientAvatar';
import BirthdaysCard from './components/BirthdaysCard';

interface Patient {
  id: string;
  name: string;
  cpf: string | null;
  phone: string | null;
  email: string | null;
  avatar_url: string | null;
  /** Foto do WhatsApp do lead vinculado — fallback do avatar até salvar a própria. */
  lead?: { profile_picture_url: string | null } | null;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  // Onda 17.47 — status de atividade CALCULADO pela API (Inativo = +12 meses
  // sem atendimento). O selo usa este; `status` continua sendo o salvo (ARCHIVED).
  activity_status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  primary_dentist?: { id: string; name: string } | null;
  last_visit_at?: string | null;
  tags?: Array<{ tag_id: string; tag: PatientTag }>;
  _count?: { anamneses: number; treatment_plans: number; appointments: number };
}

interface PatientList {
  data: Patient[];
  total: number;
  page: number;
  totalPages: number;
}

const STATUS_BADGE: Record<Patient['status'], { label: string; cls: string; icon: React.ElementType }> = {
  ACTIVE: { label: 'Ativo', cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20', icon: CheckCircle2 },
  INACTIVE: { label: 'Inativo', cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20', icon: XCircle },
  ARCHIVED: { label: 'Arquivado', cls: 'bg-muted text-muted-foreground border-border', icon: Archive },
};

// Next 16 / Turbopack exige useSearchParams() dentro de <Suspense>.
// Wrap o componente que consome o hook num Suspense pra permitir
// pre-rendering — sem isso o build estatico falha em produção.
export default function PacientesPage() {
  return (
    <Suspense fallback={
      <div className="p-6 flex items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
      </div>
    }>
      <PacientesPageInner />
    </Suspense>
  );
}

function PacientesPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const role = useRole();
  const [list, setList] = useState<PatientList>({ data: [], total: 0, page: 1, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED'>('all');
  const [showModal, setShowModal] = useState(false);
  // Backfill de fotos do WhatsApp (pacientes antigos sem foto salva)
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState<string | null>(null);
  const [stats, setStats] = useState({ total: 0, active: 0, inactive: 0, archived: 0, with_active_plan: 0 });
  const [allTags, setAllTags] = useState<PatientTag[]>([]);
  const [tagFilter, setTagFilter] = useState<string>('');
  // Onda 17.44 — paginação (base grande: 7k+ pacientes não cabem em 1 página).
  const [page, setPage] = useState(1);

  // Filtros avancados (Fase 22)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [noVisitMonths, setNoVisitMonths] = useState<string>(''); // '', '3', '6', '12'
  const [withActivePlan, setWithActivePlan] = useState(false);
  const [withoutAnamnesis, setWithoutAnamnesis] = useState(false);

  const hasAdvancedActive = !!noVisitMonths || withActivePlan || withoutAnamnesis;

  // Carrega tags do tenant uma vez (independente do filtro)
  useEffect(() => {
    api.get<PatientTag[]>('/patient-tags')
      .then((r) => setAllTags(r.data || []))
      .catch(() => {});
  }, []);

  // Deep-link: /atendimento/pacientes?new=1 abre o modal automaticamente
  // (acionado pelo sub-item "Novo paciente" do Sidebar). Limpa o param
  // depois pra não reabrir em refresh.
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setShowModal(true);
      router.replace('/atendimento/pacientes');
    }
  }, [searchParams, router]);

  // Onda 17.34 — guarda contra resposta fora de ordem: digitando rapido, a
  // busca antiga podia chegar DEPOIS da nova e sobrescrever a lista com
  // resultado errado. So a requisicao mais recente aplica o resultado.
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (status !== 'all') params.set('activity', status);
      if (tagFilter) params.set('tagId', tagFilter);
      if (noVisitMonths) params.set('noVisitMonths', noVisitMonths);
      if (withActivePlan) params.set('withActivePlan', 'true');
      if (withoutAnamnesis) params.set('withoutAnamnesis', 'true');
      params.set('limit', '50');
      params.set('page', String(page));
      const [listRes, statsRes] = await Promise.all([
        api.get<PatientList>(`/patients?${params.toString()}`),
        api.get<typeof stats>('/patients/stats'),
      ]);
      if (seq !== loadSeqRef.current) return; // chegou atrasada — descarta
      setList(listRes.data);
      setStats(statsRes.data);
    } catch (err: any) {
      if (seq !== loadSeqRef.current) return;
      showError(err?.response?.data?.message || 'Erro ao carregar pacientes');
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [search, status, tagFilter, noVisitMonths, withActivePlan, withoutAnamnesis, page]);

  // Puxa as fotos do WhatsApp pros pacientes SEM foto salva. Roda em lotes (o
  // backend busca 1 foto fresca por paciente com pausa anti-ban), até acabar.
  const handleBackfillPhotos = async () => {
    if (backfillRunning) return;
    if (!confirm(
      'Puxar as fotos do WhatsApp pros pacientes que ainda não têm foto?\n\n' +
      'O sistema consulta o WhatsApp de cada um, com uma pausa entre eles (pode levar alguns minutos). ' +
      'Quem já tem foto (salva ou enviada por você) não é mexido.'
    )) return;
    setBackfillRunning(true);
    setBackfillMsg('Puxando fotos... 0');
    let offset = 0;
    let totalUpdated = 0, totalNoPhoto = 0, totalFailed = 0, totalLinked = 0, totalRenamed = 0, totalShared = 0, totalCleaned = 0;
    try {
      for (let i = 0; i < 500; i++) {
        const { data } = await api.post<{ updated: number; noPhoto: number; failed: number; linkedLeads?: number; renamedLeads?: number; sharedSkipped?: number; cleanedDuplicates?: number; nextOffset: number; done: boolean }>(
          '/patients/backfill-whatsapp-avatars',
          { offset, limit: 10 },
        );
        totalUpdated += data.updated || 0;
        totalNoPhoto += data.noPhoto || 0;
        totalFailed += data.failed || 0;
        totalLinked += data.linkedLeads || 0;
        totalRenamed += data.renamedLeads || 0;
        totalShared += data.sharedSkipped || 0;
        totalCleaned += data.cleanedDuplicates || 0;
        offset = data.nextOffset;
        setBackfillMsg(`Puxando fotos... ${totalUpdated}`);
        if (data.done) break;
        await new Promise((r) => setTimeout(r, 800)); // respiro entre lotes
      }
      showSuccess(
        `Fotos atualizadas: ${totalUpdated}.` +
        (totalLinked ? ` Contatos vinculados: ${totalLinked}.` : '') +
        (totalRenamed ? ` Nomes corrigidos p/ cadastro: ${totalRenamed}.` : '') +
        (totalShared ? ` Números compartilhados (pulados): ${totalShared}.` : '') +
        (totalCleaned ? ` Fotos duplicadas removidas: ${totalCleaned}.` : '') +
        (totalNoPhoto ? ` Sem foto no WhatsApp: ${totalNoPhoto}.` : '') +
        (totalFailed ? ` Falhas: ${totalFailed}.` : '')
      );
      await load(); // recarrega a lista pra mostrar as fotos novas
    } catch (e: any) {
      showError(e?.response?.data?.message || 'Falha ao puxar as fotos do WhatsApp');
    } finally {
      setBackfillRunning(false);
      setBackfillMsg(null);
    }
  };

  // Export CSV: gera planilha com filtros aplicados (limit alto)
  const handleExportCsv = async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (status !== 'all') params.set('activity', status);
      if (tagFilter) params.set('tagId', tagFilter);
      if (noVisitMonths) params.set('noVisitMonths', noVisitMonths);
      if (withActivePlan) params.set('withActivePlan', 'true');
      if (withoutAnamnesis) params.set('withoutAnamnesis', 'true');
      params.set('limit', '500');
      const { data } = await api.get<PatientList>(`/patients?${params.toString()}`);
      // Gera CSV in-browser (evita endpoint dedicado pra MVP)
      const headers = ['Nome', 'CPF', 'Telefone', 'Email', 'Status', 'Dentista', 'Tags'];
      const rows = data.data.map((p: any) => [
        p.name || '',
        p.cpf || '',
        p.phone || '',
        p.email || '',
        // Onda 17.47 — coluna Status usa o rotulo CALCULADO (igual ao selo da
        // lista): Ativo/Inativo/Arquivado, nao o campo cru do banco.
        STATUS_BADGE[(p.activity_status ?? p.status) as Patient['status']]?.label || '',
        p.primary_dentist?.name || '',
        (p.tags || []).map((t: any) => t.tag?.name).filter(Boolean).join('; '),
      ]);
      const csv = [headers, ...rows]
        .map((r) => r.map((cell: string) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        .join('\n');
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pacientes-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao exportar');
    }
  };

  useEffect(() => {
    const t = setTimeout(load, 250); // debounce leve pra busca
    return () => clearTimeout(t);
  }, [load]);

  // Onda 17.44 — qualquer mudança de filtro volta pra página 1 (senão você
  // poderia ficar "preso" numa página que o novo filtro nem tem).
  useEffect(() => {
    setPage(1);
  }, [search, status, tagFilter, noVisitMonths, withActivePlan, withoutAnamnesis]);

  const handleCreated = (patient: Patient) => {
    setShowModal(false);
    load();
    router.push(`/atendimento/pacientes/${patient.id}`);
  };

  return (
    // Onda 17.46 — root precisa do proprio scroll: o <main> do layout e
    // overflow-hidden, entao sem h-full+overflow-y-auto aqui a lista de 50
    // pacientes estoura a altura e nao rola (padrao igual ao dashboard).
    <div className="h-full overflow-y-auto p-6 w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Pacientes</h1>
          <p className="text-sm text-muted-foreground">Cadastro e ficha clínica dos pacientes da clínica</p>
        </div>
        {/* Novo paciente — apenas pra ADMIN/OPERADOR (secretaria)/ASSISTANT.
            DENTIST/FINANCEIRO nao cadastram standalone — pra atender, usam
            o botao "Atender" da ficha (ensure-patient idempotente). */}
        {role.canCreatePatient && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleBackfillPhotos}
              disabled={backfillRunning}
              title="Puxar as fotos do WhatsApp pros pacientes que ainda não têm foto (com pausa anti-ban)"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-card border border-border text-sm font-medium hover:bg-accent transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {backfillRunning
                ? <Loader2 size={16} className="animate-spin" />
                : <ImageDown size={16} />}
              {backfillMsg || 'Puxar fotos do WhatsApp'}
            </button>
            <button
              onClick={() => setShowModal(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Plus size={16} /> Novo paciente
            </button>
          </div>
        )}
      </div>

      {/* Aniversariantes (auto-esconde se nao tem ninguem hoje) */}
      <BirthdaysCard />

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        {[
          { label: 'Total', value: stats.total, cls: 'text-foreground', hint: 'Todos os pacientes cadastrados' },
          { label: 'Ativos', value: stats.active, cls: 'text-emerald-600', hint: 'Com atendimento nos últimos 12 meses' },
          { label: 'Inativos', value: stats.inactive, cls: 'text-amber-600', hint: 'Mais de 12 meses sem atendimento' },
          { label: 'Arquivados', value: stats.archived, cls: 'text-muted-foreground', hint: 'Arquivados manualmente' },
          { label: 'Em tratamento', value: stats.with_active_plan, cls: 'text-primary', hint: 'Com plano de tratamento ativo' },
        ].map((s) => (
          <div key={s.label} title={s.hint} className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{s.label}</p>
            <p className={`text-2xl font-bold mt-1 ${s.cls}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          {/* pointer-events-none: o icone fica sobre o input (left-3 absolute);
              sem isso, clicar em cima da lupa NAO foca o campo e o que voce
              digita nao registra (lista nao filtra). Padrao igual ao PatientSearch. */}
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, ficha, CPF, telefone, email ou etiqueta..."
            className="w-full pl-10 pr-3 py-2 rounded-lg bg-card border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          className="px-3 py-2 rounded-lg bg-card border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        >
          <option value="all">Todos os status</option>
          <option value="ACTIVE">Ativos</option>
          <option value="INACTIVE">Inativos</option>
          <option value="ARCHIVED">Arquivados</option>
        </select>
        {allTags.length > 0 && (
          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            className="px-3 py-2 rounded-lg bg-card border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            title="Filtrar por tag"
          >
            <option value="">Todas as tags</option>
            {allTags.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className={`px-3 py-2 rounded-lg border text-sm inline-flex items-center gap-1 ${
            showAdvanced || hasAdvancedActive
              ? 'bg-primary/10 border-primary/30 text-primary'
              : 'bg-card border-border hover:bg-accent'
          }`}
        >
          <SlidersHorizontal size={14} />
          Filtros avançados
          {hasAdvancedActive && (
            <span className="ml-1 inline-block w-2 h-2 rounded-full bg-primary" />
          )}
        </button>
        <button
          onClick={handleExportCsv}
          className="px-3 py-2 rounded-lg bg-card border border-border text-sm hover:bg-accent inline-flex items-center gap-1"
          title="Exportar CSV com filtros aplicados"
        >
          <Download size={14} /> CSV
        </button>
      </div>

      {/* Painel de filtros avançados — colapsável */}
      {showAdvanced && (
        <div className="bg-card border border-border rounded-xl p-4 mb-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Sem revisão há</label>
              <select
                value={noVisitMonths}
                onChange={(e) => setNoVisitMonths(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm"
              >
                <option value="">Qualquer período</option>
                <option value="3">3 meses ou mais</option>
                <option value="6">6 meses ou mais</option>
                <option value="12">12 meses ou mais</option>
                <option value="24">24 meses ou mais</option>
              </select>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={withActivePlan}
                  onChange={(e) => setWithActivePlan(e.target.checked)}
                  className="w-4 h-4 rounded border-border"
                />
                Apenas com plano ativo
              </label>
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={withoutAnamnesis}
                  onChange={(e) => setWithoutAnamnesis(e.target.checked)}
                  className="w-4 h-4 rounded border-border"
                />
                Sem anamnese preenchida
              </label>
            </div>
          </div>
          {hasAdvancedActive && (
            <div className="flex justify-end">
              <button
                onClick={() => {
                  setNoVisitMonths('');
                  setWithActivePlan(false);
                  setWithoutAnamnesis(false);
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Limpar filtros avançados
              </button>
            </div>
          )}
        </div>
      )}

      {/* Lista */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        {loading ? (
          <div className="py-12 flex items-center justify-center text-muted-foreground">
            <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
          </div>
        ) : list.data.length === 0 ? (
          <div className="py-16 text-center">
            <User size={40} className="mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground">Nenhum paciente encontrado.</p>
            <p className="text-xs text-muted-foreground mt-1">
              {search ? 'Ajuste os filtros ou cadastre um novo paciente.' : 'Cadastre o primeiro paciente para começar.'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {list.data.map((p) => {
              // Onda 17.47 — selo usa o status CALCULADO (Inativo = +12m sem
              // atendimento) que a API manda; cai pro status salvo se faltar.
              const activity = p.activity_status ?? p.status;
              const StatusIcon = STATUS_BADGE[activity].icon;
              return (
                <li
                  key={p.id}
                  onClick={() => router.push(`/atendimento/pacientes/${p.id}`)}
                  className="px-4 py-3 hover:bg-accent/40 transition-colors cursor-pointer flex items-center gap-4"
                >
                  <PatientAvatar
                    patientId={p.id}
                    patientName={p.name}
                    avatarUrl={p.avatar_url}
                    fallbackPhotoUrl={p.lead?.profile_picture_url}
                    size={56}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-foreground truncate">{p.name}</p>
                    {/* Onda 17.35.4 — etiquetas em linha própria logo abaixo do
                        nome, pra ficarem expostas (antes ficavam coladas no
                        nome e passavam batido). */}
                    {p.tags && p.tags.length > 0 && (
                      <div className="flex items-center gap-1 flex-wrap mt-1">
                        {p.tags.slice(0, 5).map((t) => (
                          <TagBadge key={t.tag_id} tag={t.tag} />
                        ))}
                        {p.tags.length > 5 && (
                          <span className="text-[10px] text-muted-foreground">
                            +{p.tags.length - 5}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                      {/* Onda 17.32.184 — ficha visivel na listagem */}
                      {(p as any).record_number && <span className="font-semibold text-primary">Ficha {(p as any).record_number}</span>}
                      {p.phone && <span className="flex items-center gap-1"><Phone size={12} /> {formatPhone(p.phone)}</span>}
                      {p.cpf && <span>CPF: {formatCPF(p.cpf)}</span>}
                      {p.primary_dentist && <span>Dentista: {p.primary_dentist.name}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {p._count && (p._count.treatment_plans > 0 || p._count.anamneses > 0) && (
                      <div className="text-xs text-muted-foreground hidden md:block">
                        {p._count.treatment_plans > 0 && <span className="mr-2">{p._count.treatment_plans} plano(s)</span>}
                        {p._count.anamneses > 0 && <span>{p._count.anamneses} anamnese(s)</span>}
                      </div>
                    )}
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_BADGE[activity].cls}`}
                    >
                      <StatusIcon size={12} /> {STATUS_BADGE[activity].label}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {list.total > 0 && (
        <div className="flex items-center justify-between gap-3 mt-3 flex-wrap">
          <p className="text-xs text-muted-foreground">
            Mostrando {(list.page - 1) * 50 + 1}–{(list.page - 1) * 50 + list.data.length} de {list.total} pacientes
          </p>
          {list.totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={list.page <= 1 || loading}
                className="px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-card hover:bg-accent/40 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                ← Anterior
              </button>
              <span className="text-xs text-muted-foreground tabular-nums">
                Página {list.page} de {list.totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(list.totalPages, p + 1))}
                disabled={list.page >= list.totalPages || loading}
                className="px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-card hover:bg-accent/40 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Próxima →
              </button>
            </div>
          )}
        </div>
      )}

      {showModal && (
        <NewPatientModal onClose={() => setShowModal(false)} onCreated={handleCreated} />
      )}
    </div>
  );
}
