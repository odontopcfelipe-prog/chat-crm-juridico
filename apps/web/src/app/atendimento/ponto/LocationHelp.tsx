'use client';

/**
 * Como liberar a localização — passo a passo PELO APARELHO de quem está batendo
 * (iPhone/Safari, iPhone/Chrome, Android, computador). Aparece aberto quando o
 * navegador nega a localização: "permita no cadeado ao lado do endereço" só vale
 * no Chrome de computador e deixava o colaborador do iPhone sem saída.
 */
import { useState } from 'react';
import { ChevronDown, Smartphone } from 'lucide-react';
import { pickBt } from '@crm/shared';
import { useBusinessType } from '@/lib/useBusinessType';

type Plataforma = 'ios-safari' | 'ios-chrome' | 'ios-outro' | 'android' | 'computador';

export function detectarPlataforma(ua: string, touchMac = false): Plataforma {
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || touchMac;
  if (isIOS) {
    if (/CriOS/i.test(ua)) return 'ios-chrome';
    if (/FxiOS|EdgiOS|OPiOS/i.test(ua)) return 'ios-outro';
    return 'ios-safari';
  }
  if (/Android/i.test(ua)) return 'android';
  return 'computador';
}

// Por tipo de conta: o passo do computador fala do local da conta (clínica ou laboratório).
const passosDe = (bt: unknown): Record<Plataforma, { titulo: string; passos: string[] }> => ({
  'ios-safari': {
    titulo: 'iPhone (Safari)',
    passos: [
      'Abra os Ajustes do iPhone › Privacidade e Segurança › Serviços de Localização e deixe LIGADO.',
      'Na mesma tela, toque em "Sites do Safari", escolha "Ao Usar o App" e ligue "Localização Precisa".',
      'Volte ao Safari, toque no ícone à esquerda do endereço (ou em "aA") › Ajustes do Site › Localização › Permitir.',
      'Feche esta página e abra de novo — ou toque em "Localizar de novo" e aceite quando o iPhone perguntar.',
    ],
  },
  'ios-chrome': {
    titulo: 'iPhone (Chrome)',
    passos: [
      'Abra os Ajustes do iPhone › Privacidade e Segurança › Serviços de Localização e deixe LIGADO.',
      'Role até "Chrome", escolha "Durante o Uso" e ligue "Localização Precisa".',
      'Volte ao Chrome, toque em "Localizar de novo" e aceite quando ele perguntar.',
    ],
  },
  'ios-outro': {
    titulo: 'iPhone',
    passos: [
      'Abra os Ajustes do iPhone › Privacidade e Segurança › Serviços de Localização e deixe LIGADO.',
      'Role até o navegador que você usa, escolha "Durante o Uso" e ligue "Localização Precisa".',
      'Se não der certo, abra o sistema pelo Safari.',
    ],
  },
  android: {
    titulo: 'Android',
    passos: [
      'Puxe a barra do topo do celular e ligue a "Localização".',
      'No navegador, toque no ícone à esquerda do endereço › Permissões (ou Configurações do site) › Localização › Permitir.',
      'Em Configurações do celular › Apps › Chrome (ou o navegador que usa) › Permissões › Localização: "Permitir durante o uso" e ligue "Usar local preciso".',
      'Volte e toque em "Localizar de novo".',
    ],
  },
  computador: {
    titulo: 'Computador',
    passos: [
      pickBt(
        bt,
        'Computador não tem GPS — o ponto é batido pelo celular, dentro da clínica.',
        'Computador não tem GPS — o ponto é batido pelo celular, dentro do laboratório.',
      ),
      'Se estiver no celular e vendo isto, abra o sistema pelo navegador do celular (Safari ou Chrome).',
    ],
  },
});

export function LocationHelp({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const bt = useBusinessType();
  const plataforma =
    typeof navigator === 'undefined'
      ? 'computador'
      : detectarPlataforma(navigator.userAgent, navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const info = passosDe(bt)[plataforma];
  return (
    <div className="mt-3 w-full max-w-md text-left border border-slate-200 rounded-xl bg-slate-50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm font-semibold text-slate-700"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5"><Smartphone className="w-4 h-4 text-sky-600" /> Como liberar a localização ({info.titulo})</span>
        <ChevronDown className={`w-4 h-4 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ol className="px-3 pb-3 space-y-1.5 text-xs text-slate-600 list-decimal list-inside">
          {info.passos.map((p) => <li key={p}>{p}</li>)}
        </ol>
      )}
    </div>
  );
}
