'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

/**
 * A tela antiga do Financeiro (Entradas/Saídas/Pacientes/Diárias/Log) foi UNIFICADA
 * no painel /atendimento/financeiro/contas-a-pagar, que virou O Financeiro:
 *   - setor financeiro (view_financial): Entradas, Pacientes, Log + resumo de cobranças
 *   - adm/gerente (manage_payables): também Contas Fixas, Gastos do dia e multi-empresa
 * (gate POR ABA — o financeiro NÃO vê aluguel/folha/fornecedor).
 *
 * Cobranças = item "Boletos"; caixa = item "Caixa"; validação = item "Validar" — todos
 * itens próprios do menu. Esta rota só redireciona (mantém bookmarks/deep-links/balões).
 */
export default function FinanceiroRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/atendimento/financeiro/contas-a-pagar');
  }, [router]);
  return (
    <div className="h-full flex items-center justify-center p-8">
      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
    </div>
  );
}
