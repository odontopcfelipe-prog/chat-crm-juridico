/**
 * Passos CAD — lista de clientes da ficha do caso (GET /patients/nomes).
 *
 * Só o nome sai da API: nem documento nem contato. Conta, arquivados e carteira filtram como na
 * lista completa. A rota tem de estar liberada para o laboratório, senão a tela leva 403 em
 * produção, e tem de vir antes de @Get(':id'), senão "nomes" vira um id.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PatientsController } from './patients.controller';
import { PatientsService } from './patients.service';
import { ownPatientsWhere } from '../auth/patient-scope';
import { PermissionsGuard } from '../auth/decorators/requires-permission.decorator';
import { rotaDoLaboratorio } from '../business-type/lab-route-policy';

const CONTA = 'conta-exemplo-1';

function montarServico(linhas: Array<{ name: string }>) {
  const findMany = jest.fn().mockResolvedValue(linhas);
  const svc = new PatientsService({ patient: { findMany } } as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, findMany };
}

describe('PatientsService.nomes', () => {
  it('devolve só os nomes, na ordem do banco', async () => {
    const m = montarServico([{ name: 'Clínica Sorriso' }, { name: 'Dra. Ana' }]);
    await expect(m.svc.nomes(CONTA)).resolves.toEqual(['Clínica Sorriso', 'Dra. Ana']);
  });

  it('pede ao banco só o nome, sem repetir, com teto', async () => {
    const m = montarServico([]);
    await m.svc.nomes(CONTA);
    const args = m.findMany.mock.calls[0][0];
    expect(args.select).toEqual({ name: true });
    expect(args.include).toBeUndefined();
    expect(args.distinct).toEqual(['name']);
    expect(args.take).toBeGreaterThan(0);
    expect(args.orderBy).toEqual({ name: 'asc' });
  });

  it('filtra pela conta e tira os arquivados', async () => {
    const m = montarServico([]);
    await m.svc.nomes(CONTA);
    expect(m.findMany.mock.calls[0][0].where).toEqual({ AND: [{ tenant_id: CONTA }, { status: { not: 'ARCHIVED' } }] });
  });

  it('quem só vê a própria carteira recebe só a carteira', async () => {
    const m = montarServico([]);
    await m.svc.nomes(CONTA, 'usuario-exemplo-1');
    expect(m.findMany.mock.calls[0][0].where.AND).toContainEqual(ownPatientsWhere('usuario-exemplo-1'));
    expect(m.findMany.mock.calls[0][0].where.AND).toContainEqual({ tenant_id: CONTA });
  });
});

describe('PatientsController.nomes', () => {
  function montar() {
    const svc = { nomes: jest.fn().mockResolvedValue(['Dra. Ana']) };
    return { svc, ctrl: new PatientsController(svc as any, {} as any, {} as any, {} as any) };
  }
  afterEach(() => jest.restoreAllMocks());

  it('administrador vê todos', async () => {
    const m = montar();
    await expect(m.ctrl.nomes({ user: { id: 'u1', roles: ['ADMIN'], tenant_id: CONTA } })).resolves.toEqual(['Dra. Ana']);
    expect(m.svc.nomes).toHaveBeenCalledWith(CONTA, null);
  });

  it('sem "ver todos" fica preso à própria carteira', async () => {
    jest.spyOn(PermissionsGuard, 'permissionsFor').mockResolvedValue(new Set(['view_patients', 'create_evaluation']) as any);
    const m = montar();
    await m.ctrl.nomes({ user: { id: 'u2', roles: ['OPERADOR'], tenant_id: CONTA } });
    expect(m.svc.nomes).toHaveBeenCalledWith(CONTA, 'u2');
  });

  it('com "ver todos" liberado na pessoa, vê todos', async () => {
    jest.spyOn(PermissionsGuard, 'permissionsFor').mockResolvedValue(new Set(['view_patients', 'view_all_patients']) as any);
    const m = montar();
    await m.ctrl.nomes({ user: { id: 'u3', roles: ['OPERADOR'], tenant_id: CONTA } });
    expect(m.svc.nomes).toHaveBeenCalledWith(CONTA, null);
  });

  it('sem conta no token, recusa em vez de listar', async () => {
    const m = montar();
    await expect(m.ctrl.nomes({ user: { id: 'u1', roles: ['ADMIN'] } })).rejects.toThrow('tenant_id ausente');
    expect(m.svc.nomes).not.toHaveBeenCalled();
  });

  it('está liberada para o laboratório', () => {
    expect(rotaDoLaboratorio('PatientsController.nomes')).toBe(true);
  });

  it('exige ver_pacientes e vem antes de @Get(":id")', () => {
    const src = fs.readFileSync(path.join(__dirname, 'patients.controller.ts'), 'utf8');
    const rota = src.indexOf("@Get('nomes')");
    expect(rota).toBeGreaterThan(-1);
    // Só o decorador de verdade: comentários do arquivo também citam @Get(':id').
    expect(rota).toBeLessThan(src.search(/^\s*@Get\(':id'\)/m));
    expect(src.slice(0, rota).trimEnd().endsWith("@RequiresPermission('view_patients')")).toBe(true);
  });
});
