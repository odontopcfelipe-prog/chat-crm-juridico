'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import api from '@/lib/api';
import { AiTestChatCard } from '../AiTestChatCard';
import type { AiProfileResponse } from '../clinic-hours';

/**
 * Teste sua IA — conversa de teste com a assistente, numa página própria (abaixo
 * de Ajustes IA no menu). Mesmo cérebro do WhatsApp (perfil do chip, dados da
 * clínica, valores, skills, agenda real), mas nada é enviado nem gravado.
 */
export default function AiTestPage() {
  const [chips, setChips] = useState<AiProfileResponse['chips'] | null>(null);

  useEffect(() => {
    api
      .get('/settings/ai-profile')
      .then((r) => setChips(r.data?.chips ?? null))
      .catch(() => setChips(null)); // sem perfil: o teste funciona igual, só sem o nome antecipado
  }, []);

  return (
    <div className="h-full flex flex-col pt-8 overflow-hidden bg-background">
      <header className="px-4 sm:px-8 mb-4 shrink-0 space-y-2">
        <Link
          href="/atendimento/settings/ai"
          className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft size={14} /> Voltar aos Ajustes IA
        </Link>
        <h1 className="text-2xl font-bold text-foreground tracking-tight">Teste sua IA</h1>
        <p className="text-[13px] text-muted-foreground max-w-3xl">
          Escreva como um paciente escreveria e veja a resposta que ele receberia no WhatsApp. Nada é enviado nem gravado.
        </p>
        <ul className="text-[12px] text-muted-foreground list-disc pl-5 space-y-0.5 max-w-3xl">
          <li>Escolha o chip (Comercial, Clínica ou Financeiro): vale o perfil daquele chip.</li>
          <li>Shift+Enter: cada linha vira uma mensagem separada do paciente.</li>
          <li>Troque a IA no seletor e clique em &quot;Responder de novo&quot; para comparar as respostas.</li>
        </ul>
      </header>
      <div className="flex-1 min-h-0 flex flex-col px-4 sm:px-8 pb-6">
        <AiTestChatCard
          tall
          chipNames={{
            COMERCIAL: chips?.COMERCIAL?.assistantName,
            CLINICA: chips?.CLINICA?.assistantName,
            FINANCEIRO: chips?.FINANCEIRO?.assistantName,
          }}
        />
      </div>
    </div>
  );
}
