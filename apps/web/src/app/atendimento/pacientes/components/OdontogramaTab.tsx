'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { Loader2, Activity, X, Trash2, Save, Printer, ChevronDown, ChevronUp, DollarSign } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { colorForSpecialty } from '@/lib/specialty-colors';
import QuotePanel from './QuotePanel';

interface Props {
  patientId: string;
  /** Onda 25.5 — nome do paciente exibido no cabecalho de impressao */
  patientName?: string;
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
  total_value: string | number;
  created_at: string;
  valid_until: string | null;
  closing_category: ClosingCategory;
  _count?: { items: number };
  created_by?: { id: string; name: string };
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

export default function OdontogramaTab({ patientId, patientName }: Props) {
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

  // Toggle expansion: clica no card pra expandir; clica no expandido pra fechar.
  // Single-expand: so 1 orcamento aberto por vez (UX accordion clean).
  const toggleExpand = useCallback(async (id: string) => {
    if (expandedQuoteId === id) {
      setExpandedQuoteId(null);
      setExpandedQuote(null);
      return;
    }
    setExpandedQuoteId(id);
    setExpandedQuote(null); // limpa enquanto carrega
    await loadExpandedQuote(id);
  }, [expandedQuoteId, loadExpandedQuote]);

  // Cria orcamento DRAFT vazio + auto-expande pra edicao imediata
  const createNewQuote = useCallback(async () => {
    try {
      const { data } = await api.post<{ id: string }>(`/patients/${patientId}/quotes`);
      showSuccess('Orcamento criado');
      await loadQuotesList();
      setExpandedQuoteId(data.id);
      await loadExpandedQuote(data.id);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { message?: string } } };
      showError(e?.response?.data?.message || 'Erro ao criar orcamento');
    }
  }, [patientId, loadQuotesList, loadExpandedQuote]);

  // Atualiza titulo do orcamento (edicao inline no card)
  const updateQuoteTitle = useCallback(async (id: string, title: string) => {
    try {
      await api.patch(`/quotes/${id}`, { title: title || null });
      await loadQuotesList();
      if (expandedQuoteId === id) await loadExpandedQuote(id);
    } catch (err: unknown) {
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
    <div className="odontogram-print">
      {/* Onda 25.5 — CSS print scoped (so afeta quando body tem .printing-odontogram) */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          body.printing-odontogram * { visibility: hidden !important; }
          body.printing-odontogram .odontogram-print,
          body.printing-odontogram .odontogram-print * { visibility: visible !important; }
          body.printing-odontogram .odontogram-print {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            padding: 24px !important;
            background: white !important;
            color: black !important;
          }
          body.printing-odontogram .print-hide { display: none !important; }
          body.printing-odontogram .print-only { display: block !important; }
          body.printing-odontogram .odontogram-print * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
        }
        .print-only { display: none; }
      `}} />

      {/* Cabecalho que SO aparece na impressao */}
      <div className="print-only mb-4 pb-3 border-b-2 border-black">
        <h2 className="text-xl font-bold">Odontograma — {patientName || 'Paciente'}</h2>
        <p className="text-sm">
          Impresso em {new Date().toLocaleString('pt-BR')}
        </p>
      </div>

      {/* Header + legenda */}
      <div className="flex items-center justify-between mb-3 print-hide">
        <div className="flex items-center gap-2">
          <Activity size={18} className="text-primary" />
          <h3 className="font-semibold text-foreground">Odontograma</h3>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={odonto?.meta?.dentition_stage || 'permanent'}
            onChange={(e) => updateDentitionStage(e.target.value)}
            className="text-xs px-2 py-1 rounded-lg bg-card border border-border focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="permanent">Dentição permanente</option>
            <option value="mixed">Dentição mista</option>
            <option value="deciduous">Dentição decídua</option>
          </select>
          <button
            onClick={handlePrint}
            className="text-xs inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-border hover:bg-accent text-muted-foreground hover:text-foreground"
            title="Imprimir odontograma (gera versão limpa pra papel/PDF)"
          >
            <Printer size={12} /> Imprimir
          </button>
        </div>
      </div>

      {/* Arcadas */}
      <div className="bg-card border border-border rounded-xl p-6 mb-4">
        {/* Superior */}
        <div className="mb-6">
          <p className="text-xs text-muted-foreground text-center mb-2">Superior</p>
          <div className="flex justify-center gap-8">
            <TeethRow fdiList={FDI_PERMANENT.superior_direito} toothRecords={toothRecords} onClick={onToothClick} selectedSet={selectedTeethForQuote} quotedItems={itemsByFdi} />
            <div className="w-px bg-border" />
            <TeethRow fdiList={FDI_PERMANENT.superior_esquerdo} toothRecords={toothRecords} onClick={onToothClick} selectedSet={selectedTeethForQuote} quotedItems={itemsByFdi} />
          </div>
          {showDeciduous && (
            <div className="mt-2 flex justify-center gap-8">
              <TeethRow fdiList={FDI_DECIDUOUS.superior_direito_dec} toothRecords={toothRecords} onClick={onToothClick} isDeciduous selectedSet={selectedTeethForQuote} quotedItems={itemsByFdi} />
              <div className="w-px bg-border" />
              <TeethRow fdiList={FDI_DECIDUOUS.superior_esquerdo_dec} toothRecords={toothRecords} onClick={onToothClick} isDeciduous selectedSet={selectedTeethForQuote} quotedItems={itemsByFdi} />
            </div>
          )}
        </div>

        {/* Linha central */}
        <div className="h-px bg-border mb-6" />

        {/* Inferior */}
        <div>
          {showDeciduous && (
            <div className="mb-2 flex justify-center gap-8">
              <TeethRow fdiList={FDI_DECIDUOUS.inferior_direito_dec} toothRecords={toothRecords} onClick={onToothClick} isDeciduous selectedSet={selectedTeethForQuote} quotedItems={itemsByFdi} />
              <div className="w-px bg-border" />
              <TeethRow fdiList={FDI_DECIDUOUS.inferior_esquerdo_dec} toothRecords={toothRecords} onClick={onToothClick} isDeciduous selectedSet={selectedTeethForQuote} quotedItems={itemsByFdi} />
            </div>
          )}
          <div className="flex justify-center gap-8">
            <TeethRow fdiList={FDI_PERMANENT.inferior_direito} toothRecords={toothRecords} onClick={onToothClick} selectedSet={selectedTeethForQuote} quotedItems={itemsByFdi} />
            <div className="w-px bg-border" />
            <TeethRow fdiList={FDI_PERMANENT.inferior_esquerdo} toothRecords={toothRecords} onClick={onToothClick} selectedSet={selectedTeethForQuote} quotedItems={itemsByFdi} />
          </div>
          <p className="text-xs text-muted-foreground text-center mt-2">Inferior</p>
        </div>
      </div>

      {/* Legenda de cores */}
      <div className="bg-card border border-border rounded-xl p-3 mb-4">
        <p className="text-xs font-medium text-muted-foreground mb-2">Estados</p>
        <div className="flex flex-wrap gap-2">
          {STATES.map((s) => (
            <span key={s.v} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border ${s.cls}`}>
              <span className="w-2 h-2 rounded-full bg-current opacity-70" />
              {s.label}
            </span>
          ))}
        </div>
      </div>

      {/* Editor de dente — print-hide pra nao sair no papel */}
      {selectedTooth && (
        <div className="print-hide mb-4">
          <ToothEditor
            patientId={patientId}
            toothFdi={selectedTooth}
            records={toothRecords(selectedTooth)}
            editingRecord={editingRecord}
            onEdit={onEditRecord}
            onSaved={onRecordSaved}
            onClose={closeEditor}
          />
        </div>
      )}

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
              className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold shadow-sm transition"
            >
              <DollarSign size={16} /> Iniciar orcamento
            </button>
          </div>
        ) : (
          // Lista de cards expansiveis
          <div className="space-y-2">
            {quotesList.map((q, idx) => (
              <QuoteCard
                key={q.id}
                quote={q}
                index={quotesList.length - idx}
                expanded={expandedQuoteId === q.id}
                expandedQuote={expandedQuoteId === q.id ? expandedQuote : null}
                onToggleExpand={() => toggleExpand(q.id)}
                onRename={(newTitle) => updateQuoteTitle(q.id, newTitle)}
                onDelete={q.status === 'DRAFT' ? () => deleteDraft(q.id) : undefined}
                patientId={patientId}
                procedures={procedures}
                selectedTeeth={expandedQuoteId === q.id ? selectedTeethArray : []}
                onClearSelection={clearTeethSelection}
                onQuoteChange={refreshQuotes}
                lastAnnotation={expandedQuoteId === q.id ? lastAnnotation : null}
                onAnnotationConsumed={consumeLastAnnotation}
              />
            ))}
            {/* CTA final: criar mais um orcamento */}
            <button
              onClick={createNewQuote}
              className="w-full bg-card border border-dashed border-border hover:border-emerald-500/40 hover:bg-emerald-500/5 rounded-xl py-3 text-sm font-medium text-emerald-700 transition-colors inline-flex items-center justify-center gap-2"
            >
              <DollarSign size={14} /> Iniciar novo orcamento
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Card de orcamento expansivel (Onda 3.9) ──────────────────
// Click no header expande/contrai. Quando expandido, renderiza QuotePanel
// inline com a tabela de procedimentos (sem valores — visao clinica). Para
// negociacao comercial (valores, descontos, envio), operador clica no link
// "Abrir na aba Orcamentos" no rodape.

function QuoteCard({
  quote, index, expanded, expandedQuote, onToggleExpand, onRename, onDelete,
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

  return (
    <div className={`bg-card border rounded-xl overflow-hidden transition-colors ${
      expanded ? 'border-primary/40 shadow-sm' : 'border-border hover:border-primary/30'
    }`}>
      {/* HEADER — sempre visivel, click expande/colapsa */}
      <button
        type="button"
        onClick={onToggleExpand}
        className="w-full px-4 py-3 flex items-center gap-3 flex-wrap text-left"
      >
        <span className="text-xs text-muted-foreground font-mono">#{index}</span>
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
              if (e.key === 'Enter') commitTitle();
              if (e.key === 'Escape') setTitleDraft(null);
            }}
            placeholder="Nome do orcamento (ex: Reabilitacao superior)"
            className="text-sm font-bold tracking-wide px-2 py-0.5 rounded border border-primary bg-background min-w-[200px] focus:outline-none"
          />
        ) : (
          <span
            onClick={startEditTitle}
            className="text-sm font-bold text-primary hover:underline tracking-wide cursor-text"
            title="Clique pra editar nome"
          >
            {quote.title || categoryLabel}
          </span>
        )}
        {/* Quando tem titulo customizado, mostra a categoria como badge secundaria */}
        {quote.title && (
          <span className="text-[10px] uppercase font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {categoryLabel}
          </span>
        )}
        <span className={`text-[10px] uppercase font-semibold px-2 py-0.5 rounded ${STATUS_CLS[quote.status]}`}>
          {STATUS_LABEL[quote.status]}
        </span>
        <div className="flex flex-col text-xs text-muted-foreground">
          <span>
            {itemsCount === 0 ? 'sem procedimentos' : `${itemsCount} ${itemsCount === 1 ? 'item' : 'itens'}`}
            {' · '}
            Criado em {createdDate}
          </span>
          {quote.created_by?.name && (
            <span>por {quote.created_by.name}</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              title="Apagar rascunho"
            >
              <Trash2 size={12} />
            </button>
          )}
          <span className="text-muted-foreground" title={expanded ? 'Recolher' : 'Expandir pra editar procedimentos'}>
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </span>
        </div>
      </button>

      {/* CONTEUDO EXPANSIVEL — QuotePanel inline (sem valores) */}
      {expanded && (
        <div className="border-t border-border bg-background/30">
          {!expandedQuote ? (
            <div className="p-8 flex items-center justify-center text-muted-foreground text-sm">
              <Loader2 size={14} className="animate-spin mr-2" />
              Carregando procedimentos...
            </div>
          ) : (
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
