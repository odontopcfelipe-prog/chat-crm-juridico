/**
 * F4 do laboratório — LabVocabInterceptor (business-type/lab-vocab.interceptor.ts) e
 * o mapa de mensagens (mensagens-api-clinica.ts × lab-api-messages.ts).
 *
 * CLÍNICA: o interceptor devolve o MESMO Observable de next.handle() — erro e corpo
 * chegam com a mesma referência, sem operador nenhum no meio.
 * LABORATÓRIO: a message do HttpException e message/error do corpo de sucesso trocam
 * pelo texto do laboratório (mensagem inteira; mapa exato e moldes), com o mesmo
 * status e o mesmo code. O que sobra com palavra de clínica vira log [LAB-VOCAB].
 * MAPA: cada texto de clínica ainda existe igual em apps/api/src (se a frase mudar no
 * serviço, este spec avisa) e nenhum texto do laboratório tem vocabulário de clínica.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Observable, firstValueFrom, lastValueFrom, of, throwError } from 'rxjs';
import { LabVocabInterceptor, temPalavraDeClinica, trocarTexto } from '../business-type/lab-vocab.interceptor';
import { MENSAGENS_API_CLINICA, MOLDES_API_CLINICA } from '../business-type/mensagens-api-clinica';
import { LAB_API_MESSAGES, LAB_API_MOLDES } from '../business-type/lab-api-messages';
import { AllExceptionsFilter } from '../common/filters/all-exceptions.filter';

const SRC = path.resolve(__dirname, '..');
const RAIZ = path.resolve(SRC, '..', '..', '..');

class FakeController {
  metodo() {}
  outro() {}
}

function contexto(user: unknown, tipo = 'http', handler: () => void = FakeController.prototype.metodo) {
  return {
    getType: () => tipo,
    switchToHttp: () => ({ getRequest: () => (user === SEM_REQUEST ? undefined : { user }), getResponse: () => ({ statusCode: 200 }) }),
    getClass: () => FakeController,
    getHandler: () => handler,
  } as any;
}
const SEM_REQUEST = Symbol('sem-request');
const LAB = { id: 'u1', tenant_id: 't-lab', bt: 'LABORATORIO' };

const pegarErro = async (obs: Observable<unknown>): Promise<unknown> => {
  try {
    await lastValueFrom(obs);
  } catch (e) {
    return e;
  }
  throw new Error('esperava erro');
};

describe('LabVocabInterceptor — clínica sai na 1ª linha', () => {
  const interceptor = new LabVocabInterceptor();
  const clinicas: Array<[string, unknown]> = [
    ['sem usuário (rota pública)', undefined],
    ['sem request', SEM_REQUEST],
    ['usuário sem bt', { id: 'u1', tenant_id: 't1' }],
    ['bt CLINICA', { bt: 'CLINICA' }],
    ['bt minúsculo', { bt: 'laboratorio' }],
    ['bt com espaço', { bt: 'LABORATORIO ' }],
    ['bt objeto', { bt: { bt: 'LABORATORIO' } }],
    ['bt true', { bt: true }],
    ['bt 1', { bt: 1 }],
  ];

  it.each(clinicas)('%s: devolve o MESMO Observable, o MESMO erro e o MESMO corpo', async (_n, user) => {
    const corpo = { message: 'Horário da clínica salvo', x: 1 };
    const okObs = of(corpo);
    expect(interceptor.intercept(contexto(user), { handle: () => okObs })).toBe(okObs);
    expect(await firstValueFrom(interceptor.intercept(contexto(user), { handle: () => okObs }))).toBe(corpo);

    const err = new NotFoundException('Paciente não encontrado');
    const errObs = throwError(() => err);
    const saida = interceptor.intercept(contexto(user), { handle: () => errObs });
    expect(saida).toBe(errObs);
    const recebido = await pegarErro(saida);
    expect(recebido).toBe(err);
    expect((recebido as NotFoundException).getResponse()).toEqual({
      message: 'Paciente não encontrado',
      error: 'Not Found',
      statusCode: 404,
    });
  });

  it('contexto que não é http (socket) passa direto até com bt de laboratório', () => {
    const obs = of({ message: 'Paciente não encontrado' });
    expect(interceptor.intercept(contexto(LAB, 'ws'), { handle: () => obs })).toBe(obs);
    expect(interceptor.intercept(contexto(LAB, 'rpc'), { handle: () => obs })).toBe(obs);
  });

  it('não tem dependência no construtor (não entra em ciclo de DI)', () => {
    expect(LabVocabInterceptor.length).toBe(0);
    const tipos = Reflect.getMetadata('design:paramtypes', LabVocabInterceptor) as unknown[] | undefined;
    expect(tipos ?? []).toEqual([]);
  });
});

describe('LabVocabInterceptor — laboratório: erro', () => {
  let interceptor: LabVocabInterceptor;
  let warn: jest.SpyInstance;
  beforeEach(() => {
    interceptor = new LabVocabInterceptor();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const erroDe = (e: unknown, user: unknown = LAB, handler?: () => void) =>
    pegarErro(interceptor.intercept(contexto(user, 'http', handler), { handle: () => throwError(() => e) }));

  it.each(['Paciente não encontrado', 'Paciente nao encontrado'])('NotFoundException %j vira "Cliente não encontrado" (404, mesmo error, cause = original)', async (msg) => {
    const original = new NotFoundException(msg);
    const e = (await erroDe(original)) as HttpException;
    expect(e).toBeInstanceOf(HttpException);
    expect(e).not.toBe(original);
    expect(e.getStatus()).toBe(404);
    expect(e.getResponse()).toEqual({ message: 'Cliente não encontrado', error: 'Not Found', statusCode: 404 });
    expect(e.cause).toBe(original);
    expect(e.stack).toBe(original.stack);
    // O original não é mexido.
    expect(original.getResponse()).toEqual({ message: msg, error: 'Not Found', statusCode: 404 });
  });

  it('ForbiddenException com code mantém o code e o status', async () => {
    const e = (await erroDe(new ForbiddenException({ message: 'Paciente fora da sua carteira', code: 'PERMISSION_DENIED' }))) as HttpException;
    expect(e.getStatus()).toBe(403);
    expect(e.getResponse()).toEqual({ message: 'Cliente fora da sua carteira', code: 'PERMISSION_DENIED' });
  });

  it('message string[] (ValidationPipe) é trocada item a item; o que não está no mapa fica', async () => {
    const e = (await erroDe(new BadRequestException(['Paciente nao encontrado', 'nome must be a string']))) as HttpException;
    expect(e.getStatus()).toBe(400);
    expect((e.getResponse() as any).message).toEqual(['Cliente não encontrado', 'nome must be a string']);
    expect((e.getResponse() as any).error).toBe('Bad Request');
  });

  it('resposta string (new HttpException(texto, status)) também troca', async () => {
    const e = (await erroDe(new HttpException('Cobrança de outra clínica', 403))) as HttpException;
    expect(e.getStatus()).toBe(403);
    expect(e.getResponse()).toBe('Cobrança de outra conta');
  });

  it('mensagem fora do mapa devolve o MESMO erro; sem palavra de clínica, sem log', async () => {
    const original = new BadRequestException('Conversa sem tenant');
    expect(await erroDe(original)).toBe(original);
    expect(warn).not.toHaveBeenCalled();
  });

  it('mensagem fora do mapa com palavra de clínica: 1 log [LAB-VOCAB] por handler × mensagem × hora', async () => {
    const original = new BadRequestException('Paciente arquivado não pode receber mensagem');
    expect(await erroDe(original)).toBe(original);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^\[LAB-VOCAB\] FakeController\.metodo 400 mensagem de clínica sem tradução \(44 caracteres, id [0-9a-f]{8}\)$/);

    await erroDe(new BadRequestException('Paciente arquivado não pode receber mensagem'));
    expect(warn).toHaveBeenCalledTimes(1);

    // Outro handler conta à parte.
    await erroDe(new BadRequestException('Paciente arquivado não pode receber mensagem'), LAB, FakeController.prototype.outro);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toContain('[LAB-VOCAB] FakeController.outro 400 ');
  });

  it('o log nunca leva o texto da mensagem (pode ter nome de pessoa): só tamanho e um id', async () => {
    await erroDe(new BadRequestException('Paciente Maria da Silva não encontrada na sua carteira'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain('Maria');
    expect(warn.mock.calls[0][0]).not.toContain('Paciente');
    expect(warn.mock.calls[0][0]).toMatch(/id [0-9a-f]{8}\)$/);
  });

  it('batida de ponto fora da área: molde com distância e raio vira o texto do laboratório', async () => {
    const e = (await erroDe(new BadRequestException('Você está a 1,2 km da clínica (área de 150 m). O ponto só pode ser registrado no local.'))) as HttpException;
    expect(e.getStatus()).toBe(400);
    expect((e.getResponse() as any).message).toBe('Você está a 1,2 km do laboratório (área de 150 m). O ponto só pode ser registrado no local.');
  });

  it('o registro do log se limpa acima de 5000 marcas', async () => {
    for (let i = 0; i <= 5001; i++) await erroDe(new BadRequestException(`Paciente ${i}`));
    expect((interceptor as any).avisados.size).toBeLessThan(10);
  });

  it('erro que não é HttpException (Prisma, erro cru) volta IGUAL', async () => {
    const cru = new Error('Paciente não encontrado');
    expect(await erroDe(cru)).toBe(cru);
    const prisma = Object.assign(new Error('x'), { code: 'P2025', name: 'PrismaClientKnownRequestError' });
    expect(await erroDe(prisma)).toBe(prisma);
    const texto = 'Paciente não encontrado';
    expect(await erroDe(texto)).toBe(texto);
    expect(warn).not.toHaveBeenCalled();
  });

  it('HttpException sem message no corpo volta IGUAL', async () => {
    const original = new HttpException({ code: 'X' }, 409);
    expect(await erroDe(original)).toBe(original);
  });
});

describe('LabVocabInterceptor — laboratório: corpo de sucesso', () => {
  const interceptor = new LabVocabInterceptor();
  const corpoDe = (c: unknown) => firstValueFrom(interceptor.intercept(contexto(LAB), { handle: () => of(c) }));

  it('{ message: "Horário da clínica salvo", x: 1 } vira o texto do laboratório, sem mexer no original', async () => {
    const original = { message: 'Horário da clínica salvo', x: 1 };
    const saida = await corpoDe(original);
    expect(saida).toEqual({ message: 'Horário do laboratório salvo', x: 1 });
    expect(saida).not.toBe(original);
    expect(original).toEqual({ message: 'Horário da clínica salvo', x: 1 });
  });

  it('error do 1º nível também troca', async () => {
    expect(await corpoDe({ ok: false, error: 'Paciente nao encontrado' })).toEqual({ ok: false, error: 'Cliente não encontrado' });
  });

  it('sem troca: a MESMA referência (array, Buffer, sem message, 2º nível, classe, primitivos)', async () => {
    const casos: unknown[] = [
      [{ message: 'Paciente não encontrado' }],
      Buffer.from('Paciente não encontrado'),
      { id: 1, nome: 'x' },
      { data: { message: 'Paciente não encontrado' } },
      { message: 'Mensagem enviada' },
      { message: { text: 'Paciente não encontrado' } },
      Object.assign(new (class Resposta {})(), { message: 'Paciente não encontrado' }),
    ];
    for (const c of casos) expect(await corpoDe(c)).toBe(c);
    expect(await corpoDe(undefined)).toBeUndefined();
    expect(await corpoDe('Paciente não encontrado')).toBe('Paciente não encontrado');
    expect(await corpoDe(null)).toBeNull();
  });
});

describe('LabVocabInterceptor — moldes', () => {
  it('molde do whatsapp com função "Clínica" vira "Atendimento"; o nome do chip fica', () => {
    expect(trocarTexto('Sua clinica ja tem um WhatsApp Clínica ("chip1"). Pra trocar, remova a linha atual primeiro.')).toBe(
      'Seu laboratório já tem um WhatsApp Atendimento ("chip1"). Pra trocar, remova a linha atual primeiro.',
    );
    expect(trocarTexto('Sua clinica ja tem um WhatsApp Comercial ("t1-2").')).toBe('Seu laboratório já tem um WhatsApp Comercial ("t1-2").');
    expect(trocarTexto('Sua clinica ja possui um WhatsApp conectado ("Recepção"). Pra trocar de numero, remova a linha atual primeiro.')).toBe(
      'Seu laboratório já possui um WhatsApp conectado ("Recepção"). Pra trocar de número, remova a linha atual primeiro.',
    );
  });

  it('molde de conversations com "Clínica" vira "Atendimento"', () => {
    expect(trocarTexto('Sua clínica não tem um WhatsApp Clínica conectado.')).toBe('Seu laboratório não tem um WhatsApp Atendimento conectado.');
    expect(trocarTexto('Sua clínica não tem um WhatsApp Comercial conectado.')).toBe('Seu laboratório não tem um WhatsApp Comercial conectado.');
  });

  it('molde do telefone diferente', () => {
    expect(
      trocarTexto('O telefone do cadastro (final 1234) é diferente do contato do WhatsApp (final 9876) — corrija o cadastro do paciente antes de enviar.'),
    ).toBe('O telefone do cadastro (final 1234) é diferente do contato do WhatsApp (final 9876) — corrija o cadastro do cliente antes de enviar.');
  });

  it('texto que só COMEÇA ou só TERMINA igual ao molde não é trocado', () => {
    const comeca = 'Sua clinica ja tem um WhatsApp Clínica ("chip1"). Pra trocar, remova a linha atual primeiro. E mais.';
    expect(trocarTexto(comeca)).toBe(comeca);
    const termina = 'Aviso: Sua clínica não tem um WhatsApp Clínica conectado.';
    expect(trocarTexto(termina)).toBe(termina);
  });

  it('pelo interceptor: erro com molde troca com o mesmo status', async () => {
    const interceptor = new LabVocabInterceptor();
    const original = new BadRequestException('Sua clínica não tem um WhatsApp Clínica conectado.');
    const e = (await pegarErro(interceptor.intercept(contexto(LAB), { handle: () => throwError(() => original) }))) as HttpException;
    expect(e.getStatus()).toBe(400);
    expect((e.getResponse() as any).message).toBe('Seu laboratório não tem um WhatsApp Atendimento conectado.');
  });
});

describe('LabVocabInterceptor — o erro trocado no AllExceptionsFilter', () => {
  function rodarFiltro(e: unknown) {
    const json = jest.fn();
    const res = { headersSent: false, status: jest.fn(() => ({ json })) };
    const req = { url: '/team-chat/messages', method: 'POST', user: LAB, headers: {} };
    const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) } as unknown as ArgumentsHost;
    const audit = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    new AllExceptionsFilter().catch(e, host);
    audit.mockRestore();
    expect(json).toHaveBeenCalledTimes(1);
    return { status: (res.status.mock.calls[0] as unknown[])[0], corpo: json.mock.calls[0][0] };
  }

  it('mesma forma do erro da clínica, só o texto muda', async () => {
    const interceptor = new LabVocabInterceptor();
    const original = new NotFoundException('Paciente não encontrado');
    const trocado = await pegarErro(interceptor.intercept(contexto(LAB), { handle: () => throwError(() => original) }));

    const daClinica = rodarFiltro(original);
    const doLab = rodarFiltro(trocado);
    expect(doLab.status).toBe(404);
    expect(Object.keys(doLab.corpo).sort()).toEqual(Object.keys(daClinica.corpo).sort());
    expect(doLab.corpo).toEqual({ ...daClinica.corpo, message: 'Cliente não encontrado', timestamp: expect.any(String) });
  });

  it('o code (PERMISSION_DENIED) chega igual ao front', async () => {
    const interceptor = new LabVocabInterceptor();
    const original = new ForbiddenException({ message: 'Paciente fora da sua carteira', code: 'PERMISSION_DENIED' });
    const trocado = await pegarErro(interceptor.intercept(contexto(LAB), { handle: () => throwError(() => original) }));
    const { status, corpo } = rodarFiltro(trocado);
    expect(status).toBe(403);
    expect(corpo).toMatchObject({ statusCode: 403, message: 'Cliente fora da sua carteira', code: 'PERMISSION_DENIED', path: '/team-chat/messages' });
  });
});

// ─── O mapa ──────────────────────────────────────────────────────────────────

/** Fonte da API por arquivo (sem specs, sem __guards__ e sem os arquivos do mapa), com 'a' + 'b' juntado. */
function fontesDaApi(): string[] {
  const fora = new Set(['mensagens-api-clinica.ts', 'lab-api-messages.ts', 'lab-vocab.interceptor.ts']);
  const partes: string[] = [];
  const andar = (dir: string) => {
    for (const nome of fs.readdirSync(dir)) {
      const p = path.join(dir, nome);
      if (fs.statSync(p).isDirectory()) {
        if (nome !== '__guards__' && nome !== 'node_modules') andar(p);
      } else if (nome.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(nome) && !fora.has(nome)) {
        partes.push(fs.readFileSync(p, 'utf8'));
      }
    }
  };
  andar(SRC);
  return partes.map((p) => p.replace(/(['"`])\s*\+\s*\1/g, ''));
}

/** A lista PROIBIDOS (e PERMITIDOS) lida do próprio script da trava — ele é ESM e roda git ao carregar. */
function travaDoScript(): { proibidos: Array<[string, RegExp]>; permitidos: RegExp[] } {
  const src = fs.readFileSync(path.join(RAIZ, 'scripts', 'ci', 'check-pick-literals.mjs'), 'utf8');
  const bloco = (nome: string) => {
    const m = new RegExp(`const ${nome} = \\[([\\s\\S]*?)\\]\\.map`).exec(src);
    if (!m) throw new Error(`não achei ${nome} em check-pick-literals.mjs`);
    return m[1];
  };
  const palavra = (padrao: string, flags: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${padrao})(?![\\p{L}\\p{N}])`, `u${flags}`);
  const proibidos = [...bloco('PROIBIDOS').matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g)].map(
    (m) => [m[1], palavra(m[2], '')] as [string, RegExp],
  );
  const permitidos = [...bloco('PERMITIDOS').matchAll(/'([^']+)'/g)].map((m) => palavra(m[1], 'g'));
  return { proibidos, permitidos };
}

const normalizar = (t: string) =>
  t
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');

describe('Mapa de mensagens da API (clínica × laboratório)', () => {
  const clinica = MENSAGENS_API_CLINICA as Readonly<Record<string, string>>;
  const moldes = MOLDES_API_CLINICA as Readonly<Record<string, string>>;
  const lab = LAB_API_MESSAGES as Readonly<Record<string, string>>;
  const labMoldes = LAB_API_MOLDES as Readonly<Record<string, string>>;

  it('mesmas chaves dos dois lados, e tudo congelado', () => {
    expect(Object.keys(lab).sort()).toEqual(Object.keys(clinica).sort());
    expect(Object.keys(labMoldes).sort()).toEqual(Object.keys(moldes).sort());
    for (const o of [clinica, moldes, lab, labMoldes]) expect(Object.isFrozen(o)).toBe(true);
  });

  it('nenhum texto de clínica se repete, e cada troca muda o texto', () => {
    const todos = [...Object.values(clinica), ...Object.values(moldes)];
    expect(new Set(todos).size).toBe(todos.length);
    for (const k of Object.keys(clinica)) expect(lab[k]).not.toBe(clinica[k]);
    for (const k of Object.keys(moldes)) expect(labMoldes[k]).not.toBe(moldes[k]);
  });

  it('o texto do laboratório não cai de novo no mapa (sem troca em cadeia)', () => {
    for (const t of [...Object.values(lab), ...Object.values(labMoldes)]) expect(trocarTexto(t)).toBe(t);
  });

  it('moldes da clínica e do laboratório têm os mesmos {n}', () => {
    const marcas = (t: string) => (t.match(/\{\d+\}/g) ?? []).sort();
    for (const k of Object.keys(moldes)) {
      expect(marcas(moldes[k]).length).toBeGreaterThan(0);
      expect(marcas(labMoldes[k])).toEqual(marcas(moldes[k]));
    }
  });

  it('cada texto de clínica ainda existe IGUAL como string em apps/api/src', () => {
    const fonte = fontesDaApi().join('\n');
    const sumidos = Object.entries(clinica).filter(
      ([, t]) => !fonte.includes(`'${t}'`) && !fonte.includes(`"${t}"`) && !fonte.includes(`\`${t}\``),
    );
    expect(sumidos).toEqual([]);
  });

  it('cada parte fixa de cada molde existe, em ordem e perto uma da outra, num arquivo de apps/api/src', () => {
    const fontes = fontesDaApi();
    // Entre uma parte fixa e a próxima só cabe o ${...} do trecho variável.
    const PERTO = 200;
    const achou = (fonte: string, partes: string[]) => {
      for (let ini = fonte.indexOf(partes[0]); ini >= 0; ini = fonte.indexOf(partes[0], ini + 1)) {
        let pos = ini + partes[0].length;
        let ok = true;
        for (const p of partes.slice(1)) {
          const i = fonte.indexOf(p, pos);
          if (i < 0 || i - pos > PERTO) {
            ok = false;
            break;
          }
          pos = i + p.length;
        }
        if (ok) return true;
      }
      return false;
    };
    const sumidos = Object.entries(moldes).filter(([, molde]) => {
      const partes = molde.split(/\{\d+\}/).filter(Boolean);
      return !fontes.some((f) => achou(f, partes));
    });
    expect(sumidos).toEqual([]);
  });

  it('texto do laboratório sem os termos PROIBIDOS da trava e sem "sua/nesta clínica"', () => {
    const { proibidos, permitidos } = travaDoScript();
    expect(proibidos.length).toBeGreaterThanOrEqual(8);
    const contaPropria = /(?<![\p{L}\p{N}])(?:sua|nesta|desta|esta|outra|da) clinica(?![\p{L}\p{N}])/u;
    const ruins: string[] = [];
    for (const t of [...Object.values(lab), ...Object.values(labMoldes)]) {
      let n = normalizar(t);
      for (const re of permitidos) n = n.replace(re, ' ');
      const termos = proibidos.filter(([, re]) => re.test(n)).map(([r]) => r);
      if (termos.length || contaPropria.test(normalizar(t))) ruins.push(`${t} → ${termos.join(', ') || 'clínica da conta'}`);
      expect(temPalavraDeClinica(t)).toBe(false);
    }
    expect(ruins).toEqual([]);
  });

  it('o detector de palavra de clínica pega o que a trava pega', () => {
    expect(temPalavraDeClinica('Paciente arquivado')).toBe(true);
    expect(temPalavraDeClinica('Sem PRONTUÁRIO')).toBe(true);
    expect(temPalavraDeClinica('Essa linha nao pertence a sua clinica')).toBe(true);
    expect(temPalavraDeClinica('Procedimento nao encontrado')).toBe(true);
    expect(temPalavraDeClinica('Dados do paciente do caso')).toBe(false);
    expect(temPalavraDeClinica('Clínica parceira cadastrada')).toBe(false);
    expect(temPalavraDeClinica('Consultar depois')).toBe(false);
  });

  it('o interceptor e o arquivo da clínica ficam FORA da trava 1 (sem pickBt e sem const LAB_)', () => {
    for (const arq of ['lab-vocab.interceptor.ts', 'mensagens-api-clinica.ts']) {
      const src = fs.readFileSync(path.join(SRC, 'business-type', arq), 'utf8');
      expect(src).not.toMatch(/\bpickBt\s*\(/);
      expect(src).not.toMatch(/\b(const|let|var)\s+LAB_/);
    }
  });
});

describe('Registro no app.module', () => {
  it('LabVocabInterceptor é APP_INTERCEPTOR logo depois do SensitiveDataInterceptor (fica por dentro dele)', () => {
    const inv = JSON.parse(fs.readFileSync(path.join(SRC, '__guards__', 'inventario.json'), 'utf8')) as {
      globais: Array<{ token: string; classe: string }>;
    };
    const interceptors = inv.globais.filter((g) => g.token === 'APP_INTERCEPTOR').map((g) => g.classe);
    expect(interceptors).toEqual(['SensitiveDataInterceptor', 'LabVocabInterceptor']);
  });
});
