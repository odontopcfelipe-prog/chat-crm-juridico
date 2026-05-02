'use client';

import { useEffect, useState, useCallback } from 'react';
import { Loader2, Activity, X, Trash2, Save, Printer, DollarSign } from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import AddQuoteItemModal from './AddQuoteItemModal';

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
  const [showAddItemsModal, setShowAddItemsModal] = useState(false);
  const [draftQuoteId, setDraftQuoteId] = useState<string | null>(null);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [openingModal, setOpeningModal] = useState(false);

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

  useEffect(() => { load(); }, [load]);

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
  const clearTeethSelection = () => setSelectedTeethForQuote(new Set());

  const openAddToQuoteModal = async () => {
    if (selectedTeethForQuote.size === 0) return;
    setOpeningModal(true);
    try {
      // 1. Carrega procedures + draft em paralelo (otimiza tempo de abrir)
      const [procRes, draftRes] = await Promise.all([
        api.get<Procedure[]>('/procedures'),
        api.post<{ id: string }>(`/patients/${patientId}/quotes/draft-or-create`),
      ]);
      setProcedures(procRes.data || []);
      setDraftQuoteId(draftRes.data.id);
      setShowAddItemsModal(true);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao abrir orçamento');
    } finally {
      setOpeningModal(false);
    }
  };

  const onItemsAdded = async () => {
    showSuccess(`Procedimentos adicionados ao orçamento — vá no tab Orçamentos pra ver`);
    setShowAddItemsModal(false);
    clearTeethSelection();
    setDraftQuoteId(null);
  };

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

  const onRecordSaved = async () => {
    closeEditor();
    await load();
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
          <h3 className="font-semibold text-foreground">Odontograma (notação FDI)</h3>
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

      {/* Onda 3.1 — hint sobre multi-selecao via Ctrl+click */}
      <div className="text-[11px] text-muted-foreground mb-2 print-hide flex items-center gap-1.5 flex-wrap">
        <DollarSign size={11} className="text-primary" />
        <span>
          <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">Ctrl</kbd>
          +click (ou <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">Shift</kbd>+click)
          em um ou mais dentes pra adicionar procedimentos ao orçamento.
        </span>
      </div>

      {/* Arcadas */}
      <div className="bg-card border border-border rounded-xl p-6 mb-4">
        {/* Superior */}
        <div className="mb-6">
          <p className="text-xs text-muted-foreground text-center mb-2">Superior</p>
          <div className="flex justify-center gap-8">
            <TeethRow fdiList={FDI_PERMANENT.superior_direito} toothRecords={toothRecords} onClick={onToothClick} selectedSet={selectedTeethForQuote} />
            <div className="w-px bg-border" />
            <TeethRow fdiList={FDI_PERMANENT.superior_esquerdo} toothRecords={toothRecords} onClick={onToothClick} selectedSet={selectedTeethForQuote} />
          </div>
          {showDeciduous && (
            <div className="mt-2 flex justify-center gap-8">
              <TeethRow fdiList={FDI_DECIDUOUS.superior_direito_dec} toothRecords={toothRecords} onClick={onToothClick} isDeciduous selectedSet={selectedTeethForQuote} />
              <div className="w-px bg-border" />
              <TeethRow fdiList={FDI_DECIDUOUS.superior_esquerdo_dec} toothRecords={toothRecords} onClick={onToothClick} isDeciduous selectedSet={selectedTeethForQuote} />
            </div>
          )}
        </div>

        {/* Linha central */}
        <div className="h-px bg-border mb-6" />

        {/* Inferior */}
        <div>
          {showDeciduous && (
            <div className="mb-2 flex justify-center gap-8">
              <TeethRow fdiList={FDI_DECIDUOUS.inferior_direito_dec} toothRecords={toothRecords} onClick={onToothClick} isDeciduous selectedSet={selectedTeethForQuote} />
              <div className="w-px bg-border" />
              <TeethRow fdiList={FDI_DECIDUOUS.inferior_esquerdo_dec} toothRecords={toothRecords} onClick={onToothClick} isDeciduous selectedSet={selectedTeethForQuote} />
            </div>
          )}
          <div className="flex justify-center gap-8">
            <TeethRow fdiList={FDI_PERMANENT.inferior_direito} toothRecords={toothRecords} onClick={onToothClick} selectedSet={selectedTeethForQuote} />
            <div className="w-px bg-border" />
            <TeethRow fdiList={FDI_PERMANENT.inferior_esquerdo} toothRecords={toothRecords} onClick={onToothClick} selectedSet={selectedTeethForQuote} />
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
        <div className="print-hide">
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

      {/* Onda 3.1 — FAB sticky no fundo quando tem dentes selecionados */}
      {selectedTeethForQuote.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 print-hide animate-in slide-in-from-bottom-4 duration-200">
          <div className="bg-card border border-primary/40 shadow-2xl rounded-full pl-4 pr-2 py-2 flex items-center gap-3">
            <span className="text-sm font-semibold flex items-center gap-2">
              <DollarSign size={14} className="text-primary" />
              {selectedTeethForQuote.size} {selectedTeethForQuote.size === 1 ? 'dente selecionado' : 'dentes selecionados'}
            </span>
            <div className="flex flex-wrap gap-1 max-w-[200px]">
              {Array.from(selectedTeethForQuote).slice(0, 8).map((t) => (
                <span
                  key={t}
                  className="inline-flex items-center px-1.5 py-0.5 rounded font-mono text-[10px] bg-primary/10 text-primary"
                >
                  {t}
                </span>
              ))}
              {selectedTeethForQuote.size > 8 && (
                <span className="text-[10px] text-muted-foreground">
                  +{selectedTeethForQuote.size - 8}
                </span>
              )}
            </div>
            <button
              onClick={clearTeethSelection}
              className="text-xs px-2 py-1 rounded-full text-muted-foreground hover:bg-muted"
              title="Limpar seleção"
            >
              <X size={14} />
            </button>
            <button
              onClick={openAddToQuoteModal}
              disabled={openingModal}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 disabled:opacity-50"
            >
              {openingModal ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <DollarSign size={14} />
              )}
              Adicionar ao orçamento
            </button>
          </div>
        </div>
      )}

      {/* Onda 3.1 — Modal compartilhado com prefillTeeth */}
      {showAddItemsModal && draftQuoteId && (
        <AddQuoteItemModal
          quoteId={draftQuoteId}
          procedures={procedures}
          prefillTeeth={Array.from(selectedTeethForQuote)}
          onClose={() => {
            setShowAddItemsModal(false);
            setDraftQuoteId(null);
          }}
          onAdded={onItemsAdded}
        />
      )}
    </div>
  );
}

// ─── Linha de dentes ──────────────────────────────────────────

function TeethRow({
  fdiList, toothRecords, onClick, isDeciduous, selectedSet,
}: {
  fdiList: string[];
  toothRecords: (fdi: string) => ToothRecord[];
  onClick: (fdi: string, e: React.MouseEvent) => void;
  isDeciduous?: boolean;
  /** Onda 3.1 — dentes selecionados pra orcamento (renderiza ring azul) */
  selectedSet?: Set<string>;
}) {
  return (
    <div className="flex gap-1">
      {fdiList.map((fdi) => {
        const records = toothRecords(fdi);
        const primaryState = records[0]?.state;
        const cls = primaryState ? STATE_CLS[primaryState] : 'bg-background border-border text-muted-foreground';
        const isSelected = selectedSet?.has(fdi);
        return (
          <button
            key={fdi}
            onClick={(e) => onClick(fdi, e)}
            className={`${isDeciduous ? 'w-7 h-7 text-[10px]' : 'w-9 h-9 text-xs'} rounded-md border-2 font-semibold flex items-center justify-center hover:scale-110 transition-transform ${cls} ${
              isSelected ? 'ring-2 ring-primary ring-offset-2 ring-offset-background scale-105' : ''
            }`}
            title={
              isSelected
                ? `${fdi} — selecionado pra orçamento (Ctrl+click pra remover)`
                : records.length > 0
                ? `${fdi} — ${records.length} anotação(ões) · Ctrl+click pra adicionar ao orçamento`
                : `${fdi} — Ctrl+click pra adicionar ao orçamento`
            }
          >
            {fdi}
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
  onSaved: () => void;
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
      onSaved();
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
