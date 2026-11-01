/**
 * F7 do laboratório — texto do aviso "Novo agendamento" aos administradores para a
 * coleta, a prova e a entrega. O texto da clínica (montarTextoNovoAgendamento) não
 * muda.
 */
import { montarTextoNovoAgendamentoDoLaboratorio } from './admin-agendamento-laboratorio';
import { montarTextoNovoAgendamento, type DadosAvisoAgendamento } from './admin-agendamento-regras';

// Mesmo vocabulário barrado pela trava 2 (scripts/ci/check-pick-literals.mjs).
const PROIBIDOS = /(?<![\p{L}\p{N}])(pacientes?|consultas?|prontuarios?|anamneses?|odontogramas?|planos? de tratamentos?|tratamentos? odontologicos?|tcle)(?![\p{L}\p{N}])/u;
const semAcento = (t: string) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Dados de exemplo (repositório público: nada real). 22/10/2026 é uma quinta-feira.
const dados = (over: Partial<DadosAvisoAgendamento> = {}): DadosAvisoAgendamento => ({
  pacienteNome: 'Dra. Ana Souza',
  telefone: '5582900000021',
  startNaive: new Date('2026-10-22T14:30:00.000Z'),
  allDay: false,
  tipo: 'COLETA',
  tipoNome: null,
  dentista: 'Expedição Exemplo',
  origem: 'EQUIPE',
  criadoPor: 'Recepção Exemplo',
  recorrencia: null,
  ...over,
});

describe('Aviso "Novo agendamento" do laboratório (montarTextoNovoAgendamentoDoLaboratorio)', () => {
  it.each([
    ['COLETA', 'Coleta'],
    ['PROVA', 'Prova'],
    ['ENTREGA', 'Entrega'],
  ])('%s: texto exato', (tipo, rotulo) => {
    expect(montarTextoNovoAgendamentoDoLaboratorio(dados({ tipo }))).toBe(
      [
        '📅 *Novo agendamento*',
        'Cliente: Dra. Ana Souza (5582900000021)',
        'Quando: quinta-feira 22/10 às 14:30',
        `Tipo: ${rotulo}`,
        'Com: Expedição Exemplo',
        'Marcado por: Recepção Exemplo',
      ].join('\n'),
    );
  });

  it('sem nome, sem telefone, sem responsável e sem quem marcou; dia inteiro', () => {
    expect(
      montarTextoNovoAgendamentoDoLaboratorio(dados({ pacienteNome: '', telefone: null, dentista: null, criadoPor: null, allDay: true })),
    ).toBe(
      [
        '📅 *Novo agendamento*',
        'Cliente: Cliente sem nome',
        'Quando: quinta-feira 22/10 (dia inteiro)',
        'Tipo: Coleta',
        'Com: sem protético definido',
        'Marcado por: equipe',
      ].join('\n'),
    );
  });

  it('série recorrente: avisa só a 1ª, com o rótulo da repetição', () => {
    expect(montarTextoNovoAgendamentoDoLaboratorio(dados({ recorrencia: 'WEEKLY' })).split('\n').at(-1)).toBe('Repete: semanal (aviso só da 1ª)');
    expect(montarTextoNovoAgendamentoDoLaboratorio(dados({ recorrencia: 'XYZ' })).split('\n').at(-1)).toBe('Repete: sim (aviso só da 1ª)');
  });

  it('nenhum vocabulário de clínica no texto do laboratório', () => {
    for (const tipo of ['COLETA', 'PROVA', 'ENTREGA']) {
      const t = montarTextoNovoAgendamentoDoLaboratorio(dados({ tipo, pacienteNome: '', dentista: null, recorrencia: 'MONTHLY' }));
      expect(PROIBIDOS.test(semAcento(t))).toBe(false);
    }
  });

  it('o texto da clínica continua o mesmo', () => {
    expect(montarTextoNovoAgendamento(dados({ tipo: 'CONSULTA', pacienteNome: 'Maria Exemplo', dentista: 'Dra. Ana Exemplo' }))).toBe(
      [
        '📅 *Novo agendamento*',
        'Paciente: Maria Exemplo (5582900000021)',
        'Quando: quinta-feira 22/10 às 14:30',
        'Tipo: Consulta',
        'Com: Dra. Ana Exemplo',
        'Marcado por: Recepção Exemplo',
      ].join('\n'),
    );
  });
});
