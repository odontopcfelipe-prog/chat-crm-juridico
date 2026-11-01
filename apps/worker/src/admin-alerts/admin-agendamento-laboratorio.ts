/**
 * F7 do laboratório — texto do aviso "Novo agendamento" aos administradores para a
 * coleta, a prova e a entrega (só a origem EQUIPE: o laboratório não tem IA). Os
 * dados são os mesmos do aviso da clínica (DadosAvisoAgendamento); o texto vem de
 * LAB_NOVO_AGENDAMENTO (@crm/shared): cliente, tipo do laboratório e o responsável.
 *
 * Função pura (sem Prisma/DI).
 */
import { LAB_NOVO_AGENDAMENTO, rotuloTipoDoLaboratorio } from '@crm/shared';
import { RECORRENCIA_LABEL, rotuloQuandoAgendamento, type DadosAvisoAgendamento } from './admin-agendamento-regras';

export function montarTextoNovoAgendamentoDoLaboratorio(d: DadosAvisoAgendamento): string {
  const rec = String(d.recorrencia || '').toUpperCase();
  return LAB_NOVO_AGENDAMENTO.montar({
    nome: d.pacienteNome,
    telefone: d.telefone,
    quando: rotuloQuandoAgendamento(d.startNaive, !!d.allDay),
    tipo: rotuloTipoDoLaboratorio(d.tipo),
    protetico: d.dentista,
    marcadoPor: d.criadoPor,
    repete: rec ? RECORRENCIA_LABEL[rec] || 'sim' : '',
  });
}
