'use client';

import { useEffect, useState } from 'react';
import { Wallet, Loader2, AlertTriangle, CheckCircle } from 'lucide-react';
import portalApi from '@/lib/portalApi';

interface Installment {
  id: string;
  sequence: number;
  total_count: number;
  amount: string;
  amount_paid: string;
  due_date: string;
  paid_at: string | null;
  payment_method: string | null;
  status: string;
}
interface Totals { paid: number; open: number; overdue: number }

const fmtBRL = (v: number | string) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v));

const STATUS_CFG: Record<string, { label: string; cls: string }> = {
  ABERTA:    { label: 'Aberta',    cls: 'bg-blue-500/10 text-blue-700 border-blue-500/20' },
  PARCIAL:   { label: 'Parcial',   cls: 'bg-amber-500/10 text-amber-700 border-amber-500/20' },
  PAGA:      { label: 'Paga',      cls: 'bg-green-500/10 text-green-700 border-green-500/20' },
  ATRASADA:  { label: 'Atrasada',  cls: 'bg-red-500/10 text-red-700 border-red-500/20' },
  CANCELADA: { label: 'Cancelada', cls: 'bg-gray-500/10 text-gray-700 border-gray-500/20' },
  RENEGOCIADA: { label: 'Renegociada', cls: 'bg-purple-500/10 text-purple-700 border-purple-500/20' },
};

export default function AreaPacienteParcelasPage() {
  const [loading, setLoading] = useState(true);
  const [installments, setInstallments] = useState<Installment[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);

  useEffect(() => {
    portalApi.get<{ installments: Installment[]; totals: Totals }>('/portal/installments')
      .then(({ data }) => {
        setInstallments(data.installments || []);
        setTotals(data.totals || { paid: 0, open: 0, overdue: 0 });
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 size={20} className="animate-spin mr-2" /> Carregando...
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold flex items-center gap-2">
        <Wallet size={24} className="text-primary" /> Minhas parcelas
      </h1>

      {totals && (
        <div className="grid grid-cols-3 gap-2">
          <Card label="Em aberto" value={fmtBRL(totals.open)} color="text-blue-700" />
          <Card label="Em atraso" value={fmtBRL(totals.overdue)} color="text-destructive" icon={<AlertTriangle size={11} />} />
          <Card label="Já pago" value={fmtBRL(totals.paid)} color="text-green-700" icon={<CheckCircle size={11} />} />
        </div>
      )}

      {installments.length === 0 ? (
        <p className="text-sm text-muted-foreground py-12 text-center bg-card border border-border rounded-xl">
          Você não tem parcelas registradas.
        </p>
      ) : (
        <ul className="space-y-2">
          {installments.map((i) => {
            const cfg = STATUS_CFG[i.status] || STATUS_CFG.ABERTA;
            const due = new Date(i.due_date);
            const overdue = i.status !== 'PAGA' && i.status !== 'CANCELADA' && due < new Date();
            const remaining = Number(i.amount) - Number(i.amount_paid);

            return (
              <li key={i.id} className="bg-card border border-border rounded-xl p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold text-sm">
                      Parcela {i.sequence}/{i.total_count}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Vencimento: {due.toLocaleDateString('pt-BR')}
                    </p>
                    {overdue && (
                      <p className="text-[10px] text-destructive mt-0.5 flex items-center gap-1">
                        <AlertTriangle size={9} /> em atraso
                      </p>
                    )}
                    {i.paid_at && (
                      <p className="text-[10px] text-green-700 mt-0.5">
                        Pago em {new Date(i.paid_at).toLocaleDateString('pt-BR')}
                        {i.payment_method && ` via ${i.payment_method}`}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="font-mono font-bold">{fmtBRL(i.status === 'PAGA' ? i.amount : remaining)}</p>
                    <span className={`text-[10px] px-2 py-0.5 rounded border ${cfg.cls}`}>{cfg.label}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Card({
  label, value, color, icon,
}: { label: string; value: string; color: string; icon?: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-xl p-3">
      <div className="text-[10px] uppercase text-muted-foreground flex items-center gap-1 mb-1">
        {icon} {label}
      </div>
      <div className={`text-sm font-mono font-bold ${color}`}>{value}</div>
    </div>
  );
}
