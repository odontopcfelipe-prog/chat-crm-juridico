/**
 * F4 do laboratório — textos do LABORATÓRIO que mais de uma tela usa: nome e
 * descrição de cada setor, nome do cargo (papel do login) e nome da função do
 * chip de WhatsApp.
 *
 * Só texto (o valor/enum continua o mesmo da clínica): quem usa escolhe com
 * pickBt(bt, textoDaClinica, LAB_X.y). Este arquivo só tem estas 3 consts
 * LAB_*: fica sob as travas de scripts/ci/check-pick-literals.mjs, e nenhum
 * texto fora delas pode entrar aqui.
 */
import type { Sector } from './sectors.config';

/** Setor (mesmos ids da clínica) → nome, persona, descrição e subtítulo no laboratório. */
export const LAB_SECTOR_TEXT: Readonly<Record<Sector, Readonly<{ name: string; persona: string; description: string; subtitle: string }>>> =
  Object.freeze({
    admin: Object.freeze({
      name: 'Administrador',
      persona: 'Administrador',
      description: 'Acesso completo ao laboratório',
      subtitle: 'Visão completa do laboratório: pendências, equipe e números.',
    }),
    recepcao: Object.freeze({
      name: 'Atendimento',
      persona: 'Atendimento',
      description: 'Atende os clientes, lança os pedidos, faz venda de balcão e opera o caixa',
      subtitle: 'Organize os pedidos do dia e mantenha os clientes informados.',
    }),
    dentista: Object.freeze({
      name: 'Protético',
      persona: 'Protético',
      description: 'Produz os trabalhos e acompanha o próprio jogo',
      subtitle: 'Acompanhe os trabalhos do dia e os prazos de entrega.',
    }),
    acd_asb: Object.freeze({
      name: 'Expedição',
      persona: 'Expedição',
      description: 'Coleta, prova e entrega dos trabalhos no consultório do cliente',
      subtitle: 'Organize as coletas e entregas do dia.',
    }),
    financeiro: Object.freeze({
      name: 'Financeiro',
      persona: 'Financeiro',
      description: 'Cobranças, conciliação e boletos',
      subtitle: 'Cobranças, conciliação e visão geral do caixa.',
    }),
    crc: Object.freeze({
      name: 'Comercial',
      persona: 'Comercial',
      description: 'Relacionamento com dentistas e clínicas parceiras',
      subtitle: 'Capte e acompanhe dentistas e clínicas parceiras.',
    }),
  });

/** Papel do login (o mesmo da clínica) → nome do cargo no laboratório. */
export const LAB_ROLE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ADMIN: 'Administrador',
  DENTIST: 'Protético',
  OPERADOR: 'Atendimento',
  ASSISTANT: 'Expedição',
  FINANCEIRO: 'Financeiro',
});

/** Função do chip (o valor gravado não muda) → nome no laboratório. */
export const LAB_PURPOSE_LABEL: Readonly<Record<'COMERCIAL' | 'CLINICA' | 'FINANCEIRO', string>> = Object.freeze({
  COMERCIAL: 'Comercial',
  CLINICA: 'Atendimento',
  FINANCEIRO: 'Financeiro',
});
