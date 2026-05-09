'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  Loader2, ShieldCheck, CheckCircle, AlertCircle, FileText, Camera, RotateCcw, Lock,
} from 'lucide-react';
import portalApi from '@/lib/portalApi';
import DynamicAnamneseForm, { AnamnesisSchema } from '@/app/atendimento/pacientes/components/DynamicAnamneseForm';

interface ActiveAnamneseResp {
  exists: boolean;
  anamnesis?: {
    id: string;
    answers: Record<string, any>;
    template_schema: AnamnesisSchema;
    template: { id: string; version: number };
    filled_at: string;
    submitted_via: 'STAFF' | 'PATIENT_PORTAL' | null;
    consent_accepted_at: string | null;
    audit_hash: string | null;
  };
  template?: { id: string; version: number; schema: AnamnesisSchema } | null;
  consent_text: string;
}

interface SubmitResp {
  id: string;
  filled_at: string;
  audit_hash: string | null;
}

/**
 * Comprime e redimensiona imagem JPEG via canvas. Retorna data-url base64.
 * Default: max 800x800, quality 0.7 — ~80-150KB para selfie tipica.
 */
async function compressImage(
  file: File,
  maxDim = 800,
  quality = 0.7,
): Promise<string> {
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    const ratio = width / height;
    if (ratio > 1) {
      width = maxDim;
      height = Math.round(maxDim / ratio);
    } else {
      height = maxDim;
      width = Math.round(maxDim * ratio);
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas indisponivel');
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

export default function AreaPacienteAnamnesePreencherPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ActiveAnamneseResp | null>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [signature, setSignature] = useState('');
  const [selfie, setSelfie] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [success, setSuccess] = useState<SubmitResp | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    portalApi.get<ActiveAnamneseResp>('/portal/anamnesis')
      .then(({ data }) => {
        setData(data);
        if (data.exists && data.anamnesis) {
          setAnswers(data.anamnesis.answers || {});
        }
      })
      .catch((err) => {
        setErrorMsg(err?.response?.data?.message || 'Erro ao carregar ficha');
      })
      .finally(() => setLoading(false));
  }, []);

  const handleSelfieSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg('');
    try {
      const compressed = await compressImage(file);
      setSelfie(compressed);
    } catch (err: any) {
      setErrorMsg('Nao foi possivel processar a foto. Tente outra.');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, []);

  const handleSubmit = async () => {
    setErrorMsg('');
    if (!consentAccepted) {
      setErrorMsg('Voce precisa concordar com o termo para enviar.');
      return;
    }
    if (signature.trim().length < 3) {
      setErrorMsg('Digite seu nome completo para confirmar.');
      return;
    }
    if (!selfie) {
      setErrorMsg('Tire uma foto de confirmacao para enviar.');
      return;
    }
    setSubmitting(true);
    try {
      const { data: resp } = await portalApi.post<SubmitResp>('/portal/anamnesis/submit', {
        answers,
        signature_data: signature.trim(),
        signature_method: 'TYPED_NAME',
        selfie_data: selfie,
        consent_accepted: true,
      });
      setSuccess(resp);
    } catch (err: any) {
      setErrorMsg(err?.response?.data?.message || 'Erro ao enviar anamnese');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando sua ficha...
      </div>
    );
  }

  if (errorMsg && !data) {
    return (
      <div className="max-w-xl mx-auto bg-card border border-destructive/30 rounded-xl p-6 text-center">
        <AlertCircle size={32} className="mx-auto text-destructive mb-2" />
        <p className="text-sm font-medium">{errorMsg}</p>
      </div>
    );
  }

  // Tela "ja confirmada" — paciente nao pode reeditar
  const alreadyConfirmed =
    data?.exists && data.anamnesis?.consent_accepted_at != null;

  if (alreadyConfirmed && !success) {
    const filledAt = new Date(data!.anamnesis!.consent_accepted_at!).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    return (
      <div className="max-w-xl mx-auto space-y-4">
        <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 rounded-2xl p-6 text-center">
          <Lock size={40} className="mx-auto text-emerald-600 mb-2" />
          <h2 className="text-lg font-bold mb-1">Anamnese ja confirmada</h2>
          <p className="text-sm text-muted-foreground">
            Voce confirmou eletronicamente sua anamnese em <strong>{filledAt}</strong>.
          </p>
          <p className="text-xs text-muted-foreground mt-3">
            Para alterar qualquer informacao, fale com a recepcao da clinica
            durante sua proxima visita.
          </p>
          {data!.anamnesis!.audit_hash && (
            <div className="mt-4 inline-block bg-white/60 dark:bg-black/20 rounded-lg px-3 py-2 text-xs font-mono text-muted-foreground break-all">
              🔒 Protocolo: {data!.anamnesis!.audit_hash.slice(0, 16)}...
            </div>
          )}
        </div>
        <button
          onClick={() => router.replace('/area-paciente')}
          className="w-full px-4 py-3 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90"
        >
          Voltar para o portal
        </button>
      </div>
    );
  }

  if (success) {
    const filledAt = new Date(success.filled_at).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    return (
      <div className="max-w-xl mx-auto space-y-4">
        <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 rounded-2xl p-6 text-center">
          <CheckCircle size={48} className="mx-auto text-emerald-600 mb-3" />
          <h2 className="text-lg font-bold mb-1">Anamnese confirmada!</h2>
          <p className="text-sm text-muted-foreground mb-4">
            Suas informacoes foram registradas com seguranca.
          </p>
          <div className="text-xs text-muted-foreground space-y-1 bg-white/60 dark:bg-black/20 rounded-lg p-3 inline-block text-left">
            <p>📅 <span className="font-medium">{filledAt}</span></p>
            {success.audit_hash && (
              <p className="font-mono break-all">
                🔒 Protocolo: {success.audit_hash.slice(0, 16)}...
              </p>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-3">
            Apos a confirmacao, alteracoes precisam ser feitas pela recepcao.
          </p>
        </div>
        <button
          onClick={() => router.replace('/area-paciente')}
          className="w-full px-4 py-3 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90"
        >
          Voltar para o portal
        </button>
      </div>
    );
  }

  if (!data) return null;

  if (!data.exists && !data.template) {
    return (
      <div className="max-w-xl mx-auto bg-card border border-amber-300 dark:border-amber-900 rounded-xl p-6 text-center">
        <AlertCircle size={32} className="mx-auto text-amber-600 mb-2" />
        <p className="text-sm font-semibold mb-1">Anamnese indisponivel</p>
        <p className="text-xs text-muted-foreground">
          A clinica ainda nao configurou o modelo de ficha. Por favor, entre
          em contato com a recepcao.
        </p>
      </div>
    );
  }

  const schema = data.exists
    ? data.anamnesis!.template_schema
    : data.template!.schema;

  return (
    <div className="max-w-2xl mx-auto space-y-4 pb-8">
      {/* Cabecalho */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-start gap-2">
          <FileText size={20} className="text-primary mt-0.5" />
          <div>
            <h1 className="text-lg font-bold">Ficha de anamnese</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Responda com calma. Suas respostas ajudam a equipe a oferecer o
              melhor atendimento. <strong>Apos confirmar, nao sera possivel reeditar</strong>.
            </p>
          </div>
        </div>
      </div>

      {/* Formulario dinamico */}
      <DynamicAnamneseForm
        schema={schema}
        initialAnswers={answers}
        onAnswersChange={setAnswers}
        hideActions
        onSave={() => {}}
      />

      {/* Bloco selfie */}
      <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-xl p-4 space-y-3">
        <div className="flex items-start gap-2">
          <Camera size={18} className="text-blue-600 mt-0.5 shrink-0" />
          <div>
            <h3 className="font-semibold text-sm">Foto de confirmacao</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Tire uma selfie agora. A foto fica registrada como prova de que
              voce mesmo preencheu a anamnese.
            </p>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="user"
          onChange={handleSelfieSelect}
          className="hidden"
        />

        {selfie ? (
          <div className="space-y-2">
            <img
              src={selfie}
              alt="Selfie de confirmacao"
              className="w-full max-w-xs mx-auto rounded-lg border border-blue-200 dark:border-blue-900"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full px-3 py-2 rounded-lg border border-blue-300 dark:border-blue-800 text-sm font-medium hover:bg-blue-100 dark:hover:bg-blue-900/40 flex items-center justify-center gap-2"
            >
              <RotateCcw size={14} /> Tirar outra
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full px-4 py-4 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 flex items-center justify-center gap-2"
          >
            <Camera size={18} /> Abrir camera
          </button>
        )}
      </div>

      {/* Bloco de consentimento + assinatura */}
      <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl p-4 space-y-3">
        <div className="flex items-start gap-2">
          <ShieldCheck size={18} className="text-amber-600 mt-0.5 shrink-0" />
          <div>
            <h3 className="font-semibold text-sm">Confirmacao eletronica</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Para validar legalmente, leia o termo abaixo e assine.
            </p>
          </div>
        </div>

        <div className="text-xs leading-relaxed text-foreground bg-white/60 dark:bg-black/20 border border-amber-200/60 dark:border-amber-900/60 rounded-lg p-3 max-h-40 overflow-y-auto">
          {data.consent_text}
        </div>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={consentAccepted}
            onChange={(e) => setConsentAccepted(e.target.checked)}
            className="mt-0.5 w-4 h-4 accent-primary"
          />
          <span className="text-sm">
            Li e concordo com o termo acima.
          </span>
        </label>

        <div>
          <label className="block text-xs font-medium mb-1">
            Digite seu nome completo para confirmar <span className="text-destructive">*</span>
          </label>
          <input
            type="text"
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            placeholder="Ex: Maria Silva Santos"
            className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            Este campo equivale a sua assinatura. Sera registrado junto com a
            foto, data, hora, IP e dispositivo de acesso.
          </p>
        </div>
      </div>

      {errorMsg && (
        <div className="bg-destructive/10 border border-destructive/30 text-destructive rounded-lg px-3 py-2 text-sm flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full px-4 py-3 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {submitting ? (
          <>
            <Loader2 size={16} className="animate-spin" /> Enviando...
          </>
        ) : (
          <>
            <ShieldCheck size={16} /> Confirmar e enviar anamnese
          </>
        )}
      </button>
    </div>
  );
}
