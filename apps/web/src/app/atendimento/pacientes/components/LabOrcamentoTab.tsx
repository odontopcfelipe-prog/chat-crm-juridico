'use client';

/**
 * F6 do laboratório — aba Orçamento da ficha do cliente. Só o laboratório monta esta
 * aba (a ficha decide pelo tipo de negócio da sessão).
 *
 * Lista os orçamentos de trabalho em aberto do cliente (rascunho e enviado, sem os
 * arquivados e sem a venda rápida), do mais antigo para o mais novo, e deixa:
 *   - criar um orçamento e já abrir o seletor de serviços e elementos; fechar o seletor
 *     sem adicionar nada apaga o rascunho vazio;
 *   - montar os serviços na tabela do orçamento (rascunho) ou ver a tabela só de
 *     leitura (enviado);
 *   - aplicar um modelo, ver o PDF, os anexos e as versões, só para quem negocia
 *     (manage_proposals, que a API exige nessas rotas);
 *   - ir para a aba Propostas, onde o orçamento é enviado, aprovado e cobrado.
 *
 * Quem só monta (create_evaluation) não vê PDF, modelos, anexos nem versões. Valores só
 * com view_values. Todo texto vem de ../lab-orcamento-textos.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown, ChevronUp, ClipboardList, FileText, Layers, Loader2, Pencil, Plus, Send, Trash2, X,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { useUserPermissions } from '@/lib/useUserPermissions';
import { getQuoteNumberBadge } from '@/lib/quote-display';
import AddQuoteItemModal from './AddQuoteItemModal';
import QuotePanel from './QuotePanel';
import QuoteAttachments from './QuoteAttachments';
import QuoteVersions from './QuoteVersions';
import { LAB_ORCAMENTO } from '../lab-orcamento-textos';
// F8 — ficha do caso de cada orçamento (as chamadas de rede ficam no componente dela).
import { LabFichaDoCasoDoOrcamento, LabSeloDoCaso, useCasosDoCliente } from './LabFichaDoCaso';

interface Servico {
  id: string;
  name: string;
  base_price: string | number;
  code_tuss: string | null;
  duration_minutes?: number;
  specialty?: { id: string; name: string } | null;
  specialty_id?: string | null;
}

interface OrcamentoDaLista {
  id: string;
  title: string | null;
  notes?: string | null;
  status: string;
  quote_number?: number | null;
  total_value?: string | number | null;
  created_at: string;
  valid_until?: string | null;
  archived_at?: string | null;
  is_venda_rapida?: boolean;
  created_by?: { id: string; name: string } | null;
  _count?: { items: number };
}

interface ItemDoOrcamento {
  id: string;
  procedure_id: string;
  tooth_fdi: string | null;
  dentist_id?: string | null;
  quantity: number;
  unit_price: string | number;
  total_price: string | number;
  notes?: string | null;
  procedure?: {
    id: string;
    name: string;
    code_tuss?: string | null;
    specialty_id?: string | null;
    specialty?: { id: string; name: string } | null;
  };
}

interface OrcamentoDetalhe {
  id: string;
  status: string;
  subtotal: string | number;
  discount_percent: string | number;
  discount_value: string | number;
  total_value: string | number;
  items: ItemDoOrcamento[];
}

interface Modelo {
  id: string;
  name: string;
  description?: string | null;
  specialty?: string | null;
  _count?: { items: number };
}

type ErroDaApi = { response?: { data?: { message?: string } } };
const mensagemDoErro = (err: unknown, padrao: string) =>
  (err as ErroDaApi)?.response?.data?.message || padrao;

/** Sem seleção de elementos pelo desenho dos dentes: array fixo, para não renderizar à toa. */
const SEM_DENTES_SELECIONADOS: string[] = [];
const NADA = () => {};

const ABERTOS = new Set(['DRAFT', 'SENT']);

function ehVendaRapida(q: OrcamentoDaLista): boolean {
  if (q.is_venda_rapida) return true;
  const norm = (s: string | null | undefined) =>
    (s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return norm(q.title).startsWith('venda rapida') || norm(q.notes).startsWith('venda rapida');
}

const formatarValor = (v: string | number | null | undefined) =>
  Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const formatarData = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR');
};

const rotuloDoStatus = (status: string) =>
  status === 'DRAFT' ? LAB_ORCAMENTO.status.DRAFT : status === 'SENT' ? LAB_ORCAMENTO.status.SENT : status;

export default function LabOrcamentoTab({
  patientId,
  readOnly = false,
  onGoToProposals,
}: {
  patientId: string;
  readOnly?: boolean;
  onGoToProposals?: () => void;
}) {
  const { hasPermission } = useUserPermissions();
  const podeNegociar = hasPermission('manage_proposals');
  const podeMontar = !readOnly && (podeNegociar || hasPermission('create_evaluation'));
  const verValores = hasPermission('view_values');

  const [lista, setLista] = useState<OrcamentoDaLista[]>([]);
  const [servicos, setServicos] = useState<Servico[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [aberto, setAberto] = useState<string | null>(null);
  const [revisando, setRevisando] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<OrcamentoDetalhe | null>(null);
  const [carregandoDetalhe, setCarregandoDetalhe] = useState(false);
  const [criando, setCriando] = useState(false);
  const [modalId, setModalId] = useState<string | null>(null);
  const [modelosPara, setModelosPara] = useState<string | null>(null);
  const [modelos, setModelos] = useState<Modelo[]>([]);
  const [carregandoModelos, setCarregandoModelos] = useState(false);
  const [aplicandoModelo, setAplicandoModelo] = useState<string | null>(null);
  const [gerandoPdf, setGerandoPdf] = useState<string | null>(null);
  // F8 — caso efetivo de cada orçamento (selo "Entrega dd/mm"): UMA chamada para a aba.
  // A aba só existe no laboratório.
  const { casos, recarregar: recarregarCasos } = useCasosDoCliente(true, patientId);

  // Contra clique duplo no "Novo orçamento de trabalho" (checado e marcado no mesmo tick).
  const criandoRef = useRef(false);
  // Rascunho criado agora para o seletor: fechar sem adicionar nada apaga.
  const recemCriadoRef = useRef<string | null>(null);
  const adicionouRef = useRef(false);
  const modalIdRef = useRef<string | null>(null);
  const abertoRef = useRef<string | null>(null);
  abertoRef.current = aberto;

  const carregarLista = useCallback(async () => {
    try {
      const { data } = await api.get<OrcamentoDaLista[]>(`/patients/${patientId}/quotes`);
      setLista(Array.isArray(data) ? data : []);
    } catch (err) {
      showError(mensagemDoErro(err, LAB_ORCAMENTO.erros.carregar));
    }
  }, [patientId]);

  const carregarDetalhe = useCallback(async (id: string) => {
    setCarregandoDetalhe(true);
    try {
      const { data } = await api.get<OrcamentoDetalhe>(`/quotes/${id}`);
      if (abertoRef.current === id) setDetalhe(data);
    } catch (err) {
      showError(mensagemDoErro(err, LAB_ORCAMENTO.erros.detalhe));
    } finally {
      setCarregandoDetalhe(false);
    }
  }, []);

  const recarregar = useCallback(async () => {
    const id = abertoRef.current;
    await Promise.all([carregarLista(), id ? carregarDetalhe(id) : Promise.resolve()]);
  }, [carregarLista, carregarDetalhe]);

  useEffect(() => {
    let cancelado = false;
    setCarregando(true);
    Promise.all([
      api.get<OrcamentoDaLista[]>(`/patients/${patientId}/quotes`),
      api.get<Servico[]>('/procedures').catch(() => ({ data: [] as Servico[] })),
    ])
      .then(([orcamentos, tabela]) => {
        if (cancelado) return;
        setLista(Array.isArray(orcamentos.data) ? orcamentos.data : []);
        setServicos(Array.isArray(tabela.data) ? tabela.data : []);
      })
      .catch((err) => {
        if (!cancelado) showError(mensagemDoErro(err, LAB_ORCAMENTO.erros.carregar));
      })
      .finally(() => {
        if (!cancelado) setCarregando(false);
      });
    return () => {
      cancelado = true;
    };
  }, [patientId]);

  const emAberto = lista
    .filter((q) => ABERTOS.has(q.status) && !q.archived_at && !ehVendaRapida(q))
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const alternar = (id: string) => {
    if (aberto === id) {
      setAberto(null);
      setDetalhe(null);
      return;
    }
    setAberto(id);
    abertoRef.current = id;
    setDetalhe(null);
    void carregarDetalhe(id);
  };

  const abrirSeletor = (id: string) => {
    modalIdRef.current = id;
    setModalId(id);
  };

  const novoOrcamento = async () => {
    if (criandoRef.current) return;
    criandoRef.current = true;
    setCriando(true);
    try {
      const { data } = await api.post<{ id: string }>(`/patients/${patientId}/quotes`, {});
      recemCriadoRef.current = data.id;
      adicionouRef.current = false;
      await carregarLista();
      abrirSeletor(data.id);
    } catch (err) {
      showError(mensagemDoErro(err, LAB_ORCAMENTO.erros.criar));
    } finally {
      criandoRef.current = false;
      setCriando(false);
    }
  };

  const aoAdicionar = async () => {
    // A ref (sempre atual) é o que o fechamento lê logo depois do salvar do seletor.
    adicionouRef.current = true;
    const id = modalIdRef.current;
    if (id && abertoRef.current !== id) {
      setAberto(id);
      abertoRef.current = id;
      setDetalhe(null);
    }
    await recarregar();
  };

  const aoFecharSeletor = async () => {
    const id = modalIdRef.current;
    modalIdRef.current = null;
    setModalId(null);
    const apagarVazio = !!id && recemCriadoRef.current === id && !adicionouRef.current;
    if (id && recemCriadoRef.current === id) recemCriadoRef.current = null;
    adicionouRef.current = false;
    if (!apagarVazio || !id) return;
    try {
      // Fechou no meio do salvar ou depois de um erro parcial: com serviço gravado, fica.
      const { data } = await api.get<OrcamentoDetalhe>(`/quotes/${id}`);
      if ((data?.items?.length ?? 0) > 0) {
        await recarregar();
        return;
      }
      await api.delete(`/quotes/${id}`);
      if (abertoRef.current === id) {
        setAberto(null);
        abertoRef.current = null;
        setDetalhe(null);
      }
      await carregarLista();
    } catch {
      // O rascunho pode já ter saído por outro caminho.
    }
  };

  /** Orçamento já enviado: encerra o enviado e abre um rascunho novo com os mesmos serviços. */
  const revisar = async (q: OrcamentoDaLista) => {
    if (revisando || !confirm(LAB_ORCAMENTO.confirmarRevisar)) return;
    setRevisando(q.id);
    try {
      const { data } = await api.post<{ id: string }>(`/quotes/${q.id}/renegotiate`, {});
      showSuccess(LAB_ORCAMENTO.revisado);
      await carregarLista();
      // O rascunho novo herda a ficha do caso do enviado: atualiza o selo.
      recarregarCasos();
      if (data?.id) {
        setAberto(data.id);
        abertoRef.current = data.id;
        setDetalhe(null);
        void carregarDetalhe(data.id);
      }
    } catch (err) {
      showError(mensagemDoErro(err, LAB_ORCAMENTO.erros.revisar));
    } finally {
      setRevisando(null);
    }
  };

  /** Nova opção paralela: copia os serviços para outro rascunho; o orçamento atual não muda. */
  const novaOpcao = async (q: OrcamentoDaLista) => {
    if (revisando || !confirm(LAB_ORCAMENTO.confirmarNovaOpcao)) return;
    setRevisando(q.id);
    try {
      const { data } = await api.post<{ id: string }>(`/quotes/${q.id}/duplicate-as-option`);
      showSuccess(LAB_ORCAMENTO.novaOpcaoCriada);
      await carregarLista();
      if (data?.id) {
        setAberto(data.id);
        abertoRef.current = data.id;
        setDetalhe(null);
        void carregarDetalhe(data.id);
      }
    } catch (err) {
      showError(mensagemDoErro(err, LAB_ORCAMENTO.erros.novaOpcao));
    } finally {
      setRevisando(null);
    }
  };

  const apagarRascunho = async (q: OrcamentoDaLista) => {
    const nome = (q.title || '').trim() || LAB_ORCAMENTO.semNome;
    if (!confirm(LAB_ORCAMENTO.confirmarApagar(nome))) return;
    try {
      await api.delete(`/quotes/${q.id}`);
      showSuccess(LAB_ORCAMENTO.apagado);
      if (abertoRef.current === q.id) {
        setAberto(null);
        abertoRef.current = null;
        setDetalhe(null);
      }
      await carregarLista();
    } catch (err) {
      showError(mensagemDoErro(err, LAB_ORCAMENTO.erros.apagar));
    }
  };

  const abrirModelos = async (quoteId: string) => {
    setModelosPara(quoteId);
    setCarregandoModelos(true);
    try {
      const { data } = await api.get<Modelo[]>('/quote-templates', { params: { activeOnly: '1' } });
      setModelos(Array.isArray(data) ? data : []);
    } catch (err) {
      setModelos([]);
      showError(mensagemDoErro(err, LAB_ORCAMENTO.erros.modelos));
    } finally {
      setCarregandoModelos(false);
    }
  };

  const aplicarModelo = async (modelo: Modelo) => {
    const quoteId = modelosPara;
    if (!quoteId || aplicandoModelo) return;
    setAplicandoModelo(modelo.id);
    try {
      await api.post(`/quotes/${quoteId}/apply-template`, { template_id: modelo.id });
      showSuccess(LAB_ORCAMENTO.modelos.aplicado(modelo.name));
      setModelosPara(null);
      if (abertoRef.current !== quoteId) {
        setAberto(quoteId);
        abertoRef.current = quoteId;
        setDetalhe(null);
      }
      await recarregar();
    } catch (err) {
      showError(mensagemDoErro(err, LAB_ORCAMENTO.erros.aplicar));
    } finally {
      setAplicandoModelo(null);
    }
  };

  /**
   * PDF do orçamento. A aba abre JÁ no clique (gesto do usuário), para o navegador
   * (Safari/iPhone) não bloquear; depois do download ela aponta para o PDF. Falhou: fecha.
   */
  const verPdf = async (quoteId: string) => {
    const win = window.open('', '_blank');
    setGerandoPdf(quoteId);
    try {
      const res = await api.get(`/quotes/${quoteId}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      if (win) win.location.href = url;
      else window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      win?.close();
      showError(LAB_ORCAMENTO.erros.pdf);
    } finally {
      setGerandoPdf(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <ClipboardList size={16} className="text-primary" />
            {LAB_ORCAMENTO.titulo}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
            {onGoToProposals ? LAB_ORCAMENTO.subtitulo : LAB_ORCAMENTO.subtituloSemPropostas}
          </p>
        </div>
        {podeMontar && (
          <button
            type="button"
            onClick={novoOrcamento}
            disabled={criando}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed shadow-sm"
          >
            {criando ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
            {criando ? LAB_ORCAMENTO.criando : LAB_ORCAMENTO.novo}
          </button>
        )}
      </div>

      {carregando ? (
        <div className="bg-card border border-border rounded-xl p-8 flex items-center justify-center text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin mr-2" />
          {LAB_ORCAMENTO.carregando}
        </div>
      ) : emAberto.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-10 text-center">
          <ClipboardList size={28} className="mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-sm font-medium text-foreground mb-1">{LAB_ORCAMENTO.vazioTitulo}</p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">{LAB_ORCAMENTO.vazioTexto}</p>
          {podeMontar && (
            <p className="text-xs text-muted-foreground max-w-md mx-auto mt-1">{LAB_ORCAMENTO.vazioMontar}</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {emAberto.map((q) => {
            const estaAberto = aberto === q.id;
            const rascunho = q.status === 'DRAFT';
            const numero = getQuoteNumberBadge(q);
            const nome = (q.title || '').trim() || LAB_ORCAMENTO.semNome;
            const qtdServicos = q._count?.items ?? 0;
            const criadoEm = formatarData(q.created_at);
            const validade = formatarData(q.valid_until);
            const detalheDeste = estaAberto && detalhe?.id === q.id ? detalhe : null;
            const montarAqui = rascunho && podeMontar;
            return (
              <div key={q.id} className="bg-card border border-border rounded-xl overflow-hidden">
                <button
                  type="button"
                  onClick={() => alternar(q.id)}
                  className="w-full px-4 py-3 flex items-start gap-3 text-left hover:bg-accent/30 transition-colors"
                  aria-expanded={estaAberto}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {numero && (
                        <span className="font-mono text-xs font-bold px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                          {numero}
                        </span>
                      )}
                      <span className="text-sm font-semibold text-foreground truncate">{nome}</span>
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${
                          rascunho
                            ? 'text-amber-700 bg-amber-500/10 border-amber-500/30'
                            : 'text-blue-700 bg-blue-500/10 border-blue-500/30'
                        }`}
                      >
                        {rotuloDoStatus(q.status)}
                      </span>
                      {casos[q.id]?.due_date && <LabSeloDoCaso caso={casos[q.id]} />}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 flex items-center gap-x-3 gap-y-0.5 flex-wrap">
                      <span className="inline-flex items-center gap-1">
                        <Layers size={11} />
                        {LAB_ORCAMENTO.servicos(qtdServicos)}
                      </span>
                      {criadoEm && <span>{LAB_ORCAMENTO.criadoEm(criadoEm)}</span>}
                      {q.created_by?.name && <span>{LAB_ORCAMENTO.criadoPor(q.created_by.name)}</span>}
                      {validade && <span>{LAB_ORCAMENTO.validoAte(validade)}</span>}
                    </div>
                  </div>
                  {verValores && q.total_value !== null && q.total_value !== undefined && (
                    <div className="text-right shrink-0">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{LAB_ORCAMENTO.total}</div>
                      <div className="text-sm font-bold text-foreground">{formatarValor(q.total_value)}</div>
                    </div>
                  )}
                  <span className="shrink-0 text-muted-foreground mt-0.5" title={estaAberto ? LAB_ORCAMENTO.recolher : LAB_ORCAMENTO.abrir}>
                    {estaAberto ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </span>
                </button>

                {estaAberto && (
                  <div className="border-t border-border">
                    <div className="px-4 py-2.5 flex items-center gap-2 flex-wrap bg-background/40">
                      {montarAqui && (
                        <button
                          type="button"
                          onClick={() => abrirSeletor(q.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90"
                        >
                          <Pencil size={12} /> {LAB_ORCAMENTO.editar}
                        </button>
                      )}
                      {podeNegociar && montarAqui && (
                        <button
                          type="button"
                          onClick={() => abrirModelos(q.id)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-accent"
                        >
                          <Layers size={12} /> {LAB_ORCAMENTO.usarModelo}
                        </button>
                      )}
                      {podeNegociar && (
                        <button
                          type="button"
                          onClick={() => verPdf(q.id)}
                          disabled={gerandoPdf === q.id}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-accent disabled:opacity-60"
                        >
                          {gerandoPdf === q.id ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
                          {gerandoPdf === q.id ? LAB_ORCAMENTO.gerandoPdf : LAB_ORCAMENTO.verPdf}
                        </button>
                      )}
                      {podeNegociar && q.status === 'SENT' && (
                        <button
                          type="button"
                          onClick={() => revisar(q)}
                          disabled={!!revisando}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60"
                        >
                          {revisando === q.id ? <Loader2 size={12} className="animate-spin" /> : <Pencil size={12} />}
                          {LAB_ORCAMENTO.revisar}
                        </button>
                      )}
                      {podeNegociar && (
                        <button
                          type="button"
                          onClick={() => novaOpcao(q)}
                          disabled={!!revisando}
                          title={LAB_ORCAMENTO.novaOpcaoDica}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-xs font-medium hover:bg-accent disabled:opacity-60"
                        >
                          <Plus size={12} /> {LAB_ORCAMENTO.novaOpcao}
                        </button>
                      )}
                      {montarAqui && (
                        <button
                          type="button"
                          onClick={() => apagarRascunho(q)}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-red-600 hover:bg-red-500/10"
                        >
                          <Trash2 size={12} /> {LAB_ORCAMENTO.apagar}
                        </button>
                      )}
                      {onGoToProposals && (
                        <button
                          type="button"
                          onClick={onGoToProposals}
                          className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
                        >
                          <Send size={12} /> {LAB_ORCAMENTO.irPropostas}
                        </button>
                      )}
                    </div>

                    {!detalheDeste ? (
                      <div className="p-6 flex items-center justify-center text-xs text-muted-foreground">
                        {carregandoDetalhe ? <Loader2 size={14} className="animate-spin mr-2" /> : null}
                        {LAB_ORCAMENTO.carregandoServicos}
                      </div>
                    ) : montarAqui ? (
                      <QuotePanel
                        compact
                        patientId={patientId}
                        quote={detalheDeste}
                        procedures={servicos}
                        selectedTeeth={SEM_DENTES_SELECIONADOS}
                        onClearSelection={NADA}
                        onQuoteChange={recarregar}
                      />
                    ) : (
                      <TabelaSoLeitura itens={detalheDeste.items} verValores={verValores} enviado={!rascunho} />
                    )}

                    {/* F8 — ficha do caso (rascunho e enviado; quem monta edita) */}
                    <LabFichaDoCasoDoOrcamento
                      quoteId={q.id}
                      clienteId={patientId}
                      servicoIds={detalheDeste?.items.map((i) => i.procedure_id) ?? []}
                      podeEditar={podeMontar}
                      aoSalvar={recarregarCasos}
                    />

                    {podeNegociar && (
                      <div className="px-4 pt-3">
                        <QuoteAttachments quoteId={q.id} quoteStatus={q.status} />
                        <QuoteVersions quoteId={q.id} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {modalId && (
        <AddQuoteItemModal
          quoteId={modalId}
          procedures={servicos}
          onClose={aoFecharSeletor}
          onAdded={aoAdicionar}
        />
      )}

      {modelosPara && (
        <div
          className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setModelosPara(null)}
        >
          <div
            className="bg-card border border-border rounded-2xl w-full max-w-lg shadow-2xl max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold flex items-center gap-2">
                <Layers size={16} className="text-primary" />
                {LAB_ORCAMENTO.modelos.titulo}
              </h3>
              <button
                type="button"
                onClick={() => setModelosPara(null)}
                className="p-1.5 hover:bg-accent rounded-full"
                aria-label={LAB_ORCAMENTO.modelos.fechar}
              >
                <X size={16} />
              </button>
            </div>
            <p className="px-5 pt-3 text-xs text-muted-foreground">{LAB_ORCAMENTO.modelos.dica}</p>
            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-2">
              {carregandoModelos ? (
                <div className="py-6 flex items-center justify-center text-xs text-muted-foreground">
                  <Loader2 size={14} className="animate-spin mr-2" />
                  {LAB_ORCAMENTO.modelos.carregando}
                </div>
              ) : modelos.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">{LAB_ORCAMENTO.modelos.vazio}</p>
              ) : (
                modelos.map((m) => (
                  <div key={m.id} className="border border-border rounded-xl p-3 flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-foreground truncate">{m.name}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap mt-0.5">
                        {m.specialty && (
                          <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary">{m.specialty}</span>
                        )}
                        <span>{LAB_ORCAMENTO.modelos.servicos(m._count?.items ?? 0)}</span>
                      </div>
                      {m.description && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{m.description}</p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => aplicarModelo(m)}
                      disabled={!!aplicandoModelo}
                      className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 disabled:opacity-60"
                    >
                      {aplicandoModelo === m.id ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                      {LAB_ORCAMENTO.modelos.aplicar}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Tabela só de leitura (orçamento enviado, ou quem não monta). */
function TabelaSoLeitura({
  itens,
  verValores,
  enviado,
}: {
  itens: ItemDoOrcamento[];
  verValores: boolean;
  enviado: boolean;
}) {
  return (
    <div>
      {enviado && (
        <p className="px-4 pt-3 text-xs text-muted-foreground">{LAB_ORCAMENTO.somenteLeitura}</p>
      )}
      {itens.length === 0 ? (
        <p className="p-6 text-center text-xs text-muted-foreground">{LAB_ORCAMENTO.semServicos}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-background/50 text-xs text-muted-foreground">
                <th className="text-left px-4 py-2 font-medium w-24">{LAB_ORCAMENTO.tabela.elemento}</th>
                <th className="text-left px-3 py-2 font-medium">{LAB_ORCAMENTO.tabela.servico}</th>
                <th className="text-center px-2 py-2 font-medium w-16">{LAB_ORCAMENTO.tabela.qtd}</th>
                {verValores && (
                  <th className="text-right px-4 py-2 font-medium w-32">{LAB_ORCAMENTO.tabela.valor}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {itens.map((it) => (
                <tr key={it.id} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-2">
                    {it.tooth_fdi ? (
                      <span className="inline-flex items-center justify-center min-w-8 h-7 px-1.5 rounded-md font-mono font-bold text-xs border border-primary/40 bg-primary/10 text-primary">
                        {it.tooth_fdi}
                      </span>
                    ) : (
                      <span className="text-xs italic text-muted-foreground">{LAB_ORCAMENTO.tabela.porArcada}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-foreground">{it.procedure?.name || LAB_ORCAMENTO.tabela.semNomeDoServico}</div>
                    {it.notes && <div className="text-[10px] text-muted-foreground truncate max-w-md">{it.notes}</div>}
                  </td>
                  <td className="px-2 py-2 text-center">{it.quantity}</td>
                  {verValores && (
                    <td className="px-4 py-2 text-right font-semibold">{formatarValor(it.total_price)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
