'use client';

/**
 * PacienteFichaPage — ficha completa do paciente.
 *
 * Tabs: Visão geral, Anamnese, Prontuário, Odontograma, Estética facial,
 * Smile Design, Radiografias, Orçamentos, Tratamentos.
 *
 * Visão geral é 100% editável:
 *  - Header: avatar com upload de foto (POST /patients/:id/avatar)
 *  - Card "Dados pessoais": botão Editar abre EditPatientModal completo
 *    (com endereço + ViaCEP + estado civil + responsável legal)
 *  - Card "Resumo clínico": dentista principal + queixa principal editáveis inline
 *  - Card "Alergias" / "Medicações": botão "+ Adicionar" + lixeira por item
 */
import { useEffect, useRef, useState, Suspense } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft, Loader2, User, Phone, Mail, IdCard,
  FileText, Stethoscope, Activity, DollarSign,
  AlertTriangle, Pill, Trash2, Sparkles, MessageCircle,
  Pencil, Plus, Camera, Check, X, Clock, ChevronRight, Calendar,
  Layers, HandCoins,
} from 'lucide-react';
import api, { API_BASE_URL } from '@/lib/api';
import { useAuthedImage } from '@/lib/use-authed-image';
import { showError, showSuccess } from '@/lib/toast';
import { useRole } from '@/lib/useRole';
import { useUserPermissions } from '@/lib/useUserPermissions';
import { calculateAge, formatBirthDateWithAge } from '@/lib/age';
import { formatPhone, formatCPF, formatRG } from '@/lib/utils';
import AnamneseTab from '../components/AnamneseTab';
import ProntuarioTab from '../components/ProntuarioTab';
import OdontogramaTab from '../components/OdontogramaTab';
import OrcamentoTab from '../components/OrcamentoTab';
import FinanceiroTab from '../components/FinanceiroTab';
import PropostasTab from '../components/PropostasTab';
import EsteticaFacialTab from '../components/EsteticaFacialTab';
import SmileDesignTab from '../components/SmileDesignTab';
import RadiografiasTab from '../components/RadiografiasTab';
import AfiliadoTab from '../components/AfiliadoTab';
// Onda 5e v38 — aba Tratamento (procedimentos fechados + validacao por dentista)
import TratamentoTab from '../components/TratamentoTab';
import EditPatientModal from '../components/EditPatientModal';
import { AddAllergyModal, AddMedicationModal } from '../components/AllergyMedicationModals';
import TimelineTab from '../components/TimelineTab';
import OverviewClinicalSection from '../components/OverviewClinicalSection';
import PatientTagsPicker, { type AssignedTag } from '../components/PatientTagsPicker';

interface Patient {
  id: string;
  name: string;
  cpf: string | null;
  rg: string | null;
  birth_date: string | null;
  gender: string | null;
  marital_status: string | null;
  avatar_url: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  address_number: string | null;
  address_complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  blood_type: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  is_minor: boolean | null;
  guardian_name: string | null;
  guardian_cpf: string | null;
  guardian_phone: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  first_visit_at: string | null;
  last_visit_at: string | null;
  notes: string | null;
  chief_complaint: string | null;
  primary_dentist_id: string | null;
  primary_dentist?: { id: string; name: string } | null;
  referred_by: string | null;
  referred_by_id: string | null;
  referred_by_patient?: { id: string; name: string | null; phone: string } | null;
  // Programa de Afiliado — paciente parceiro que indica e recebe 3%
  is_affiliate?: boolean | null;
  affiliate_code?: string | null;
  affiliate_commission_pct?: number | null;
  affiliate_notes?: string | null;
  tags?: AssignedTag[];
  allergies: Array<{ id: string; allergen: string; severity: string | null; notes: string | null }>;
  medications: Array<{ id: string; medication: string; dosage: string | null; frequency: string | null }>;
  medical_record?: { id: string; chief_complaint: string | null } | null;
  _count?: { appointments: number; clinical_images: number; consents: number; quotes: number; referrals: number };
}

interface UserOption { id: string; name: string }

const TABS = [
  // Onda 3.30 — Tabs reorganizadas em 2 grupos (operational + clinical)
  // pra fluxo de dia-a-dia ficar à esquerda, documentação à direita.
  // Operational
  { id: 'overview',       label: 'Visão geral',     icon: User,        group: 'operational' as const },
  { id: 'odontogram',     label: 'Avaliação',       icon: Activity,    group: 'operational' as const },
  // Onda 17.32.23 — Aba "Orçamentos" removida. Fluxo enxuto: Avaliação cria itens,
  // Propostas exibe versões agrupadas (urgente/essencial/completo) com configuração
  // de cobrança direto no painel. Componente OrcamentoTab + endpoints continuam
  // existindo (são consumidos por outras telas) — apenas a aba sumiu do menu.
  { id: 'proposals',      label: 'Propostas',       icon: Layers,      group: 'operational' as const },
  { id: 'financial',      label: 'Financeiro',      icon: DollarSign,  group: 'operational' as const },
  // Onda 5e v38 — Tratamento: procedimentos fechados (de quotes ACCEPTED),
  // validacao por item (dentista responsavel marca "feito" + executed_at)
  { id: 'treatment',      label: 'Tratamento',      icon: Activity,    group: 'operational' as const },
  // Afiliado — so aparece quando patient.is_affiliate = true (filtrado no render)
  { id: 'affiliate',      label: 'Afiliado',        icon: HandCoins,   group: 'operational' as const },
  // Clinical (documentação/histórico)
  { id: 'timeline',       label: 'Histórico',       icon: Clock,       group: 'clinical'    as const },
  { id: 'anamnesis',      label: 'Anamnese',        icon: FileText,    group: 'clinical'    as const },
  { id: 'medical-record', label: 'Prontuário',      icon: Stethoscope, group: 'clinical'    as const },
  { id: 'radiografias',   label: 'Radiografias',    icon: Activity,    group: 'clinical'    as const },
  { id: 'smile-design',   label: 'Smile Design',    icon: Sparkles,    group: 'clinical'    as const },
  { id: 'esthetic',       label: 'Estética facial', icon: Sparkles,    group: 'clinical'    as const },
] as const;

type TabId = typeof TABS[number]['id'];

const MARITAL_LABEL: Record<string, string> = {
  SOLTEIRO: 'Solteiro(a)',
  CASADO: 'Casado(a)',
  UNIAO_ESTAVEL: 'União estável',
  DIVORCIADO: 'Divorciado(a)',
  VIUVO: 'Viúvo(a)',
};

const SEVERITY_LABEL: Record<string, string> = { MILD: 'Leve', MODERATE: 'Moderada', SEVERE: 'Grave' };
const SEVERITY_CLS: Record<string, string> = {
  MILD:     'bg-amber-500/10 text-amber-600 border-amber-500/20',
  MODERATE: 'bg-orange-500/10 text-orange-600 border-orange-500/20',
  SEVERE:   'bg-red-500/10 text-red-600 border-red-500/20',
};

// Wrap padrão com <Suspense> exigido por Next 16 / Turbopack quando o
// componente filho usa useSearchParams (pra ler ?tab=...).
export default function PacienteFichaPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Carregando ficha...</div>}>
      <PacienteFichaInner />
    </Suspense>
  );
}

function PacienteFichaInner() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const role = useRole();
  // Onda 17.65 — Propostas (manage_proposals) e Financeiro (view_financial) só pra
  // quem tem a permissão. Dentista sem o grant não vê as abas. Gateia por permissão
  // (não por papel), então recepção/CRC/admin que têm continuam vendo.
  const { hasPermission, ready: permsReady } = useUserPermissions();
  const canProposals = hasPermission('manage_proposals');
  const canFinancial = hasPermission('view_financial');
  const [patient, setPatient] = useState<Patient | null>(null);
  const [loading, setLoading] = useState(true);
  // Aceita ?tab=odontogram (e variantes) na URL pra que outras páginas
  // (ex: botão "Atender" do CRM Kanban) abram direto na aba certa.
  // Lista permitida = TabId — qualquer valor inválido cai em 'overview'.
  const initialTab: TabId = (() => {
    const raw = searchParams?.get('tab');
    if (!raw) return 'overview';
    const valid = TABS.some(t => t.id === raw);
    return valid ? (raw as TabId) : 'overview';
  })();
  const [tab, setTab] = useState<TabId>(initialTab);
  // Onda 17.65 — se cair numa aba sem permissão (ex.: ?tab=financial via link),
  // volta pra Visão Geral (só depois que /users/me carregou as permissões).
  useEffect(() => {
    if (!permsReady) return;
    if ((tab === 'proposals' && !canProposals) || (tab === 'financial' && !canFinancial)) {
      setTab('overview');
    }
  }, [permsReady, tab, canProposals, canFinancial]);
  const [editOpen, setEditOpen] = useState(false);
  const [addAllergyOpen, setAddAllergyOpen] = useState(false);
  const [addMedOpen, setAddMedOpen] = useState(false);
  const [avatarBust, setAvatarBust] = useState(0); // força reload da img após upload
  // Filtro pré-aplicado quando entra na aba Histórico via click em contador
  // (ex: "Consultas: 1" abre Histórico já filtrado por appointment)
  const [historyInitialFilter, setHistoryInitialFilter] = useState<Set<string> | undefined>(undefined);

  const load = async () => {
    if (!params?.id) return;
    setLoading(true);
    try {
      const { data } = await api.get<Patient>(`/patients/${params.id}`);
      setPatient(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar paciente');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [params?.id]);

  const handleSendPortalLink = async () => {
    if (!patient) return;
    if (!patient.phone) {
      showError('Paciente sem telefone — cadastre antes de enviar o portal');
      return;
    }
    if (!confirm(`Enviar link do Portal do Paciente para ${patient.name} via WhatsApp (${patient.phone})?`)) return;
    try {
      const { data } = await api.post('/portal/magic-link', {
        patient_id: patient.id,
        channel: 'WHATSAPP',
      });
      if (data?.dispatch?.status === 'SENT') {
        showSuccess(`Link enviado para ${patient.phone}!`);
      } else if (data?.dispatch?.status === 'FAILED') {
        showError(`Token gerado mas envio falhou: ${data.dispatch.reason}. Link: ${data.link}`);
      } else {
        showSuccess(`Link gerado: ${data.link}`);
      }
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao gerar link');
    }
  };

  const handleArchive = async () => {
    if (!patient) return;
    if (!confirm(`Arquivar o paciente ${patient.name}? Esta ação preserva todos os dados.`)) return;
    try {
      await api.delete(`/patients/${patient.id}`);
      showSuccess('Paciente arquivado');
      router.push('/atendimento/pacientes');
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao arquivar');
    }
  };

  // Onda 14 — Exclusao permanente (hard delete). Modal pede digitacao do nome.
  // Onda 14.1 — Modal expandido com preview de dependencias + opção cascade.
  interface DeletionPreview {
    can_delete_safely: boolean;
    appointments: Array<{ id: string; title: string; type: string; status: string; start_at: string }>;
    quotes: Array<{ id: string; title: string | null; status: string; total_value: number | string; created_at: string }>;
    paid_installments: Array<{ id: string; amount: number | string; paid_at: string; sequence: number; total_count: number }>;
    medical_records_count: number;
  }
  const [deletePermanentOpen, setDeletePermanentOpen] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deletingPermanent, setDeletingPermanent] = useState(false);
  const [deletionPreview, setDeletionPreview] = useState<DeletionPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [forceCheckbox, setForceCheckbox] = useState(false);

  const openDeleteModal = async () => {
    if (!patient) return;
    setDeleteConfirmName('');
    setForceCheckbox(false);
    setDeletionPreview(null);
    setDeletePermanentOpen(true);
    setLoadingPreview(true);
    try {
      const { data } = await api.get<DeletionPreview>(`/patients/${patient.id}/deletion-preview`);
      setDeletionPreview(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar dependências');
      setDeletePermanentOpen(false);
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleDeletePermanent = async () => {
    if (!patient || !deletionPreview) return;
    setDeletingPermanent(true);
    try {
      // Se pode deletar safely (sem deps) → endpoint normal
      // Senão → endpoint /force que apaga cascade
      const url = deletionPreview.can_delete_safely
        ? `/patients/${patient.id}/permanent`
        : `/patients/${patient.id}/permanent/force`;
      await api.delete(url);
      showSuccess(
        deletionPreview.can_delete_safely
          ? 'Paciente excluído permanentemente'
          : 'Paciente e todas as dependências excluídos',
      );
      router.push('/atendimento/pacientes');
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao excluir paciente');
    } finally {
      setDeletingPermanent(false);
    }
  };

  const fmtDateBR = (iso: string) =>
    new Date(iso).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
    });
  const fmtDateTimeBR = (iso: string) =>
    new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });

  // Onda 3.30 — Avaliação restaurado no header (antigo "Atender", renomeado).
  // Marca que o paciente compareceu (gradua lead pra "Avaliacao Feita") + abre
  // o Odontograma. Permite contabilizar quem efetivamente veio na clínica.
  const [startingAttending, setStartingAttending] = useState(false);
  const handleStartAttending = async () => {
    if (!patient || startingAttending) return;
    setStartingAttending(true);
    try {
      await api.post(`/patients/${patient.id}/start-attending`);
      router.replace(`/atendimento/pacientes/${patient.id}?tab=odontogram`);
      setTab('odontogram');
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao iniciar avaliação');
    } finally {
      setStartingAttending(false);
    }
  };


  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando ficha...
      </div>
    );
  }

  if (!patient) return null;

  const age = calculateAge(patient.birth_date);
  const avatarUrl = patient.avatar_url
    ? `${API_BASE_URL}/patients/${patient.id}/avatar?t=${avatarBust}`
    : null;

  return (
    // h-full + overflow-y-auto: pai <main> tem overflow-hidden, entao precisamos
    // de container scrollavel proprio pra que conteudos longos (orcamento com
    // anexos, prontuario com muitas evolucoes) nao fiquem cortados na viewport.
    <div className="h-full overflow-y-auto p-6 w-full">
      {/* Back */}
      <button
        onClick={() => router.push('/atendimento/pacientes')}
        className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-4"
      >
        <ArrowLeft size={14} /> Voltar para lista
      </button>

      {/* Header com avatar editável */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-4">
          <AvatarUploader
            patientId={patient.id}
            avatarUrl={avatarUrl}
            patientName={patient.name}
            onUploaded={() => { setAvatarBust(Date.now()); load(); }}
            readOnly={!role.canEditPatientPersonalData}
          />
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2 flex-wrap">
              {patient.name}
              {age !== null && (
                <span className="text-sm font-normal text-muted-foreground">({age} anos)</span>
              )}
              {patient.is_minor && (
                <span className="text-xs px-2 py-0.5 rounded bg-blue-500/10 text-blue-600 border border-blue-500/20">
                  Menor de idade
                </span>
              )}
            </h1>
            <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1 flex-wrap">
              {patient.phone && <span className="flex items-center gap-1"><Phone size={14} /> {formatPhone(patient.phone)}</span>}
              {patient.email && <span className="flex items-center gap-1"><Mail size={14} /> {patient.email}</span>}
              {patient.cpf && <span className="flex items-center gap-1"><IdCard size={14} /> {formatCPF(patient.cpf)}</span>}
            </div>
            {/* Tags do paciente — gerenciamento inline */}
            <div className="mt-2">
              <PatientTagsPicker
                patientId={patient.id}
                initialTags={patient.tags || []}
              />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Onda 5e v36 — Badge "Afiliado" quando ativo (atalho pra aba).
              Onda 5e v37: o botao "Tornar Afiliado" foi removido daqui —
              ativacao agora so pelo modal Editar > Programa de Afiliado
              (toggle), pra manter o header da ficha enxuto. */}
          {patient.status !== 'ARCHIVED' && patient.is_affiliate && (
            <button
              onClick={() => {
                router.replace(`/atendimento/pacientes/${patient.id}?tab=affiliate`);
                setTab('affiliate');
              }}
              className="text-xs text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40 hover:bg-emerald-100 dark:hover:bg-emerald-950/60 border border-emerald-300 dark:border-emerald-800 px-3 py-2 rounded-lg flex items-center gap-1.5 font-bold shadow-sm"
              title="Paciente é afiliado — ver saldo e indicações"
            >
              <HandCoins size={14} /> Afiliado
            </button>
          )}

          {/* Onda 3.30 — Avaliação (antigo "Atender" renomeado). Marca
              comparecimento + abre Odontograma. */}
          {patient.status !== 'ARCHIVED' && (
            <button
              onClick={handleStartAttending}
              disabled={startingAttending}
              className="text-xs text-white bg-sky-600 hover:bg-sky-700 px-3 py-2 rounded-lg flex items-center gap-1 font-semibold shadow-sm disabled:opacity-50"
              title="Marca que o paciente compareceu pra avaliação e abre o Odontograma"
            >
              {startingAttending ? <Loader2 size={14} className="animate-spin" /> : <Stethoscope size={14} />}
              Avaliação
            </button>
          )}
          {patient.status !== 'ARCHIVED' && (
            <button
              onClick={() => {
                const params = new URLSearchParams({
                  new: '1',
                  patient_id: patient.id,
                  patient_name: patient.name || '',
                  phone: patient.phone || '',
                });
                router.push(`/atendimento/agenda?${params.toString()}`);
              }}
              className="text-xs text-white bg-primary hover:bg-primary/90 px-3 py-2 rounded-lg flex items-center gap-1 font-semibold shadow-sm"
              title="Agendar consulta para este paciente"
            >
              <Calendar size={14} /> Agendar
            </button>
          )}
          {/* Onda 3.30 — "Enviar portal" removido do header pra limpar a
              area principal de acoes. Acionavel via outras rotas. */}
          {/* Arquivar — exclusivo do ADMIN (backend tambem valida).
              Secretaria/dentista nao podem apagar paciente do sistema. */}
          {patient.status !== 'ARCHIVED' && role.canArchivePatient && (
            <button
              onClick={handleArchive}
              className="text-xs text-destructive hover:bg-destructive/10 px-3 py-2 rounded-lg flex items-center gap-1"
              title="Arquiva o paciente (preserva histórico, reversível)"
            >
              <Trash2 size={14} /> Arquivar
            </button>
          )}
          {/* Onda 14 — Excluir permanentemente (hard delete).
              Onda 14.1 — Mostra preview das dependencias + badge "ADMIN". */}
          {role.canArchivePatient && (
            <button
              onClick={openDeleteModal}
              className="text-xs text-white bg-red-600 hover:bg-red-700 px-3 py-2 rounded-lg flex items-center gap-1.5 font-semibold shadow-sm"
              title="Exclui o paciente permanentemente do banco (irreversível) — apenas ADMIN"
            >
              <Trash2 size={14} /> Excluir
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-white/20 text-white border border-white/30">
                🔒 ADMIN
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Onda 14.1 — Modal de exclusao com preview detalhado das dependencias */}
      {deletePermanentOpen && (
        <div
          // Onda 17.16 — overlay com blur. Em modo neon, bg-black/50
          // em cima de fundo ja dark ficava preto demais. Trocado pra
          // backdrop-blur-md + opacidade menor — respeita o tema e
          // ainda destaca o modal.
          className="fixed inset-0 z-50 bg-background/70 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => !deletingPermanent && setDeletePermanentOpen(false)}
        >
          <div
            // Onda 17.16 — fundo SOLIDO pra escapar do backdrop-filter
            // do .bg-card no tema neon (que torna o card translucido
            // e deixa o conteudo de tras vazar). Inline style ganha
            // de qualquer regra de tema (incl. clay/neon/solid).
            className="border border-border rounded-xl shadow-2xl max-w-2xl w-full overflow-hidden flex flex-col max-h-[90vh]"
            style={{
              background: 'hsl(var(--card))',
              backdropFilter: 'none',
              WebkitBackdropFilter: 'none',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-border bg-red-500/10 shrink-0">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-lg bg-red-500/20 flex items-center justify-center shrink-0">
                  <Trash2 size={18} className="text-red-700" />
                </div>
                <div className="flex-1">
                  <h3 className="text-base font-bold text-red-800 flex items-center gap-2">
                    Excluir paciente permanentemente?
                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-700 border border-red-500/30">
                      🔒 ADMIN ONLY
                    </span>
                  </h3>
                  <p className="text-xs text-red-700 mt-1">
                    Paciente: <strong>{patient.name}</strong> · esta ação é <strong>irreversível</strong>
                  </p>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {loadingPreview && (
                <div className="py-8 flex items-center justify-center text-muted-foreground">
                  <Loader2 size={16} className="animate-spin mr-2" /> Carregando dependências...
                </div>
              )}

              {!loadingPreview && deletionPreview && (
                <>
                  {deletionPreview.can_delete_safely ? (
                    /* Cenário 1: cadastro vazio — pode excluir sem cascade */
                    <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-md p-3">
                      <p className="text-xs text-emerald-800">
                        ✓ Cadastro vazio (sem consultas, orçamentos, parcelas ou prontuário).
                        Pode excluir com segurança.
                      </p>
                    </div>
                  ) : (
                    /* Cenário 2: tem dependências — mostra lista + opção cascade */
                    <>
                      <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3">
                        <p className="text-xs text-amber-800 mb-1">
                          ⚠ Este paciente tem histórico no sistema. Se excluir,
                          <strong> todos esses dados serão apagados em cascade</strong>.
                        </p>
                        <p className="text-[11px] text-amber-700">
                          💡 <strong>Recomendado:</strong> usar <strong>Arquivar</strong> em vez,
                          pra preservar histórico.
                        </p>
                      </div>

                      {/* Lista de consultas */}
                      {deletionPreview.appointments.length > 0 && (
                        <div className="border border-border rounded-md overflow-hidden">
                          <div className="bg-muted/30 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-foreground border-b border-border">
                            📅 Consultas ({deletionPreview.appointments.length})
                          </div>
                          <ul className="divide-y divide-border/40 max-h-48 overflow-y-auto">
                            {deletionPreview.appointments.map((a) => (
                              <li key={a.id} className="px-3 py-2 text-xs flex items-center gap-2">
                                <span className="text-foreground font-medium truncate flex-1">
                                  {a.title || a.type}
                                </span>
                                <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                                  {fmtDateTimeBR(a.start_at)}
                                </span>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold shrink-0 ${
                                  a.status === 'CONCLUIDO' ? 'bg-emerald-500/15 text-emerald-700'
                                  : a.status === 'CANCELADO' ? 'bg-red-500/15 text-red-700'
                                  : 'bg-sky-500/15 text-sky-700'
                                }`}>
                                  {a.status}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Lista de orçamentos */}
                      {deletionPreview.quotes.length > 0 && (
                        <div className="border border-border rounded-md overflow-hidden">
                          <div className="bg-muted/30 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-foreground border-b border-border">
                            💰 Orçamentos ({deletionPreview.quotes.length})
                          </div>
                          <ul className="divide-y divide-border/40 max-h-48 overflow-y-auto">
                            {deletionPreview.quotes.map((q) => (
                              <li key={q.id} className="px-3 py-2 text-xs flex items-center gap-2">
                                <span className="text-foreground font-medium truncate flex-1">
                                  {q.title || 'Orçamento sem nome'}
                                </span>
                                <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                                  {fmtDateBR(q.created_at)}
                                </span>
                                <span className="text-[11px] font-bold tabular-nums shrink-0">
                                  R$ {Number(q.total_value).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                </span>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold shrink-0 ${
                                  q.status === 'ACCEPTED' ? 'bg-emerald-500/15 text-emerald-700'
                                  : q.status === 'REJECTED' ? 'bg-red-500/15 text-red-700'
                                  : 'bg-sky-500/15 text-sky-700'
                                }`}>
                                  {q.status}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Lista de parcelas pagas */}
                      {deletionPreview.paid_installments.length > 0 && (
                        <div className="border border-red-500/30 rounded-md overflow-hidden">
                          <div className="bg-red-500/15 px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-red-800 border-b border-red-500/30">
                            🚨 Parcelas pagas ({deletionPreview.paid_installments.length}) — perda de histórico financeiro!
                          </div>
                          <ul className="divide-y divide-border/40 max-h-48 overflow-y-auto">
                            {deletionPreview.paid_installments.map((i) => (
                              <li key={i.id} className="px-3 py-2 text-xs flex items-center gap-2">
                                <span className="text-foreground font-medium shrink-0">
                                  Parcela {i.sequence}/{i.total_count}
                                </span>
                                <span className="flex-1" />
                                <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                                  pago em {fmtDateBR(i.paid_at)}
                                </span>
                                <span className="text-[11px] font-bold text-emerald-700 tabular-nums shrink-0">
                                  R$ {Number(i.amount).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Prontuário */}
                      {deletionPreview.medical_records_count > 0 && (
                        <div className="border border-border rounded-md px-3 py-2 text-xs text-foreground">
                          📋 <strong>{deletionPreview.medical_records_count}</strong> registro
                          {deletionPreview.medical_records_count === 1 ? '' : 's'} de prontuário clínico será
                          {deletionPreview.medical_records_count === 1 ? '' : 'm'} apagado
                          {deletionPreview.medical_records_count === 1 ? '' : 's'}.
                        </div>
                      )}

                      {/* Checkbox de ciência */}
                      <label className="flex items-start gap-2 cursor-pointer p-3 border-2 border-red-500/30 rounded-md bg-red-500/5 mt-3">
                        <input
                          type="checkbox"
                          checked={forceCheckbox}
                          onChange={(e) => setForceCheckbox(e.target.checked)}
                          disabled={deletingPermanent}
                          className="mt-0.5 shrink-0"
                        />
                        <span className="text-xs text-red-800">
                          Eu entendo que <strong>todos esses dados serão apagados em cascade</strong> e
                          esta ação <strong>não pode ser desfeita</strong>.
                        </span>
                      </label>
                    </>
                  )}

                  {/* Confirmação por nome (sempre exigida) */}
                  <div className="pt-2">
                    <label className="text-xs font-semibold text-foreground block mb-1">
                      Pra confirmar, digite o nome do paciente:{' '}
                      <span className="text-red-700 font-mono">{patient.name}</span>
                    </label>
                    <input
                      type="text"
                      value={deleteConfirmName}
                      onChange={(e) => setDeleteConfirmName(e.target.value)}
                      placeholder="Digite o nome exato"
                      disabled={deletingPermanent}
                      className="w-full text-sm px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-red-500/30 focus:border-red-500"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="p-3 border-t border-border flex items-center justify-end gap-2 bg-muted/20 shrink-0">
              <button
                type="button"
                onClick={() => setDeletePermanentOpen(false)}
                disabled={deletingPermanent}
                className="text-xs px-3 py-1.5 rounded-lg border border-border hover:bg-accent disabled:opacity-50"
              >
                Cancelar
              </button>
              {deletionPreview && !deletionPreview.can_delete_safely && (
                <button
                  type="button"
                  onClick={() => {
                    setDeletePermanentOpen(false);
                    handleArchive();
                  }}
                  disabled={deletingPermanent}
                  className="text-xs px-3 py-1.5 rounded-lg border border-amber-500/50 bg-amber-500/10 text-amber-800 hover:bg-amber-500/20 disabled:opacity-50 font-semibold"
                >
                  Arquivar em vez (recomendado)
                </button>
              )}
              <button
                type="button"
                onClick={handleDeletePermanent}
                disabled={
                  !deletionPreview ||
                  deleteConfirmName.trim() !== patient.name.trim() ||
                  (!deletionPreview.can_delete_safely && !forceCheckbox) ||
                  deletingPermanent
                }
                className="text-xs px-4 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 font-semibold"
              >
                {deletingPermanent ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                {deletionPreview?.can_delete_safely
                  ? 'Excluir permanentemente'
                  : 'Excluir tudo em cascade'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tabs ULTRA-COMPACTAS (Fase 25 5b v3).
          Reducao maxima sem comprometer legibilidade:
            text-[11px] sempre + px-2 + py-1.5 + icon 12px (w-3 h-3) + gap-1
          Em xl ainda mantem icone visivel; em < md (768px) esconde icone
          pra ganhar mais espaco horizontal. */}
      <div className="border-b border-border mb-4 -mx-6 px-6 overflow-x-auto">
        <div className="flex gap-0.5 items-end">
          {TABS.filter((t) => t.group === 'operational')
            // Aba "Afiliado" so aparece quando o paciente esta no programa.
            // Default off — toggle em Editar paciente > Programa de Afiliado.
            .filter((t) => t.id !== 'affiliate' || patient.is_affiliate)
            // Onda 17.65 — Propostas/Financeiro só com permissão.
            .filter((t) => (t.id !== 'proposals' || canProposals) && (t.id !== 'financial' || canFinancial))
            .map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                data-tab-id={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium border-b-2 transition-colors whitespace-nowrap ${
                  active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                } ${t.id === 'affiliate' ? 'text-emerald-600 hover:text-emerald-700' : ''}`}
              >
                <Icon className="w-3 h-3 shrink-0 hidden md:inline-block" />
                {t.label}
              </button>
            );
          })}
          <div className="flex-1 min-w-[24px]" />
          {TABS.filter((t) => t.group === 'clinical').map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                data-tab-id={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium border-b-2 transition-colors whitespace-nowrap ${
                  active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="w-3 h-3 shrink-0 hidden md:inline-block" />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      {tab === 'overview' && (
        <OverviewTab
          patient={patient}
          onReload={load}
          // Editar dados pessoais e exclusivo do ADMIN. Pra nao-ADMIN o
          // OverviewTab esconde os botoes "Editar" do card de dados pessoais
          // e os pencils inline do Resumo Clinico (queixa, dentista responsavel).
          // Adicionar alergias/medicacoes continua liberado (sao dados clinicos).
          onEdit={role.canEditPatientPersonalData ? () => setEditOpen(true) : undefined}
          onAddAllergy={() => setAddAllergyOpen(true)}
          onAddMedication={() => setAddMedOpen(true)}
          onGoToHistory={(types) => {
            setHistoryInitialFilter(types);
            setTab('timeline');
          }}
          // Onda 17.32.23 — Aba Orçamentos removida, redireciona pra Propostas
          onGoToQuotes={() => setTab('proposals')}
          // Onda 14.54 — callbacks pro snapshot clinico (odontograma + evolucao)
          // na Visao Geral. Click leva pra aba correspondente.
          onGoToOdontogram={() => setTab('odontogram')}
          onGoToTimelineAll={() => setTab('timeline')}
        />
      )}
      {tab === 'timeline' && (
        <TimelineTab
          patientId={patient.id}
          initialActiveTypes={historyInitialFilter as any}
        />
      )}
      {tab === 'anamnesis' && <AnamneseTab patientId={patient.id} />}
      {tab === 'medical-record' && <ProntuarioTab patientId={patient.id} />}
      {tab === 'odontogram' && (
        <OdontogramaTab
          patientId={patient.id}
          patientName={patient.name}
          // Onda 3.39 — onOpenQuoteDetail NAO eh mais passado.
          // Click em card da Avaliacao agora abre modal NA propria aba
          // (visao clinica, sem valores). Dentista nao precisa nem deve ver
          // a aba Orcamentos (negociacao/cobranca eh do financeiro).
        />
      )}
      {tab === 'esthetic' && <EsteticaFacialTab patientId={patient.id} />}
      {tab === 'smile-design' && <SmileDesignTab patientId={patient.id} />}
      {tab === 'radiografias' && <RadiografiasTab patientId={patient.id} />}
      {/* Onda 17.32.23 — Aba "Orçamentos" removida (fluxo enxuto: tudo em Propostas) */}
      {tab === 'proposals' && canProposals && (
        <PropostasTab
          patientId={patient.id}
          onOpenQuoteDetail={() => {
            // Onda 17.32.23 — Sem aba Orçamentos. Tudo (ajuste, aprovação,
            // cobrança) acontece dentro da própria aba Propostas. Mantemos
            // a prop pra compatibilidade mas sem navegação.
          }}
          // Onda 14.23 — dialog "Nova proposta" tem empty state que precisa
          // mandar o operador pra aba Avaliacao quando nao ha orcamentos.
          onGoToEvaluation={() => {
            setTab('odontogram');
            router.push(`/atendimento/pacientes/${patient.id}?tab=odontogram`);
          }}
        />
      )}
      {tab === 'financial' && canFinancial && <FinanceiroTab patientId={patient.id} />}
      {tab === 'treatment' && <TratamentoTab patientId={patient.id} />}
      {tab === 'affiliate' && patient.is_affiliate && (
        <AfiliadoTab
          patientId={patient.id}
          patientName={patient.name}
          affiliateCode={patient.affiliate_code || null}
        />
      )}

      {/* Modais */}
      {editOpen && (
        <EditPatientModal
          patient={patient}
          onClose={() => setEditOpen(false)}
          onUpdated={() => { setEditOpen(false); load(); }}
        />
      )}
      {addAllergyOpen && (
        <AddAllergyModal
          patientId={patient.id}
          onClose={() => setAddAllergyOpen(false)}
          onCreated={() => { setAddAllergyOpen(false); load(); }}
        />
      )}
      {addMedOpen && (
        <AddMedicationModal
          patientId={patient.id}
          onClose={() => setAddMedOpen(false)}
          onCreated={() => { setAddMedOpen(false); load(); }}
        />
      )}
    </div>
  );
}

// ─── Avatar com upload ───────────────────────────────────────

function AvatarUploader({
  patientId, avatarUrl, patientName, onUploaded, readOnly = false,
}: {
  patientId: string;
  avatarUrl: string | null;
  patientName: string;
  onUploaded: () => void;
  readOnly?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  // Tag <img> não envia Authorization header → endpoint protegido retorna 401
  // e mostra alt text. Hook faz fetch via axios (com token) e gera blob URL.
  const { src: authedSrc, loading: imgLoading } = useAuthedImage(avatarUrl);

  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      showError('Apenas imagens (JPG, PNG, WebP)');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      showError('Máximo 2 MB');
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      await api.post(`/patients/${patientId}/avatar`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      showSuccess('Foto atualizada');
      onUploaded();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao enviar foto');
    } finally {
      setUploading(false);
    }
  };

  const initials = patientName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase())
    .join('') || '?';

  return (
    <div className="relative group">
      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = ''; // permite re-selecionar mesmo arquivo
        }}
      />
      <button
        type="button"
        onClick={() => { if (!readOnly) fileRef.current?.click(); }}
        disabled={uploading || readOnly}
        title={readOnly ? 'Apenas ADMIN pode trocar a foto' : 'Trocar foto'}
        className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden relative disabled:opacity-60 disabled:cursor-default"
      >
        {authedSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={authedSrc} alt={patientName} className="w-full h-full object-cover" />
        ) : imgLoading ? (
          <Loader2 size={18} className="text-primary/60 animate-spin" />
        ) : (
          <span className="text-xl font-bold text-primary">{initials}</span>
        )}
        {/* overlay no hover — escondido em readOnly (sinaliza que nao pode trocar) */}
        {!readOnly && (
          <span className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            {uploading ? <Loader2 size={20} className="text-white animate-spin" /> : <Camera size={20} className="text-white" />}
          </span>
        )}
      </button>
    </div>
  );
}

// ─── Visão geral (totalmente editável) ───────────────────────────────────────

function OverviewTab({
  patient, onReload, onEdit, onAddAllergy, onAddMedication, onGoToHistory, onGoToQuotes,
  onGoToOdontogram, onGoToTimelineAll,
}: {
  patient: Patient;
  onReload: () => void;
  // onEdit indefinido = user nao tem permissao pra editar dados pessoais.
  // Usado pra esconder o botao "Editar" do card e os pencils inline do
  // Resumo Clinico (queixa principal, dentista responsavel).
  onEdit?: () => void;
  onAddAllergy: () => void;
  onAddMedication: () => void;
  onGoToHistory: (types: Set<string>) => void;
  onGoToQuotes: () => void;
  /** Onda 14.54 — leva pro odontograma quando click num dente da preview */
  onGoToOdontogram?: () => void;
  /** Onda 14.54 — leva pro historico quando click num evento da evolucao */
  onGoToTimelineAll?: () => void;
}) {
  const canEditPersonal = !!onEdit;
  const enderecoFmt = [
    patient.address && `${patient.address}${patient.address_number ? ', ' + patient.address_number : ''}`,
    patient.address_complement,
    patient.neighborhood,
    [patient.city, patient.state].filter(Boolean).join('/'),
    patient.zip_code && `CEP ${patient.zip_code}`,
  ].filter(Boolean).join(' · ');

  const removeAllergy = async (id: string) => {
    if (!confirm('Remover esta alergia?')) return;
    try {
      await api.delete(`/patients/allergies/${id}`);
      showSuccess('Alergia removida');
      onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  const removeMedication = async (id: string) => {
    if (!confirm('Remover esta medicação?')) return;
    try {
      await api.delete(`/patients/medications/${id}`);
      showSuccess('Medicação removida');
      onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  return (
    <div className="space-y-4">
      {/* Bloco superior: cards de dados pessoais + clinicos + alergias/medicacoes */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Dados pessoais */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
            <User size={16} /> Dados pessoais
          </h3>
          {/* Editar — escondido pra nao-ADMIN (canEditPersonal=false). */}
          {canEditPersonal && (
            <button
              onClick={onEdit}
              className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-border hover:bg-accent"
            >
              <Pencil size={12} /> Editar
            </button>
          )}
        </div>
        <dl className="space-y-2 text-sm">
          <Field label="Nome" value={patient.name} />
          <Field label="CPF" value={patient.cpf ? formatCPF(patient.cpf) : null} />
          <Field label="RG" value={patient.rg ? formatRG(patient.rg) : null} />
          {/* Onda 25.4 — DD/MM/YYYY + idade calculada (helper compartilhado) */}
          <Field label="Nascimento" value={formatBirthDateWithAge(patient.birth_date) || null} />
          <Field
            label="Sexo"
            value={patient.gender === 'F' ? 'Feminino' : patient.gender === 'M' ? 'Masculino' : patient.gender || null}
          />
          <Field label="Estado civil" value={patient.marital_status ? MARITAL_LABEL[patient.marital_status] : null} />
          <Field label="Telefone" value={patient.phone ? formatPhone(patient.phone) : null} />
          <Field label="Email" value={patient.email} />
          <Field label="Endereço" value={enderecoFmt || null} />
          {patient.is_minor && (
            <>
              <div className="border-t border-border my-2" />
              <Field label="Responsável" value={patient.guardian_name} />
              <Field label="CPF responsável" value={patient.guardian_cpf ? formatCPF(patient.guardian_cpf) : null} />
              <Field label="Tel. responsável" value={patient.guardian_phone ? formatPhone(patient.guardian_phone) : null} />
            </>
          )}
          {(patient.emergency_contact_name || patient.emergency_contact_phone) && (
            <>
              <div className="border-t border-border my-2" />
              <Field label="Emergência" value={[patient.emergency_contact_name, patient.emergency_contact_phone ? formatPhone(patient.emergency_contact_phone) : null].filter(Boolean).join(' · ')} />
            </>
          )}
        </dl>
      </div>

      {/* Resumo clínico */}
      <ResumoClinicoCard
        patient={patient}
        onReload={onReload}
        onGoToHistory={onGoToHistory}
        onGoToQuotes={onGoToQuotes}
        canEditPersonal={canEditPersonal}
      />

      {/* Alergias */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-500" /> Alergias
          </h3>
          <button
            onClick={onAddAllergy}
            className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus size={12} /> Adicionar
          </button>
        </div>
        {patient.allergies.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nenhuma alergia registrada.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {patient.allergies.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2 group">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="truncate">{a.allergen}</span>
                  {a.severity && (
                    <span className={`text-xs px-2 py-0.5 rounded border shrink-0 ${SEVERITY_CLS[a.severity] || 'bg-muted text-muted-foreground'}`}>
                      {SEVERITY_LABEL[a.severity] || a.severity}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => removeAllergy(a.id)}
                  className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 p-1"
                  title="Remover"
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Medicações */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
            <Pill size={16} className="text-primary" /> Medicações em uso
          </h3>
          <button
            onClick={onAddMedication}
            className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus size={12} /> Adicionar
          </button>
        </div>
        {patient.medications.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nenhuma medicação registrada.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {patient.medications.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-2 group">
                <div className="min-w-0">
                  <p className="font-medium truncate">{m.medication}</p>
                  <p className="text-xs text-muted-foreground">
                    {[m.dosage, m.frequency].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <button
                  onClick={() => removeMedication(m.id)}
                  className="text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 p-1"
                  title="Remover"
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Observações */}
      {patient.notes && (
        <div className="lg:col-span-2 bg-card border border-border rounded-xl p-4">
          <h3 className="font-semibold text-sm text-foreground mb-2">Observações</h3>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{patient.notes}</p>
        </div>
      )}
      </div>

      {/* Onda 14.54 — Snapshot clinico: odontograma read-only + evolucao
          recente. Clicks navegam pras abas correspondentes. */}
      <OverviewClinicalSection
        patientId={patient.id}
        onGoToOdontogram={onGoToOdontogram}
        onGoToTimeline={onGoToTimelineAll}
      />
    </div>
  );
}

// ─── Card "Resumo clínico" com edição inline ───────────────────────────────

function ResumoClinicoCard({
  patient, onReload, onGoToHistory, onGoToQuotes, canEditPersonal = true,
}: {
  patient: Patient;
  onReload: () => void;
  onGoToHistory: (types: Set<string>) => void;
  onGoToQuotes: () => void;
  // Quando false: esconde os pencils inline de "dentista principal" e
  // "queixa principal" (ambos vao via PATCH /patients/:id que e admin-only).
  canEditPersonal?: boolean;
}) {
  const [users, setUsers] = useState<UserOption[]>([]);
  const [editingDentist, setEditingDentist] = useState(false);
  const [editingComplaint, setEditingComplaint] = useState(false);
  const [dentistDraft, setDentistDraft] = useState(patient.primary_dentist_id || '');
  const [complaintDraft, setComplaintDraft] = useState(
    patient.chief_complaint || patient.medical_record?.chief_complaint || ''
  );
  const [saving, setSaving] = useState(false);

  // Carrega lista de dentistas só quando o operador clica pra editar
  useEffect(() => {
    if (!editingDentist || users.length > 0) return;
    // Onda 17.54 — /users/lawyers (não /users, que é ADMIN-only → 403 pra não-admin).
    // Acessível a qualquer logado, tenant-scoped, já filtra dentistas (+admin c/ especialidade).
    api.get('/users/lawyers').then((r) => {
      const data: any[] = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.users || []);
      setUsers(data.map((u: any) => ({ id: u.id, name: u.name })));
    }).catch(() => {});
  }, [editingDentist, users.length]);

  const saveDentist = async () => {
    setSaving(true);
    try {
      await api.patch(`/patients/${patient.id}`, { primary_dentist_id: dentistDraft || null });
      showSuccess('Dentista atualizado');
      setEditingDentist(false);
      onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const saveComplaint = async () => {
    setSaving(true);
    try {
      await api.patch(`/patients/${patient.id}`, { chief_complaint: complaintDraft.trim() || null });
      showSuccess('Queixa atualizada');
      setEditingComplaint(false);
      onReload();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const complaintDisplay = patient.chief_complaint || patient.medical_record?.chief_complaint || null;

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <h3 className="font-semibold text-sm text-foreground mb-3 flex items-center gap-2">
        <Stethoscope size={16} /> Resumo clínico
      </h3>
      <dl className="space-y-2 text-sm">
        {/* Dentista principal — editável inline */}
        <div className="flex items-start justify-between gap-3">
          <dt className="text-xs font-medium text-muted-foreground shrink-0 pt-1.5">Dentista principal</dt>
          <dd className="text-sm text-foreground text-right break-words flex-1 flex items-center justify-end gap-1">
            {editingDentist ? (
              <div className="flex items-center gap-1 w-full max-w-xs">
                <select
                  value={dentistDraft}
                  onChange={(e) => setDentistDraft(e.target.value)}
                  className="flex-1 px-2 py-1 rounded-lg bg-background border border-border text-sm"
                  autoFocus
                >
                  <option value="">Nenhum</option>
                  {users.map((u) => <option key={u.id} value={u.id}>Dr(a). {u.name}</option>)}
                </select>
                <button onClick={saveDentist} disabled={saving} className="p-1 text-primary hover:bg-primary/10 rounded">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                </button>
                <button onClick={() => { setEditingDentist(false); setDentistDraft(patient.primary_dentist_id || ''); }} className="p-1 text-muted-foreground hover:bg-accent rounded">
                  <X size={14} />
                </button>
              </div>
            ) : (
              <>
                <span className={patient.primary_dentist?.name ? '' : 'text-muted-foreground'}>
                  {patient.primary_dentist?.name ? `Dr(a). ${patient.primary_dentist.name}` : '—'}
                </span>
                {/* Pencil escondido pra nao-ADMIN — alocacao de dentista
                    eh decisao administrativa, mexe via PATCH /patients/:id
                    que so ADMIN pode chamar. */}
                {canEditPersonal && (
                  <button onClick={() => setEditingDentist(true)} className="text-muted-foreground hover:text-foreground p-1">
                    <Pencil size={11} />
                  </button>
                )}
              </>
            )}
          </dd>
        </div>

        <Field label="Primeira visita" value={patient.first_visit_at?.slice(0, 10)} />
        <Field label="Última visita" value={patient.last_visit_at?.slice(0, 10)} />

        {/* Queixa principal — editável inline */}
        <div className="flex items-start justify-between gap-3">
          <dt className="text-xs font-medium text-muted-foreground shrink-0 pt-1.5">Queixa principal</dt>
          <dd className="text-sm text-foreground text-right break-words flex-1 flex items-start justify-end gap-1">
            {editingComplaint ? (
              <div className="flex items-start gap-1 w-full max-w-xs">
                <textarea
                  value={complaintDraft}
                  onChange={(e) => setComplaintDraft(e.target.value)}
                  rows={2}
                  className="flex-1 px-2 py-1 rounded-lg bg-background border border-border text-sm resize-none"
                  autoFocus
                />
                <div className="flex flex-col gap-1">
                  <button onClick={saveComplaint} disabled={saving} className="p-1 text-primary hover:bg-primary/10 rounded">
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  </button>
                  <button onClick={() => { setEditingComplaint(false); setComplaintDraft(complaintDisplay || ''); }} className="p-1 text-muted-foreground hover:bg-accent rounded">
                    <X size={14} />
                  </button>
                </div>
              </div>
            ) : (
              <>
                <span className={complaintDisplay ? 'whitespace-pre-wrap' : 'text-muted-foreground'}>
                  {complaintDisplay || '—'}
                </span>
                {/* Pencil escondido pra nao-ADMIN — backend bloqueia
                    PATCH /patients/:id pra nao-ADMIN. */}
                {canEditPersonal && (
                  <button onClick={() => setEditingComplaint(true)} className="text-muted-foreground hover:text-foreground p-1 shrink-0">
                    <Pencil size={11} />
                  </button>
                )}
              </>
            )}
          </dd>
        </div>

        {/* Consultas — click abre aba Histórico já filtrada por consultas/procedimentos/retornos */}
        <ClickableCounter
          label="Consultas"
          value={patient._count?.appointments ?? 0}
          enabled={(patient._count?.appointments ?? 0) > 0}
          tooltip="Ver no Histórico"
          onClick={() => onGoToHistory(new Set(['appointment', 'procedure', 'return']))}
        />
        {/* Orçamentos — click abre aba Propostas (aba Orçamentos foi removida em 17.32.23) */}
        <ClickableCounter
          label="Orçamentos"
          value={patient._count?.quotes ?? 0}
          enabled={(patient._count?.quotes ?? 0) > 0}
          tooltip="Ver nas Propostas"
          onClick={onGoToQuotes}
        />
        {patient.referred_by_patient && (
          <Field
            label="Indicado por"
            value={`${patient.referred_by_patient.name || 'Sem nome'} (${patient.referred_by_patient.phone ? formatPhone(patient.referred_by_patient.phone) : 'sem telefone'})`}
          />
        )}
        {!patient.referred_by_patient && patient.referred_by && (
          <Field label="Indicado por" value={patient.referred_by} />
        )}
        {patient._count && patient._count.referrals > 0 && (
          <div className="flex items-start justify-between gap-3">
            <dt className="text-xs font-medium text-muted-foreground shrink-0 pt-0.5">Indicações feitas</dt>
            <dd className="text-sm text-foreground text-right break-words">
              <a
                href={`/atendimento/referrals?referrerId=${patient.id}`}
                className="text-primary hover:underline"
              >
                {patient._count.referrals} paciente(s)
              </a>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-xs font-medium text-muted-foreground shrink-0 pt-0.5">{label}</dt>
      <dd className="text-sm text-foreground text-right break-words">{value || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

/**
 * Linha de contador clicável — usa hover/cursor pra indicar que é
 * navegável. Quando enabled=false (count=0), vira só um Field comum
 * sem afetar o layout.
 */
function ClickableCounter({
  label, value, enabled, tooltip, onClick,
}: {
  label: string;
  value: number;
  enabled: boolean;
  tooltip: string;
  onClick: () => void;
}) {
  if (!enabled) {
    return (
      <div className="flex items-start justify-between gap-3">
        <dt className="text-xs font-medium text-muted-foreground shrink-0 pt-0.5">{label}</dt>
        <dd className="text-sm text-muted-foreground text-right">{value}</dd>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      className="w-full flex items-start justify-between gap-3 -mx-1 px-1 py-0.5 rounded hover:bg-accent/50 transition-colors group cursor-pointer text-left"
    >
      <span className="text-xs font-medium text-muted-foreground shrink-0 pt-0.5">{label}</span>
      <span className="text-sm font-semibold text-primary text-right group-hover:underline inline-flex items-center gap-1">
        {value}
        <ChevronRight size={12} className="opacity-60" />
      </span>
    </button>
  );
}
