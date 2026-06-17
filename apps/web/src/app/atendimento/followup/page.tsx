'use client';

// Onda 17.49 — Follow-up simplificado: a tela E o painel "Operacional" (os 4
// robos do dia-a-dia). Clicar "Abrir" num card abre a tela detalhada do robo
// (Lembrete / Pos-atendimento / Resumo do dentista) com botao voltar; o card
// "Confirmacao" vai pra Agenda (o proprio painel navega).
//
// As antigas abas (Dashboard, Sequencias, Enrollments, Aprovacoes, Disparos)
// foram removidas a pedido do usuario — o historico/CRUD continua no backend e
// o codigo antigo fica no git se um dia precisar voltar.

import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { OperacionalPanel } from './components/OperacionalPanel';
import { RemindersTab } from './components/RemindersTab';
import { PosAtendimentoTab } from './components/PosAtendimentoTab';
import { DentistSummaryTab } from './components/DentistSummaryTab';
// Onda 17.49 — aniversariantes do dia no painel (reusa o card da tela de Pacientes)
import BirthdaysCard from '@/app/atendimento/pacientes/components/BirthdaysCard';

type View = 'hub' | 'lembretes' | 'pos-atendimento' | 'dentista';

export default function FollowupPage() {
  const [view, setView] = useState<View>('hub');

  return (
    // root precisa do proprio scroll: o <main> do layout do atendimento e
    // overflow-hidden (padrao igual ao dashboard/pacientes).
    <div className="h-full overflow-y-auto bg-background">
      <div className="w-full px-4 md:px-6 py-6 pb-28 md:pb-8">
        {view === 'hub' ? (
          <>
            <OperacionalPanel
              onOpenTab={(t) => {
                if (t === 'lembretes' || t === 'pos-atendimento' || t === 'dentista') {
                  setView(t);
                }
              }}
            />
            <div className="mt-6 max-w-md">
              <BirthdaysCard alwaysShow />
            </div>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setView('hub')}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground mb-5"
            >
              <ArrowLeft size={16} /> Voltar ao Operacional
            </button>
            {view === 'lembretes' && <RemindersTab />}
            {view === 'pos-atendimento' && <PosAtendimentoTab />}
            {view === 'dentista' && <DentistSummaryTab />}
          </>
        )}
      </div>
    </div>
  );
}
