'use client';

/**
 * Faixa no topo enquanto o dono do sistema está dentro de outra conta
 * (lib/acesso-clinica.ts): qual conta, em que modo, "Trocar" e "Voltar para a minha".
 * Login normal: não desenha nada.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Eye, Loader2, PencilLine } from 'lucide-react';
import { lerAcessoDoToken, precisaRecarregar, trocarDeConta, type AcessoClinica } from '@/lib/acesso-clinica';
import { showError } from '@/lib/toast';

export function AcessoClinicaFaixa({ esconder = false }: { esconder?: boolean }) {
  const [acesso, setAcesso] = useState<AcessoClinica | null>(null);
  const [voltando, setVoltando] = useState(false);

  // Depois de montar: no SSR não há token (evita diferença de hidratação).
  // Outra aba trocou de conta → esta recarrega (lib/acesso-clinica.ts precisaRecarregar).
  useEffect(() => {
    const doCarregamento = localStorage.getItem('token');
    setAcesso(lerAcessoDoToken(doCarregamento));
    const aoMudar = (e: StorageEvent) => {
      if (e.key !== 'token' && e.key !== null) return;
      if (precisaRecarregar(doCarregamento, localStorage.getItem('token'))) window.location.reload();
    };
    window.addEventListener('storage', aoMudar);
    return () => window.removeEventListener('storage', aoMudar);
  }, []);

  if (!acesso || esconder) return null;
  const soVer = acesso.modo === 'ver';

  const voltar = async () => {
    setVoltando(true);
    try {
      await trocarDeConta(null);
    } catch (e: any) {
      setVoltando(false);
      showError(e?.response?.data?.message || 'Não deu para voltar. Saia e entre de novo.');
    }
  };

  return (
    <div
      role="status"
      className={`shrink-0 w-full flex items-center justify-center gap-x-3 gap-y-1 flex-wrap px-4 py-1.5 text-[12px] font-semibold ${
        soVer ? 'bg-amber-400 text-amber-950' : 'bg-red-600 text-white'
      }`}
    >
      {soVer ? <Eye size={14} /> : <PencilLine size={14} />}
      <span>
        {soVer ? 'Só vendo' : 'Vendo e mexendo em'}: <b>{acesso.nome || 'outra conta'}</b>
        {soVer ? ' — nada é salvo nem enviado' : ' — o que você fizer vale nesta conta'}
      </span>
      <Link href="/admin/clinicas" className="underline underline-offset-2 hover:opacity-80">
        Trocar
      </Link>
      <button
        type="button"
        onClick={voltar}
        disabled={voltando}
        className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-bold disabled:opacity-60 ${
          soVer ? 'bg-amber-950 text-amber-50' : 'bg-white text-red-700'
        }`}
      >
        {voltando && <Loader2 size={12} className="animate-spin" />}
        Voltar para a minha
      </button>
    </div>
  );
}
