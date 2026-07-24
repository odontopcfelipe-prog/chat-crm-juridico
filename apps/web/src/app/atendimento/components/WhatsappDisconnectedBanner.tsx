'use client';

// Onda 18.x — Aviso GLOBAL de chip WhatsApp desconectado.
// Aparece no topo de todas as telas do /atendimento (Início da recepção/comercial,
// inbox dos atendentes, tudo do adm) enquanto algum chip estiver fora. Fonte: polling
// de GET /whatsapp/my-numbers (só JwtAuthGuard, tenant-scoped — recepção/comercial
// enxergam). Some sozinho quando reconecta. Combina com o resolvedor "união
// Comercial↔Clínica, nunca Financeiro": enquanto a Clínica está fora, o disparo de
// paciente sai pelo Comercial; este banner pede a reconexão.

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';

type Chip = { purpose: string | null; status: string; displayName?: string; instanceName?: string };

const PURPOSE_LABEL: Record<string, string> = {
  CLINICA: 'Clínica',
  COMERCIAL: 'Comercial',
  FINANCEIRO: 'Financeiro',
};

// "down" = mesma definição do semáforo da Central de Disparos: nem 'open' nem
// 'unknown' (unknown = Evolution não respondeu; não alarma pra não dar falso positivo).
const isDown = (s?: string) => !!s && s !== 'open' && s !== 'unknown';

export function WhatsappDisconnectedBanner() {
  const router = useRouter();
  const [down, setDown] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const res = await api.get<Chip[]>('/whatsapp/my-numbers', {
          timeout: 12000,
          ...({ _silent401: true } as any),
        });
        if (!alive) return;
        const chips = Array.isArray(res.data) ? res.data : [];
        const labels = chips
          .filter((c) => isDown(c.status))
          .map((c) => (c.purpose && PURPOSE_LABEL[c.purpose]) || c.displayName || 'WhatsApp');
        setDown(labels);
      } catch {
        /* silencioso: não mostra alarme falso se a checagem falhar */
      }
    };
    check();
    const id = setInterval(check, 90_000);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  if (down.length === 0) return null;

  const label =
    down.length === 1
      ? `O WhatsApp ${down[0]} está desconectado`
      : `WhatsApps desconectados: ${down.join(', ')}`;

  return (
    <div className="shrink-0 bg-red-500/10 border-b border-red-500/30 text-red-600 dark:text-red-400 px-4 py-2 flex items-center gap-2 text-sm">
      <AlertTriangle size={16} className="shrink-0 animate-pulse" />
      <span className="font-semibold">{label}.</span>
      <span className="hidden sm:inline text-red-600/80 dark:text-red-400/80">
        Reconecte em Configurações › WhatsApp para não perder envios.
      </span>
      <button
        type="button"
        onClick={() => router.push('/atendimento/settings/whatsapp')}
        className="ml-auto shrink-0 text-xs font-bold px-2.5 py-1 rounded-lg bg-red-500/15 hover:bg-red-500/25 transition-colors"
      >
        Reconectar
      </button>
    </div>
  );
}
