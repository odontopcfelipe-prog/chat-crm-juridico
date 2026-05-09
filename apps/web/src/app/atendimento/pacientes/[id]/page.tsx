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
} from 'lucide-react';
import api, { API_BASE_URL } from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useRole } from '@/lib/useRole';
import { calculateAge, formatBirthDateWithAge } from '@/lib/age';
import AnamneseTab from '../components/AnamneseTab';
import ProntuarioTab from '../components/ProntuarioTab';
import OdontogramaTab from '../components/OdontogramaTab';
import OrcamentoTab from '../components/OrcamentoTab';
import EsteticaFacialTab from '../components/EsteticaFacialTab';
import SmileDesignTab from '../components/SmileDesignTab';
import RadiografiasTab from '../components/RadiografiasTab';
import EditPatientModal from '../components/EditPatientModal';
import { AddAllergyModal, AddMedicationModal } from '../components/AllergyMedicationModals';
import TimelineTab from '../components/TimelineTab';
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
  tags?: AssignedTag[];
  allergies: Array<{ id: string; allergen: string; severity: string | null; notes: string | null }>;
  medications: Array<{ id: string; medication: string; dosage: string | null; frequency: string | null }>;
  medical_record?: { id: string; chief_complaint: string | null } | null;
  _count?: { appointments: number; clinical_images: number; consents: number; quotes: number; referrals: number };
}

interface UserOption { id: string; name: string }

const TABS = [
  { id: 'overview', label: 'Visão geral', icon: User },
  { id: 'timeline', label: 'Histórico', icon: Clock },
  { id: 'anamnesis', label: 'Anamnese', icon: FileText },
  { id: 'medical-record', label: 'Prontuário', icon: Stethoscope },
  { id: 'odontogram', label: 'Odontograma', icon: Activity },
  { id: 'esthetic', label: 'Estética facial', icon: Sparkles },
  { id: 'smile-design', label: 'Smile Design', icon: Sparkles },
  { id: 'radiografias', label: 'Radiografias', icon: Activity },
  { id: 'quotes', label: 'Orçamentos', icon: DollarSign },
  // Onda 3.7 — Tabs "Tratamentos" e "Manutencoes" removidas: o conteudo
  // (lista de orcamentos com acoes) agora vive no Odontograma como hub
  // central. Componentes TratamentoTab e ManutencoesTab permanecem no
  // codigo (so removemos do menu) — podem ser reativados se necessario.
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

  // Atalho da dra: iniciar orcamento direto. Cria DRAFT (idempotente — reusa
  // se ja existe) + abre tab Orcamentos com o quote ja em modo edicao.
  // Backend (LeadsService.graduateLeadToEmFechamento) gradua o lead vinculado
  // pra "Em Fechamento" silenciosamente (some do Kanban CRM, vai pra /fechamentos).
  // Onda 3.7 — handleStartQuote e handleStartAttending removidos
  // (botoes correspondentes saindo do header — fluxo migrou pro Odontograma).

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
    <div className="h-full overflow-y-auto p-6 max-w-7xl mx-auto">
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
              {patient.phone && <span className="flex items-center gap-1"><Phone size={14} /> {patient.phone}</span>}
              {patient.email && <span className="flex items-center gap-1"><Mail size={14} /> {patient.email}</span>}
              {patient.cpf && <span className="flex items-center gap-1"><IdCard size={14} /> {patient.cpf}</span>}
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
        <div className="flex items-center gap-2">
          {/* Onda 3.7 — Botoes "Atender" e "Iniciar orcamento" removidos do
              header. "Iniciar orcamento" virou CTA verde grande no proprio
              tab Odontograma (centro da tela). "Atender" foi descontinuado
              porque o fluxo dele (graduar lead + abrir Odontograma) eh agora
              implicito quando o operador entra na aba Odontograma. */}
          {/* Onda 5e v30 (Fase 25) — Agendar consulta direto da ficha do paciente.
              Deep-link pra /agenda?new=1&patient_id=X&patient_name=X&phone=X
              que abre o modal de evento ja com paciente pre-selecionado. */}
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
          {patient.status !== 'ARCHIVED' && (
            <button
              onClick={handleSendPortalLink}
              className="text-xs text-primary hover:bg-primary/10 border border-primary/20 px-3 py-2 rounded-lg flex items-center gap-1"
              title="Enviar link do portal do paciente via WhatsApp"
            >
              <MessageCircle size={14} /> Enviar portal
            </button>
          )}
          {/* Arquivar — exclusivo do ADMIN (backend tambem valida).
              Secretaria/dentista nao podem apagar paciente do sistema. */}
          {patient.status !== 'ARCHIVED' && role.canArchivePatient && (
            <button
              onClick={handleArchive}
              className="text-xs text-destructive hover:bg-destructive/10 px-3 py-2 rounded-lg flex items-center gap-1"
            >
              <Trash2 size={14} /> Arquivar
            </button>
          )}
        </div>
      </div>

      {/* Tabs ULTRA-COMPACTAS (Fase 25 5b v3).
          Reducao maxima sem comprometer legibilidade:
            text-[11px] sempre + px-2 + py-1.5 + icon 12px (w-3 h-3) + gap-1
          Em xl ainda mantem icone visivel; em < md (768px) esconde icone
          pra ganhar mais espaco horizontal. */}
      <div className="border-b border-border mb-4 -mx-6 px-6 overflow-x-auto">
        <div className="flex gap-0.5">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1 px-2 py-1.5 text-[11px] font-medium border-b-2 transition-colors whitespace-nowrap ${
                  active
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
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
          onGoToQuotes={() => setTab('quotes')}
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
      {tab === 'odontogram' && <OdontogramaTab patientId={patient.id} patientName={patient.name} />}
      {tab === 'esthetic' && <EsteticaFacialTab patientId={patient.id} />}
      {tab === 'smile-design' && <SmileDesignTab patientId={patient.id} />}
      {tab === 'radiografias' && <RadiografiasTab patientId={patient.id} />}
      {tab === 'quotes' && (
        <OrcamentoTab
          patientId={patient.id}
          initialQuoteId={searchParams?.get('quote') || undefined}
        />
      )}
      {/* Onda 3.7 — tabs treatment-plans e maintenance removidas do menu
          (componentes preservados em components/ pra reativacao futura). */}

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
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={avatarUrl} alt={patientName} className="w-full h-full object-cover" />
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
          <Field label="CPF" value={patient.cpf} />
          <Field label="RG" value={patient.rg} />
          {/* Onda 25.4 — DD/MM/YYYY + idade calculada (helper compartilhado) */}
          <Field label="Nascimento" value={formatBirthDateWithAge(patient.birth_date) || null} />
          <Field
            label="Sexo"
            value={patient.gender === 'F' ? 'Feminino' : patient.gender === 'M' ? 'Masculino' : patient.gender || null}
          />
          <Field label="Estado civil" value={patient.marital_status ? MARITAL_LABEL[patient.marital_status] : null} />
          <Field label="Telefone" value={patient.phone} />
          <Field label="Email" value={patient.email} />
          <Field label="Endereço" value={enderecoFmt || null} />
          {patient.is_minor && (
            <>
              <div className="border-t border-border my-2" />
              <Field label="Responsável" value={patient.guardian_name} />
              <Field label="CPF responsável" value={patient.guardian_cpf} />
              <Field label="Tel. responsável" value={patient.guardian_phone} />
            </>
          )}
          {(patient.emergency_contact_name || patient.emergency_contact_phone) && (
            <>
              <div className="border-t border-border my-2" />
              <Field label="Emergência" value={[patient.emergency_contact_name, patient.emergency_contact_phone].filter(Boolean).join(' · ')} />
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
    api.get('/users?limit=100').then((r) => {
      const data: any[] = r.data?.data || r.data?.users || r.data || [];
      const dentists = data.filter((u: any) =>
        u.roles?.includes('DENTIST') || u.roles?.includes('ADVOGADO') || u.roles?.includes('ADMIN') ||
        u.role === 'DENTIST' || u.role === 'ADVOGADO' || u.role === 'ADMIN'
      );
      setUsers(dentists.map((u: any) => ({ id: u.id, name: u.name })));
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
        {/* Orçamentos — click abre aba Orçamentos */}
        <ClickableCounter
          label="Orçamentos"
          value={patient._count?.quotes ?? 0}
          enabled={(patient._count?.quotes ?? 0) > 0}
          tooltip="Ver na aba Orçamentos"
          onClick={onGoToQuotes}
        />
        {patient.referred_by_patient && (
          <Field
            label="Indicado por"
            value={`${patient.referred_by_patient.name || 'Sem nome'} (${patient.referred_by_patient.phone || 'sem telefone'})`}
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
