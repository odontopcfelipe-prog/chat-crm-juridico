import { canAccessRoute, resolveHomeActions, resolvePermissions, SECTORS, type Permission } from '@crm/shared';

// Relógio de ponto: todo setor bate o ponto (balão + tela); a gestão da equipe
// segue a mesma permissão do backend (manage_users).
describe('relógio de ponto — acesso', () => {
  for (const s of SECTORS) {
    const has = (p: Permission) => resolvePermissions(s.id).has(p);

    it(`${s.id}: tem o balão do Ponto e abre /atendimento/ponto`, () => {
      expect(resolveHomeActions(s.id).some((a) => a.href === '/atendimento/ponto')).toBe(true);
      expect(canAccessRoute('/atendimento/ponto', has)).toBe(true);
    });

    it(`${s.id}: equipe só com manage_users`, () => {
      expect(canAccessRoute('/atendimento/ponto/equipe', has)).toBe(has('manage_users'));
    });
  }

  it('o balão do Ponto não duplica', () => {
    const n = resolveHomeActions('admin').filter((a) => a.href === '/atendimento/ponto').length;
    expect(n).toBe(1);
  });
});
