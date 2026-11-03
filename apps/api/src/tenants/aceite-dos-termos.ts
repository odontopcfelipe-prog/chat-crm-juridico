/**
 * Aceite dos termos de uso e da política de privacidade no cadastro público
 * (clínica e laboratório). O pedido tem de trazer aceite_termos: true; as
 * versões gravadas são as que estão em vigor no servidor (@crm/shared), nunca as
 * que o navegador mandar.
 */
import { VERSAO_POLITICA_DE_PRIVACIDADE, VERSAO_TERMOS_DE_USO } from '@crm/shared';
import type { OrigemDaRequisicao } from '../common/utils/origem-da-requisicao';

export const MSG_ACEITE_OBRIGATORIO = 'Aceite os termos de uso e a política de privacidade para continuar.';

export type CadastroDoAceite = 'CADASTRO_CLINICA' | 'CADASTRO_LABORATORIO';

/** O que o cadastro passa para a criação da conta gravar o aceite. */
export interface AceiteDoCadastro extends OrigemDaRequisicao {
  source: CadastroDoAceite;
}

/** Só o booleano true vale como aceite. */
export function aceitouOsTermos(valor: unknown): boolean {
  return valor === true;
}

/** Linha da TermsAcceptance para o admin recém-criado. */
export function dadosDoAceite(
  tenantId: string,
  admin: { id: string; email: string },
  aceite: AceiteDoCadastro,
) {
  return {
    tenant_id: tenantId,
    user_id: admin.id,
    email: admin.email,
    source: aceite.source,
    terms_version: VERSAO_TERMOS_DE_USO,
    privacy_version: VERSAO_POLITICA_DE_PRIVACIDADE,
    ip: aceite.ip,
    user_agent: aceite.user_agent,
  };
}
