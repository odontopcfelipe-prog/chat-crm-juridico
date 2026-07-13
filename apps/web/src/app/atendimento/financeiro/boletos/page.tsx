'use client';

// "Boletos" saiu das abas internas do Financeiro e virou item próprio do menu
// (grupo FINANCEIRO). Renderiza o mesmo BoletosTab — todas as cobranças
// (PaymentGatewayCharge): Asaas online + recebido na clínica. Gate view_financial
// (o backend também exige); aqui é defense-in-depth pra deep-link.
import { useUserPermissions } from '@/lib/useUserPermissions';
import BoletosTab from '../components/BoletosTab';

export default function BoletosPage() {
  const { hasPermission } = useUserPermissions();
  return (
    <div className="h-full overflow-y-auto p-6 w-full">
      <div className="mb-4">
        <h1 className="text-lg font-bold text-foreground">Boletos</h1>
        <p className="text-sm text-muted-foreground">
          Todas as cobranças da clínica — Asaas (online) e recebido na clínica.
        </p>
      </div>
      {hasPermission('view_financial') ? (
        <BoletosTab />
      ) : (
        <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          Você não tem permissão para ver os boletos.
        </div>
      )}
    </div>
  );
}
