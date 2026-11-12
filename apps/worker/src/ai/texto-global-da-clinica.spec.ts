import {
  TENANT_DO_TEXTO_GLOBAL,
  adaptadorDoTextoGlobal,
  textoGlobalEhDaClinica,
} from './texto-global-da-clinica';
import { SCHEDULING_RULES } from './conversation-guide';

const OUTRA = 'd124bd41-705b-4f99-80f1-a0d1a55179db';

// Trechos reais das skills globais (sementes em apps/api/src/settings).
const SDR =
  'Sophia é AGENTE SDR ODONTOLÓGICO do Instituto Odonto Passos. Faz o primeiro contato via WhatsApp.\n' +
  '- Lead diz "Oi" às 14h: "Boa tarde! Aqui é a Sophia do Instituto Odonto Passos, qual o seu nome?"\n' +
  'Se o lead perguntar quanto custa A AVALIAÇÃO/CONSULTA: a avaliação presencial custa R$ 150 (sem compromisso). ' +
  'Resposta padrão: "A avaliação custa R$ 150, sem compromisso de fechar tratamento."';

describe('texto global da IA adaptado à clínica', () => {
  it('no Instituto o texto passa intacto (inclusive conversa legada sem clínica)', () => {
    for (const tenantId of [TENANT_DO_TEXTO_GLOBAL, null, undefined]) {
      const adaptar = adaptadorDoTextoGlobal({ tenantId, firmName: 'Instituto Odonto Passos' });
      expect(adaptar(SDR)).toBe(SDR);
    }
    // Instituto identificado pelo nome, mesmo com outro id (ex.: filial)
    expect(textoGlobalEhDaClinica({ tenantId: OUTRA, firmName: 'Instituto Odonto Passos - Filial' })).toBe(true);
  });

  it('em outra clínica troca o nome do Instituto pelo dela, com a preposição certa', () => {
    const adaptar = adaptadorDoTextoGlobal({ tenantId: OUTRA, firmName: 'Clínica Pra Sorrir' });
    const t = adaptar(SDR);
    expect(t).not.toMatch(/instituto|odonto passos/i);
    expect(t).toContain('AGENTE SDR ODONTOLÓGICO da Clínica Pra Sorrir');
    expect(t).toContain('Aqui é a Sophia da Clínica Pra Sorrir, qual o seu nome?');
    expect(adaptar('Atendemos no Instituto Odonto Passos e pelo Instituto Odonto Passos. Conheça o Instituto Odonto Passos.')).toBe(
      'Atendemos na Clínica Pra Sorrir e pela Clínica Pra Sorrir. Conheça a Clínica Pra Sorrir.',
    );
    expect(adaptar('Do Instituto Odonto Passos.')).toBe('Da Clínica Pra Sorrir.');
  });

  it('nome masculino mantém "do/no"; clínica sem nome vira "nossa clínica"', () => {
    const masc = adaptadorDoTextoGlobal({ tenantId: OUTRA, firmName: 'Consultório Dr. Silva' });
    expect(masc('Aqui é a Sophia do Instituto Odonto Passos')).toBe('Aqui é a Sophia do Consultório Dr. Silva');
    const semNome = adaptadorDoTextoGlobal({ tenantId: OUTRA, firmName: '' });
    expect(semNome('Aqui é a Sophia do Instituto Odonto Passos')).toBe('Aqui é a Sophia da nossa clínica');
  });

  it('valores do Instituto viram aviso para usar a orientação de VALORES da clínica', () => {
    const adaptar = adaptadorDoTextoGlobal({ tenantId: OUTRA, firmName: 'Clínica X' });
    const t = adaptar(SDR);
    expect(t).not.toMatch(/150/);
    expect(t).toContain('custa R$ [valor da orientação de VALORES]');
    expect(adaptar('Isto está sendo cobrado apenas 350,00 reais. Implante R$1.500,00 ou R$ 1500.')).toBe(
      'Isto está sendo cobrado apenas [valor da orientação de VALORES]. Implante R$ [valor da orientação de VALORES] ou R$ [valor da orientação de VALORES].',
    );
    // "R$ 1.234,56" é só exemplo de formato (skill do Financeiro) — fica
    expect(adaptar('Valores em R$ 1.234,56 e datas em DD/MM.')).toBe('Valores em R$ 1.234,56 e datas em DD/MM.');
  });

  it('o modelo de venda do guia (limpeza R$ 350 do Instituto) sai sem o valor dele, e a tabela da clínica fica intacta', () => {
    const adaptar = adaptadorDoTextoGlobal({ tenantId: OUTRA, firmName: 'Clínica X' });
    const regras = adaptar(SCHEDULING_RULES);
    expect(regras).not.toMatch(/R\$\s?350/);
    // A tabela da própria clínica entra DEPOIS, pela variável — não é tocada.
    expect(regras).toContain('{{price_table}}');
    expect(regras).toContain('{{firm_name}}');
  });

  it('avaliadora, telefone e links do Instituto não passam para outra clínica', () => {
    const comDentista = adaptadorDoTextoGlobal({ tenantId: OUTRA, firmName: 'Clínica X', doctorName: 'Dra. Ana Souza' });
    expect(comDentista('A avaliação é com a Dra. Suellen Passos.')).toBe('A avaliação é com a Dra. Ana Souza.');
    const semDentista = adaptadorDoTextoGlobal({ tenantId: OUTRA, firmName: 'Clínica X' });
    expect(semDentista('A avaliação é com a Dra. Suellen.')).toBe('A avaliação é com a dentista avaliadora.');
    expect(semDentista('Chame no (82) 99999-1234 ou +55 82 3333-4444.')).toBe(
      'Chame no [telefone: use só o dos DADOS DA CLÍNICA] ou [telefone: use só o dos DADOS DA CLÍNICA].',
    );
    expect(semDentista('Siga @institutoodontopassos e veja institutoodontopassos.com.br')).toBe(
      'Siga [link/@ de outra clínica: não informe] e veja [link/@ de outra clínica: não informe]',
    );
  });

  it('não mexe em horário, data nem nas variáveis do prompt', () => {
    const adaptar = adaptadorDoTextoGlobal({ tenantId: OUTRA, firmName: 'Clínica X' });
    const t = 'Terça 14/11 (2026-11-14) às 14:00 | {{available_slots}} | {{data_hoje}} | {{clinic_phone}}';
    expect(adaptar(t)).toBe(t);
  });
});
