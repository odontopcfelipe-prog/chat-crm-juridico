'use client';

// Onda 17.55 — "Disparos e Lembretes": os robôs do dia-a-dia (lembrete,
// confirmação, pós-atendimento, resumo do dentista, aniversário) que rodam no
// piloto automático. Ficam em Configurações › Inteligência Artificial porque
// dependem da IA (texto/confirmação). Reusa os componentes do Follow-up — clicar
// "Abrir" num card abre a tela detalhada do robô com botão de voltar.

import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { OperacionalPanel } from '../../followup/components/OperacionalPanel';
import { RemindersTab } from '../../followup/components/RemindersTab';
import { PosAtendimentoTab } from '../../followup/components/PosAtendimentoTab';
import { DentistSummaryTab } from '../../followup/components/DentistSummaryTab';

type View = 'hub' | 'lembretes' | 'pos-atendimento' | 'dentista';

export default function DisparosLembretesPage() {
  const [view, setView] = useState<View>('hub');

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {view === 'hub' ? (
        <OperacionalPanel
          onOpenTab={(t) => {
            if (t === 'lembretes' || t === 'pos-atendimento' || t === 'dentista') setView(t);
          }}
        />
      ) : (
        <>
          <button
            type="button"
            onClick={() => setView('hub')}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground mb-5"
          >
            <ArrowLeft size={16} /> Voltar
          </button>
          {view === 'lembretes' && <RemindersTab />}
          {view === 'pos-atendimento' && <PosAtendimentoTab />}
          {view === 'dentista' && <DentistSummaryTab />}
        </>
      )}
    </div>
  );
}
