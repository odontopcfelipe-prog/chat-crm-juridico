'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Loader2, Activity, X, Trash2, Save, Printer, ChevronDown, ChevronUp, DollarSign, Plus, Copy, Pencil } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { colorForSpecialty } from '@/lib/specialty-colors';
// Onda 14.18 — identificador unificado entre as 4 abas
import { getQuoteDisplayName, getQuoteNumberBadge } from '@/lib/quote-display';
import QuotePanel from './QuotePanel';
import AddQuoteItemModal from './AddQuoteItemModal';

interface Props {
  patientId: string;
  /** Onda 25.5 — nome do paciente exibido no cabecalho de impressao */
  patientName?: string;
  /**
   * Onda 3.33 — Quando definido, click num card de orcamento (ou em
   * "Iniciar nova avaliacao") chama esta callback em vez de expandir
   * inline. O parent (PacienteFichaInner) navega pra aba Orcamentos
   * em modo detalhe — mais espaco, fluxo nao quebra com listas longas.
   *
   * Onda 3.34 — `options.autoOpenAddItem` sinaliza pro destino abrir
   * o modal de procedimentos direto (usado quando criou um quote DRAFT
   * vazio e ja quer comecar a montar).
   */
  onOpenQuoteDetail?: (quoteId: string, options?: { autoOpenAddItem?: boolean }) => void;
}

// Onda 3.1 — type local do procedimento (espelha o que vem da /procedures)
interface Procedure {
  id: string;
  name: string;
  base_price: string | number;
  code_tuss: string | null;
  duration_minutes?: number;
  specialty?: { id: string; name: string } | null;
  specialty_id?: string | null;
}

// Onda 3.2 — Quote draft inline embaixo do odontograma. Substitui o modal
// full-screen — mantem o odontograma visivel enquanto monta o orcamento.
interface QuoteItemLite {
  id: string;
  procedure_id: string;
  tooth_fdi: string | null;
  quantity: number;
  unit_price: string | number;
  total_price: string | number;
  notes?: string | null;
  // Onda 3.3 — incluido specialty pra renderizar bolinha colorida no dente
  procedure?: {
    id: string;
    name: string;
    code_tuss?: string | null;
    specialty_id?: string | null;
    specialty?: { id: string; name: string } | null;
  };
}

interface QuoteDraft {
  id: string;
  status: string;
  subtotal: string | number;
  discount_percent: string | number;
  discount_value: string | number;
  total_value: string | number;
  items: QuoteItemLite[];
}

// Onda 3.7 — lista de orcamentos do paciente, abaixo do plano de tratamento
type ClosingCategory =
  | 'LENTES_PORCELANA'
  | 'FACETAS_RESINA'
  | 'IMPLANTE'
  | 'ORTODONTIA'
  | 'HARMONIZACAO_FACIAL'
  | 'OUTROS';

interface QuoteListItem {
  id: string;
  status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
  // Onda 3.9 — nome customizavel pelo operador (ex: "Reabilitacao superior")
  title: string | null;
  /// Onda 14.18 — numero sequencial global por tenant. Usado pra identificar
  /// o orcamento de forma consistente entre as 4 abas. Auto-incrementado
  /// no backend. Legados podem vir como 0 ate a migration rodar.
  quote_number?: number;
  total_value: string | number;
  created_at: string;
  valid_until: string | null;
  closing_category: ClosingCategory;
  /// Onda 6.4 — prioridade clinica definida pelo dentista
  priority?: 'COMPLETO' | 'ESSENCIAL' | 'URGENTE' | null;
  _count?: { items: number };
  created_by?: { id: string; name: string };
  // Onda 7.2 — contadores de aprovacao parcial (vem do backend)
  approved_count?: number;
  pending_count?: number;
}

const CLOSING_CATEGORY_LABEL: Record<ClosingCategory, string> = {
  LENTES_PORCELANA: 'LENTES PORCELANAS',
  FACETAS_RESINA: 'FACETAS RESINAS',
  IMPLANTE: 'IMPLANTE',
  ORTODONTIA: 'ORTODONTIA',
  HARMONIZACAO_FACIAL: 'HARMONIZAÇÃO FACIAL',
  OUTROS: 'OUTROS',
};

const STATUS_LABEL: Record<QuoteListItem['status'], string> = {
  DRAFT: 'rascunho',
  SENT: 'enviado',
  ACCEPTED: 'aceito',
  REJECTED: 'rejeitado',
  EXPIRED: 'expirado',
};

const STATUS_CLS: Record<QuoteListItem['status'], string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  SENT: 'bg-blue-500/10 text-blue-700',
  ACCEPTED: 'bg-emerald-500/10 text-emerald-700',
  REJECTED: 'bg-destructive/10 text-destructive',
  EXPIRED: 'bg-amber-500/10 text-amber-700',
};

interface ToothRecord {
  id: string;
  tooth_fdi: string;
  face: string | null;
  state: string;
  material: string | null;
  notes: string | null;
}

interface Odontogram {
  id: string;
  meta: { dentition_stage?: string; notes?: string };
  teeth: ToothRecord[];
}

// FDI: 4 quadrantes permanentes (adultos) + 4 decíduos (crianças)
const FDI_PERMANENT = {
  superior_direito: ['18', '17', '16', '15', '14', '13', '12', '11'],
  superior_esquerdo: ['21', '22', '23', '24', '25', '26', '27', '28'],
  inferior_esquerdo: ['31', '32', '33', '34', '35', '36', '37', '38'],
  inferior_direito: ['48', '47', '46', '45', '44', '43', '42', '41'],
};

const FDI_DECIDUOUS = {
  superior_direito_dec: ['55', '54', '53', '52', '51'],
  superior_esquerdo_dec: ['61', '62', '63', '64', '65'],
  inferior_esquerdo_dec: ['71', '72', '73', '74', '75'],
  inferior_direito_dec: ['85', '84', '83', '82', '81'],
};

const STATES = [
  { v: 'CARIE', label: 'Cárie', cls: 'bg-red-500/20 text-red-700 border-red-500' },
  { v: 'RESTAURADO', label: 'Restaurado', cls: 'bg-blue-500/20 text-blue-700 border-blue-500' },
  { v: 'AUSENTE', label: 'Ausente', cls: 'bg-muted text-muted-foreground border-border' },
  { v: 'PROTESE', label: 'Prótese', cls: 'bg-purple-500/20 text-purple-700 border-purple-500' },
  { v: 'IMPLANTE', label: 'Implante', cls: 'bg-indigo-500/20 text-indigo-700 border-indigo-500' },
  { v: 'ENDODONTIA', label: 'Endodontia', cls: 'bg-amber-500/20 text-amber-700 border-amber-500' },
  { v: 'EXTRACAO_INDICADA', label: 'Extração indicada', cls: 'bg-orange-500/20 text-orange-700 border-orange-500' },
  { v: 'COROA', label: 'Coroa', cls: 'bg-teal-500/20 text-teal-700 border-teal-500' },
  { v: 'FRATURA', label: 'Fratura', cls: 'bg-pink-500/20 text-pink-700 border-pink-500' },
  { v: 'OUTROS', label: 'Outros', cls: 'bg-gray-500/20 text-gray-700 border-gray-500' },
] as const;

const FACES = ['M', 'D', 'O', 'V', 'L', 'INCISAL'] as const;

const STATE_CLS: Record<string, string> = Object.fromEntries(STATES.map((s) => [s.v, s.cls]));

export default function OdontogramaTab({ patientId, patientName, onOpenQuoteDetail }: Props) {
  const [odonto, setOdonto] = useState<Odontogram | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTooth, setSelectedTooth] = useState<string | null>(null);
  const [editingRecord, setEditingRecord] = useState<ToothRecord | null>(null);
  const [showDeciduous, setShowDeciduous] = useState(false);

  // Onda 3.1 — multi-selecao de dentes pra adicionar ao orcamento.
  // Ctrl/Cmd+click ou Shift+click adiciona/remove dente da selecao,
  // sem abrir o ToothEditor (comportamento de click normal).
  const [selectedTeethForQuote, setSelectedTeethForQuote] = useState<Set<string>>(new Set());
  const [procedures, setProcedures] = useState<Procedure[]>([]);

  // Onda 3.9 — Modelo "cada orcamento eh um plano clinico autocontido":
  // - quotesList: lista TODOS os orcamentos do paciente (cards na UI)
  // - expandedQuoteId: id do orcamento atualmente expandido (so 1 por vez)
  // - expandedQuote: quote completo (com items) do expandido — usado pra
  //   renderizar o QuotePanel inline dentro do card
  // O conceito de "draft idempotente unico" foi removido — agora o operador
  // cria/expande/edita orcamentos como entidades independentes.
  const [quotesList, setQuotesList] = useState<QuoteListItem[]>([]);
  const [expandedQuoteId, setExpandedQuoteId] = useState<string | null>(null);
  const [expandedQuote, setExpandedQuote] = useState<QuoteDraft | null>(null);
  const [loadingQuote, setLoadingQuote] = useState(true);
  // Onda 14.55 — flag de "criação em voo" pra evitar double-submit do botão
  // "Adicionar procedimento". useRef em vez de só useState porque estado React
  // só atualiza no próximo render — ref é síncrono e bloqueia 2 clicks no mesmo
  // tick. State paralelo serve só pra UI mostrar o spinner.
  //
  // Bug original: 2 clicks rápidos criavam 2 quotes. O primeiro ficava órfão
  // porque justCreatedQuoteId era sobrescrito pelo segundo, então o cleanup de
  // DRAFT vazio falhava e o quote sem itens ficava poluindo a aba.
  const creatingQuoteRef = useRef(false);
  const [creatingQuote, setCreatingQuote] = useState(false);
  // Onda 6 — quando o modal abre via "Adicionar procedimento" (cria DRAFT
  // vazio no banco antes), guardamos o id aqui. Se o operador fechar sem
  // adicionar nenhum item, o DRAFT vazio eh DELETED pra nao poluir a lista.
  // Quando abre via click em quote ja existente, esse state fica null e
  // nada eh deletado no close.
  const [justCreatedQuoteId, setJustCreatedQuoteId] = useState<string | null>(null);
  const [wasAddedInModal, setWasAddedInModal] = useState(false);
  // Onda 14.3 — useRef pra "wasAddedInModal" (sempre atual, sem closure stale).
  // Bug fix: o submit do modal chamava onClose() apos onAdded(), mas a closure
  // do onClose lia wasAddedInModal=false (do render anterior), deletando o quote
  // recem-criado erroneamente quando user clicava "Adicionar ao orcamento".
  const wasAddedInModalRef = useRef(false);
  // Onda 3.36 — quote id pro qual o modal AddQuoteItemModal deve abrir.
  // Quando "Iniciar nova avaliação" eh clicado, cria-se o DRAFT e seta isso —
  // modal abre POR CIMA da aba Avaliação (sem navegar pra Orcamentos).
  const [addingItemForQuoteId, setAddingItemForQuoteId] = useState<string | null>(null);

  // Onda 3.2 — captura ultima anotacao NOVA (nao edicao) pra acionar sugestao
  // automatica no QuotePanel. Inclui ts pra garantir disparo mesmo se mesma
  // dupla (fdi, state) for anotada de novo.
  const [lastAnnotation, setLastAnnotation] = useState<{
    tooth_fdi: string;
    state: string;
    ts: number;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<Odontogram>(`/patients/${patientId}/odontogram`);
      setOdonto(data);
      setShowDeciduous(data.meta?.dentition_stage === 'mixed' || data.meta?.dentition_stage === 'deciduous');
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar odontograma');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  // Onda 3.9 — Carrega quote completo (com items) quando o usuario expande um card
  const loadExpandedQuote = useCallback(async (id: string) => {
    try {
      const { data } = await api.get<QuoteDraft>(`/quotes/${id}`);
      setExpandedQuote(data);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao carregar orcamento');
    }
  }, []);

  // Lista de orcamentos do paciente (com closing_category derivado)
  const loadQuotesList = useCallback(async () => {
    try {
      const { data } = await api.get<QuoteListItem[]>(`/patients/${patientId}/quotes`);
      setQuotesList(data || []);
    } catch {
      // silencia — lista vazia eh estado valido
    }
  }, [patientId]);

  // Refetch unificado: usado pelo QuotePanel apos cada mutacao em items.
  // Recarrega lista (pra contadores) E o expandido (pra refresh items).
  const refreshQuotes = useCallback(async () => {
    await Promise.all([
      loadQuotesList(),
      expandedQuoteId ? loadExpandedQuote(expandedQuoteId) : Promise.resolve(),
    ]);
  }, [loadQuotesList, expandedQuoteId, loadExpandedQuote]);

  // Onda 3.39 — Click num card abre o modal AddQuoteItemModal NA propria
  // aba Avaliação (sem navegar pra Orcamentos). Dentista nunca ve valores
  // ou negociacao — visao clinica pura. Aba Orcamentos eh exclusiva pro
  // financeiro/admin que faz negociacao com paciente (descontos, envio,
  // aprovacao, cobranca).
  const openQuoteDetail = useCallback((id: string) => {
    setAddingItemForQuoteId(id);
  }, []);

  // Cria orcamento DRAFT vazio + abre o modal AddQuoteItemModal direto na
  // propria aba Avaliação (NAO navega pra aba Orcamentos). Onda 3.36 —
  // operador fluxo: click "Iniciar nova avaliação" → DRAFT criado → modal
  // de procedimentos por cima da Avaliação. Click "Adicionar" no modal →
  // items salvos → modal fecha → lista da Avaliação atualizada. Operador
  // permanece no contexto clinico/operacional sem trocar de aba.
  const createNewQuote = useCallback(async () => {
    // Onda 14.55 — guarda síncrono contra double-click. Se já está criando,
    // ignora o click extra. Ref é checada/setada no MESMO tick, antes de
    // qualquer await — bloqueio efetivo mesmo em rajada de cliques.
    if (creatingQuoteRef.current) return;
    creatingQuoteRef.current = true;
    setCreatingQuote(true);
    try {
      const { data } = await api.post<{ id: string }>(`/patients/${patientId}/quotes`);
      await loadQuotesList();
      // Onda 6 — marca este quote como "criado-agora-pra-modal". Se o operador
      // fechar o modal SEM adicionar nada, deletamos o DRAFT vazio (cleanup).
      setJustCreatedQuoteId(data.id);
      setWasAddedInModal(false);
      setAddingItemForQuoteId(data.id);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao criar orcamento');
    } finally {
      creatingQuoteRef.current = false;
      setCreatingQuote(false);
    }
  }, [patientId, loadQuotesList]);

  // Atualiza titulo do orcamento (edicao inline no card).
  // Onda 14.18 (fix): optimistic update — atualiza a lista local IMEDIATAMENTE
  // pra evitar a sensacao de "cancelou" enquanto o PATCH/refetch acontece.
  // Toast de sucesso confirma visualmente. Em caso de erro, reverte via refetch.
  const updateQuoteTitle = useCallback(async (id: string, title: string) => {
    // Optimistic — atualiza estado local na hora
    setQuotesList((prev) => prev.map((q) => q.id === id ? { ...q, title: title || null } : q));
    try {
      await api.patch(`/quotes/${id}`, { title: title || null });
      showSuccess('Orcamento renomeado');
      // Refetch em background pra garantir consistencia (categoria, contadores, etc)
      loadQuotesList();
      if (expandedQuoteId === id) loadExpandedQuote(id);
    } catch (err: unknown) {
      // Reverte via refetch
      await loadQuotesList();
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao renomear');
    }
  }, [loadQuotesList, expandedQuoteId, loadExpandedQuote]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setLoadingQuote(true);
    Promise.all([
      loadQuotesList(),
      api.get<Procedure[]>('/procedures').then((r) => setProcedures(r.data || [])).catch(() => {}),
    ]).finally(() => setLoadingQuote(false));
  }, [loadQuotesList]);

  // Onda 3.9 — acceptQuote removido daqui. Aprovacao agora acontece SO na
  // aba Orcamentos (visao comercial) — operador escolhe items, aplica
  // desconto, envia ao paciente, aceita parcial ou completo.

  // Apaga DRAFT (soft-delete via service). Bloqueia em outros status —
  // apenas DRAFT eh "descartavel"; SENT/ACCEPTED ficam no historico.
  const deleteDraft = useCallback(async (id: string) => {
    if (!confirm('Apagar este rascunho?')) return;
    try {
      await api.delete(`/quotes/${id}`);
      showSuccess('Rascunho apagado');
      await refreshQuotes();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao apagar');
    }
  }, [refreshQuotes]);

  // Onda 3.41 — Duplica orçamento: cria um novo DRAFT identico (mesmos
  // procedimentos, mesmos dentes). Util quando paciente quer outra
  // versao similar (ex: outra opcao com mais procedimentos, ou repetir
  // um tratamento que ja foi feito antes). Backend: POST duplicate-as-option.
  // Onda 3.42 — Apos duplicar, faz PATCH no titulo pra adicionar "cópia N"
  // (auto-incrementa se ja terminar em "cópia N"). Sem nome no original
  // vira "cópia 1".
  const duplicateQuote = useCallback(async (id: string) => {
    if (!confirm('Duplicar este orçamento? Vai criar um novo rascunho com os mesmos procedimentos.')) return;
    try {
      const { data } = await api.post<{ id: string }>(`/quotes/${id}/duplicate-as-option`);
      // Atualiza o titulo do novo quote com " cópia N"
      const original = quotesList.find((q) => q.id === id);
      const baseTitle = (original?.title || '').trim();
      // Detecta " cópia N" no final pra incrementar
      const copiaMatch = baseTitle.match(/^(.*) cópia (\d+)$/);
      let newTitle: string;
      if (copiaMatch) {
        const root = copiaMatch[1];
        const n = parseInt(copiaMatch[2], 10) + 1;
        newTitle = `${root} cópia ${n}`;
      } else if (baseTitle) {
        newTitle = `${baseTitle} cópia 1`;
      } else {
        newTitle = 'Orçamento cópia 1';
      }
      if (data?.id) {
        await api.patch(`/quotes/${data.id}`, { title: newTitle });
      }
      showSuccess(`Orçamento duplicado: "${newTitle}"`);
      await refreshQuotes();
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao duplicar');
    }
  }, [refreshQuotes, quotesList]);

  // Onda 3.9 — Mapa fdi → items do orcamento EXPANDIDO. Reflete o que esta
  // sendo editado naquele momento. Quando nada expandido, FDI grid fica limpo.
  const itemsByFdi = useMemo(() => {
    const m = new Map<string, QuoteItemLite[]>();
    for (const item of expandedQuote?.items || []) {
      if (!item.tooth_fdi) continue;
      const arr = m.get(item.tooth_fdi) || [];
      arr.push(item);
      m.set(item.tooth_fdi, arr);
    }
    return m;
  }, [expandedQuote?.items]);

  // Array estavel de dentes selecionados — Set#values() retorna nova
  // referencia a cada render, e Array.from(set) tambem. Memoizar baseado
  // no conteudo evita reconciliacao desnecessaria no QuotePanel filho.
  const selectedTeethArray = useMemo(
    () => Array.from(selectedTeethForQuote).sort(),
    [selectedTeethForQuote],
  );

  const toothRecords = (fdi: string) =>
    odonto?.teeth.filter((t) => t.tooth_fdi === fdi) || [];

  const onToothClick = (fdi: string, e?: React.MouseEvent) => {
    // Onda 3.1 — Ctrl/Cmd/Shift+click: toggle selecao pra orcamento
    // (NAO abre o ToothEditor). Click normal mantem comportamento atual.
    if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) {
      setSelectedTeethForQuote((prev) => {
        const next = new Set(prev);
        if (next.has(fdi)) next.delete(fdi);
        else next.add(fdi);
        return next;
      });
      return;
    }
    setSelectedTooth(fdi);
    setEditingRecord(null);
  };

  // Onda 3.1 — handlers da multi-selecao
  const clearTeethSelection = useCallback(() => setSelectedTeethForQuote(new Set()), []);
  const consumeLastAnnotation = useCallback(() => setLastAnnotation(null), []);

  const onEditRecord = (rec: ToothRecord) => {
    setSelectedTooth(rec.tooth_fdi);
    setEditingRecord(rec);
  };

  const closeEditor = () => {
    setSelectedTooth(null);
    setEditingRecord(null);
  };

  const updateDentitionStage = async (stage: string) => {
    try {
      await api.patch(`/patients/${patientId}/odontogram`, {
        meta: { ...(odonto?.meta || {}), dentition_stage: stage },
      });
      await load();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao atualizar');
    }
  };

  const onRecordSaved = async (savedState?: string) => {
    const wasNew = !editingRecord; // editingRecord populated => edicao, null => novo
    const fdi = selectedTooth;
    closeEditor();
    await load();
    if (wasNew && fdi && savedState) {
      setLastAnnotation({ tooth_fdi: fdi, state: savedState, ts: Date.now() });
    }
  };

  if (loading) {
    return (
      <div className="py-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={18} className="animate-spin mr-2" /> Carregando odontograma...
      </div>
    );
  }

  // Onda 25.5 — handler de impressao via window.print + CSS classico
  // (visibility:hidden tudo, visible so o .odontogram-print)
  const handlePrint = () => {
    document.body.classList.add('printing-odontogram');
    window.print();
    setTimeout(() => document.body.classList.remove('printing-odontogram'), 200);
  };

  return (
    <div>
      {/* Onda 3.30 — Aba Odontograma simplificada: chart + states legend +
          impressao removidos. Aba virou hub de orcamento — click em
          "Iniciar orcamento" abre modal com mini-odontograma proprio.
          Anotacao clinica vive na aba Prontuario. */}

      {/* Onda 3.9 — Bloco unico: empty state quando nenhum orcamento OU
          lista de cards expansiveis. Cada card eh um orcamento autocontido
          com nome editavel e procedimentos sem valores (visao clinica).
          Mesmas entidades aparecem na aba Orcamentos com valores e UI de
          negociacao comercial completa. */}
      <div className="print-hide">
        {loadingQuote ? (
          <div className="bg-card border border-border rounded-xl p-8 flex items-center justify-center text-muted-foreground">
            <Loader2 size={16} className="animate-spin mr-2" />
            Carregando orcamentos...
          </div>
        ) : quotesList.length === 0 ? (
          // Empty state: nenhum orcamento ainda
          <div className="bg-card border border-border rounded-xl p-10 text-center">
            <DollarSign size={28} className="mx-auto text-muted-foreground/50 mb-3" />
            <p className="text-sm font-medium text-foreground mb-1">
              Comece adicionando procedimentos
            </p>
            <p className="text-xs text-muted-foreground mb-5 max-w-md mx-auto">
              Clique em um dente para anotar · Ctrl+clique em varios para orcar em lote · Ou use o botao abaixo
            </p>
            <button
              onClick={createNewQuote}
              disabled={creatingQuote}
              className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-600/70 disabled:cursor-not-allowed text-white text-sm font-semibold shadow-sm transition"
            >
              {creatingQuote ? (
                <><Loader2 size={16} className="animate-spin" /> Criando...</>
              ) : (
                <><Plus size={16} /> Adicionar procedimento</>
              )}
            </button>
          </div>
        ) : (
          // Lista de cards expansiveis
          <div className="space-y-2">
            {/* Onda 3.32 — CTA principal NO TOPO em verde solido grande pra
                dar destaque maximo (era um botao pequeno tracejado embaixo). */}
            <button
              onClick={createNewQuote}
              disabled={creatingQuote}
              className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-600/70 disabled:cursor-not-allowed rounded-xl py-3.5 text-base font-bold text-white shadow-sm transition-colors inline-flex items-center justify-center gap-2"
            >
              {creatingQuote ? (
                <><Loader2 size={18} className="animate-spin" /> Criando orçamento...</>
              ) : (
                <><Plus size={18} /> Adicionar procedimento</>
              )}
            </button>
            {/* Onda 7.6 — Ordem crescente (#1, #2, #3...) — orcamento mais
                antigo no topo. API retorna desc por created_at, fazemos
                reverse aqui pra exibir asc. Numero (#N) eh a posicao no
                array reverso (1-based). */}
            {[...quotesList].reverse().map((q, idx) => (
              <QuoteCard
                key={q.id}
                quote={q}
                index={idx + 1}
                expanded={expandedQuoteId === q.id}
                expandedQuote={expandedQuoteId === q.id ? expandedQuote : null}
                onToggleExpand={() => openQuoteDetail(q.id)}
                onRename={(newTitle) => updateQuoteTitle(q.id, newTitle)}
                // Onda 7.8 — Orcamentos com items APROVADOS nao podem ser
                // excluidos (operador nao pode apagar registro de procedimento
                // que paciente ja fechou). So DRAFT sem nenhuma aprovacao.
                onDelete={
                  q.status === 'DRAFT' && (q.approved_count ?? 0) === 0
                    ? () => deleteDraft(q.id)
                    : undefined
                }
                onDuplicate={() => duplicateQuote(q.id)}
                patientId={patientId}
                procedures={procedures}
                selectedTeeth={expandedQuoteId === q.id ? selectedTeethArray : []}
                onClearSelection={clearTeethSelection}
                onQuoteChange={refreshQuotes}
                lastAnnotation={expandedQuoteId === q.id ? lastAnnotation : null}
                onAnnotationConsumed={consumeLastAnnotation}
              />
            ))}
          </div>
        )}
      </div>

      {/* Onda 3.36 — Modal AddQuoteItemModal renderizado AQUI (na propria
          aba Avaliação) quando "Iniciar nova avaliação" eh clicado.
          Operador nao sai da Avaliação — modal abre por cima e ao salvar
          atualiza a lista de cards. */}
      {addingItemForQuoteId && (
        <AddQuoteItemModal
          quoteId={addingItemForQuoteId}
          procedures={procedures}
          onDuplicate={async () => {
            const id = addingItemForQuoteId;
            // Onda 3.42 — Fecha o modal antes de duplicar pra nao perder
            // estado. Operador pode editar o novo card depois se quiser.
            setAddingItemForQuoteId(null);
            setJustCreatedQuoteId(null);
            setWasAddedInModal(false);
            await duplicateQuote(id);
          }}
          onClose={async () => {
            // Onda 6 — Cleanup de DRAFT vazio: se este modal foi aberto via
            // "Adicionar procedimento" (criou DRAFT vazio antes), e o operador
            // fechou SEM adicionar nada, deleta o DRAFT pra nao poluir a aba.
            // Onda 14.3 — usa wasAddedInModalRef.current (sempre atual) em vez
            // do state wasAddedInModal (closure desatualizada quando onClose e
            // chamado logo apos onAdded pelo submit do modal).
            const shouldCleanup =
              justCreatedQuoteId === addingItemForQuoteId
              && !wasAddedInModalRef.current;
            const idToCleanup = addingItemForQuoteId;
            setAddingItemForQuoteId(null);
            setJustCreatedQuoteId(null);
            setWasAddedInModal(false);
            wasAddedInModalRef.current = false;
            if (shouldCleanup) {
              try {
                await api.delete(`/quotes/${idToCleanup}`);
                await loadQuotesList();
              } catch {
                // silencia — quote pode ter sido deletado em outro lugar
              }
            }
          }}
          onAdded={async () => {
            // Onda 6 — Marca que houve adicao real → close NAO deleta o quote.
            // Onda 14.3 — seta tambem a ref (sempre atual) pra que o onClose
            // chamado logo depois pelo submit do modal leia o valor correto.
            wasAddedInModalRef.current = true;
            setWasAddedInModal(true);
            await refreshQuotes();
            setAddingItemForQuoteId(null);
            setJustCreatedQuoteId(null);
            setWasAddedInModal(false);
            // NAO resetar wasAddedInModalRef.current aqui — o onClose pode ser
            // chamado em seguida pelo submit(false) do modal e precisa ver true.
            // Reset acontece no proximo open ou dentro do onClose.
          }}
        />
      )}
    </div>
  );
}

// ─── Card de orcamento expansivel (Onda 3.9) ──────────────────
// Click no header expande/contrai. Quando expandido, renderiza QuotePanel
// inline com a tabela de procedimentos (sem valores — visao clinica). Para
// negociacao comercial (valores, descontos, envio), operador clica no link
// "Abrir na aba Orcamentos" no rodape.

function QuoteCard({
  quote, index, expanded, expandedQuote, onToggleExpand, onRename, onDelete, onDuplicate,
  patientId, procedures, selectedTeeth, onClearSelection, onQuoteChange,
  lastAnnotation, onAnnotationConsumed,
}: {
  quote: QuoteListItem;
  index: number;
  expanded: boolean;
  expandedQuote: QuoteDraft | null;
  onToggleExpand: () => void;
  onRename: (newTitle: string) => void | Promise<void>;
  onDelete?: () => void;
  /** Onda 3.41 — duplica o orçamento (cria novo DRAFT com mesmos items) */
  onDuplicate?: () => void;
  patientId: string;
  procedures: Procedure[];
  selectedTeeth: string[];
  onClearSelection: () => void;
  onQuoteChange: () => void | Promise<void>;
  lastAnnotation: { tooth_fdi: string; state: string; ts: number } | null;
  onAnnotationConsumed: () => void;
}) {
  const itemsCount = quote._count?.items ?? 0;
  const createdDate = new Date(quote.created_at).toLocaleDateString('pt-BR');
  const categoryLabel = CLOSING_CATEGORY_LABEL[quote.closing_category] || 'OUTROS';
  // Onda 14.18 — identificador unificado: #001 (quote_number) e nome (title
  // ou fallback "Orcamento"). Usado igual nas 4 abas.
  const quoteNumberBadge = getQuoteNumberBadge(quote);
  const quoteDisplayName = getQuoteDisplayName(quote);

  // Edicao inline do titulo: state local enquanto edita, commit no blur/Enter
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const startEditTitle = (e: React.MouseEvent) => {
    e.stopPropagation(); // nao expandir/colapsar ao clicar no titulo
    setTitleDraft(quote.title || '');
  };
  const commitTitle = () => {
    if (titleDraft === null) return;
    const trimmed = titleDraft.trim();
    if (trimmed !== (quote.title || '')) onRename(trimmed);
    setTitleDraft(null);
  };

  // Onda 7.8 — Qualquer aprovacao (mesmo parcial) deixa o card verde.
  // Antes amber = parcial, agora unificado em verde pra simplificar.
  // REJEITADO continua vermelho suave. DRAFT/SENT/EXPIRED sem nenhuma
  // aprovacao = neutro.
  const isAccepted = quote.status === 'ACCEPTED';
  const isRejected = quote.status === 'REJECTED';
  const hasAnyApproved = (quote.approved_count ?? 0) > 0;
  const cardBg = (isAccepted || hasAnyApproved)
    ? 'bg-emerald-500/10 border-emerald-500/30 hover:border-emerald-500/50'
    : isRejected
    ? 'bg-destructive/5 border-destructive/20 hover:border-destructive/40'
    : 'bg-card border-border hover:border-primary/30';

  return (
    <div className={`border rounded-xl overflow-hidden transition-colors ${
      expanded ? 'border-primary/40 shadow-sm bg-card' : cardBg
    }`}>
      {/* HEADER — sempre visivel, click expande/colapsa.
          Onda 14.18 (fix): trocado <button> por <div role=button> pq input
          dentro de button faz o navegador interpretar Space/Enter como
          ativacao do button pai (bug "espaco apaga texto e expande card"
          ao renomear). Div nao tem esse comportamento default — agora
          controlamos teclado manualmente e bloqueamos toggle durante edicao. */}
      <div
        role="button"
        tabIndex={titleDraft === null ? 0 : -1}
        onClick={() => {
          // Filhos interativos (input/botoes) ja chamam stopPropagation,
          // entao aqui so checa se nao estamos no meio de uma edicao de titulo.
          if (titleDraft !== null) return;
          onToggleExpand();
        }}
        onKeyDown={(e) => {
          // Espaco NAO toggla aqui — fica reservado pro input filho digitar
          // espacos. So Enter expande/colapsa (e so quando nao esta editando).
          if (titleDraft !== null) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            onToggleExpand();
          }
        }}
        className="w-full px-4 py-3 flex items-center gap-3 flex-wrap text-left cursor-pointer hover:bg-accent/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {/* Onda 14.18 — numero global do orcamento (#001). Fallback pra
            #{index} (sequencial da lista renderizada) quando legado sem
            quote_number ainda nao migrado. */}
        <span
          className="text-xs text-primary font-mono font-semibold"
          title="Numero do orcamento (global da clinica)"
        >
          {quoteNumberBadge || `#${index}`}
        </span>
        {titleDraft !== null ? (
          <input
            autoFocus
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                // preventDefault pra evitar submit/scroll/outros side-effects
                e.preventDefault();
                commitTitle();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setTitleDraft(null);
              }
            }}
            placeholder="Nome do orcamento (ex: Reabilitacao superior)"
            // Onda 14.22 — largura fixa de 35ch igual ao span, pro layout
            // nao "saltar" quando entra/sai de edicao. Operador pode digitar
            // mais que 35 chars (input scrolla horizontalmente dentro).
            maxLength={120}
            className="text-sm font-bold tracking-wide px-2 py-0.5 rounded border border-primary bg-background w-[35ch] focus:outline-none"
          />
        ) : (
          <span
            onClick={startEditTitle}
            // Onda 14.22 — largura fixa de 35 chars + truncate. Garante que
            // os badges/info do lado direito ficam SEMPRE no mesmo lugar,
            // independente do tamanho do nome. Tooltip mostra completo. Nome
            // inteiro tambem fica visivel ao expandir o card.
            className="text-sm font-bold text-primary hover:underline tracking-wide cursor-text inline-block w-[35ch] truncate align-middle"
            title={quoteDisplayName.length > 35
              ? `${quoteDisplayName} — clique pra editar`
              : 'Clique pra editar nome'}
          >
            {quoteDisplayName}
          </span>
        )}
        {/* Onda 14.18 — botao Renomear explicito (alem do click no titulo).
            Foi pedido especificamente em Avaliacao e Orcamentos pra discoverability.
            Apenas dispara o mesmo fluxo de inline edit. */}
        {titleDraft === null && (
          <button
            type="button"
            onClick={startEditTitle}
            className="text-[10px] px-1.5 py-0.5 rounded border border-border hover:bg-accent inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            title="Renomear orcamento (propaga pra todas as abas)"
          >
            <Pencil size={10} /> Renomear
          </button>
        )}
        {/* Onda 14.44 — Slots com largura fixa pra cada badge condicional.
            Quando o badge nao aparece, o slot mantem o espaco reservado
            pra preservar alinhamento das colunas em todas as linhas.

            Onda 14.45 — Ocultar OUTROS (categoria padrao) e RASCUNHO
            (status DRAFT) — pedido do operador. Slots continuam reservados
            pra alinhar, mas badges so renderizam quando agregam info:
            - Categoria: so se NAO for OUTROS (mostra LENTES/IMPLANTE/etc)
            - Status: so se NAO for DRAFT (mostra ENVIADO/ACEITO/etc) */}

        {/* SLOT 1: Categoria (oculta OUTROS) */}
        <span className="w-[80px] shrink-0 flex items-center justify-start">
          {quote.title && quote.closing_category !== 'OUTROS' && (
            <span className="text-[10px] uppercase font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {categoryLabel}
            </span>
          )}
        </span>

        {/* SLOT 2: Status (oculta DRAFT/RASCUNHO) */}
        <span className="w-[88px] shrink-0 flex items-center justify-start">
          {quote.status !== 'DRAFT' && (
            <span className={`text-[10px] uppercase font-semibold px-2 py-0.5 rounded ${STATUS_CLS[quote.status]}`}>
              {STATUS_LABEL[quote.status]}
            </span>
          )}
        </span>

        {/* SLOT 3: Aprovacao parcial — Onda 7.8 */}
        <span className="w-[140px] shrink-0 flex items-center justify-start">
          {hasAnyApproved && (
            <span
              className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 inline-flex items-center gap-1"
              title="Procedimentos aprovados"
            >
              ✓ {quote.approved_count}/{quote._count?.items ?? 0} aprovados
            </span>
          )}
        </span>

        {/* SLOT 4: Priority — Onda 6.4 */}
        <span className="w-[120px] shrink-0 flex items-center justify-start">
          {(() => {
            const p = quote.priority || 'COMPLETO';
            const cfg = {
              URGENTE:   { label: '🔥 URGENTE',   cls: 'bg-red-500/15 text-red-700 border-red-500/30',         tip: 'Urgência clínica' },
              ESSENCIAL: { label: '⚠ ESSENCIAL', cls: 'bg-amber-500/15 text-amber-700 border-amber-500/30',   tip: 'Procedimento essencial' },
              COMPLETO:  { label: '✓ COMPLETO',  cls: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30', tip: 'Tratamento completo (sem urgência)' },
            }[p];
            return (
              <span
                className={`text-[10px] uppercase font-semibold px-2 py-0.5 rounded border ${cfg.cls}`}
                title={cfg.tip}
              >
                {cfg.label}
              </span>
            );
          })()}
        </span>

        {/* INFO: "X itens · Criado em ..." — width fixo pra alinhar */}
        <div className="flex flex-col text-xs text-muted-foreground min-w-[240px] shrink-0">
          <span>
            {itemsCount === 0 ? 'sem procedimentos' : `${itemsCount} ${itemsCount === 1 ? 'item' : 'itens'}`}
            {' · '}
            Criado em {createdDate}
          </span>
          {quote.created_by?.name && (
            <span>por {quote.created_by.name}</span>
          )}
        </div>
        {/* Onda 14.44 (extensao) — Actions com slots fixos pra alinhamento
            vertical consistente entre as linhas. onDuplicate aparece sempre,
            onDelete so pra DRAFT — slot vazio em outros status preserva o
            espaco. Chevron sempre presente.

            Slot Duplicar: 90px
            Slot Lixeira:  32px (so DRAFT)
            Slot Chevron:  20px (sempre) */}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {/* Onda 14.44.2 — Trocados <span> por <div> nos slots pra evitar
              edge cases de span com display:flex em alguns browsers. Forca
              min-width = width pra slot vazio nao colapsar mesmo se nada
              renderizar dentro (lixeira ausente em quotes ACCEPTED/etc). */}
          <div className="w-[90px] min-w-[90px] shrink-0 flex items-center justify-end">
            {onDuplicate && (
              <button
                onClick={(e) => { e.stopPropagation(); onDuplicate(); }}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 text-xs font-semibold"
                title="Duplicar orçamento (cria novo rascunho com os mesmos procedimentos)"
              >
                <Copy size={12} />
                Duplicar
              </button>
            )}
          </div>
          <div
            className="w-[32px] min-w-[32px] shrink-0 flex items-center justify-center"
            aria-hidden={!onDelete}
          >
            {onDelete ? (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
                className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                title="Apagar rascunho"
              >
                <Trash2 size={12} />
              </button>
            ) : (
              // Onda 14.44.2 — Placeholder invisivel pra forcar o slot a manter
              // largura quando onDelete ausente (cards ACCEPTED/SENT/etc).
              // Tailwind alguma vezes colapsa div vazio em flex container.
              <span className="inline-block w-px h-px opacity-0" aria-hidden="true" />
            )}
          </div>
          <div
            className="w-[20px] min-w-[20px] shrink-0 flex items-center justify-center text-muted-foreground"
            title={expanded ? 'Recolher' : 'Expandir pra editar procedimentos'}
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </div>
        </div>
      </div>

      {/* CONTEUDO EXPANSIVEL — Mini-odontograma + QuotePanel inline */}
      {expanded && (
        <div className="border-t border-border bg-background/30">
          {!expandedQuote ? (
            <div className="p-8 flex items-center justify-center text-muted-foreground text-sm">
              <Loader2 size={14} className="animate-spin mr-2" />
              Carregando procedimentos...
            </div>
          ) : (
            <>
              {/* Onda 14.22 — Nome completo do orcamento no topo do conteudo
                  expandido. No card colapsado o nome fica truncado (35ch fixo
                  pra nao desalinhar os badges), aqui aparece inteiro pro
                  operador conferir/copiar quando precisar. */}
              {quoteDisplayName.length > 35 && (
                <div className="px-4 pt-3 pb-1 text-sm font-bold text-primary break-words">
                  {quoteDisplayName}
                </div>
              )}
              {/* Onda 3.31 — Mini-odontograma de visualizacao do orcamento.
                  Mostra todos os dentes; os que ja estao no orcamento ficam
                  destacados com a cor da especialidade do procedimento.
                  Read-only — pra editar, usa "+ procedimentos" no QuotePanel. */}
              <QuoteMiniOdontograma items={expandedQuote.items} />
              <QuotePanel
                patientId={patientId}
                quote={expandedQuote}
                procedures={procedures}
                selectedTeeth={selectedTeeth}
                onClearSelection={onClearSelection}
                onQuoteChange={onQuoteChange}
                loading={false}
                lastAnnotation={lastAnnotation}
                onAnnotationConsumed={onAnnotationConsumed}
                compact
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Linha de dentes ──────────────────────────────────────────

function TeethRow({
  fdiList, toothRecords, onClick, isDeciduous, selectedSet, quotedItems,
}: {
  fdiList: string[];
  toothRecords: (fdi: string) => ToothRecord[];
  onClick: (fdi: string, e: React.MouseEvent) => void;
  isDeciduous?: boolean;
  /** Onda 3.1 — dentes selecionados pra orcamento (renderiza ring azul) */
  selectedSet?: Set<string>;
  /** Onda 3.3 — items do orcamento agrupados por dente, pra renderizar
   * bolinhas coloridas por especialidade no canto + tooltip rico. */
  quotedItems?: Map<string, QuoteItemLite[]>;
}) {
  return (
    <div className="flex gap-1">
      {fdiList.map((fdi) => {
        const records = toothRecords(fdi);
        const primaryState = records[0]?.state;
        const cls = primaryState ? STATE_CLS[primaryState] : 'bg-background border-border text-muted-foreground';
        const isSelected = selectedSet?.has(fdi);
        const items = quotedItems?.get(fdi) || [];
        const isQuoted = items.length > 0;
        // Onda 3.5 — Cor da especialidade do PRIMEIRO procedimento planejado.
        // Pinta o numero do dente. Se ha mais procedimentos com especialidades
        // diferentes, mostra bolinha "+N" embaixo (sem fragmentar o numero).
        const primaryItem = items[0];
        const primarySpecKey = primaryItem
          ? primaryItem.procedure?.specialty?.id ||
            primaryItem.procedure?.specialty_id ||
            '__none__'
          : null;
        const primaryColor = primarySpecKey ? colorForSpecialty(primarySpecKey).bar : null;
        // Especialidades distintas (set) — pra decidir se mostra "+N"
        const distinctSpecs = new Set<string>();
        for (const it of items) {
          distinctSpecs.add(
            it.procedure?.specialty?.id || it.procedure?.specialty_id || '__none__',
          );
        }
        const extraSpecs = distinctSpecs.size > 1 ? distinctSpecs.size - 1 : 0;
        // Tooltip combina anotacoes + procedimentos planejados
        const tooltipParts: string[] = [];
        if (isSelected) tooltipParts.push('selecionado pra orcamento (Ctrl+click pra remover)');
        if (records.length > 0) tooltipParts.push(`${records.length} anotacao(oes) clinica(s)`);
        if (isQuoted) {
          tooltipParts.push('Plano de tratamento:');
          for (const it of items) {
            tooltipParts.push(`  • ${it.procedure?.name || 'procedimento'}`);
          }
        }
        if (!isSelected && !isQuoted && records.length === 0) {
          tooltipParts.push('Ctrl+click pra adicionar ao orcamento');
        }
        return (
          <button
            key={fdi}
            onClick={(e) => onClick(fdi, e)}
            className={`relative ${isDeciduous ? 'w-7 h-7 text-[10px]' : 'w-9 h-9 text-xs'} rounded-md border-2 font-bold flex items-center justify-center hover:scale-110 transition-transform ${cls} ${
              isSelected ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-105' : ''
            }`}
            title={`${fdi} — ${tooltipParts.join('\n')}`}
            // Onda 3.5 — quando dente tem item no orcamento, pinta numero
            // com cor da especialidade do primeiro procedimento. Override
            // do `text-*` herdado de cls (estado clinico).
            style={primaryColor ? { color: primaryColor } : undefined}
          >
            {fdi}
            {extraSpecs > 0 && (
              <span
                className="absolute -bottom-1 -right-1 text-[7px] font-bold bg-background rounded-full px-0.5 border border-border leading-none print-hide"
                title={`${distinctSpecs.size} especialidades diferentes`}
              >
                +{extraSpecs}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Mini-odontograma de visualizacao do orcamento (Onda 3.31) ─

const FDI_MINI_SUP_DIR = ['18', '17', '16', '15', '14', '13', '12', '11'];
const FDI_MINI_SUP_ESQ = ['21', '22', '23', '24', '25', '26', '27', '28'];
const FDI_MINI_INF_ESQ = ['31', '32', '33', '34', '35', '36', '37', '38'];
const FDI_MINI_INF_DIR = ['48', '47', '46', '45', '44', '43', '42', '41'];

function QuoteMiniOdontograma({ items }: { items: QuoteItemLite[] }) {
  // Mapa fdi -> primeiro item daquele dente (pra cor da especialidade)
  const itemsByFdi = new Map<string, QuoteItemLite>();
  for (const it of items) {
    if (!it.tooth_fdi) continue;
    if (!itemsByFdi.has(it.tooth_fdi)) itemsByFdi.set(it.tooth_fdi, it);
  }
  const totalLinked = itemsByFdi.size;
  const totalUnlinked = items.filter((it) => !it.tooth_fdi).length;

  return (
    <div className="px-4 py-3 border-b border-border bg-card/40">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          Visão dos dentes deste orçamento
        </p>
        <p className="text-[10px] text-muted-foreground">
          <strong className="text-foreground">{totalLinked}</strong> dente(s) com procedimento
          {totalUnlinked > 0 && (
            <>
              {' · '}
              <span className="text-amber-700">{totalUnlinked} sem dente vinculado</span>
            </>
          )}
        </p>
      </div>
      <div className="flex flex-col items-center gap-1">
        <div className="flex justify-center gap-3">
          <QuoteMiniRow fdiList={FDI_MINI_SUP_DIR} itemsByFdi={itemsByFdi} />
          <div className="w-px bg-border" />
          <QuoteMiniRow fdiList={FDI_MINI_SUP_ESQ} itemsByFdi={itemsByFdi} />
        </div>
        <div className="h-px bg-border w-full max-w-[420px]" />
        <div className="flex justify-center gap-3">
          <QuoteMiniRow fdiList={FDI_MINI_INF_DIR} itemsByFdi={itemsByFdi} />
          <div className="w-px bg-border" />
          <QuoteMiniRow fdiList={FDI_MINI_INF_ESQ} itemsByFdi={itemsByFdi} />
        </div>
      </div>
    </div>
  );
}

function QuoteMiniRow({
  fdiList, itemsByFdi,
}: {
  fdiList: string[];
  itemsByFdi: Map<string, QuoteItemLite>;
}) {
  return (
    <div className="flex gap-0.5">
      {fdiList.map((fdi) => {
        const item = itemsByFdi.get(fdi);
        const specKey = item
          ? item.procedure?.specialty?.id || item.procedure?.specialty_id || '__none__'
          : null;
        const color = specKey ? colorForSpecialty(specKey) : null;
        const procName = item?.procedure?.name;
        const inlineStyle: React.CSSProperties | undefined = color
          ? {
              backgroundColor: color.tint,
              borderColor: color.bar,
              color: color.bar,
            }
          : undefined;
        return (
          <div
            key={fdi}
            className={`w-7 h-7 rounded text-[10px] font-bold border-2 flex items-center justify-center transition-all ${
              color ? '' : 'bg-background border-border text-muted-foreground/60'
            }`}
            style={inlineStyle}
            title={procName ? `${fdi} — ${procName}` : `${fdi} — sem procedimento`}
          >
            {fdi}
          </div>
        );
      })}
    </div>
  );
}

// ─── Editor ───────────────────────────────────────────────────

function ToothEditor({
  patientId, toothFdi, records, editingRecord, onEdit, onSaved, onClose,
}: {
  patientId: string;
  toothFdi: string;
  records: ToothRecord[];
  editingRecord: ToothRecord | null;
  onEdit: (r: ToothRecord) => void;
  /** Onda 3.2 — recebe o state salvo (ex: "CARIE") pra acionar sugestao automatica */
  onSaved: (savedState?: string) => void;
  onClose: () => void;
}) {
  const [face, setFace] = useState(editingRecord?.face || '');
  const [state, setState] = useState(editingRecord?.state || 'CARIE');
  const [material, setMaterial] = useState(editingRecord?.material || '');
  const [notes, setNotes] = useState(editingRecord?.notes || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setFace(editingRecord?.face || '');
    setState(editingRecord?.state || 'CARIE');
    setMaterial(editingRecord?.material || '');
    setNotes(editingRecord?.notes || '');
  }, [editingRecord]);

  const save = async () => {
    setSaving(true);
    try {
      if (editingRecord) {
        await api.patch(`/tooth-records/${editingRecord.id}`, {
          face: face || undefined,
          state,
          material: material || undefined,
          notes: notes || undefined,
        });
        showSuccess('Atualizado');
      } else {
        await api.post(`/patients/${patientId}/odontogram/teeth`, {
          tooth_fdi: toothFdi,
          face: face || undefined,
          state,
          material: material || undefined,
          notes: notes || undefined,
        });
        showSuccess('Registro adicionado');
      }
      onSaved(state);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Remover este registro dentário?')) return;
    try {
      await api.delete(`/tooth-records/${id}`);
      showSuccess('Removido');
      onSaved();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao remover');
    }
  };

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-semibold text-foreground">Dente <span className="text-primary">{toothFdi}</span></h4>
        <button onClick={onClose} className="p-1 hover:bg-accent rounded">
          <X size={16} />
        </button>
      </div>

      {records.length > 0 && !editingRecord && (
        <div className="mb-4">
          <p className="text-xs text-muted-foreground mb-2">Anotações existentes</p>
          <ul className="space-y-1.5">
            {records.map((r) => {
              const stateLabel = STATES.find((s) => s.v === r.state)?.label || r.state;
              return (
                <li key={r.id} className="flex items-center justify-between bg-background rounded-lg px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs border ${STATE_CLS[r.state] || ''}`}>
                      {stateLabel}
                    </span>
                    {r.face && <span className="text-xs text-muted-foreground">face {r.face}</span>}
                    {r.material && <span className="text-xs text-muted-foreground">· {r.material}</span>}
                    {r.notes && <span className="text-xs text-muted-foreground">· {r.notes}</span>}
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => onEdit(r)}
                      className="text-xs text-primary hover:bg-primary/10 px-2 py-0.5 rounded"
                    >
                      Editar
                    </button>
                    <button
                      onClick={() => remove(r.id)}
                      className="text-destructive hover:bg-destructive/10 p-1 rounded"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Form (adicionar ou editar) */}
      <div className="space-y-3">
        <p className="text-xs font-medium text-foreground">
          {editingRecord ? 'Editando registro' : 'Adicionar novo registro'}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium mb-1">Estado</label>
            <select
              value={state}
              onChange={(e) => setState(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              {STATES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Face (opcional)</label>
            <select
              value={face}
              onChange={(e) => setFace(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="">Dente inteiro</option>
              {FACES.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Material (opcional)</label>
          <input
            type="text"
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
            placeholder="Resina, Amálgama, Porcelana..."
            className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Observações</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y"
          />
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 rounded-lg border border-border text-sm hover:bg-accent disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {editingRecord ? 'Atualizar' : 'Adicionar'}
          </button>
        </div>
      </div>
    </div>
  );
}
