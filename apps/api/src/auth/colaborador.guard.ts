import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ehSoPonto } from '@crm/shared';
import { chaveDoHandler } from '../business-type/lab-route-policy';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionsGuard } from './decorators/requires-permission.decorator';

/** Sem PERMISSION_DENIED de propósito: o web não mostra aviso, só leva para o ponto. */
export const CODIGO_SO_PONTO = 'COLABORADOR_SO_PONTO';

/**
 * Tudo o que o colaborador alcança na API, por handler ('Classe.metodo'). Vale para
 * bater o ponto e ver o próprio espelho; a central da equipe segue fechada. Quando o
 * colaborador ganhar outra tela, os handlers dela entram aqui.
 */
export const ROTAS_DO_COLABORADOR: ReadonlySet<string> = new Set([
  'UsersController.getMe',
  'PontoController.me',
  'PontoController.status',
  'PontoController.punch',
]);

/**
 * Colaborador: negação POR PADRÃO. Várias rotas da API só exigem estar logado, então
 * esconder as telas não bastaria: um handler novo nasce fechado até entrar na lista.
 *
 * Vem logo depois do JwtAuthGuard: assim responde antes do RolesGuard/PermissionsGuard,
 * cujo PERMISSION_DENIED mostraria o aviso "Sem autorização" na tela.
 * Rota pública (sem usuário), dono do sistema e os demais setores passam direto.
 */
@Injectable()
export class ColaboradorGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const user = context.switchToHttp().getRequest()?.user;
    if (typeof user?.id !== 'string' || user.id === '') return true;
    if (ROTAS_DO_COLABORADOR.has(chaveDoHandler(context.getClass(), context.getHandler()))) return true;
    const roles: string[] = Array.isArray(user.roles) ? user.roles : [];
    if (roles.includes('SUPER_ADMIN')) return true;
    const setor = await PermissionsGuard.sectorFor(this.prisma, user.id, roles);
    if (!ehSoPonto(setor, roles)) return true;
    throw new ForbiddenException({
      message: 'Seu acesso é só ao relógio de ponto.',
      code: CODIGO_SO_PONTO,
    });
  }
}
