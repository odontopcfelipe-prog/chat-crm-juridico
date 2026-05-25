'use client';

import { useState } from 'react';
import {
  Package, ArrowDownUp, Truck, Search,
} from 'lucide-react';
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

export default function EstoquePage() {
  const [tab, setTab] = useState<TabId>('products');

  return (
    <div className="p-6 w-full">
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

      {tab === 'products' && <ProductsTab />}
      {tab === 'movements' && <MovementsTab />}
      {tab === 'suppliers' && <SuppliersTab />}
      {tab === 'tracking' && <BatchTrackingTab />}
    </div>
  );
}
