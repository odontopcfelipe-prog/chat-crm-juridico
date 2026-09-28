'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Package, ArrowDownUp, Truck, Search, ShieldAlert, Loader2,
} from 'lucide-react';
import api from '@/lib/api';
import { showError, showSuccess } from '@/lib/toast';
import ProductsTab from './components/ProductsTab';
import MovementsTab from './components/MovementsTab';
import SuppliersTab from './components/SuppliersTab';
import BatchTrackingTab from './components/BatchTrackingTab';

const TABS = [
  { id: 'products',    label: 'Produtos',         icon: Package },
  { id: 'movements',   label: 'Movimentacoes',    icon: ArrowDownUp },
  { id: 'suppliers',   label: 'Fornecedores',     icon: Truck },
  { id: 'tracking',    label: 'Rastreabilidade',  icon: Search },
] as const;

type TabId = typeof TABS[number]['id'];

/**
 * Botao de politica POR CLINICA: bloquear (ou nao) a saida que deixaria o saldo
 * negativo. Nasce DESLIGADO — enquanto o estoque nao esta confiavel, travar a
 * venda de balcao com paciente na frente causa mais dano do que um saldo errado.
 * Quando a clinica arruma o estoque, liga e passa a ter saldo confiavel de verdade.
 */
function PoliticaEstoque() {
  const [block, setBlock] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    api.get<{ block_negative: boolean }>('/inventory/policy')
      .then((r) => setBlock(!!r.data?.block_negative))
      .catch(() => setBlock(null));
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async () => {
    if (block === null) return;
    const novo = !block;
    setSaving(true);
    try {
      await api.patch('/inventory/policy', { block_negative: novo });
      setBlock(novo);
      showSuccess(
        novo
          ? 'Saída sem saldo passa a ser BLOQUEADA nesta clínica'
          : 'Saída sem saldo liberada — o saldo pode ficar negativo e fica marcado',
      );
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } } };
      showError(err?.response?.data?.message || 'Erro ao salvar a política');
    } finally {
      setSaving(false);
    }
  };

  if (block === null) return null;

  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 flex-wrap">
      <div className="flex items-start gap-2 min-w-0">
        <ShieldAlert size={16} className={block ? 'text-emerald-600 mt-0.5' : 'text-muted-foreground mt-0.5'} />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">Bloquear saída sem saldo</p>
          <p className="text-xs text-muted-foreground">
            {block
              ? 'Ligado: a venda/baixa é recusada quando o produto não tem saldo. Só ligue com o estoque conferido.'
              : 'Desligado: a baixa passa mesmo sem saldo e o produto fica com saldo negativo, marcado pra conferência.'}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={toggle}
        disabled={saving}
        className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors disabled:opacity-50 ${
          block
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20'
            : 'border-border hover:bg-accent'
        }`}
      >
        {saving && <Loader2 size={12} className="animate-spin" />}
        {block ? 'Ligado' : 'Desligado'}
      </button>
    </div>
  );
}

export default function EstoquePage() {
  const [tab, setTab] = useState<TabId>('products');

  return (
    <div className="h-full overflow-y-auto p-6 w-full">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
          <Package size={26} className="text-primary" /> Estoque
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Gestao de insumos com rastreabilidade ANVISA por lote.
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-border mb-4 -mx-6 px-6 overflow-x-auto">
        <div className="flex gap-1">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  active
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon size={16} />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {tab === 'products' && <PoliticaEstoque />}
      {tab === 'products' && <ProductsTab />}
      {tab === 'movements' && <MovementsTab />}
      {tab === 'suppliers' && <SuppliersTab />}
      {tab === 'tracking' && <BatchTrackingTab />}
    </div>
  );
}
