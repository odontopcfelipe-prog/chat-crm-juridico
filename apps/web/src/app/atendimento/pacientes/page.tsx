'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, Plus, Loader2, User, Phone, Archive, CheckCircle2, XCircle, Tag as TagIcon, SlidersHorizontal, Download } from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';
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
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
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
  const [stats, setStats] = useState({ total: 0, active: 0, inactive: 0, archived: 0, with_active_plan: 0 });
  const [allTags, setAllTags] = useState<PatientTag[]>([]);
  const [tagFilter, setTagFilter] = useState<string>('');

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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (status !== 'all') params.set('status', status);
      if (tagFilter) params.set('tagId', tagFilter);
      if (noVisitMonths) params.set('noVisitMonths', noVisitMonths);
      if (withActivePlan) params.set('withActivePlan', 'true');
      if (withoutAnamnesis) params.set('withoutAnamnesis', 'true');
      params.set('limit', '50');
      const [listRes, statsRes] = await Promise.all([
        api.get<PatientList>(`/patients?${params.toString()}`),
        api.get<typeof stats>('/patients/stats'),
      ]);
      setList(listRes.data);
      setStats(statsRes.data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar pacientes');
    } finally {
      setLoading(false);
    }
  }, [search, status, tagFilter, noVisitMonths, withActivePlan, withoutAnamnesis]);

  // Export CSV: gera planilha com filtros aplicados (limit alto)
  const handleExportCsv = async () => {
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (status !== 'all') params.set('status', status);
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
        p.status || '',
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

  const handleCreated = (patient: Patient) => {
    setShowModal(false);
    load();
    router.push(`/atendimento/pacientes/${patient.id}`);
  };

  return (
    <div className="p-6 w-full">
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
          <button
            onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus size={16} /> Novo paciente
          </button>
        )}
      </div>

      {/* Aniversariantes (auto-esconde se nao tem ninguem hoje) */}
      <BirthdaysCard />

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        {[
          { label: 'Total', value: stats.total, cls: 'text-foreground' },
          { label: 'Ativos', value: stats.active, cls: 'text-emerald-600' },
          { label: 'Inativos', value: stats.inactive, cls: 'text-amber-600' },
          { label: 'Arquivados', value: stats.archived, cls: 'text-muted-foreground' },
          { label: 'Em tratamento', value: stats.with_active_plan, cls: 'text-primary' },
        ].map((s) => (
          <div key={s.label} className="bg-card border border-border rounded-xl p-4">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{s.label}</p>
            <p className={`text-2xl font-bold mt-1 ${s.cls}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Filtros */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, CPF, telefone ou email..."
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
              const StatusIcon = STATUS_BADGE[p.status].icon;
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
                    size={56}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-foreground truncate">{p.name}</p>
                      {p.tags && p.tags.length > 0 && (
                        <div className="flex items-center gap-1 flex-wrap">
                          {p.tags.slice(0, 3).map((t) => (
                            <TagBadge key={t.tag_id} tag={t.tag} />
                          ))}
                          {p.tags.length > 3 && (
                            <span className="text-[10px] text-muted-foreground">
                              +{p.tags.length - 3}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
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
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_BADGE[p.status].cls}`}
                    >
                      <StatusIcon size={12} /> {STATUS_BADGE[p.status].label}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {list.total > 0 && (
        <p className="text-xs text-muted-foreground mt-3 text-center">
          Mostrando {list.data.length} de {list.total} pacientes
        </p>
      )}

      {showModal && (
        <NewPatientModal onClose={() => setShowModal(false)} onCreated={handleCreated} />
      )}
    </div>
  );
}
