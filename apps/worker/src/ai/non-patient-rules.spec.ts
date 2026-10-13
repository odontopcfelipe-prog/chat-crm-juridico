import {
  NON_PATIENT_FOLLOWUP_TEXT,
  NON_PATIENT_HANDOFF_TEXT,
  buildNonPatientAdminText,
  buildNonPatientAttachmentCaption,
  buildNonPatientTeamNote,
  chooseNonPatientReply,
  contradictsNonPatient,
  decideNonPatientBlock,
  extractNaoPacienteFromRaw,
  isAdequateNonPatientReply,
  nonPatientAttachmentMeta,
  normalizeNaoPaciente,
} from './non-patient-rules';
import { parseClassifierCategory, NON_PATIENT_CLASSIFIER_PROMPT, CLASSIFIER_CATEGORIES } from './non-patient-classifier';

describe('normalizeNaoPaciente — campo "nao_paciente" do JSON da IA', () => {
  it('contrato: objeto no topo com categoria + resumo', () => {
    expect(
      normalizeNaoPaciente({
        reply: 'Vou repassar ao responsável.',
        nao_paciente: { categoria: 'CURRICULO', resumo: 'quer enviar currículo para auxiliar' },
      }),
    ).toEqual({ categoria: 'CURRICULO', resumo: 'quer enviar currículo para auxiliar' });
  });

  it('paciente: null, ausente, false, "PACIENTE", "null" e objeto vazio → null', () => {
    expect(normalizeNaoPaciente({ reply: 'oi', nao_paciente: null })).toBeNull();
    expect(normalizeNaoPaciente({ reply: 'oi' })).toBeNull();
    expect(normalizeNaoPaciente({ reply: 'oi', nao_paciente: false })).toBeNull();
    expect(normalizeNaoPaciente({ reply: 'oi', nao_paciente: 'PACIENTE' })).toBeNull();
    expect(normalizeNaoPaciente({ reply: 'oi', nao_paciente: 'null' })).toBeNull();
    expect(normalizeNaoPaciente({ reply: 'oi', nao_paciente: {} })).toBeNull();
    expect(normalizeNaoPaciente({ reply: 'oi', nao_paciente: { categoria: 'PACIENTE', resumo: 'quer limpeza' } })).toBeNull();
    expect(normalizeNaoPaciente({ reply: 'oi', nao_paciente: { categoria: '', resumo: '' } })).toBeNull();
    expect(normalizeNaoPaciente(null)).toBeNull();
    expect(normalizeNaoPaciente('texto')).toBeNull();
  });

  it('dentro de updates (lugar errado) também vale', () => {
    expect(
      normalizeNaoPaciente({ reply: 'x', updates: { nao_paciente: { categoria: 'NEGOCIO', resumo: 'reunião com o dono' } } }),
    ).toEqual({ categoria: 'NEGOCIO', resumo: 'reunião com o dono' });
    expect(normalizeNaoPaciente({ reply: 'x', naoPaciente: { category: 'FORNECEDOR' } })).toEqual({
      categoria: 'FORNECEDOR',
      resumo: '',
    });
  });

  it('categoria desconhecida → paciente (null); sinônimos conhecidos viram a categoria certa', () => {
    expect(normalizeNaoPaciente({ nao_paciente: { categoria: 'XPTO', resumo: 'quer algo' } })).toBeNull();
    expect(normalizeNaoPaciente({ nao_paciente: { categoria: 'Emprego' } })?.categoria).toBe('CURRICULO');
    expect(normalizeNaoPaciente({ nao_paciente: { categoria: 'entrevista' } })?.categoria).toBe('CURRICULO');
    expect(normalizeNaoPaciente({ nao_paciente: { categoria: 'Currículo' } })?.categoria).toBe('CURRICULO');
    expect(normalizeNaoPaciente({ nao_paciente: { categoria: 'vendedor' } })?.categoria).toBe('FORNECEDOR');
    expect(normalizeNaoPaciente({ nao_paciente: { categoria: 'negociação' } })?.categoria).toBe('NEGOCIO');
    expect(normalizeNaoPaciente({ nao_paciente: { categoria: 'imprensa' } })?.categoria).toBe('NEGOCIO');
    expect(normalizeNaoPaciente({ nao_paciente: { categoria: 'parceiro' } })?.categoria).toBe('PARCERIA');
    expect(normalizeNaoPaciente({ nao_paciente: { categoria: 'SPAM' } })?.categoria).toBe('SPAM');
  });

  it('string, true e JSON em string', () => {
    expect(normalizeNaoPaciente({ nao_paciente: 'CURRICULO' })).toEqual({ categoria: 'CURRICULO', resumo: '' });
    expect(normalizeNaoPaciente({ nao_paciente: true })).toEqual({ categoria: 'OUTRO', resumo: '' });
    expect(normalizeNaoPaciente({ nao_paciente: 'true' })).toEqual({ categoria: 'OUTRO', resumo: '' });
    expect(normalizeNaoPaciente({ nao_paciente: '{"categoria":"PARCERIA","resumo":"permuta"}' })).toEqual({
      categoria: 'PARCERIA',
      resumo: 'permuta',
    });
    // Texto livre não é categoria: na dúvida, paciente.
    expect(normalizeNaoPaciente({ nao_paciente: 'quer vender um sistema' })).toBeNull();
  });

  it('revisão: valores que o modelo manda pra PACIENTE nunca viram OUTRO', () => {
    for (const v of [
      { categoria: null, resumo: 'Paciente pediu horário de avaliação' },
      { resumo: 'Paciente interessada em lentes' },
      { categoria: '', resumo: 'lead interessado em implante' },
      { categoria: 'OUTRO', resumo: 'Paciente pediu horário de avaliação' },
      { categoria: 'outro', resumo: 'não se aplica' },
      'NAO_SE_APLICA',
      'não aplicável',
      'Não se aplica (é paciente)',
      'paciente/lead',
      'é paciente',
      'sim',
      'undefined',
      'OUTRO_NAO',
      'Trabalho na empresa X e quero fazer clareamento',
      { categoria: 'Vendedor de loja, quer fazer avaliação', resumo: 'quer clareamento' },
    ]) {
      expect(normalizeNaoPaciente({ nao_paciente: v })).toBeNull();
    }
    // OUTRO explícito com resumo que não é de paciente continua valendo.
    expect(normalizeNaoPaciente({ nao_paciente: { categoria: 'OUTRO', resumo: 'quer vender sistema de gestão' } })).toEqual({
      categoria: 'OUTRO',
      resumo: 'quer vender sistema de gestão',
    });
    expect(normalizeNaoPaciente({ nao_paciente: 'OUTRO' })).toEqual({ categoria: 'OUTRO', resumo: '' });
  });

  it('molde copiado do prompt sem resumo de verdade = paciente (na dúvida)', () => {
    expect(
      normalizeNaoPaciente({
        nao_paciente: { categoria: 'CURRICULO|FORNECEDOR|PARCERIA|NEGOCIO|OUTRO', resumo: '<o que a pessoa quer, 1 frase>' },
      }),
    ).toBeNull();
    // Molde na categoria, mesmo com resumo: sem categoria explícita = paciente.
    expect(
      normalizeNaoPaciente({ nao_paciente: { categoria: 'CURRICULO|FORNECEDOR', resumo: 'quer trabalhar na recepção' } }),
    ).toBeNull();
  });

  it('resumo é cortado em 200 caracteres e sem quebras', () => {
    const r = normalizeNaoPaciente({ nao_paciente: { categoria: 'NEGOCIO', resumo: `a\n${'x'.repeat(300)}` } });
    expect(r?.resumo.length).toBe(200);
    expect(r?.resumo.startsWith('a x')).toBe(true);
  });

  it('extractNaoPacienteFromRaw: JSON truncado/malformado', () => {
    expect(
      extractNaoPacienteFromRaw('{"reply":"Vou repassar","nao_paciente":{"categoria":"FORNECEDOR","resumo":"vende tráfego"},"scheduling_'),
    ).toEqual({ categoria: 'FORNECEDOR', resumo: 'vende tráfego' });
    expect(extractNaoPacienteFromRaw('{"reply":"oi","nao_paciente":null,"x')).toBeNull();
    expect(extractNaoPacienteFromRaw('{"reply":"oi"')).toBeNull();
  });
});

describe('decideNonPatientBlock — bloqueio da agenda no turno', () => {
  it('paciente normal: nada bloqueado', () => {
    expect(decideNonPatientBlock({})).toEqual({ blocked: false, categoria: null, resumo: '', origem: null, novo: false });
    expect(decideNonPatientBlock({ fromClassifier: { category: 'PACIENTE', reason: 'quer limpeza' } }).blocked).toBe(false);
  });

  it('modelo marcou → bloqueia, novo (marca/alerta)', () => {
    const d = decideNonPatientBlock({ fromModel: { categoria: 'CURRICULO', resumo: 'vaga de ASB' } });
    expect(d).toEqual({ blocked: true, categoria: 'CURRICULO', resumo: 'vaga de ASB', origem: 'modelo', novo: true });
  });

  it('classificador marcou (handoff não saiu) → bloqueia; categoria desconhecida vira OUTRO', () => {
    expect(decideNonPatientBlock({ fromClassifier: { category: 'NEGOCIO', reason: 'reunião' } })).toMatchObject({
      blocked: true,
      categoria: 'NEGOCIO',
      origem: 'classificador',
      novo: true,
    });
    expect(decideNonPatientBlock({ fromClassifier: { category: 'ESTRANHO' } }).categoria).toBe('OUTRO');
  });

  it('modelo vence o classificador no mesmo turno', () => {
    const d = decideNonPatientBlock({
      fromModel: { categoria: 'FORNECEDOR', resumo: 'marketing' },
      fromClassifier: { category: 'PARCERIA', reason: 'permuta' },
    });
    expect(d.origem).toBe('modelo');
    expect(d.categoria).toBe('FORNECEDOR');
  });

  it('lead JÁ marcado: bloqueia sem ser "novo" (não reclassifica nem alerta de novo)', () => {
    const d = decideNonPatientBlock({ leadCategory: 'CURRICULO', fromModel: { categoria: 'NEGOCIO', resumo: 'x' } });
    expect(d).toMatchObject({ blocked: true, categoria: 'CURRICULO', origem: 'lead', novo: false });
    expect(decideNonPatientBlock({ leadCategory: 'coisa velha' }).categoria).toBe('OUTRO');
  });

  it('modelo marcou mas MARCOU/OFERECEU horário no mesmo turno → paciente (classificador/lead seguem valendo)', () => {
    const fromModel = { categoria: 'CURRICULO' as const, resumo: 'entrevista' };
    expect(decideNonPatientBlock({ fromModel, modelSchedules: true }).blocked).toBe(false);
    expect(decideNonPatientBlock({ fromModel, modelSchedules: true, leadCategory: 'FORNECEDOR' })).toMatchObject({
      blocked: true,
      origem: 'lead',
    });
    expect(
      decideNonPatientBlock({ fromModel, modelSchedules: true, fromClassifier: { category: 'NEGOCIO' } }).origem,
    ).toBe('classificador');
  });

  it('cliente cadastrado: marca antiga do lead não vale; a deste turno sim', () => {
    expect(decideNonPatientBlock({ leadCategory: 'CURRICULO', isClient: true }).blocked).toBe(false);
    expect(
      decideNonPatientBlock({ leadCategory: 'CURRICULO', isClient: true, fromModel: { categoria: 'CURRICULO', resumo: '' } }),
    ).toMatchObject({ blocked: true, origem: 'modelo', novo: true });
  });
});

describe('contradictsNonPatient — sinal de paciente no mesmo turno da marca', () => {
  it('confirm_slot, oferta de horário de consulta ou "agendei" contradizem', () => {
    expect(contradictsNonPatient('Vou repassar ao responsável.', { confirmSlot: true })).toBe(true);
    expect(contradictsNonPatient('Tenho terça (13/10) às 9h ou quarta (14/10) às 14h, qual prefere?')).toBe(true);
    expect(contradictsNonPatient('Perfeito, deixei agendado terça (13/10) às 9h!')).toBe(true);
  });
  it('repasse, reunião/entrevista ou resposta vazia não contradizem', () => {
    expect(contradictsNonPatient('Vou repassar seu currículo para o responsável, combinado?')).toBe(false);
    expect(contradictsNonPatient('Posso agendar uma reunião com o gestor terça às 14h?')).toBe(false);
    expect(contradictsNonPatient('')).toBe(false);
  });
});

describe('resposta pra quem não é paciente', () => {
  it('serve: curta, sem horário, dizendo que repassa', () => {
    const r = 'Que bom seu interesse em trabalhar com a gente! Vou repassar seu currículo para o responsável, combinado?';
    expect(isAdequateNonPatientReply(r, { requireRepasse: true })).toBe(true);
    expect(chooseNonPatientReply(r, { requireRepasse: true, alreadyMarked: false })).toEqual({ text: r, replaced: false });
  });

  it('oferece horário → troca pelo texto fixo de repasse', () => {
    const r = 'Claro! Posso agendar uma entrevista terça às 14h ou quarta às 9h?';
    expect(isAdequateNonPatientReply(r)).toBe(false);
    expect(chooseNonPatientReply(r, { requireRepasse: false, alreadyMarked: false })).toEqual({
      text: NON_PATIENT_HANDOFF_TEXT,
      replaced: true,
    });
  });

  it('marca reunião / diz que agendou → não serve', () => {
    expect(isAdequateNonPatientReply('Perfeito, deixei agendado para amanhã às 10h.')).toBe(false);
    expect(isAdequateNonPatientReply('Ótimo! Vou marcar uma reunião com a Dra. pra vocês conversarem.')).toBe(false);
    expect(isAdequateNonPatientReply('A reunião fica marcada com o gestor, tá?')).toBe(false);
  });

  it('handoff com pausa exige o repasse; sem pausa a resposta neutra serve', () => {
    const r = 'Oi! Pode mandar o seu currículo por aqui mesmo.';
    expect(isAdequateNonPatientReply(r, { requireRepasse: true })).toBe(false);
    expect(isAdequateNonPatientReply(r, { requireRepasse: false })).toBe(true);
    expect(chooseNonPatientReply(r, { requireRepasse: true, alreadyMarked: false }).text).toBe(NON_PATIENT_HANDOFF_TEXT);
  });

  it('vazia → texto fixo; lead já marcado → lembrete curto', () => {
    expect(chooseNonPatientReply('', { requireRepasse: false, alreadyMarked: false }).text).toBe(NON_PATIENT_HANDOFF_TEXT);
    expect(chooseNonPatientReply('Tenho quinta às 9h, pode ser?', { requireRepasse: false, alreadyMarked: true }).text).toBe(
      NON_PATIENT_FOLLOWUP_TEXT,
    );
  });

  it('o texto fixo de repasse passa no próprio critério', () => {
    expect(isAdequateNonPatientReply(NON_PATIENT_HANDOFF_TEXT, { requireRepasse: true })).toBe(true);
    expect(isAdequateNonPatientReply(NON_PATIENT_FOLLOWUP_TEXT, { requireRepasse: true })).toBe(true);
  });
});

describe('textos dos avisos', () => {
  it('aviso aos ADMs: tipo legível, nome, telefone, resumo e trecho', () => {
    const t = buildNonPatientAdminText({
      assistantName: 'Sophia',
      categoria: 'NEGOCIO',
      nome: 'Carlos',
      telefone: '5582999998888',
      resumo: 'quer reunião com o dono pra vender franquia',
      trecho: 'Boa tarde, gostaria de marcar uma reunião com o proprietário',
    });
    expect(t).toContain('Negociação / contrato / reunião comercial');
    expect(t).toContain('*Carlos* (5582999998888)');
    expect(t).toContain('Resumo: quer reunião com o dono');
    expect(t).toContain('Mensagem: "Boa tarde, gostaria');
    expect(t).toContain('foi pausada');
  });

  it('aviso aos ADMs sem resumo/trecho/telefone não deixa linha vazia', () => {
    const t = buildNonPatientAdminText({ assistantName: 'Sophia', categoria: 'CURRICULO', nome: 'Ana' });
    expect(t).not.toContain('Resumo:');
    expect(t).not.toContain('Mensagem:');
    expect(t).toContain('*Ana*\n');
    expect(t).toContain('Currículo / vaga de emprego');
  });

  it('nota interna (sem pausa) diz o tipo e o resumo e que o contato NÃO fica marcado', () => {
    const t = buildNonPatientTeamNote({ categoria: 'FORNECEDOR', resumo: 'vende tráfego pago', trecho: 'oi, sou da agência X' });
    expect(t).toContain('NÃO ser paciente (Fornecedor / proposta comercial): vende tráfego pago');
    expect(t).toContain('o contato NÃO fica marcado');
    expect(t).toContain('Última mensagem: "oi, sou da agência X"');
  });

  it('nota do lead JÁ marcado diz como desfazer a marca', () => {
    const t = buildNonPatientTeamNote({ categoria: 'CURRICULO', alreadyMarked: true, trecho: 'quero marcar avaliação' });
    expect(t).toContain('MARCADO como não-paciente (Currículo / vaga de emprego)');
    expect(t).toContain('desliguem e religuem a IA desta conversa');
    expect(t).toContain('Última mensagem: "quero marcar avaliação"');
  });

  it('legenda do arquivo no mesmo formato do webhook da API', () => {
    expect(buildNonPatientAttachmentCaption({ nome: 'Ana', categoria: 'CURRICULO', telefone: '5582999998888' })).toBe(
      '📎 Arquivo de Ana (Currículo / vaga de emprego)\nTel: 5582999998888',
    );
  });

  it('anexo: imagem vai como imagem, o resto como documento, nome padrão pela extensão', () => {
    expect(nonPatientAttachmentMeta({ type: 'image', mime: 'image/jpeg; charset=x' })).toEqual({
      mediatype: 'image',
      mimetype: 'image/jpeg',
      fileName: 'arquivo.jpeg',
    });
    expect(nonPatientAttachmentMeta({ type: 'document', mime: 'application/pdf', originalName: 'cv.pdf' })).toEqual({
      mediatype: 'document',
      mimetype: 'application/pdf',
      fileName: 'cv.pdf',
    });
    expect(nonPatientAttachmentMeta({ type: 'document' })).toEqual({ mediatype: 'document', mimetype: null, fileName: 'arquivo.bin' });
  });
});

describe('NonPatientClassifier — categorias e prompt', () => {
  it('aceita NEGOCIO e as do shared; desconhecida/erro → PACIENTE', () => {
    expect(CLASSIFIER_CATEGORIES).toEqual(['PACIENTE', 'FORNECEDOR', 'CURRICULO', 'PARCERIA', 'NEGOCIO', 'SPAM']);
    expect(parseClassifierCategory('negocio')).toBe('NEGOCIO');
    expect(parseClassifierCategory(' CURRICULO ')).toBe('CURRICULO');
    expect(parseClassifierCategory('OUTRO')).toBe('PACIENTE');
    expect(parseClassifierCategory(undefined)).toBe('PACIENTE');
  });

  it('prompt: contrato/boleto do PRÓPRIO tratamento = PACIENTE; entrevista/estágio = CURRICULO; na dúvida PACIENTE', () => {
    expect(NON_PATIENT_CLASSIFIER_PROMPT).toMatch(/CONTRATO, PAGAMENTO, BOLETO, PARCELA, DESCONTO ou NEGOCIAÇÃO do PRÓPRIO tratamento também é PACIENTE/);
    expect(NON_PATIENT_CLASSIFIER_PROMPT).toMatch(/CURRICULO:.*ENTREVISTA ou ESTÁGIO/);
    expect(NON_PATIENT_CLASSIFIER_PROMPT).toMatch(/NEGOCIO:.*REUNIÃO de negociação, CONTRATO comercial/);
    expect(NON_PATIENT_CLASSIFIER_PROMPT).toContain('na menor DÚVIDA, responda PACIENTE');
    expect(NON_PATIENT_CLASSIFIER_PROMPT).toContain('"PACIENTE|FORNECEDOR|CURRICULO|PARCERIA|NEGOCIO|SPAM"');
  });
});
