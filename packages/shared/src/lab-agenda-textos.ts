/**
 * F7 do laboratório — textos da agenda de coleta, prova e entrega: rótulos dos
 * tipos, mensagens ao cliente (aviso na hora, remarcação, confirmação e lembretes),
 * resumo do dia do protético, aniversário, e-mails de agenda e o aviso aos
 * administradores de novo agendamento.
 *
 * Regras deste arquivo (scripts/ci/check-pick-literals.mjs):
 *   - só o import de tipo e consts LAB_: qualquer string fora delas conta como texto
 *     de clínica num arquivo novo e reprova a trava 1 (chave de objeto vai sem aspas);
 *   - nenhum termo da lista PROIBIDOS do script (trava 2), nem nome de variável de
 *     template com sublinhado que comece por um deles;
 *   - {clinica} e {{clinica_nome}} são o nome do laboratório: sem artigo antes.
 *
 * As variáveis entre chaves são trocadas por aplicarTextoDoLaboratorio
 * (agenda-laboratorio.ts): {nome} é o primeiro nome do cliente sem Dr./Dra., {tipo}
 * é coleta/prova/entrega em minúsculas, {data} é DD/MM, {hora} é HH:MM e
 * {local_line} é a linha do endereço do consultório (some quando não há endereço).
 */
import type { DadosNovoAgendamentoDoLaboratorio, TipoDoLaboratorio } from './agenda-laboratorio';

/** Rótulo de cada tipo da agenda do laboratório (pílula, lista, resumo, aviso). */
export const LAB_AGENDA_TIPO: Readonly<Record<TipoDoLaboratorio, string>> = Object.freeze({
  COLETA: 'Coleta',
  PROVA: 'Prova',
  ENTREGA: 'Entrega',
});

/** O tipo no meio da frase ({tipo} das mensagens). */
export const LAB_AGENDA_TIPO_FRASE: Readonly<Record<TipoDoLaboratorio, string>> = Object.freeze({
  COLETA: 'coleta',
  PROVA: 'prova',
  ENTREGA: 'entrega',
});

/** Mensagens ao cliente, resumo do protético e textos curtos da agenda do laboratório. */
export const LAB_AGENDA_TEXTOS = Object.freeze({
  /** Aviso na hora em que a coleta, a prova ou a entrega é marcada. */
  avisoAgendado:
    'Olá {nome}! Agendamos a *{tipo}* do seu trabalho para *{data}* às *{hora}*.\n' +
    '{local_line}\n' +
    'Qualquer dúvida, é só chamar por aqui.',
  /** Aviso de remarcação (dia ou hora mudou). */
  remarcacao:
    'Olá {nome}! O horário da {tipo} do seu trabalho mudou para *{data}* às *{hora}*.\n' +
    '{local_line}\n' +
    'Qualquer dúvida, é só chamar por aqui.',
  /** Confirmação da véspera (24 h antes): a equipe marca a resposta na agenda. */
  confirmacao24h:
    'Oi {nome}, tudo bem? Aqui é do laboratório. Passando pra confirmar a {tipo} do seu trabalho amanhã, *{data}* às *{hora}*.\n' +
    '{local_line}\n' +
    'Vai ter alguém no consultório pra receber? Se precisar mudar, é só responder aqui.',
  /** Confirmação sem os dados do evento (quando não dá para montar o texto completo). */
  confirmacaoReserva:
    'Oi, tudo bem? Aqui é do laboratório. Passando pra confirmar a visita de amanhã no consultório. ' +
    'Vai ter alguém pra receber? Se precisar mudar, é só responder aqui.',
  /** Lembrete de 48 h. */
  lembrete48h:
    'Oi {nome}! Lembrete do laboratório: *{data}* às *{hora}* passamos no consultório para a {tipo} do seu trabalho.\n' +
    '{local_line}\n' +
    'Se precisar mudar, é só responder aqui.',
  /** Lembrete de 24 h. */
  lembrete24h:
    'Oi {nome}! Lembrete do laboratório: amanhã, *{data}* às *{hora}*, passamos no consultório para a {tipo} do seu trabalho.\n' +
    '{local_line}',
  /** Resumo do dia de quem é responsável pelas coletas, provas e entregas. */
  resumoProtetico:
    'Bom dia, {nome}! 👋\n\n' +
    'Sua agenda hoje ({data}) tem {qtd} coleta(s), prova(s) e entrega(s):\n\n' +
    '{agenda}\n\n' +
    'Bom trabalho!',
  /** Aniversário do cliente (só a mensagem clássica). */
  aniversario:
    'Feliz aniversário, {nome}! A equipe do laboratório deseja um dia excelente pra você. Obrigado pela parceria de sempre!',
  cliente: 'Cliente',
  clienteSemNome: 'Cliente sem nome',
  protetico: 'Protético(a)',
  /** {nome} quando o cadastro não tem nome. */
  nomePadrao: 'doutor(a)',
  laboratorioSemNome: 'nosso laboratório',
  localACombinar: 'a combinar',
  semTelefone: 'Cliente sem telefone cadastrado',
  /** Resumo do dia: pessoa da equipe sem telefone no cadastro. */
  equipeSemTelefone: 'Pessoa da equipe sem telefone cadastrado',
  semChip:
    'Laboratório sem chip de Atendimento conectado — o lembrete não sai pelo Financeiro. Reconecte o WhatsApp de Atendimento.',
  semChipConfirmacao: 'Sem chip de Atendimento do WhatsApp conectado neste laboratório',
  /** Coleta, prova e entrega sem cliente: recusada na tela e no servidor. */
  clienteObrigatorio: 'Selecione o cliente (dentista ou consultório) da coleta, prova ou entrega.',
});

/** E-mails de agenda do laboratório (gravados na conta pelo lab-defaults). */
export const LAB_AGENDA_EMAIL = Object.freeze({
  agendado: Object.freeze({
    assunto: 'Agendamento do seu trabalho — {{clinica_nome}}',
    corpo:
      'Olá, {{cliente_nome}}!\n\n' +
      'Agendamos a {{tipo}} do seu trabalho:\n\n' +
      'Data: {{data}}\n' +
      'Horário: {{hora}}\n' +
      'Local: {{local}}\n\n' +
      'Se precisar mudar, é só falar com a gente.',
  }),
  remarcado: Object.freeze({
    assunto: 'Horário do seu trabalho alterado — {{clinica_nome}}',
    corpo:
      'Olá, {{cliente_nome}}!\n\n' +
      'O horário da {{tipo}} do seu trabalho mudou:\n\n' +
      'Nova data: {{data}}\n' +
      'Novo horário: {{hora}}\n' +
      'Local: {{local}}\n\n' +
      'Se o novo horário não funcionar, é só falar com a gente.',
  }),
});

/**
 * Aviso aos administradores de novo agendamento no laboratório. Quem chama já manda
 * o "quando", o rótulo do tipo e o rótulo da repetição prontos.
 */
export const LAB_NOVO_AGENDAMENTO = Object.freeze({
  montar(d: DadosNovoAgendamentoDoLaboratorio): string {
    const nome = String(d.nome ?? '').trim() || 'Cliente sem nome';
    const tel = String(d.telefone ?? '').trim();
    const linhas = [
      '📅 *Novo agendamento*',
      `Cliente: ${nome}${tel ? ` (${tel})` : ''}`,
      `Quando: ${d.quando}`,
      `Tipo: ${d.tipo}`,
      `Com: ${String(d.protetico ?? '').trim() || 'sem protético definido'}`,
      `Marcado por: ${String(d.marcadoPor ?? '').trim() || 'equipe'}`,
    ];
    const repete = String(d.repete ?? '').trim();
    if (repete) linhas.push(`Repete: ${repete} (aviso só da 1ª)`);
    return linhas.join('\n');
  },
});
