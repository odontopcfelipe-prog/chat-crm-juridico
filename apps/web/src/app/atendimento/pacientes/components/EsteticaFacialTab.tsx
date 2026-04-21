'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Calendar, Loader2, Plus, Sparkles, Syringe, X,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import { FacialMap, FACIAL_POINTS, type FacialPoint } from './FacialMap';

// ============================================================================
// Tipos
// ============================================================================

interface EstheticApplication {
  id: string;
  application_point: string;
  side: string | null;
  product_name_snapshot: string | null;
  brand_snapshot: string | null;
  batch_number: string | null;
  expiration_date: string | null;
  volume: string | null;
  unit: string | null;
  technique: string | null;
  depth: string | null;
  notes: string | null;
  expected_revisit_at: string | null;
  applied_at: string;
  procedure?: { id: string; name: string; category: string | null } | null;
  product?: { id: string; name: string; brand: string | null } | null;
  applied_by?: { id: string; name: string } | null;
  _count?: { adverse_reactions: number };
}

interface Procedure {
  id: string;
  name: string;
  category: string | null;
  default_revisit_months: number | null;
}

interface Product {
  id: string;
  name: string;
  brand: string | null;
  unit: string;
  category: string | null;
  current_stock: string;
  requires_lot_tracking: boolean;
  is_injectable: boolean;
}

const FACIAL_POINT_LABEL: Record<string, string> = Object.fromEntries(
  FACIAL_POINTS.map((p) => [p.code, p.label]),
);

// ============================================================================
// Componente principal — aba "Estetica Facial" da ficha do paciente
// ============================================================================

export default function EsteticaFacialTab({ patientId }: { patientId: string }) {
  const [loading, setLoading] = useState(true);
  const [applications, setApplications] = useState<EstheticApplication[]>([]);
  const [selectedPoint, setSelectedPoint] = useState<FacialPoint | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get<{ data: EstheticApplication[] }>(
        `/patients/${patientId}/esthetic-applications?limit=100`,
      );
      setApplications(data?.data || []);
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao carregar aplicacoes');
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    load();
  }, [load]);

  // Mapa code → contagem (para exibir no FacialMap)
  const pointCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of applications) {
      counts[a.application_point] = (counts[a.application_point] || 0) + 1;
    }
    return counts;
  }, [applications]);

  // Pontos com pelo menos 1 aplicacao (highlighted)
  const highlightedPoints = useMemo(() => Object.keys(pointCounts), [pointCounts]);

  if (loading) {
    return (
      <div className="p-12 flex items-center justify-center text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando aplicacoes esteticas...
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
      {/* Mapa facial — esquerda */}
      <div className="lg:col-span-5">
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
              <Sparkles size={16} className="text-primary" /> Mapa facial
            </h3>
            <button
              onClick={() => setSelectedPoint({ code: 'OUTRO', label: 'Outro', cx: 0, cy: 0 })}
              className="text-xs inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Plus size={14} /> Nova aplicacao
            </button>
          </div>
          <p className="text-xs text-muted-foreground mb-3">
            Clique em um ponto para registrar uma aplicacao. Pontos com numeros mostram o
            historico de aplicacoes.
          </p>
          <FacialMap
            onPointClick={(point) => setSelectedPoint(point)}
            highlighted={highlightedPoints}
            pointCounts={pointCounts}
          />
        </div>

        {/* Resumo rapido */}
        <div className="grid grid-cols-3 gap-2 mt-3">
          <Stat label="Aplicacoes" value={applications.length} />
          <Stat
            label="Reacoes"
            value={applications.reduce((sum, a) => sum + (a._count?.adverse_reactions || 0), 0)}
          />
          <Stat label="Pontos ativos" value={Object.keys(pointCounts).length} />
        </div>
      </div>

      {/* Timeline — direita */}
      <div className="lg:col-span-7">
        <div className="bg-card border border-border rounded-xl p-4">
          <h3 className="font-semibold text-sm text-foreground mb-3 flex items-center gap-2">
            <Syringe size={16} /> Historico de aplicacoes
          </h3>

          {applications.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              <Sparkles size={24} className="mx-auto mb-2 opacity-50" />
              <p>Nenhuma aplicacao estetica registrada para este paciente.</p>
              <p className="text-xs mt-1">Clique em um ponto do mapa para comecar.</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {applications.map((app) => (
                <ApplicationItem key={app.id} app={app} />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Modal de nova aplicacao */}
      {selectedPoint && (
        <NewEstheticApplicationModal
          patientId={patientId}
          initialPoint={selectedPoint}
          onClose={() => setSelectedPoint(null)}
          onCreated={() => {
            setSelectedPoint(null);
            load();
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Item da timeline
// ============================================================================

function ApplicationItem({ app }: { app: EstheticApplication }) {
  const point = FACIAL_POINT_LABEL[app.application_point] || app.application_point;
  const date = new Date(app.applied_at).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const revisit = app.expected_revisit_at
    ? new Date(app.expected_revisit_at).toLocaleDateString('pt-BR')
    : null;

  return (
    <li className="bg-background border border-border rounded-lg p-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-foreground">{point}</span>
            {app.side && app.side !== 'CENTRAL' && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {app.side === 'DIREITA' ? 'D' : app.side === 'ESQUERDA' ? 'E' : 'Bilateral'}
              </span>
            )}
            {app.procedure && (
              <span className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary">
                {app.procedure.name}
              </span>
            )}
            {(app._count?.adverse_reactions ?? 0) > 0 && (
              <span className="text-xs px-2 py-0.5 rounded bg-destructive/10 text-destructive flex items-center gap-1">
                <AlertTriangle size={10} /> Reacao
              </span>
            )}
          </div>

          <div className="text-xs text-muted-foreground space-y-0.5">
            <p className="flex items-center gap-1">
              <Calendar size={11} /> {date}
              {app.applied_by && <span className="ml-2">por {app.applied_by.name}</span>}
            </p>
            {(app.product_name_snapshot || app.brand_snapshot) && (
              <p>
                <strong>Produto:</strong>{' '}
                {[app.product_name_snapshot, app.brand_snapshot].filter(Boolean).join(' — ')}
                {app.batch_number && (
                  <span className="ml-2">
                    Lote: <span className="font-mono">{app.batch_number}</span>
                  </span>
                )}
              </p>
            )}
            {app.volume && (
              <p>
                <strong>Volume:</strong> {app.volume} {app.unit || ''}
                {app.technique && <span className="ml-2"><strong>Tec:</strong> {app.technique}</span>}
                {app.depth && <span className="ml-2"><strong>Prof:</strong> {app.depth}</span>}
              </p>
            )}
            {revisit && (
              <p className="text-amber-600 dark:text-amber-400">
                <strong>Retorno previsto:</strong> {revisit}
              </p>
            )}
            {app.notes && <p className="italic mt-1">"{app.notes}"</p>}
          </div>
        </div>
      </div>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-card border border-border rounded-lg p-2 text-center">
      <p className="text-lg font-bold text-foreground">{value}</p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
    </div>
  );
}

// ============================================================================
// Modal de Nova Aplicacao
// ============================================================================

const VALID_SIDES = [
  { v: '', label: '—' },
  { v: 'DIREITA', label: 'Direita' },
  { v: 'ESQUERDA', label: 'Esquerda' },
  { v: 'BILATERAL', label: 'Bilateral' },
  { v: 'CENTRAL', label: 'Central' },
];
const VALID_TECHNIQUES = ['BOLUS', 'RETROINJECAO', 'FANNING', 'CROSSHATCH', 'MAP', 'ROLAMENTO', 'OUTRO'];
const VALID_DEPTHS = ['SUPERFICIAL', 'MEDIO', 'PROFUNDO', 'SUPRAPERIOSTAL', 'SUBDERMICO'];
const VALID_UNITS = ['ML', 'UI', 'MG'];

function NewEstheticApplicationModal({
  patientId, initialPoint, onClose, onCreated,
}: {
  patientId: string;
  initialPoint: FacialPoint;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(true);

  // Form fields
  const [applicationPoint, setApplicationPoint] = useState(initialPoint.code);
  const [side, setSide] = useState<string>(
    initialPoint.side === 'D' ? 'DIREITA' : initialPoint.side === 'E' ? 'ESQUERDA' : 'CENTRAL',
  );
  const [procedureId, setProcedureId] = useState('');
  const [productId, setProductId] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [expirationDate, setExpirationDate] = useState('');
  const [volume, setVolume] = useState('');
  const [unit, setUnit] = useState('ML');
  const [dilution, setDilution] = useState('');
  const [needleGauge, setNeedleGauge] = useState('');
  const [technique, setTechnique] = useState('');
  const [depth, setDepth] = useState('');
  const [notes, setNotes] = useState('');
  const [expectedDuration, setExpectedDuration] = useState<string>('');
  const [appliedAt, setAppliedAt] = useState(() => new Date().toISOString().slice(0, 16));

  // Load procedures + products (filtered to facial)
  useEffect(() => {
    (async () => {
      setLoadingMeta(true);
      try {
        const [procRes, prodRes] = await Promise.all([
          api.get<{ data?: Procedure[] } | Procedure[]>('/procedures?limit=200'),
          api.get<{ data?: Product[] } | Product[]>('/products?limit=200&active=true'),
        ]);
        const procData = Array.isArray(procRes.data) ? procRes.data : (procRes.data as any).data || [];
        const prodData = Array.isArray(prodRes.data) ? prodRes.data : (prodRes.data as any).data || [];
        setProcedures(procData);
        setProducts(prodData);
      } catch {
        // ignora — usuario ainda pode salvar sem proc/produto
      } finally {
        setLoadingMeta(false);
      }
    })();
  }, []);

  // Quando seleciona produto, auto-preenche unidade
  const selectedProduct = products.find((p) => p.id === productId);
  useEffect(() => {
    if (selectedProduct?.unit && ['ML', 'UI', 'MG'].includes(selectedProduct.unit)) {
      setUnit(selectedProduct.unit);
    }
  }, [productId]);

  // Quando seleciona procedimento, auto-preenche revisit
  const selectedProcedure = procedures.find((p) => p.id === procedureId);
  useEffect(() => {
    if (selectedProcedure?.default_revisit_months) {
      setExpectedDuration(String(selectedProcedure.default_revisit_months));
    }
  }, [procedureId]);

  const requiresLot = selectedProduct?.requires_lot_tracking ?? false;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!applicationPoint) {
      showError('Selecione um ponto de aplicacao');
      return;
    }
    if (requiresLot && !batchNumber.trim()) {
      showError(`Produto "${selectedProduct?.name}" exige rastreabilidade ANVISA. Informe o lote.`);
      return;
    }

    setSaving(true);
    try {
      const payload: any = {
        application_point: applicationPoint,
        side: side || undefined,
        procedure_id: procedureId || undefined,
        product_id: productId || undefined,
        batch_number: batchNumber.trim() || undefined,
        expiration_date: expirationDate || undefined,
        volume: volume ? parseFloat(volume) : undefined,
        unit: unit || undefined,
        dilution: dilution.trim() || undefined,
        needle_gauge: needleGauge.trim() || undefined,
        technique: technique || undefined,
        depth: depth || undefined,
        notes: notes.trim() || undefined,
        expected_duration_months: expectedDuration ? parseInt(expectedDuration, 10) : undefined,
        applied_at: appliedAt ? new Date(appliedAt).toISOString() : undefined,
      };

      await api.post(`/patients/${patientId}/esthetic-applications`, payload);
      showSuccess('Aplicacao registrada');
      onCreated();
    } catch (err: any) {
      showError(err?.response?.data?.message || 'Erro ao salvar aplicacao');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-xl w-full max-w-2xl shadow-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Syringe size={20} className="text-primary" />
            <h2 className="text-lg font-semibold">Nova aplicacao estetica</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded">
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={submit} className="p-4 space-y-3 overflow-y-auto">
          {/* Ponto + lado */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-xs font-medium mb-1">Ponto de aplicacao *</label>
              <select
                value={applicationPoint}
                onChange={(e) => setApplicationPoint(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {FACIAL_POINTS.map((p) => (
                  <option key={p.code} value={p.code}>{p.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Lado</label>
              <select
                value={side}
                onChange={(e) => setSide(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {VALID_SIDES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
              </select>
            </div>
          </div>

          {/* Procedimento */}
          <div>
            <label className="block text-xs font-medium mb-1">Procedimento</label>
            <select
              value={procedureId}
              onChange={(e) => setProcedureId(e.target.value)}
              disabled={loadingMeta}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="">— sem procedimento vinculado —</option>
              {procedures.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.category ? ` (${p.category})` : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Produto + lote ANVISA */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Produto / insumo</label>
              <select
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                disabled={loadingMeta}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">— sem produto —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}{p.brand ? ` — ${p.brand}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                Lote {requiresLot && <span className="text-destructive">*ANVISA</span>}
              </label>
              <input
                type="text"
                value={batchNumber}
                onChange={(e) => setBatchNumber(e.target.value)}
                placeholder={requiresLot ? 'Obrigatorio' : 'Opcional'}
                className={`w-full px-3 py-2 rounded-lg bg-background border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 ${
                  requiresLot && !batchNumber ? 'border-destructive/50' : 'border-border'
                }`}
              />
            </div>
          </div>

          {/* Validade do lote */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Validade do lote</label>
              <input
                type="date"
                value={expirationDate}
                onChange={(e) => setExpirationDate(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Volume</label>
              <input
                type="number"
                step="0.01"
                value={volume}
                onChange={(e) => setVolume(e.target.value)}
                placeholder="0.5"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Unidade</label>
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                {VALID_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </div>

          {/* Tecnica + profundidade */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Tecnica</label>
              <select
                value={technique}
                onChange={(e) => setTechnique(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">—</option>
                {VALID_TECHNIQUES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Profundidade</label>
              <select
                value={depth}
                onChange={(e) => setDepth(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">—</option>
                {VALID_DEPTHS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>

          {/* Diluicao + agulha */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Diluicao</label>
              <input
                type="text"
                value={dilution}
                onChange={(e) => setDilution(e.target.value)}
                placeholder="100UI/2mL"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Agulha</label>
              <input
                type="text"
                value={needleGauge}
                onChange={(e) => setNeedleGauge(e.target.value)}
                placeholder="30G x 13mm"
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          {/* Data + duracao */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Aplicado em</label>
              <input
                type="datetime-local"
                value={appliedAt}
                onChange={(e) => setAppliedAt(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Validade do efeito (meses)</label>
              <input
                type="number"
                min="1"
                max="60"
                value={expectedDuration}
                onChange={(e) => setExpectedDuration(e.target.value)}
                placeholder={selectedProcedure?.default_revisit_months ? String(selectedProcedure.default_revisit_months) : 'Auto'}
                className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          {/* Notas */}
          <div>
            <label className="block text-xs font-medium mb-1">Observacoes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded-lg bg-background border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
              placeholder="Tecnica especial, reacoes do paciente durante a aplicacao, orientacoes..."
            />
          </div>

          {requiresLot && (
            <div className="flex items-start gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <span>
                Produto injetavel — rastreabilidade obrigatoria por <strong>RDC ANVISA 751/2022</strong>.
                O lote sera registrado para rastreabilidade reversa.
              </span>
            </div>
          )}

          {/* Footer */}
          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-border text-sm font-medium hover:bg-accent"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              Registrar aplicacao
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
