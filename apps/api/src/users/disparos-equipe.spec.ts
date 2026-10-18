import {
  disparosEquipeDoPapel,
  recebeDisparoEquipe,
  normalizarDisparosIds,
  ehProfissionalQueAtende,
  destinatariosAvisoAdm,
  telefoneNaListaDeAviso,
  DEFAULT_DENTIST_DAILY_SUMMARY,
} from '@crm/shared';

/**
 * Disparos internos por pessoa (cadastro da equipe → "Disparos que recebe").
 * O dentista recebe a agenda numa mensagem só, às 8h — e dá pra tirar alguém.
 * Os avisos dos ADMs são opt-in: só recebe quem foi adicionado (marcado no cadastro
 * ou com o número na Central).
 */
describe('disparos da equipe (quem recebe)', () => {
  it('resumo do dentista sai às 8h por padrão', () => {
    expect(DEFAULT_DENTIST_DAILY_SUMMARY.send_at).toBe('08:00');
  });

  it('profissional = DENTIST, ou ADMIN que atende (com especialidade)', () => {
    expect(ehProfissionalQueAtende({ roles: ['DENTIST'] })).toBe(true);
    expect(ehProfissionalQueAtende({ roles: ['ADMIN'], specialties: ['Ortodontia'] })).toBe(true);
    expect(ehProfissionalQueAtende({ roles: ['ADMIN'], specialties: [] })).toBe(false);
    expect(ehProfissionalQueAtende({ roles: ['OPERADOR'] })).toBe(false);
  });

  it('cada papel vê só os disparos do seu nicho', () => {
    expect(disparosEquipeDoPapel({ roles: ['DENTIST'] }).map((d) => d.id)).toEqual(['resumo_dentista', 'task_alerts']);
    expect(disparosEquipeDoPapel({ roles: ['OPERADOR'] }).map((d) => d.id)).toEqual(['task_alerts']);
  });

  it('padrão recebe; desligado no cadastro não recebe', () => {
    expect(recebeDisparoEquipe({ disparos_off: [] }, 'resumo_dentista')).toBe(true);
    expect(recebeDisparoEquipe({}, 'resumo_dentista')).toBe(true);
    expect(recebeDisparoEquipe({ disparos_off: ['resumo_dentista'] }, 'resumo_dentista')).toBe(false);
    expect(recebeDisparoEquipe({ disparos_off: ['resumo_dentista'] }, 'task_alerts')).toBe(true);
  });

  it('aviso de ADM é opt-in: só quem marcou (ou tem o número na Central); desligar vence tudo', () => {
    expect(recebeDisparoEquipe({}, 'venda_feita')).toBe(false);
    expect(recebeDisparoEquipe({ disparos_on: ['venda_feita'] }, 'venda_feita')).toBe(true);
    expect(recebeDisparoEquipe({}, 'venda_feita', { naCentral: true })).toBe(true);
    expect(recebeDisparoEquipe({ disparos_on: ['venda_feita'], disparos_off: ['venda_feita'] }, 'venda_feita')).toBe(false);
    expect(recebeDisparoEquipe({ disparos_off: ['venda_feita'] }, 'venda_feita', { naCentral: true })).toBe(false);
    // "sem agendamento" já ia pra todo ADM: segue padrão (só sai quem desligar)
    expect(recebeDisparoEquipe({}, 'pacientes_sem_agendamento')).toBe(true);
  });

  it('saneia o que vem da tela (só ids conhecidos, sem repetir)', () => {
    expect(normalizarDisparosIds(['resumo_dentista', 'resumo_dentista', 'xpto', 3])).toEqual(['resumo_dentista']);
    expect(normalizarDisparosIds(['venda_feita', 'admin_agendamento_ia'])).toEqual(['venda_feita', 'admin_agendamento_ia']);
    expect(normalizarDisparosIds(null)).toEqual([]);
  });

  it('ADM vê os avisos da clínica (por nicho); ADM que atende vê os dois', () => {
    const adm = disparosEquipeDoPapel({ roles: ['ADMIN'] });
    expect(adm.map((d) => d.id)).toEqual([
      'task_alerts',
      'venda_feita',
      'resumo_diario',
      'carla_escalonamento',
      'admin_agendamento_ia',
      'admin_agendamento_equipe',
      'pacientes_sem_agendamento',
      'pacientes_sem_agendamento_orto',
      'nao_paciente_triage',
    ]);
    expect([...new Set(adm.map((d) => d.nicho))]).toEqual(['Tarefas', 'Vendas e financeiro', 'Agenda da clínica', 'Contatos']);
    const admDentista = disparosEquipeDoPapel({ roles: ['ADMIN'], specialties: ['Ortodontia'] }).map((d) => d.id);
    expect(admDentista).toContain('resumo_dentista');
    expect(admDentista).toContain('venda_feita');
  });

  it('telefone do cadastro na lista da Central (com/sem 9 e 55)', () => {
    expect(telefoneNaListaDeAviso('(82) 99999-8888', ['558299998888', '5582911112222'])).toBe(true);
    expect(telefoneNaListaDeAviso('82988887777', ['5582999998888'])).toBe(false);
    expect(telefoneNaListaDeAviso('', ['5582999998888'])).toBe(false);
  });
});

describe('quem recebe um aviso dos ADMs (destinatariosAvisoAdm)', () => {
  const ana = { id: 'u-ana', name: 'Ana', phone: '(82) 99999-8888', roles: ['ADMIN'], disparos_on: ['venda_feita', 'resumo_diario'] };
  const bia = { id: 'u-bia', name: 'Bia', phone: '82 98888-7777', roles: ['ADMIN'], disparos_off: ['venda_feita'] };
  const caio = { id: 'u-caio', name: 'Caio', phone: '5582977776666', roles: ['DENTIST'] };
  const davi = { id: 'u-davi', name: 'Davi', phone: '82966665555', roles: ['ADMIN'] }; // ADM que não marcou nada

  it('números da Central + ADMs que marcaram o aviso, sem repetir o assinante (com/sem 9 e 55)', () => {
    const r = destinatariosAvisoAdm('venda_feita', ['5582911112222', '558299998888'], [ana, bia, caio, davi]);
    expect(r).toEqual([
      { phone: '5582911112222', userId: null, nome: null }, // número da Central sem dono no cadastro
      { phone: '558299998888', userId: 'u-ana', nome: 'Ana' }, // o da Ana (gravado sem o 9) conta 1 vez
    ]);
  });

  it('ADM que não marcou não recebe (opt-in) — a não ser que o número dele esteja na Central', () => {
    expect(destinatariosAvisoAdm('admin_agendamento_ia', [], [ana, bia, davi])).toEqual([]);
    expect(destinatariosAvisoAdm('admin_agendamento_ia', ['82966665555'], [davi])).toEqual([
      { phone: '5582966665555', userId: 'u-davi', nome: 'Davi' },
    ]);
  });

  it('quem desligou sai — mesmo com o número na Central', () => {
    const r = destinatariosAvisoAdm('venda_feita', ['5582988887777', '5582911112222'], [ana, bia]);
    expect(r.map((d) => d.phone)).toEqual(['5582911112222', '5582999998888']);
    expect(r.some((d) => d.userId === 'u-bia')).toBe(false);
  });

  it('"sem agendamento" segue indo pra todo ADM (padrão), menos quem desligou', () => {
    const biaSemOrto = { ...bia, disparos_off: ['pacientes_sem_agendamento'] };
    expect(destinatariosAvisoAdm('pacientes_sem_agendamento', [], [ana, biaSemOrto, davi]).map((d) => d.userId)).toEqual([
      'u-ana',
      'u-davi',
    ]);
  });

  it('só ADM entra pelo cadastro; quem não é ADM só sai (se desligou)', () => {
    expect(destinatariosAvisoAdm('venda_feita', [], [{ ...caio, disparos_on: ['venda_feita'] }])).toEqual([]);
    const caioDesligou = { ...caio, disparos_off: ['venda_feita'] };
    expect(destinatariosAvisoAdm('venda_feita', ['82977776666'], [caioDesligou])).toEqual([]);
    expect(destinatariosAvisoAdm('venda_feita', ['82977776666'], [caio])).toEqual([
      { phone: '5582977776666', userId: 'u-caio', nome: 'Caio' },
    ]);
  });

  it('mesmo número em 2 contas: vale o ADM que marcou o aviso', () => {
    const anaDentista = { id: 'u-ana2', name: 'Ana (dentista)', phone: '82999998888', roles: ['DENTIST'], disparos_off: ['venda_feita'] };
    expect(destinatariosAvisoAdm('venda_feita', ['82999998888'], [anaDentista, ana]).map((d) => d.userId)).toEqual(['u-ana']);
    const anaDesligou = { ...ana, disparos_off: ['venda_feita'] };
    expect(destinatariosAvisoAdm('venda_feita', ['82999998888'], [anaDesligou])).toEqual([]);
  });

  it('telefone inválido no cadastro ou na Central é ignorado; ninguém = []', () => {
    const semTel = { ...ana, phone: '8299' };
    expect(destinatariosAvisoAdm('venda_feita', ['123', ''], [semTel, { ...ana, id: 'x', phone: null }])).toEqual([]);
  });
});
