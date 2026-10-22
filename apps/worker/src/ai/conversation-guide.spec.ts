import { Logger } from '@nestjs/common';
import { CONVERSATION_GUIDE, SCHEDULING_RULES, isClosingWithoutScheduling, replyProposesSlots, replyListsSlots, promisesSlotsLater } from './conversation-guide';
import { PromptBuilder } from './prompt-builder';

describe('isClosingWithoutScheduling', () => {
  it('encerramento curto sem contexto continua encerramento (comportamento antigo)', () => {
    for (const t of ['ok', 'Ok!', 'beleza', 'tá bom', 'obrigada', 'vou pensar', '👍']) {
      expect(isClosingWithoutScheduling(t)).toBe(true);
    }
  });

  it('intenção aberta / recusa / saudação não é encerramento', () => {
    for (const t of ['ok, tem amanhã?', 'sim', 'pode ser', 'não, obrigado', 'oi, tudo bem']) {
      expect(isClosingWithoutScheduling(t)).toBe(false);
    }
  });

  describe('ack logo depois da NOSSA proposta de horário = confirmação, não encerramento', () => {
    const umHorario = 'Felipe, vamos deixar terça às 17h que já fica certo?';
    const olharAgenda = 'Tudo isso fica apenas R$ 350. Posso dar uma olhada na agenda e ver se consigo pra essa semana?';

    it.each(['ok', 'Ok!', '👍', 'beleza', 'pode ser', 'fechado', 'combinado', 'tá bom', 'ok 👍'])(
      '%p depois de "vamos deixar terça às 17h?"',
      (ack) => {
        expect(isClosingWithoutScheduling(ack, umHorario)).toBe(false);
      },
    );

    it('"beleza" depois de "posso olhar a agenda?" também é um sim', () => {
      expect(isClosingWithoutScheduling('beleza', olharAgenda)).toBe(false);
    });

    it('hesitação depois da proposta continua encerramento ("vou pensar", "obrigada")', () => {
      expect(isClosingWithoutScheduling('vou pensar', umHorario)).toBe(true);
      expect(isClosingWithoutScheduling('obrigada', umHorario)).toBe(true);
    });

    it('"ok" depois de mensagem SEM proposta continua encerramento', () => {
      expect(isClosingWithoutScheduling('ok', 'Imagina, Felipe!')).toBe(true);
      expect(isClosingWithoutScheduling('ok', null)).toBe(true);
    });
  });

  it('replyProposesSlots reconhece a proposta de um horário', () => {
    expect(replyProposesSlots('vamos deixar terça às 17h?')).toBe(true);
    expect(replyProposesSlots('Imagina, Felipe!')).toBe(false);
  });
});

describe('SCHEDULING_RULES — contrato de saída', () => {
  it('termina com o contrato do JSON (scheduling_action no topo + exemplo)', () => {
    const tail = SCHEDULING_RULES.slice(SCHEDULING_RULES.indexOf('FORMATO DA RESPOSTA'));
    expect(tail).toContain('"scheduling_action"');
    expect(tail).toContain('NUNCA vai dentro de "updates"');
    expect(tail).toContain('{"action":"confirm_slot","date":"AAAA-MM-DD","time":"HH:MM"}');
    expect(tail).not.toMatch(/20dd-dd-dd/); // molde sem data real (o modelo copiava)
    expect(tail).toContain('vale para PROCEDIMENTO');
  });

  it('regra 9 tem a exceção do "ok" depois de proposta de UM horário', () => {
    expect(SCHEDULING_RULES).toContain('EXCEÇÃO — RESPOSTA À SUA PROPOSTA');
  });

  it('"nao_paciente" no topo do contrato (null = paciente) e no molde, antes do scheduling_action', () => {
    const tail = SCHEDULING_RULES.slice(SCHEDULING_RULES.indexOf('FORMATO DA RESPOSTA'));
    expect(tail).toContain('a chave "nao_paciente"');
    expect(tail).toContain('{"categoria":"CURRICULO|FORNECEDOR|PARCERIA|NEGOCIO|OUTRO","resumo":"<o que a pessoa quer, 1 frase>"}');
    expect(tail).toMatch(/Nesse caso "scheduling_action" é null, sem horário nenhum/);
    // Molde: nao_paciente null ANTES do scheduling_action (o prompt continua terminando no confirm_slot).
    expect(tail).toContain('"nao_paciente":null,"scheduling_action":{"action":"confirm_slot"');
  });

  it('NÃO É CONSULTA sempre ligado: nas correções + exceção na regra 4 (repassar ao responsável)', () => {
    const corr = SCHEDULING_RULES.slice(
      SCHEDULING_RULES.indexOf('CORREÇÕES DAS INSTRUÇÕES ANTIGAS'),
      SCHEDULING_RULES.indexOf('JEITO DE ESCREVER'),
    );
    expect(corr).toContain('9. NÃO É CONSULTA');
    for (const t of ['EMPREGO', 'CURRÍCULO', 'ENTREVISTA', 'fornecedor', 'NEGOCIAÇÃO', 'CONTRATO comercial', 'REUNIÃO', 'PARCERIA', 'IMPRENSA']) {
      expect(corr).toContain(t);
    }
    expect(corr).toContain('Nunca ofereça horário, nunca emita confirm_slot');
    expect(corr).toContain('vai repassar ao responsável');
    // Paciente falando do contrato/pagamento do próprio tratamento continua paciente.
    expect(corr).toMatch(/CONTRATO, PAGAMENTO, BOLETO, PARCELA ou NEGOCIAÇÃO do PRÓPRIO tratamento É paciente/);
    expect(corr).toContain('Na dúvida, é paciente.');
    const regra4 = SCHEDULING_RULES.slice(SCHEDULING_RULES.indexOf('4. NÃO empurre'), SCHEDULING_RULES.indexOf('5. CONFIRMOU'));
    expect(regra4).toContain('Única exceção: quem NÃO é paciente');
  });
});

describe('tom — simples, direta e humana', () => {
  it('o guia traz o que entrega que é robô e os pares robótico × natural', () => {
    expect(CONVERSATION_GUIDE).toContain('O QUE ENTREGA QUE É ROBÔ');
    expect(CONVERSATION_GUIDE).toContain('COMO SOA (só pra mostrar o tom — não copie estas frases)');
    expect(CONVERSATION_GUIDE).toContain('"Fazer" em vez de "realizar"');
  });

  it('o bloco final anula as regras de formato e as respostas padrão das skills', () => {
    const jeito = SCHEDULING_RULES.slice(SCHEDULING_RULES.indexOf('JEITO DE ESCREVER'), SCHEDULING_RULES.indexOf('VALORES —'));
    expect(jeito).toContain('"nunca pule linha"');
    expect(jeito).toContain('"Resposta padrão", roteiros e exemplos das skills e referências são CONTEÚDO');
    expect(jeito).toContain('Quando for passar VALOR, siga o COMO VENDER');
  });

  it('o jeito de vender do dono continua (valor antes do preço, "apenas R$", oferta leve de agenda)', () => {
    const vender = SCHEDULING_RULES.slice(SCHEDULING_RULES.indexOf('COMO VENDER'), SCHEDULING_RULES.indexOf('REGRAS DE AGENDAMENTO'));
    expect(vender).toContain('CONSTRUA O VALOR ANTES DO PREÇO');
    expect(vender).toContain('Tudo isso fica apenas R$ 350');
    expect(vender).toContain('Posso dar uma olhada na agenda e ver se consigo pra essa semana?');
    expect(vender).toContain('depende muito do que você vai precisar');
    // A oferta leve de agenda continua sendo reconhecida como proposta (o "beleza" depois dela é um sim).
    expect(replyProposesSlots('Posso dar uma olhada na agenda e ver se consigo pra essa semana?')).toBe(true);
  });
});

describe('contrato entra por ÚLTIMO no prompt (com skill, sem skill e no chat de teste)', () => {
  // ai.processor usa o MESMO buildSystemPrompt(finalRules: SCHEDULING_RULES) nos 3 caminhos.
  it('vem depois da seção "Saída" da skill', () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const skill = 'Você é a SDR. NÃO agenda consulta.\n# Saída\nRetorne SOMENTE JSON: {"reply":"...","updates":{}}';
    const prompt: string = new PromptBuilder().buildSystemPrompt({
      mediaCapabilities: 'MEDIA',
      behaviorRules: 'CORE',
      skillPrompt: skill,
      references: [],
      maxContextTokens: 4000,
      vars: { assistant_name: 'Sophia', firm_name: 'Clínica', available_slots: 'X' },
      finalRules: SCHEDULING_RULES,
    });
    expect(prompt.indexOf('FORMATO DA RESPOSTA')).toBeGreaterThan(prompt.indexOf('# Saída'));
    expect(prompt.trimEnd().endsWith('"time":"HH:MM"}}')).toBe(true);
  });
});

describe('remarcação / horário prometido sem listar (13b-2)', () => {
  it('promessa de mandar horários depois é detectada', () => {
    for (const t of [
      'Sem problemas, Felipe!\n\nVou te passar outros horários pra você escolher.',
      'Já te mando os horários disponíveis.',
      'Vou ver os horários e te passo, tá?',
      'Vou verificar outras opções na agenda.',
      'Deixa eu olhar a agenda: vou separar umas vagas pra você.',
    ]) expect(promisesSlotsLater(t)).toBe(true);
  });

  it('não confunde com resposta normal', () => {
    for (const t of [
      'Nosso horário de atendimento é das 8h às 18h.',
      'Quer que eu veja um horário pra você essa semana?',
      'Perfeito, deixei agendado terça (13/10) às 8h.',
      'Sem problemas, Felipe!',
    ]) expect(promisesSlotsLater(t)).toBe(false);
  });

  it('replyListsSlots: só conta horário concreto', () => {
    expect(replyListsSlots('Tenho estes horários livres:\n• qua., 14/10 às 08:00\n• qui., 15/10 às 13:00')).toBe(true);
    expect(replyListsSlots('Tenho quinta (15/10) às 9h ou sexta às 14h.')).toBe(true);
    expect(replyListsSlots('Vou te passar outros horários pra você escolher.')).toBe(false);
    expect(replyListsSlots('Quer que eu veja um horário?')).toBe(false);
  });
});
