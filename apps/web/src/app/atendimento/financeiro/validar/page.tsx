'use client';

// "Validar" saiu das abas internas do Financeiro e virou item próprio do menu
// (grupo FINANCEIRO). Renderiza o mesmo ValidarTab — fila de tratamentos fechados
// aguardando liberação do Financeiro pro dentista atender. Gate manage_financial
// (o backend também exige); aqui é defense-in-depth pra quem acessa por deep-link.
import { pickBt } from '@crm/shared';
import { useBusinessType } from '@/lib/useBusinessType';
import { useUserPermissions } from '@/lib/useUserPermissions';
import ValidarTab from '../components/ValidarTab';

export default function ValidarPage() {
  const { hasPermission } = useUserPermissions();
  const bt = useBusinessType();
  return (
    <div className="h-full overflow-y-auto p-6 w-full">
      <div className="mb-4">
        <h1 className="text-lg font-bold text-foreground">{pickBt(bt, 'Validar tratamentos', 'Validar trabalhos')}</h1>
        <p className="text-sm text-muted-foreground">
          {pickBt(bt, 'Tratamentos fechados aguardando liberação do Financeiro pro dentista atender.', 'Trabalhos fechados aguardando o Financeiro liberar o trabalho para a produção.')}
        </p>
      </div>
      {hasPermission('manage_financial') ? (
        <ValidarTab />
      ) : (
        <div className="bg-card border border-border rounded-xl p-8 text-center text-sm text-muted-foreground">
          {pickBt(bt, 'Você não tem permissão para validar tratamentos.', 'Você não tem permissão para validar trabalhos.')}
        </div>
      )}
    </div>
  );
}
