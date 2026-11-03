import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { chaveDoHandler } from '../business-type/lab-route-policy';
import { CODIGO_SO_VER, lerAcessoClinica } from './acesso-clinica';

const METODOS_DE_LEITURA = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Fora o GET, o que passa no modo só ver: trocar de conta, voltar para a própria
 * e as prévias que só leem. Lista fechada de propósito — nem toda rota @SuperAdmin
 * é da plataforma (sincronizar chip, por exemplo, grava na conta visitada).
 */
export const LIBERADAS_NO_SO_VER: ReadonlySet<string> = new Set([
  'AuthController.acessarClinica',
  'AuthController.voltarParaMinhaConta',
  'CampanhasController.previa',
  'InventoryController.previewConsumption',
]);

/**
 * Dono do sistema dentro de uma conta no modo 'ver' (auth/acesso-clinica.ts):
 * só leitura. Fora o GET, passa só LIBERADAS_NO_SO_VER; o resto é 403 SO_VER
 * antes do handler. Login normal e modo 'mexer' passam direto.
 */
@Injectable()
export class ModoSoVerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest();
    if (lerAcessoClinica(req?.user?.acesso_clinica)?.modo !== 'ver') return true;
    if (METODOS_DE_LEITURA.has(String(req.method || '').toUpperCase())) return true;
    if (LIBERADAS_NO_SO_VER.has(chaveDoHandler(context.getClass(), context.getHandler()))) return true;
    throw new ForbiddenException({
      message: 'Você está só vendo esta conta: nada é salvo, enviado ou apagado. Para alterar, entre de novo em "Ver e mexer".',
      code: CODIGO_SO_VER,
    });
  }
}
