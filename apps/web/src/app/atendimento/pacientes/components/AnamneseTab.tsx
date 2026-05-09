'use client';

import { useEffect, useState, useCallback } from 'react';
import { Loader2, FileText, Send, ShieldCheck, User, Hash, Camera } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import DynamicAnamneseForm, { AnamnesisSchema } from './DynamicAnamneseForm';

interface Props {
  patientId: string;
}

interface ActiveAnamnese {
  exists: boolean;
  anamnesis?: {
    id: string;
    answers: Record<string, any>;
    template_schema: AnamnesisSchema;
    template: { id: string; version: number };
    filled_at: string;
    updated_at: string;
    submitted_via: 'STAFF' | 'PATIENT_PORTAL' | null;
    submitted_ip: string | null;
    submitted_user_agent: string | null;
    consent_text: string | null;
    consent_accepted_at: string | null;
    signature_method: 'TYPED_NAME' | 'DRAWN' | null;
    signature_data: string | null;
    selfie_data: string | null;
    audit_hash: string | null;
    filled_by_user: { id: string; name: string } | null;
  };
  template?: { id: string; version: number; schema: AnamnesisSchema } | null;
}

export default function AnamneseTab({ patientId }: Props) {
  const [data, setData] = useState<ActiveAnamnese | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sendingLink, setSendingLink] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<ActiveAnamnese>(`/patients/${patientId}/anamnesis`);
      setData(data);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar anamnese');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async (answers: Record<string, any>) => {
    setSaving(true);
    try {
      await api.patch(`/patients/${patientId}/anamnesis`, { answers });
      showSuccess('Anamnese salva');
      await load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleSendLink = async () => {
    if (sendingLink) return;
    if (!confirm('Enviar link de preenchimento da anamnese para o paciente via WhatsApp?')) return;
    setSendingLink(true);
    try {
      const { data: resp } = await api.post('/portal/magic-link', {
        patient_id: patientId,
        channel: 'WHATSAPP',
        purpose: 'ANAMNESE',
      });
      if (resp?.dispatch?.status === 'SENT') {
        showSuccess('Link enviado pelo WhatsApp');
      } else if (resp?.dispatch?.status === 'SKIPPED') {
        showError(resp.dispatch.reason || 'Nao foi possivel enviar (paciente sem telefone)');
      } else {
        showError(resp?.dispatch?.reason || 'Falha ao enviar WhatsApp — link gerado mesmo assim');
      }
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao enviar link');
    } finally {
      setSendingLink(false);
    }
  };

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" /> Carregando...
      </div>
    );
  }

  if (!data) return null;

  // Sem anamnese E sem template ativo cadastrado pelo admin
  if (!data.exists && !data.template) {
    return (
      <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl p-6 text-center">
        <FileText size={32} className="mx-auto text-amber-600 mb-2" />
        <p className="text-sm font-semibold mb-1">Template de anamnese nao cadastrado</p>
        <p className="text-xs text-muted-foreground">
          Peça a um admin para cadastrar o modelo de ficha em
          {' '}<span className="font-mono">Settings &rarr; Anamnese</span>{' '}
          antes de preencher.
        </p>
      </div>
    );
  }

  const schema = data.exists
    ? data.anamnesis!.template_schema
    : data.template!.schema;
  const initialAnswers = data.exists ? data.anamnesis!.answers : {};
  const templateVersion = data.exists ? data.anamnesis!.template.version : data.template!.version;

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText size={14} />
          <span>Ficha unica do paciente</span>
          <span className="text-xs">· Template v{templateVersion}</span>
        </div>
        <button
          onClick={handleSendLink}
          disabled={sendingLink}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
          title="Enviar link de preenchimento via WhatsApp"
        >
          {sendingLink ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          Enviar p/ paciente preencher
        </button>
      </div>

      {/* Bloco de auditoria — so aparece se ja foi preenchida */}
      {data.exists && data.anamnesis && (
        <AuditPanel anm={data.anamnesis} />
      )}

      {/* Formulario sempre aberto. Key forca remontar quando muda a anamnese
          (ex.: apos save) — assim o useState interno pega o novo initialAnswers. */}
      <DynamicAnamneseForm
        key={data.exists ? `anm-${data.anamnesis!.id}-${data.anamnesis!.updated_at}` : 'new'}
        schema={schema}
        initialAnswers={initialAnswers}
        onSave={handleSave}
        saving={saving}
      />
    </div>
  );
}

function AuditPanel({ anm }: { anm: NonNullable<ActiveAnamnese['anamnesis']> }) {
  const isPatient = anm.submitted_via === 'PATIENT_PORTAL';
  const isStaff = anm.submitted_via === 'STAFF';

  const filledAt = new Date(anm.filled_at).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  if (!anm.submitted_via) {
    // Anamnese legada (pre-prova-eletronica) — mostra so o que tem
    return (
      <div className="bg-muted/30 border border-border rounded-xl p-3 text-xs text-muted-foreground">
        Preenchida em {filledAt}
        {anm.filled_by_user && <> por {anm.filled_by_user.name}</>}
      </div>
    );
  }

  return (
    <div
      className={`rounded-xl p-4 border ${
        isPatient
          ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900'
          : 'bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-900'
      }`}
    >
      <div className="flex items-start gap-2 mb-2">
        <ShieldCheck
          size={18}
          className={isPatient ? 'text-emerald-600' : 'text-blue-600'}
        />
        <div className="flex-1">
          <p className="text-sm font-semibold">
            {isPatient
              ? 'Confirmada eletronicamente pelo paciente'
              : 'Preenchida pela equipe'}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {filledAt}
            {isStaff && anm.filled_by_user && <> · {anm.filled_by_user.name}</>}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs mt-3">
        {anm.signature_data && (
          <div className="flex items-start gap-1.5">
            <User size={12} className="mt-0.5 text-muted-foreground shrink-0" />
            <div>
              <span className="text-muted-foreground">Assinatura:</span>{' '}
              <span className="font-medium">{anm.signature_data}</span>
            </div>
          </div>
        )}
        {anm.submitted_ip && (
          <div className="flex items-start gap-1.5">
            <span className="text-muted-foreground shrink-0">IP:</span>
            <span className="font-mono">{anm.submitted_ip}</span>
          </div>
        )}
        {anm.audit_hash && (
          <div className="flex items-start gap-1.5 md:col-span-2">
            <Hash size={12} className="mt-0.5 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <span className="text-muted-foreground">Hash de integridade:</span>{' '}
              <span className="font-mono text-[10px] break-all">{anm.audit_hash}</span>
            </div>
          </div>
        )}
      </div>

      {/* Selfie de confirmacao — so aparece quando preenchido pelo paciente */}
      {isPatient && anm.selfie_data && (
        <div className="mt-3 pt-3 border-t border-emerald-200/60 dark:border-emerald-900/60">
          <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
            <Camera size={12} />
            <span>Foto tirada no momento da confirmacao</span>
          </div>
          <a
            href={anm.selfie_data}
            target="_blank"
            rel="noopener noreferrer"
            title="Clique para ampliar"
          >
            <img
              src={anm.selfie_data}
              alt="Selfie de confirmacao do paciente"
              className="w-32 h-32 object-cover rounded-lg border border-emerald-200 dark:border-emerald-900 hover:opacity-90 transition-opacity"
            />
          </a>
        </div>
      )}

      {isPatient && anm.consent_text && (
        <details className="mt-3">
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            Ver termo aceito pelo paciente
          </summary>
          <p className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed">
            {anm.consent_text}
          </p>
        </details>
      )}
    </div>
  );
}
