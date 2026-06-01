'use client';

import { useEffect, useState, useCallback } from 'react';
import { Loader2, FileText, Send, ShieldCheck, User, Hash, Camera, Copy, X, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
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
  // Onda 17.9 — modal de fallback quando Evolution falha (link foi
  // gerado, mas WhatsApp nao foi enviado). Operadora ve o link, copia
  // e envia manualmente, ou abre wa.me.
  const [fallbackLink, setFallbackLink] = useState<{
    link: string;
    patientName: string;
    patientPhone: string | null;
    reason: string;
  } | null>(null);

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
      } else {
        // Onda 17.9 — Evolution offline / paciente sem telefone / outro
        // erro: o link foi gerado, abrimos modal de fallback pra
        // operadora copiar e enviar manualmente.
        setFallbackLink({
          link: resp?.link || '',
          patientName: resp?.patient?.name || 'Paciente',
          patientPhone: resp?.patient?.phone || null,
          reason: resp?.dispatch?.reason || 'WhatsApp não foi enviado automaticamente',
        });
      }
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao gerar link');
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

      {/* Onda 17.9 — Modal de fallback quando o envio automatico do
          WhatsApp falha (Evolution offline, paciente sem telefone, etc).
          O link foi gerado no banco e funciona — operadora copia e envia
          manualmente OU abre wa.me direto pelo botao. */}
      {fallbackLink && (
        <FallbackLinkModal
          patientId={patientId}
          link={fallbackLink.link}
          patientName={fallbackLink.patientName}
          patientPhone={fallbackLink.patientPhone}
          reason={fallbackLink.reason}
          onClose={() => setFallbackLink(null)}
          onResent={(newLink) => {
            // Reenvio teve sucesso: fecha modal + mostra success
            showSuccess('Link enviado pelo WhatsApp');
            setFallbackLink(null);
          }}
          onResendFailed={(newReason, newLink) => {
            // Falhou de novo: atualiza o motivo no modal e mantem aberto
            setFallbackLink((prev) => prev ? { ...prev, reason: newReason, link: newLink || prev.link } : prev);
          }}
        />
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   FallbackLinkModal — Onda 17.10
   Aparece quando /portal/magic-link gera link mas Evolution falha.
   Acao principal: TENTAR REENVIAR pela Evolution (chama o mesmo
   endpoint do backend de novo). Fallback secundario: copiar link
   pra enviar manualmente caso reenvio continue falhando.
────────────────────────────────────────────────────────────── */
function FallbackLinkModal({
  patientId, link, patientName, patientPhone, reason, onClose, onResent, onResendFailed,
}: {
  patientId: string;
  link: string;
  patientName: string;
  patientPhone: string | null;
  reason: string;
  onClose: () => void;
  onResent: (newLink: string) => void;
  onResendFailed: (newReason: string, newLink?: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      showSuccess('Link copiado!');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showError('Não foi possível copiar (permita acesso à área de transferência)');
    }
  };

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const { data: resp } = await api.post('/portal/magic-link', {
        patient_id: patientId,
        channel: 'WHATSAPP',
        purpose: 'ANAMNESE',
      });
      if (resp?.dispatch?.status === 'SENT') {
        onResent(resp.link);
      } else {
        onResendFailed(
          resp?.dispatch?.reason || 'WhatsApp não foi enviado',
          resp?.link,
        );
      }
    } catch (err: any) {
      onResendFailed(
        err?.response?.data?.message || err?.message || 'Erro ao reenviar pela Evolution',
      );
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="flex items-start gap-3 px-5 py-4 border-b border-border bg-amber-500/5">
          <div className="w-9 h-9 rounded-lg bg-amber-500/15 grid place-items-center flex-none">
            <AlertTriangle size={18} className="text-amber-500" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold text-foreground">
              WhatsApp não foi enviado pela Evolution
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 break-words">
              Motivo: {reason}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-accent/30 text-muted-foreground" aria-label="Fechar">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-sm text-foreground">
            O link foi gerado e está válido por 7 dias. Você pode tentar reenviar pela
            Evolution agora — pode ter sido lentidão momentânea.
          </p>

          {/* Acao principal: reenviar pela Evolution */}
          <button
            onClick={handleRetry}
            disabled={retrying}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 text-white rounded-lg text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50 transition-colors"
          >
            {retrying ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Reenviando pela Evolution...
              </>
            ) : (
              <>
                <RefreshCw size={16} />
                Tentar reenviar pela Evolution
              </>
            )}
          </button>

          {/* Fallback secundario: copiar link */}
          <details className="border border-border rounded-lg overflow-hidden">
            <summary className="px-3 py-2.5 cursor-pointer text-xs font-semibold text-muted-foreground hover:bg-accent/10 select-none">
              Se continuar falhando, copiar link e enviar manualmente
            </summary>
            <div className="p-3 space-y-2 border-t border-border bg-accent/5">
              <div className="bg-background border border-border rounded p-2 break-all text-[11px] text-muted-foreground font-mono">
                {link}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs font-semibold hover:opacity-90 transition-opacity"
                >
                  {copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                  {copied ? 'Copiado!' : 'Copiar link'}
                </button>
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {patientPhone ? `Tel: ${patientPhone}` : 'Sem telefone'}
                </span>
              </div>
            </div>
          </details>

          {/* Dica de diagnostico */}
          <div className="text-[11px] text-muted-foreground bg-muted/30 rounded-lg p-3 leading-relaxed">
            <b>Não consegue reenviar?</b> Verifique:
            <br />• <b>Configurações → WhatsApp</b>: URL e API Key da Evolution corretas
            <br />• Instância está conectada (QR code lido)
            <br />• Servidor da Evolution está online
          </div>
        </div>
      </div>
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
