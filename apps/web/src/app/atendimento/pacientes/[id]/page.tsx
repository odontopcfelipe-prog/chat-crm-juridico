'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, Loader2, User, Phone, Mail, Cake, IdCard, MapPin,
  FileText, Stethoscope, Activity, ClipboardList, DollarSign,
  AlertTriangle, Pill, Trash2,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';

interface Patient {
  id: string;
  name: string;
  cpf: string | null;
  rg: string | null;
  birth_date: string | null;
  gender: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  first_visit_at: string | null;
  last_visit_at: string | null;
  notes: string | null;
  primary_dentist?: { id: string; name: string } | null;
  allergies: Array<{ id: string; allergen: string; severity: string | null; notes: string | null }>;
  medications: Array<{ id: string; medication: string; dosage: string | null; frequency: string | null }>;
  medical_record?: { id: string; chief_complaint: string | null } | null;
  _count?: { appointments: number; clinical_images: number; consents: number; quotes: number };
}

const TABS = [
  { id: 'overview', label: 'Visão geral', icon: User },
  { id: 'anamnesis', label: 'Anamnese', icon: FileText },
  { id: 'medical-record', label: 'Prontuário', icon: Stethoscope },
  { id: 'odontogram', label: 'Odontograma', icon: Activity },
  { id: 'quotes', label: 'Orçamentos', icon: DollarSign },
  { id: 'treatment-plans', label: 'Tratamentos', icon: ClipboardList },
] as const;

type TabId = typeof TABS[number]['id'];

export default function PacienteFichaPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabId>('overview');

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

  useEffect(() => {
    load();
  }, [params?.id]);

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

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando ficha...
      </div>
    );
  }

  if (!patient) return null;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Back + header */}
      <button
        onClick={() => router.push('/atendimento/pacientes')}
        className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 mb-4"
      >
        <ArrowLeft size={14} /> Voltar para lista
      </button>

      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
            <User size={32} className="text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">{patient.name}</h1>
            <div className="flex items-center gap-3 text-sm text-muted-foreground mt-1">
              {patient.phone && <span className="flex items-center gap-1"><Phone size={14} /> {patient.phone}</span>}
              {patient.email && <span className="flex items-center gap-1"><Mail size={14} /> {patient.email}</span>}
              {patient.cpf && <span className="flex items-center gap-1"><IdCard size={14} /> {patient.cpf}</span>}
            </div>
          </div>
        </div>
        {patient.status !== 'ARCHIVED' && (
          <button
            onClick={handleArchive}
            className="text-xs text-destructive hover:bg-destructive/10 px-3 py-2 rounded-lg flex items-center gap-1"
          >
            <Trash2 size={14} /> Arquivar
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className="border-b border-border mb-4 -mx-6 px-6 overflow-x-auto">
        <div className="flex gap-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  active
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon size={16} />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab content */}
      {tab === 'overview' && <OverviewTab patient={patient} onReload={load} />}
      {tab === 'anamnesis' && <Placeholder label="Anamnese — disponível na próxima entrega" />}
      {tab === 'medical-record' && <Placeholder label="Prontuário — disponível na próxima entrega" />}
      {tab === 'odontogram' && <Placeholder label="Odontograma — disponível na próxima entrega" />}
      {tab === 'quotes' && <Placeholder label="Orçamentos — disponível na próxima entrega" />}
      {tab === 'treatment-plans' && <Placeholder label="Planos de tratamento — disponível na próxima entrega" />}
    </div>
  );
}

function OverviewTab({ patient, onReload }: { patient: Patient; onReload: () => void }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Dados pessoais */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="font-semibold text-sm text-foreground mb-3 flex items-center gap-2">
          <User size={16} /> Dados pessoais
        </h3>
        <dl className="space-y-2 text-sm">
          <Field label="Nome" value={patient.name} />
          <Field label="CPF" value={patient.cpf} />
          <Field label="RG" value={patient.rg} />
          <Field label="Nascimento" value={patient.birth_date?.slice(0, 10)} />
          <Field
            label="Sexo"
            value={patient.gender === 'F' ? 'Feminino' : patient.gender === 'M' ? 'Masculino' : patient.gender || null}
          />
          <Field label="Telefone" value={patient.phone} />
          <Field label="Email" value={patient.email} />
          <Field
            label="Endereço"
            value={[patient.address, patient.city, patient.state].filter(Boolean).join(', ') || null}
          />
        </dl>
      </div>

      {/* Resumo clínico */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="font-semibold text-sm text-foreground mb-3 flex items-center gap-2">
          <Stethoscope size={16} /> Resumo clínico
        </h3>
        <dl className="space-y-2 text-sm">
          <Field
            label="Dentista principal"
            value={patient.primary_dentist?.name || null}
          />
          <Field label="Primeira visita" value={patient.first_visit_at?.slice(0, 10)} />
          <Field label="Última visita" value={patient.last_visit_at?.slice(0, 10)} />
          <Field label="Queixa principal" value={patient.medical_record?.chief_complaint} />
          <Field
            label="Consultas"
            value={patient._count ? String(patient._count.appointments) : '0'}
          />
          <Field
            label="Orçamentos"
            value={patient._count ? String(patient._count.quotes) : '0'}
          />
        </dl>
      </div>

      {/* Alergias */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="font-semibold text-sm text-foreground mb-3 flex items-center gap-2">
          <AlertTriangle size={16} className="text-amber-500" /> Alergias
        </h3>
        {patient.allergies.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nenhuma alergia registrada.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {patient.allergies.map((a) => (
              <li key={a.id} className="flex items-center justify-between">
                <span>{a.allergen}</span>
                {a.severity && (
                  <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-600 border border-amber-500/20">
                    {a.severity}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Medicações */}
      <div className="bg-card border border-border rounded-xl p-4">
        <h3 className="font-semibold text-sm text-foreground mb-3 flex items-center gap-2">
          <Pill size={16} className="text-primary" /> Medicações em uso
        </h3>
        {patient.medications.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nenhuma medicação registrada.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {patient.medications.map((m) => (
              <li key={m.id}>
                <p className="font-medium">{m.medication}</p>
                <p className="text-xs text-muted-foreground">
                  {[m.dosage, m.frequency].filter(Boolean).join(' · ')}
                </p>
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

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-xs font-medium text-muted-foreground shrink-0 pt-0.5">{label}</dt>
      <dd className="text-sm text-foreground text-right break-words">{value || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

function Placeholder({ label }: { label: string }) {
  return (
    <div className="bg-card border border-border border-dashed rounded-xl p-12 text-center text-muted-foreground">
      {label}
    </div>
  );
}
