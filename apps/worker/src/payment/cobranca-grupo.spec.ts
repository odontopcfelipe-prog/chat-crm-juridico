import {
  buildGroupMessage,
  memberKey,
  planGroup,
  GROUP_MAX_PDFS,
  GROUP_MAX_PIX_MSGS,
  type GroupMember,
} from './cobranca-grupo';

const m = (over: Partial<GroupMember>): GroupMember => ({
  chargeId: over.chargeId || 'c1',
  amount: 5,
  dueDate: new Date('2026-09-10T12:00:00Z'),
  link: 'https://www.asaas.com/i/abc',
  ...over,
});

describe('aviso agrupado da régua de cobrança', () => {
  it('boletos com PDF vão anexos — sem link e sem PIX no texto', () => {
    const plan = planGroup([
      m({ chargeId: 'a', pdfUrl: 'https://x/a.pdf', codigo: 'PIXA' }),
      m({ chargeId: 'b', pdfUrl: 'https://x/b.pdf', codigo: 'PIXB' }),
    ]);
    expect(plan.pdfs.map((x) => x.chargeId)).toEqual(['a', 'b']);
    expect(plan.pix).toHaveLength(0);
    expect(plan.links).toHaveLength(0);
    const txt = buildGroupMessage('Fellipe', 'Instituto Odonto Passos', 11.09, plan);
    expect(txt).toContain('você tem 2 boletos em aberto');
    expect(txt).toContain('Seguem os boletos em anexo');
    expect(txt).not.toContain('http');
    expect(txt).not.toContain('PIX');
  });

  it('caso do print: 2 sem PDF mas com PIX → códigos em mensagens separadas, nenhum link', () => {
    const plan = planGroup([
      m({ chargeId: 'a', amount: 5, codigo: 'PIXA', link: 'https://www.asaas.com/i/juc9' }),
      m({ chargeId: 'b', amount: 6.09, codigo: 'PIXB', dueDate: new Date('2026-09-15T12:00:00Z'), link: 'https://www.asaas.com/i/xmgg' }),
    ]);
    expect(plan.pix.map((x) => x.codigo)).toEqual(['PIXA', 'PIXB']);
    const txt = buildGroupMessage('Fellipe', 'Instituto Odonto Passos', 11.09, plan);
    expect(txt).not.toContain('asaas.com');
    expect(txt).not.toContain('Acesse pelos links');
    expect(txt).toContain('próximas mensagens');
    expect(txt).toContain('venc. 10/09');
    expect(txt).toContain('venc. 15/09');
    // o código em si NÃO vai na msg 1 (vai limpo na msg própria)
    expect(txt).not.toContain('PIXA');
  });

  it('sem PDF e sem PIX → link como último recurso (nunca fica sem forma de pagar)', () => {
    const plan = planGroup([
      m({ chargeId: 'a', pdfUrl: 'https://x/a.pdf' }),
      m({ chargeId: 'b', link: 'https://www.asaas.com/i/so-link' }),
    ]);
    const txt = buildGroupMessage('Ana', 'Clínica', 20, plan);
    expect(plan.links.map((x) => x.chargeId)).toEqual(['b']);
    expect(txt).toContain('Segue o boleto em anexo');
    expect(txt).toContain('Pra pagar a outra, acesse:\nhttps://www.asaas.com/i/so-link');
    expect(txt).toContain('2 cobranças');
  });

  it('PDF + PIX juntos: o texto diz que o PIX vem DEPOIS do boleto (não "próxima mensagem")', () => {
    const plan = planGroup([
      m({ chargeId: 'a', pdfUrl: 'https://x/a.pdf' }),
      m({ chargeId: 'b', codigo: 'PIXB' }),
    ]);
    const txt = buildGroupMessage('Ana', 'Clínica', 10, plan);
    expect(txt).toContain('O código *PIX* da outra vai logo depois do boleto');
    expect(txt).not.toContain('próxima mensagem');
  });

  it('PDFs além do teto vão pro PIX/link (anti-ban)', () => {
    const many = Array.from({ length: GROUP_MAX_PDFS + 1 }, (_, i) =>
      m({ chargeId: `c${i}`, pdfUrl: `https://x/${i}.pdf`, link: `https://l/${i}` }),
    );
    const plan = planGroup(many);
    expect(plan.pdfs).toHaveLength(GROUP_MAX_PDFS);
    expect(plan.links.map((x) => x.chargeId)).toEqual([`c${GROUP_MAX_PDFS}`]);
  });

  it('chave da cobrança é o id do Asaas (duplicata no banco não sai 2×)', () => {
    expect(memberKey(m({ chargeId: 'x', externalId: 'pay_1' }))).toBe(memberKey(m({ chargeId: 'y', externalId: 'pay_1' })));
    expect(memberKey(m({ chargeId: 'x' }))).not.toBe(memberKey(m({ chargeId: 'y' })));
  });

  it('PIX além do teto cai no link (anti-ban)', () => {
    const many = Array.from({ length: GROUP_MAX_PIX_MSGS + 2 }, (_, i) =>
      m({ chargeId: `c${i}`, codigo: `PIX${i}`, link: `https://l/${i}` }),
    );
    const plan = planGroup(many);
    expect(plan.pix).toHaveLength(GROUP_MAX_PIX_MSGS);
    expect(plan.links).toHaveLength(2);
  });
});
