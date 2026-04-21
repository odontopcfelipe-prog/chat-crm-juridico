'use client';

import { useEffect, useState } from 'react';
import { FileText, Loader2, CheckCircle, Clock } from 'lucide-react';
import portalApi from '@/lib/portalApi';

interface Anamnesis {
  id: string;
  filled_at: string;
  updated_at: string;
  template: { id: string; version: number };
}

export default function AreaPacienteAnamnesePage() {
  const [loading, setLoading] = useState(true);
  const [anamneses, setAnamneses] = useState<Anamnesis[]>([]);

  useEffect(() => {
    portalApi.get<Anamnesis[]>('/portal/anamneses')
      .then(({ data }) => setAnamneses(data || []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold flex items-center gap-2">
        <FileText size={24} className="text-primary" /> Minha anamnese
      </h1>

      {anamneses.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          <FileText size={28} className="mx-auto mb-2 opacity-40" />
          <p className="text-sm text-muted-foreground mb-2">
            Você ainda não preencheu nenhuma anamnese.
          </p>
          <p className="text-xs text-muted-foreground">
            Quando vier para uma consulta, peça à recepção para enviar o link de preenchimento da anamnese.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {anamneses.map((a) => (
            <li key={a.id} className="bg-card border border-border rounded-xl p-3 flex items-center justify-between gap-3">
              <div>
                <p className="font-semibold text-sm flex items-center gap-1">
                  <CheckCircle size={14} className="text-green-600" />
                  Anamnese v{a.template.version}
                </p>
                <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                  <Clock size={11} />
                  Preenchida em {new Date(a.filled_at).toLocaleString('pt-BR', {
                    day: '2-digit', month: '2-digit', year: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="text-xs text-muted-foreground text-center pt-3">
        Manter sua anamnese atualizada ajuda os profissionais a oferecer o melhor cuidado.
      </div>
    </div>
  );
}
