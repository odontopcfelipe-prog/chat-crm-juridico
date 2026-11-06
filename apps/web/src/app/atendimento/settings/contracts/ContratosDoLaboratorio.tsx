'use client';

/**
 * Configurações › Contratos, na conta de LABORATÓRIO.
 *
 * Mostra, de forma visível, que o texto do contrato é um MODELO INICIAL a ser revisado
 * com o advogado do laboratório, oferece o contrato de exemplo em PDF (com os dados
 * reais do laboratório e o cliente em branco) e explica de onde vêm os dados. Não lê nem
 * grava a conta da ClickSign (que é da plataforma) nem os dados fixos do contrato da clínica.
 */
import { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, FileSignature, Loader2, Eye, Building2 } from 'lucide-react';
import api from '@/lib/api';
import { showError } from '@/lib/toast';
import { LAB_CONTRATO_CONFIG } from '../../pacientes/lab-contrato-textos';

export default function ContratosDoLaboratorio() {
  const T = LAB_CONTRATO_CONFIG;
  const [abrindo, setAbrindo] = useState(false);

  const abrirModelo = async () => {
    if (abrindo) return;
    const janela = window.open('', '_blank');
    setAbrindo(true);
    try {
      const res = await api.get('/contract-templates/MODELO_LABORATORIO/pdf', { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      if (janela && !janela.closed) {
        janela.opener = null;
        janela.location.href = url;
      } else {
        const w = window.open(url, '_blank');
        if (w) w.opener = null;
        else showError(T.popupBloqueado);
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      janela?.close();
      showError(T.modeloErro);
    } finally {
      setAbrindo(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col pt-8 overflow-hidden bg-background">
      <header className="px-8 mb-6 shrink-0">
        <h1 className="text-2xl font-bold text-foreground tracking-tight">{T.titulo}</h1>
        <p className="text-[13px] text-muted-foreground mt-1">{T.subtitulo}</p>
      </header>

      <div className="flex-1 overflow-y-auto px-8 pb-8 flex flex-col gap-6">
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-5 flex items-start gap-3">
          <AlertTriangle size={20} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div>
            <h4 className="text-sm font-bold text-amber-800 dark:text-amber-300">{T.avisoTitulo}</h4>
            <p className="text-[13px] text-amber-800 dark:text-amber-300 mt-1 leading-relaxed">{T.avisoTexto}</p>
          </div>
        </div>

        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-3 bg-primary/5">
            <div className="w-8 h-8 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <FileSignature size={16} />
            </div>
            <h4 className="text-sm font-bold text-foreground">{T.modeloTitulo}</h4>
          </div>
          <div className="p-5 space-y-4">
            <p className="text-[13px] text-muted-foreground leading-relaxed">{T.modeloTexto}</p>
            <button
              type="button"
              onClick={() => void abrirModelo()}
              disabled={abrindo}
              className="bg-primary text-primary-foreground px-6 py-2.5 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-primary/90 transition-all disabled:opacity-50 shadow-lg shadow-primary/20"
            >
              {abrindo ? <Loader2 className="animate-spin" size={15} /> : <Eye size={15} />}
              {abrindo ? T.modeloAbrindo : T.modeloBotao}
            </button>
          </div>
        </div>

        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center shrink-0">
              <Building2 size={16} />
            </div>
            <h4 className="text-sm font-bold text-foreground">{T.dadosTitulo}</h4>
          </div>
          <div className="p-5 space-y-3">
            <ul className="space-y-2 text-[13px] text-muted-foreground list-disc list-inside">
              {T.dadosItens.map((item) => <li key={item}>{item}</li>)}
            </ul>
            <Link href="/atendimento/settings/identidade" className="text-sm font-bold text-primary hover:underline inline-block">
              {T.identidadeLink}
            </Link>
          </div>
        </div>

        <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border">
            <h4 className="text-sm font-bold text-foreground">{T.assinaturaTitulo}</h4>
          </div>
          <div className="p-5 space-y-4">
            <p className="text-[13px] text-muted-foreground leading-relaxed">{T.assinaturaTexto}</p>
            <div>
              <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide mb-2">{T.passosTitulo}</p>
              <ol className="space-y-1.5 text-[12px] text-muted-foreground list-none">
                {T.passos.map((passo, i) => (
                  <li key={passo} className="flex items-start gap-2">
                    <span className="w-4 h-4 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5">
                      {i + 1}
                    </span>
                    {passo}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
