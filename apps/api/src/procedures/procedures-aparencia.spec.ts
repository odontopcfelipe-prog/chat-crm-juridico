/**
 * Edição básica da Venda Rápida: cada conta tem a sua, só o ADMIN muda e só entra cor e tamanho
 * válidos. O valor vira CSS na tela de venda, por isso o servidor também confere o formato.
 */
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ProceduresService } from './procedures.service';
import { ProceduresController } from './procedures.controller';
import { AparenciaVendaDto, UpdateProcedureDto } from './dto/procedure.dto';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { REQUIRES_PERMISSION_KEY } from '../auth/decorators/requires-permission.decorator';

const VALIDO = {
  cor_cabecalho: '#7c3aed',
  cor_produtos: '#1F2937',
  cor_destaque: '#fde68a',
  cor_rodape: '#111827',
  tamanho_foto: 'grande',
};

function montar() {
  const linhas = new Map<string, string>();
  const chave = (w: any) => `${w.tenant_id_key.tenant_id}|${w.tenant_id_key.key}`;
  const prisma: any = {
    tenantSetting: {
      findUnique: jest.fn(async ({ where }: any) => {
        const value = linhas.get(chave(where));
        return value === undefined ? null : { value };
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        linhas.set(chave(where), linhas.has(chave(where)) ? update.value : create.value);
      }),
    },
  };
  return { svc: new ProceduresService(prisma, {} as any), prisma, linhas };
}

describe('aparência da venda por conta', () => {
  it('sem nada salvo volta vazio: a tela usa o padrão', async () => {
    const { svc } = montar();
    await expect(svc.aparenciaVenda('a')).resolves.toEqual({});
  });

  it('o que uma conta salva não aparece na outra', async () => {
    const { svc } = montar();
    await svc.salvarAparenciaVenda('a', VALIDO as AparenciaVendaDto);
    await expect(svc.aparenciaVenda('a')).resolves.toEqual(VALIDO);
    await expect(svc.aparenciaVenda('b')).resolves.toEqual({});
  });

  it('salvar de novo substitui', async () => {
    const { svc } = montar();
    await svc.salvarAparenciaVenda('a', VALIDO as AparenciaVendaDto);
    await svc.salvarAparenciaVenda('a', { ...VALIDO, tamanho_foto: 'pequeno' } as AparenciaVendaDto);
    await expect(svc.aparenciaVenda('a')).resolves.toMatchObject({ tamanho_foto: 'pequeno' });
  });

  it('grava só os campos conhecidos', async () => {
    const { svc, linhas } = montar();
    await svc.salvarAparenciaVenda('a', { ...VALIDO, intruso: 'x' } as unknown as AparenciaVendaDto);
    expect(Object.keys(JSON.parse([...linhas.values()][0])).sort()).toEqual(Object.keys(VALIDO).sort());
  });

  it('valor corrompido no banco não derruba a tela', async () => {
    const { svc, linhas } = montar();
    linhas.set('a|VENDA_RAPIDA_APARENCIA', '{quebrado');
    await expect(svc.aparenciaVenda('a')).resolves.toEqual({});
  });
});

describe('quem pode', () => {
  const proto = ProceduresController.prototype as any;

  it('quem vende lê; só o ADMIN grava', () => {
    expect(Reflect.getMetadata(REQUIRES_PERMISSION_KEY, proto.aparenciaVenda)).toEqual(['manage_proposals']);
    expect(Reflect.getMetadata(ROLES_KEY, proto.salvarAparenciaVenda)).toEqual(['ADMIN']);
  });
});

describe('validação (mesmas opções do main.ts)', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const validar = (corpo: unknown, metatype: any = AparenciaVendaDto) => pipe.transform(corpo, { type: 'body', metatype });

  it('aceita o corpo completo', async () => {
    await expect(validar(VALIDO)).resolves.toMatchObject({ tamanho_foto: 'grande' });
  });

  it.each([
    ['#fff'],
    ['vermelho'],
    ['#00000g'],
    ['#000000;color:red'],
    ['url(https://x.y/z)'],
    [''],
    [123],
  ])('recusa a cor %p', async (cor) => {
    await expect(validar({ ...VALIDO, cor_rodape: cor })).rejects.toBeDefined();
  });

  it('recusa corpo sem uma das cores', async () => {
    const { cor_destaque: _fora, ...corpo } = VALIDO;
    await expect(validar(corpo)).rejects.toBeDefined();
  });

  it.each([['gigante'], [''], [2]])('recusa o tamanho %p', async (tamanho) => {
    await expect(validar({ ...VALIDO, tamanho_foto: tamanho })).rejects.toBeDefined();
  });

  it('recusa campo fora da lista', async () => {
    await expect(validar({ ...VALIDO, intruso: 'x' })).rejects.toBeDefined();
  });

  it('o destaque do produto entra pelo PATCH, e só como verdadeiro ou falso', async () => {
    await expect(validar({ featured: true }, UpdateProcedureDto)).resolves.toMatchObject({ featured: true });
    await expect(validar({ featured: 'sim' }, UpdateProcedureDto)).rejects.toBeDefined();
  });
});
