import { canAccessRoute, resolveHomeActions, resolvePermissions, SECTORS, type Permission } from '@crm/shared';

// Relógio de ponto: a tela do funcionário abre pra todos (o backend só deixa bater
// quem está na equipe do ponto); a central e a configuração seguem manage_users,
// a mesma permissão do backend. O balão NÃO é fixo do setor (vem do /ponto/status).
describe('relógio de ponto — acesso', () => {
  for (const s of SECTORS) {
    const has = (p: Permission) => resolvePermissions(s.id).has(p);

    it(`${s.id}: abre /atendimento/ponto; central e config só com manage_users`, () => {
      expect(canAccessRoute('/atendimento/ponto', has)).toBe(true);
      expect(canAccessRoute('/atendimento/ponto/equipe', has)).toBe(has('manage_users'));
      expect(canAccessRoute('/atendimento/settings/ponto', has)).toBe(has('manage_users'));
    });

    it(`${s.id}: o balão do ponto não vem fixo do setor`, () => {
      expect(resolveHomeActions(s.id).some((a) => a.href.startsWith('/atendimento/ponto'))).toBe(false);
    });
  }

  it('admin gerencia o ponto; recepção e dentista não', () => {
    expect(resolvePermissions('admin').has('manage_users')).toBe(true);
    expect(resolvePermissions('recepcao').has('manage_users')).toBe(false);
    expect(resolvePermissions('dentista').has('manage_users')).toBe(false);
  });
});
