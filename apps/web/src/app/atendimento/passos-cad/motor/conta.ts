/**
 * Passos CAD — a conta aberta neste navegador. O que a tela lembra aqui (nomes de cliente e de
 * técnico) é separado por conta: duas contas no mesmo navegador não se enxergam.
 */
import { decodeJwtPayload } from '@crm/shared';

export function contaDoNavegador(): string {
  let conta: unknown;
  try {
    conta = decodeJwtPayload(window.localStorage.getItem('token'))?.tenant_id;
  } catch {
    conta = undefined;
  }
  return typeof conta === 'string' && conta ? conta : 'sem-conta';
}

/**
 * Versões antigas guardavam a biblioteca de dentes importada num banco do navegador, por conta.
 * A importação saiu (os termos das bibliotecas só permitem o uso no CAD de origem), e a cópia
 * que tiver ficado neste navegador é apagada ao abrir a tela.
 */
export function apagarBibliotecaAntiga(): void {
  try {
    indexedDB.deleteDatabase(`passos-cad-${contaDoNavegador()}`);
  } catch {
    // Sem armazenamento no navegador: não há o que apagar.
  }
}
