'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Loader2, CheckCircle, Clock, ShieldCheck, Pencil } from 'lucide-react';
import portalApi from '@/lib/portalApi';

interface ActiveAnamneseResp {
  exists: boolean;
  anamnesis?: {
    id: string;
    filled_at: string;
    submitted_via: 'STAFF' | 'PATIENT_PORTAL' | null;
    audit_hash: string | null;
    template: { id: string; version: number };
  };
  template?: { id: string; version: number };
  consent_text: string;
}

export default function AreaPacienteAnamnesePage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ActiveAnamneseResp | null>(null);

  useEffect(() => {
    portalApi.get<ActiveAnamneseResp>('/portal/anamnesis')
      .then(({ data }) => setData(data))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
      </div>
    );
  }

  const exists = data?.exists && data.anamnesis;

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold flex items-center gap-2">
        <FileText size={24} className="text-primary" /> Minha anamnese
      </h1>

      {exists ? (
        <div className="bg-card border border-border rounded-xl p-4 space-y-3">
          <div className="flex items-start gap-2">
            <CheckCircle size={18} className="text-green-600 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="font-semibold text-sm">Anamnese preenchida</p>
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                <Clock size={11} />
                {new Date(data!.anamnesis!.filled_at).toLocaleString('pt-BR', {
                  day: '2-digit', month: '2-digit', year: 'numeric',
                  hour: '2-digit', minute: '2-digit',
                })}
              </p>
            </div>
          </div>

          {data!.anamnesis!.submitted_via === 'PATIENT_PORTAL' && (
            <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 rounded-lg p-2.5 text-xs flex items-start gap-2">
              <ShieldCheck size={14} className="text-emerald-600 mt-0.5 shrink-0" />
              <div>
                Confirmada eletronicamente por voce.
                {data!.anamnesis!.audit_hash && (
                  <p className="font-mono text-[10px] text-muted-foreground mt-0.5 break-all">
                    Protocolo: {data!.anamnesis!.audit_hash.slice(0, 16)}...
                  </p>
                )}
              </div>
            </div>
          )}

          <button
            onClick={() => router.push('/area-paciente/anamnese/preencher')}
            className="w-full px-4 py-2.5 rounded-lg border border-border text-sm font-medium hover:bg-accent flex items-center justify-center gap-2"
          >
            <Pencil size={14} /> Revisar / atualizar
          </button>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl p-5 space-y-4">
          <div className="text-center">
            <FileText size={32} className="mx-auto mb-2 text-primary/60" />
            <p className="text-sm font-semibold">Voce ainda nao preencheu sua anamnese</p>
            <p className="text-xs text-muted-foreground mt-1">
              Leva uns 3 minutos. As respostas ajudam a equipe a oferecer um
              atendimento mais seguro e personalizado.
            </p>
          </div>
          <button
            onClick={() => router.push('/area-paciente/anamnese/preencher')}
            className="w-full px-4 py-3 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 flex items-center justify-center gap-2"
          >
            <Pencil size={16} /> Preencher agora
          </button>
        </div>
      )}

      <div className="text-xs text-muted-foreground text-center pt-2">
        Manter sua anamnese atualizada ajuda a oferecer o melhor cuidado.
      </div>
    </div>
  );
}
