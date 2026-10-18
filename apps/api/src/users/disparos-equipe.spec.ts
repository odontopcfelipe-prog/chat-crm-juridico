import {
  disparosEquipeDoPapel,
  recebeDisparoEquipe,
  normalizarDisparosOff,
  ehProfissionalQueAtende,
  DEFAULT_DENTIST_DAILY_SUMMARY,
} from '@crm/shared';

/**
 * Disparos internos por pessoa (cadastro da equipe → "Disparos que recebe").
 * O dentista recebe a agenda numa mensagem só, às 8h — e dá pra tirar alguém.
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

  it('saneia o que vem da tela (só ids conhecidos, sem repetir)', () => {
    expect(normalizarDisparosOff(['resumo_dentista', 'resumo_dentista', 'xpto', 3])).toEqual(['resumo_dentista']);
    expect(normalizarDisparosOff(null)).toEqual([]);
  });
});
