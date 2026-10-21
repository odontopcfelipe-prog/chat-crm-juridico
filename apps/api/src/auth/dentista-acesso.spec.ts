/**
 * Out/2026 — regra do dono pro setor Dentista + a máscara de dados sensíveis.
 *
 * Trava de regressão: o Dentista NÃO pode voltar a ver todos os pacientes,
 * o contato do paciente, valores, propostas nem chat; e os OUTROS setores não
 * podem perder o que já viam quando as permissões novas foram criadas.
 */
import { resolvePermissions, canAccessRoute, SECTORS, type Permission } from '@crm/shared';
import { maskKeys, CONTACT_KEYS, VALUE_KEYS } from '../common/interceptors/sensitive-data.interceptor';
import { ownPatientsWhere } from './patient-scope';

describe('setor Dentista (regra do dono, out/2026)', () => {
  const dent = resolvePermissions('dentista');

  it('vê agenda, pacientes (dele), prontuário e monta a avaliação', () => {
    for (const p of ['view_agenda', 'view_patients', 'view_clinical', 'edit_clinical', 'create_evaluation'] as Permission[]) {
      expect(dent.has(p)).toBe(true);
    }
  });

  it('NÃO vê todos os pacientes, contato, valores, propostas, chat nem financeiro', () => {
    for (const p of [
      'view_all_patients', 'view_patient_contact', 'view_values',
      'manage_proposals', 'view_proposals', 'override_price',
      'view_chat', 'view_financial', 'manage_agenda',
    ] as Permission[]) {
      expect(dent.has(p)).toBe(false);
    }
  });

  it('admin pode reliberar por pessoa (extra_grants)', () => {
    const p = resolvePermissions('dentista', ['view_values']);
    expect(p.has('view_values')).toBe(true);
  });

  it('os outros setores continuam vendo todos os pacientes, contato e valores', () => {
    for (const s of SECTORS.filter((x) => x.id !== 'dentista')) {
      const perms = resolvePermissions(s.id);
      expect([s.id, perms.has('view_all_patients')]).toEqual([s.id, true]);
      expect([s.id, perms.has('view_patient_contact')]).toEqual([s.id, true]);
      expect([s.id, perms.has('view_values')]).toEqual([s.id, true]);
    }
  });

  it('home do dentista: lista "Minha agenda", pacientes e "Pontuação" — sem orçamentos nem comissão', () => {
    const acts = SECTORS.find((s) => s.id === 'dentista')!.home.actions;
    const hrefs = acts.map((a) => a.href);
    expect(hrefs).toContain('/atendimento/minha-agenda');
    expect(hrefs).toContain('/atendimento/pacientes');
    expect(hrefs).toContain('/atendimento/meu-jogo');
    expect(hrefs.some((h) => h.startsWith('/atendimento/orcamentos'))).toBe(false);
    // Com o profissional não se fala em comissão (decisão do dono, out/2026).
    expect(hrefs).not.toContain('/atendimento/minha-comissao');
    expect(acts.some((a) => /comiss/i.test(a.label + ' ' + (a.desc ?? '')))).toBe(false);
  });

  it('dentista não abre "Minha comissão" (R$) — financeiro abre', () => {
    expect(canAccessRoute('/atendimento/minha-comissao', (p) => resolvePermissions('dentista').has(p))).toBe(false);
    expect(canAccessRoute('/atendimento/minha-comissao', (p) => resolvePermissions('financeiro').has(p))).toBe(true);
  });

  it('quadrantes do dentista só têm números DELE (badges my_*) e abrem pra ele', () => {
    const has = (p: Permission) => resolvePermissions('dentista').has(p);
    for (const a of SECTORS.find((s) => s.id === 'dentista')!.home.actions) {
      expect([a.label, a.badgeKey?.startsWith('my_')]).toEqual([a.label, true]);
      expect([a.href, canAccessRoute(a.href, has)]).toEqual([a.href, true]);
    }
  });
});

describe('acesso por tela (ROUTE_ACCESS)', () => {
  const dentHas = (p: Permission) => resolvePermissions('dentista').has(p);
  const recHas = (p: Permission) => resolvePermissions('recepcao').has(p);
  const finHas = (p: Permission) => resolvePermissions('financeiro').has(p);

  it('dentista abre as telas dele', () => {
    for (const r of ['/atendimento/dashboard', '/atendimento/minha-agenda', '/atendimento/pacientes',
      '/atendimento/pacientes/abc', '/atendimento/meu-jogo']) {
      expect([r, canAccessRoute(r, dentHas)]).toEqual([r, true]);
    }
  });

  it('dentista NÃO abre chat, contatos, CRC, orçamentos, financeiro, retornos', () => {
    for (const r of ['/atendimento', '/atendimento/chat/1', '/atendimento/contacts', '/atendimento/crm',
      '/atendimento/orcamentos', '/atendimento/fechamentos', '/atendimento/venda-rapida',
      '/atendimento/financeiro/boletos', '/atendimento/return-alerts', '/atendimento/relatorios']) {
      expect([r, canAccessRoute(r, dentHas)]).toEqual([r, false]);
    }
  });

  it('recepção e financeiro mantêm os balões deles', () => {
    for (const a of SECTORS.find((s) => s.id === 'recepcao')!.home.actions) {
      expect([a.href, canAccessRoute(a.href, recHas)]).toEqual([a.href, true]);
    }
    for (const a of SECTORS.find((s) => s.id === 'financeiro')!.home.actions) {
      expect([a.href, canAccessRoute(a.href, finHas)]).toEqual([a.href, true]);
    }
  });

  it('"/atendimento" exato é o inbox; subrotas não herdam a regra', () => {
    expect(canAccessRoute('/atendimento/', dentHas)).toBe(false);
    expect(canAccessRoute('/atendimento/tasks', dentHas)).toBe(true);
  });
});

describe('maskKeys (SensitiveDataInterceptor)', () => {
  const keys = new Set([...CONTACT_KEYS, ...VALUE_KEYS]);

  it('apaga contato e valores em qualquer nível, sem mexer no resto', () => {
    const src = {
      data: [{
        id: 'p1', name: 'Maria', cpf: '123', phone: '5582999990000', email: 'm@x.com',
        address: 'Rua A', lead: { phone: '5582999990000', name: 'Maria' },
        quotes: [{ total_value: 1200, items: [{ unit_price: 600, total_price: 1200, quantity: 2 }] }],
      }],
      total: 1, page: 1,
    };
    const out: any = maskKeys(src, keys);
    expect(out.total).toBe(1); // paginação NÃO é valor
    expect(out.data[0].name).toBe('Maria');
    expect(out.data[0].cpf).toBe('123');
    expect(out.data[0].phone).toBeNull();
    expect(out.data[0].email).toBeNull();
    expect(out.data[0].address).toBeNull();
    expect(out.data[0].lead.phone).toBeNull();
    expect(out.data[0].quotes[0].total_value).toBeNull();
    expect(out.data[0].quotes[0].items[0].unit_price).toBeNull();
    expect(out.data[0].quotes[0].items[0].quantity).toBe(2);
  });

  it('não muta o objeto original (pode vir de cache compartilhado)', () => {
    const src = { phone: '1' };
    maskKeys(src, keys);
    expect(src.phone).toBe('1');
  });

  it('preserva Date e campos ausentes', () => {
    const d = new Date('2026-10-18T10:00:00Z');
    const out: any = maskKeys({ start_at: d, x: undefined }, keys);
    expect(out.start_at).toBe(d);
    expect('x' in out).toBe(true);
  });
});

describe('ownPatientsWhere', () => {
  it('cobre cadastro, ortô, agenda (paciente e lead), orçamento e execução', () => {
    const w: any = ownPatientsWhere('u1');
    const json = JSON.stringify(w);
    for (const k of ['primary_dentist_id', 'ortho_dentist_id', 'appointments', 'calendar_events',
      'dentist_id', 'created_by_user_id', 'executed_by_user_id']) {
      expect([k, json.includes(k)]).toEqual([k, true]);
    }
  });
});
