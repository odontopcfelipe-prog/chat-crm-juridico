'use client';

/**
 * ContratoLaboratorioCard — contrato de prestação de serviços de prótese dentária do
 * orçamento, na conta de LABORATÓRIO.
 *
 * É o mesmo fluxo do ContratoCard da clínica (checklist de dados que faltam, criar,
 * pré-visualizar, baixar, enviar o PDF no WhatsApp, registrar a assinatura), nas mesmas
 * rotas, com o texto do laboratório (lab-contrato-textos.ts) e sem o que é da clínica:
 * nada de termos de procedimento, de seletor de dentista nem de ClickSign (a conta da
 * ClickSign é da plataforma). Nada é enviado sem o clique do usuário.
 */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Download, Eye, FileText, Loader2, MessageSquare, Send, X } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { LAB_CONTRATO_CARD } from '../lab-contrato-textos';

type Status = 'DRAFT' | 'SENT' | 'OPENED' | 'PATIENT_SIGNED' | 'SIGNED' | 'EXPIRED' | 'CANCELLED';

interface ContratoMinimo {
  id: string;
  status: Status;
  skipped: boolean;
}

interface Cliente {
  patient: { id: string; name: string; phone: string | null };
}

interface Completude {
  complete: boolean;
  missing: string[];
  dentist: { name: string; cro: string };
}

interface PreviaWhatsapp {
  defaultCaption: string;
  patientName: string;
  phoneLast4: string;
  chip: { purpose: 'CLINICA' | 'COMERCIAL'; label: string } | null;
  problem: string | null;
  problemMessage: string | null;
  blocking: boolean;
}

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function Passo({ n, rotulo, ativo, feito }: { n: number; rotulo: string; ativo: boolean; feito: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border-2 ${
          feito ? 'bg-emerald-600 border-emerald-600 text-white' : ativo ? 'bg-violet-600 border-violet-600 text-white' : 'bg-card border-border text-muted-foreground'
        }`}
      >
        {feito ? <Check size={10} strokeWidth={3} /> : n}
      </span>
      <span className={`text-[11px] font-semibold ${feito ? 'text-emerald-700 dark:text-emerald-400' : ativo ? 'text-violet-700 dark:text-violet-400' : 'text-muted-foreground'}`}>
        {rotulo}
      </span>
    </div>
  );
}

function mensagemDoErro(err: unknown, padrao: string): string {
  const m = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
  return (Array.isArray(m) ? m.join(', ') : m) || padrao;
}

export default function ContratoLaboratorioCard({
  quoteId,
  rotuloDoOrcamento,
  total,
  readOnly = false,
  onOpenPatientChat,
}: {
  quoteId: string;
  rotuloDoOrcamento?: string;
  total?: number;
  readOnly?: boolean;
  onOpenPatientChat?: () => void | Promise<void>;
}) {
  const T = LAB_CONTRATO_CARD;
  const [contrato, setContrato] = useState<ContratoMinimo | null>(null);
  const [cliente, setCliente] = useState<Cliente | null>(null);
  const [completude, setCompletude] = useState<Completude | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [pdfOcupado, setPdfOcupado] = useState(false);
  const [zapAberto, setZapAberto] = useState(false);
  const [zapCarregando, setZapCarregando] = useState(false);
  const [zapPrevia, setZapPrevia] = useState<PreviaWhatsapp | null>(null);
  const [zapTexto, setZapTexto] = useState('');
  const [zapEnviando, setZapEnviando] = useState(false);
  const [zapEnviado, setZapEnviado] = useState<{ conversationId: string; chip: string } | null>(null);
  const [montado, setMontado] = useState(false);

  useEffect(() => setMontado(true), []);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const [c, q] = await Promise.all([
        api.get<ContratoMinimo | null>(`/quotes/${quoteId}/contract`).catch(() => ({ data: null as ContratoMinimo | null })),
        api.get<Cliente>(`/quotes/${quoteId}`).catch(() => ({ data: null as Cliente | null })),
      ]);
      setContrato(c.data);
      setCliente(q.data);
    } finally {
      setCarregando(false);
    }
  }, [quoteId]);

  useEffect(() => { void carregar(); }, [carregar]);

  const carregarCompletude = useCallback(async () => {
    try {
      const { data } = await api.get<Completude>(`/quotes/${quoteId}/contract-completeness`);
      setCompletude(data);
    } catch {
      setCompletude(null);
    }
  }, [quoteId]);

  useEffect(() => { if (!carregando) void carregarCompletude(); }, [carregarCompletude, carregando]);

  const criar = async () => {
    setOcupado(true);
    try {
      const { data } = await api.post<ContratoMinimo>(`/quotes/${quoteId}/contract`, { selected_documents: [] });
      setContrato(data);
      showSuccess(T.criado);
    } catch (err: unknown) {
      showError(mensagemDoErro(err, T.erroCriar));
    } finally {
      setOcupado(false);
    }
  };

  const acao = async (caminho: string) => {
    if (!contrato) return;
    setOcupado(true);
    try {
      const { data } = await api.post<ContratoMinimo>(`/contracts/${contrato.id}/${caminho}`, {});
      setContrato(data);
      showSuccess(T.atualizado);
    } catch (err: unknown) {
      showError(mensagemDoErro(err, T.erroAtualizar));
    } finally {
      setOcupado(false);
    }
  };

  const baixarPdf = async (caminho: string): Promise<Blob> => {
    try {
      const res = await api.get(caminho, { responseType: 'blob' });
      return res.data as Blob;
    } catch (err: unknown) {
      const dados = (err as { response?: { data?: unknown } })?.response?.data;
      let msg = '';
      if (dados instanceof Blob) {
        try { msg = JSON.parse(await dados.text())?.message || ''; } catch { /* corpo que não é JSON */ }
      }
      throw new Error(msg || T.erroPdf);
    }
  };

  // Abre a aba já no clique (o navegador não bloqueia) e aponta para o PDF depois.
  const abrirPdf = async (caminho: string, erro: string) => {
    if (pdfOcupado) return;
    const janela = window.open('', '_blank');
    setPdfOcupado(true);
    try {
      const url = URL.createObjectURL(await baixarPdf(caminho));
      if (janela && !janela.closed) {
        janela.opener = null;
        janela.location.href = url;
      } else {
        const w = window.open(url, '_blank');
        if (w) w.opener = null;
        else showError(T.popupBloqueado);
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err: unknown) {
      janela?.close();
      showError((err as Error)?.message || erro);
    } finally {
      setPdfOcupado(false);
    }
  };

  const baixar = async (id: string) => {
    if (pdfOcupado) return;
    setPdfOcupado(true);
    try {
      const url = URL.createObjectURL(await baixarPdf(`/contracts/${id}/preview-pdf`));
      const nome = (cliente?.patient?.name || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'cliente';
      const a = document.createElement('a');
      a.href = url;
      a.download = `contrato-${nome}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err: unknown) {
      showError((err as Error)?.message || T.erroBaixar);
    } finally {
      setPdfOcupado(false);
    }
  };

  const abrirZap = async () => {
    if (!contrato) return;
    setZapAberto(true);
    setZapEnviado(null);
    setZapPrevia(null);
    setZapCarregando(true);
    try {
      const { data } = await api.get<PreviaWhatsapp>(`/contracts/${contrato.id}/whatsapp-preview`);
      setZapPrevia(data);
      setZapTexto(data.defaultCaption);
    } catch (err: unknown) {
      showError(mensagemDoErro(err, T.erroPreparar));
      setZapAberto(false);
    } finally {
      setZapCarregando(false);
    }
  };

  const enviarZap = async () => {
    if (!contrato || zapEnviando) return;
    const legenda = zapTexto.trim();
    if (!legenda) { showError(T.escrevaMensagem); return; }
    setZapEnviando(true);
    try {
      const { data } = await api.post<{ conversationId: string; chip: { label: string } }>(
        `/contracts/${contrato.id}/send-whatsapp`,
        { caption: legenda },
      );
      const chip = data.chip?.label || 'WhatsApp';
      setZapEnviado({ conversationId: data.conversationId, chip });
      showSuccess(T.contratoEnviadoToast(chip));
    } catch (err: unknown) {
      showError(mensagemDoErro(err, T.erroEnviar));
    } finally {
      setZapEnviando(false);
    }
  };

  const irParaConversa = () => {
    setZapAberto(false);
    if (onOpenPatientChat) { void onOpenPatientChat(); return; }
    if (zapEnviado) {
      try { sessionStorage.setItem('crm_open_conv', zapEnviado.conversationId); } catch { /* sem armazenamento */ }
      window.location.assign('/atendimento');
    }
  };

  if (carregando) {
    return (
      <div className="mb-3 p-3 rounded-lg border border-border bg-muted/10 flex items-center text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin mr-2" />
        {T.carregando}
      </div>
    );
  }

  const iniciais = (nome: string | undefined | null) => {
    const partes = (nome || '').trim().split(/\s+/).filter(Boolean);
    if (partes.length === 0) return '??';
    if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
    return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
  };
  const nomeDoCliente = cliente?.patient?.name || T.clienteSemNome;
  const responsavel = completude?.dentist?.name || '';
  const responsavelCro = completude?.dentist?.cro || '';
  const bloqueiaCriar = completude ? !completude.complete : false;
  const status = contrato?.status;
  const terminal = !!contrato && (contrato.skipped || status === 'SIGNED' || status === 'CANCELLED' || status === 'EXPIRED');
  const rotuloStatus = !contrato
    ? { texto: T.status.naoEnviado, cls: 'bg-muted text-muted-foreground border-border' }
    : status === 'SIGNED'
    ? { texto: T.status.assinado, cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30' }
    : status === 'PATIENT_SIGNED'
    ? { texto: T.status.aguardandoLaboratorio, cls: 'bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30' }
    : status === 'SENT' || status === 'OPENED'
    ? { texto: T.status.enviado, cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30' }
    : status === 'CANCELLED' || status === 'EXPIRED'
    ? { texto: status === 'EXPIRED' ? T.status.expirado : T.status.cancelado, cls: 'bg-muted text-muted-foreground border-border' }
    : { texto: T.status.naoEnviado, cls: 'bg-muted text-muted-foreground border-border' };
  const passoAtual = !contrato ? 1 : status === 'DRAFT' ? 2 : 3;
  const clienteAssinou = status === 'SIGNED' || status === 'PATIENT_SIGNED';
  const laboratorioAssinou = status === 'SIGNED';
  const selo = (feito: boolean) => (feito
    ? { texto: T.assinou, cls: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30' }
    : { texto: T.aguardando, cls: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30' });

  const botao = 'text-xs font-semibold px-3 py-2 rounded-md border border-border bg-card hover:bg-accent/40 text-foreground inline-flex items-center gap-1.5 transition-colors disabled:opacity-50';

  return (
    <div className="mb-4 rounded-xl border border-border bg-card overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className="w-11 h-11 rounded-xl bg-violet-500/15 flex items-center justify-center shrink-0">
            <FileText size={20} className="text-violet-700 dark:text-violet-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-bold text-foreground">{T.titulo}</h3>
              <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full border ${rotuloStatus.cls}`}>
                {rotuloStatus.texto}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              {T.geradoPara} <strong className="text-foreground">{rotuloDoOrcamento || T.orcamentoPadrao}</strong>
              {' · '}<strong className="text-foreground tabular-nums">{total !== undefined ? brl(total) : '—'}</strong>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Passo n={1} rotulo={T.passos.montar} ativo={passoAtual === 1} feito={!!contrato} />
          <span className="w-4 h-px bg-border" />
          <Passo n={2} rotulo={T.passos.enviar} ativo={passoAtual === 2} feito={!!contrato && status !== 'DRAFT'} />
          <span className="w-4 h-px bg-border" />
          <Passo n={3} rotulo={T.passos.assinar} ativo={passoAtual === 3} feito={clienteAssinou} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-border">
        <div className="p-5">
          <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-3">{T.oQueVai}</p>
          <p className="text-xs text-foreground leading-relaxed">{T.oQueVaiTexto}</p>
          <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1">
            <AlertTriangle size={11} className="shrink-0 mt-0.5" />
            {T.modeloAviso}
          </p>
        </div>

        <div className="p-5">
          <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-3">{T.quemAssina}</p>
          <div className="space-y-2.5">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-violet-500/15 text-violet-700 dark:text-violet-400 font-bold text-xs flex items-center justify-center shrink-0">
                {iniciais(nomeDoCliente)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-foreground truncate">{nomeDoCliente}</p>
                <p className="text-[11px] text-muted-foreground truncate">{T.clienteRotulo}</p>
              </div>
              <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border ${selo(clienteAssinou).cls} shrink-0`}>
                {selo(clienteAssinou).texto}
              </span>
            </div>
            <div className="pt-1.5 border-t border-border/60 flex items-center gap-3">
              <div className={`w-9 h-9 rounded-full font-bold text-xs flex items-center justify-center shrink-0 ${responsavel ? 'bg-sky-500/15 text-sky-700 dark:text-sky-400' : 'bg-muted text-muted-foreground'}`}>
                {responsavel ? iniciais(responsavel) : '?'}
              </div>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-semibold truncate ${responsavel ? 'text-foreground' : 'text-amber-700 dark:text-amber-400'}`}>
                  {responsavel || T.responsavelFalta}
                </p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {T.responsavelRotulo}{responsavelCro ? ` · ${responsavelCro}` : ''}
                </p>
              </div>
              <span className={`text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded border ${selo(laboratorioAssinou).cls} shrink-0`}>
                {selo(laboratorioAssinou).texto}
              </span>
            </div>
          </div>
        </div>
      </div>

      {completude && !completude.complete && (
        <div className="px-5 py-2.5 bg-amber-500/10 border-t border-amber-500/20 flex items-start gap-2 text-[11px] text-amber-700 dark:text-amber-400">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="font-semibold">{contrato ? T.faltamNoContrato : T.faltamParaGerar}</p>
            <ul className="mt-0.5 list-disc list-inside space-y-0.5">
              {completude.missing.map((m) => <li key={m}>{m}</li>)}
            </ul>
            <p className="mt-1 opacity-80">{T.completeNoCadastro}</p>
          </div>
        </div>
      )}
      {completude && completude.complete && !contrato && (
        <div className="px-5 py-2 bg-emerald-500/10 border-t border-emerald-500/20 flex items-center gap-2 text-[11px] text-emerald-700 dark:text-emerald-400">
          <Check size={13} className="shrink-0" />
          <span>{T.tudoCompleto}</span>
        </div>
      )}

      <div className="px-5 py-3 border-t border-border bg-muted/20 flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11px] text-muted-foreground font-semibold">{T.rodape}</p>
        <div className="flex items-center gap-2 flex-wrap">
          {contrato ? (
            <>
              <button type="button" className={botao} disabled={pdfOcupado} onClick={() => void abrirPdf(`/contracts/${contrato.id}/preview-pdf`, T.erroPdf)}>
                {pdfOcupado ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />}
                {T.previa}
              </button>
              <button type="button" className={botao} disabled={pdfOcupado} title={T.baixarTitulo} onClick={() => void baixar(contrato.id)}>
                {pdfOcupado ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                {T.baixar}
              </button>
              {!readOnly && status !== 'CANCELLED' && status !== 'EXPIRED' && (
                <button
                  type="button"
                  onClick={() => void abrirZap()}
                  disabled={ocupado || pdfOcupado || zapEnviando}
                  title={T.whatsappTitulo}
                  className="text-xs font-semibold px-3 py-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1.5 transition-colors disabled:opacity-50"
                >
                  <MessageSquare size={12} />
                  {T.whatsapp}
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                className={botao}
                disabled={pdfOcupado}
                title={T.previaTitulo}
                onClick={() => void abrirPdf(`/quotes/${quoteId}/contract-preview-pdf`, T.erroPrevia)}
              >
                {pdfOcupado ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />}
                {T.previa}
              </button>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => void criar()}
                  disabled={ocupado || bloqueiaCriar}
                  title={bloqueiaCriar ? T.completeAntes((completude?.missing || []).join(', ')) : T.criarTitulo}
                  className="text-xs font-semibold px-3 py-2 rounded-md border border-violet-500/30 bg-violet-500/10 hover:bg-violet-500/20 text-violet-700 dark:text-violet-400 inline-flex items-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {ocupado ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
                  {T.criar}
                </button>
              )}
            </>
          )}
          {!readOnly && contrato && !terminal && status === 'DRAFT' && (
            <button type="button" className={botao} disabled={ocupado} onClick={() => void acao('send')}>
              <Send size={12} />
              {T.marcarEnviado}
            </button>
          )}
          {!readOnly && contrato && !terminal && (status === 'DRAFT' || status === 'SENT' || status === 'OPENED') && (
            <button
              type="button"
              disabled={ocupado}
              onClick={() => void acao('sign-patient')}
              className="text-xs font-bold px-3 py-2 rounded-md bg-violet-600 hover:bg-violet-700 text-white inline-flex items-center gap-1.5 shadow-sm transition-colors disabled:opacity-50"
            >
              <Check size={12} />
              {T.clienteAssinou}
            </button>
          )}
          {!readOnly && contrato && !terminal && status === 'PATIENT_SIGNED' && (
            <button
              type="button"
              disabled={ocupado}
              onClick={() => void acao('sign-clinic')}
              className="text-xs font-bold px-3 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white inline-flex items-center gap-1.5 transition-colors disabled:opacity-50"
            >
              <Check size={12} />
              {T.laboratorioAssinou}
            </button>
          )}
          {!readOnly && contrato && !terminal && (
            <button
              type="button"
              disabled={ocupado}
              title={T.cancelarTitulo}
              onClick={() => { if (window.confirm(T.cancelarConfirma)) void acao('cancel'); }}
              className="text-xs px-2 py-2 rounded-md border border-border hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 inline-flex items-center gap-1 text-muted-foreground"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {zapAberto && montado && createPortal(
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center overflow-y-auto p-4"
          onClick={() => { if (!zapEnviando) setZapAberto(false); }}
        >
          <div className="bg-card border border-border rounded-xl shadow-2xl max-w-lg w-full my-8 overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-foreground">{T.modalTitulo}</h3>
                <p className="text-[11px] text-muted-foreground mt-0.5">{T.modalSubtitulo}</p>
              </div>
              <button
                type="button"
                onClick={() => setZapAberto(false)}
                disabled={zapEnviando}
                className="p-1.5 rounded-md hover:bg-accent/50 text-muted-foreground shrink-0 disabled:opacity-50"
                aria-label={T.fechar}
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-5 space-y-3">
              {zapCarregando || !zapPrevia ? (
                <div className="flex items-center text-xs text-muted-foreground py-6 justify-center">
                  <Loader2 size={14} className="animate-spin mr-2" />
                  {T.preparando}
                </div>
              ) : zapEnviado ? (
                <div className="py-4 text-center space-y-2">
                  <div className="mx-auto w-10 h-10 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
                    <Check size={20} />
                  </div>
                  <p className="text-sm font-semibold text-foreground">{T.contratoEnviado}</p>
                  <p className="text-xs text-muted-foreground">{T.saiuPor(zapEnviado.chip, zapPrevia.patientName)}</p>
                </div>
              ) : (
                <>
                  <div className="text-xs space-y-1">
                    <p>
                      <span className="text-muted-foreground">{T.para}</span>
                      <span className="font-semibold text-foreground">{zapPrevia.patientName}</span>
                      {zapPrevia.phoneLast4 && <span className="text-muted-foreground">{T.final(zapPrevia.phoneLast4)}</span>}
                    </p>
                    {zapPrevia.chip && (
                      <p className="text-muted-foreground">
                        {T.saiPor}<span className="font-semibold text-foreground">{zapPrevia.chip.label}</span>{T.saiPorFim}
                      </p>
                    )}
                  </div>
                  {zapPrevia.problemMessage && (
                    <div className={`text-[11px] rounded-md px-3 py-2 flex items-start gap-1.5 border ${zapPrevia.blocking ? 'bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400' : 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400'}`}>
                      <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                      <span>{zapPrevia.problemMessage}</span>
                    </div>
                  )}
                  <div>
                    <textarea
                      value={zapTexto}
                      onChange={(e) => setZapTexto(e.target.value.slice(0, 1000))}
                      rows={6}
                      disabled={zapEnviando || zapPrevia.blocking}
                      className="w-full text-sm rounded-md border border-border bg-background px-3 py-2 text-foreground focus:outline-none focus:ring-2 focus:ring-emerald-500/40 disabled:opacity-60 resize-y"
                      placeholder={T.placeholder}
                    />
                    <p className="text-[10px] text-muted-foreground text-right">{zapTexto.length}/1000</p>
                  </div>
                </>
              )}
            </div>

            <div className="px-5 py-3 border-t border-border bg-muted/20 flex justify-end gap-2">
              {zapEnviado ? (
                <>
                  <button type="button" onClick={() => setZapAberto(false)} className="text-xs font-semibold px-3 py-2 rounded-md border border-border bg-card hover:bg-accent/40 text-foreground">
                    {T.fechar}
                  </button>
                  <button type="button" onClick={irParaConversa} className="text-xs font-bold px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white inline-flex items-center gap-1.5">
                    <MessageSquare size={12} />
                    {T.verNaConversa}
                  </button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => setZapAberto(false)} disabled={zapEnviando} className="text-xs font-semibold px-3 py-2 rounded-md border border-border bg-card hover:bg-accent/40 text-foreground disabled:opacity-50">
                    {T.cancelar}
                  </button>
                  <button
                    type="button"
                    onClick={() => void enviarZap()}
                    disabled={zapEnviando || zapCarregando || !zapPrevia || zapPrevia.blocking || !zapTexto.trim()}
                    className="text-xs font-bold px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white inline-flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {zapEnviando ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                    {zapEnviando ? T.enviando : T.enviar}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
