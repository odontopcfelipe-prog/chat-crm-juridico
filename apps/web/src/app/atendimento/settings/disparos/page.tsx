'use client';

// Onda 17.55 — "Disparos e Lembretes": APENAS a configuração de cada disparo
// (sem o painel de monitoramento/métricas do Follow-up). Abas no topo; cada aba
// mostra o painel de config daquele disparo. O on/off e as métricas continuam no
// painel Operacional (/atendimento/followup).
import { useState } from 'react';
import { Bell, Heart, Stethoscope } from 'lucide-react';
import { RemindersConfigModal } from '../../followup/components/RemindersConfigModal';
import { PosAtendimentoTab } from '../../followup/components/PosAtendimentoTab';
import { DentistSummaryTab } from '../../followup/components/DentistSummaryTab';

type Tab = 'lembrete' | 'pos' | 'dentista';

const TABS: { id: Tab; label: string; Icon: typeof Bell }[] = [
  { id: 'lembrete', label: 'Lembrete de consulta', Icon: Bell },
  { id: 'pos', label: 'Pós-atendimento', Icon: Heart },
  { id: 'dentista', label: 'Resumo do dentista', Icon: Stethoscope },
];

export default function DisparosLembretesPage() {
  const [tab, setTab] = useState<Tab>('lembrete');

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">Disparos e Lembretes</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure as mensagens automáticas de cada disparo. Para ligar/desligar e ver as
          métricas, use o painel Operacional.
        </p>
      </div>

      {/* Abas — um painel de configuração por disparo */}
      <div className="flex flex-wrap gap-1.5">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${
              tab === id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent border border-border'
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {/* Painel de configuração do disparo selecionado */}
      {tab === 'lembrete' && <RemindersConfigModal open embedded onClose={() => {}} />}
      {tab === 'pos' && <PosAtendimentoTab />}
      {tab === 'dentista' && <DentistSummaryTab />}
    </div>
  );
}
