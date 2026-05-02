/**
 * @Authenticated() — extrai req.user TIPADO do request (Fase 25 Onda 2.1).
 *
 * Substitui o padrao antigo:
 *   removeQuote(@Param('id') id: string, @Request() req: any) {
 *     const tenantId = req.user?.tenant_id;
 *     const userId = req.user?.id;            // <-- typo aqui = bug invisivel
 *     if (!tenantId) throw new BadRequestException('tenant_id ausente');
 *     ...
 *   }
 *
 * Pelo padrao novo:
 *   removeQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
 *     return this.svc.remove(id, user.tenant_id, user.id);
 *   }
 *
 * Ganhos:
 *   - tipo seguro: TS pega `user.sub` (que nao existe), `user.tenantId` (camel
 *     errado), `user.userId` (campo errado) ANTES de subir codigo
 *   - elimina o boilerplate `if (!tenantId) throw ...` (ja garantido pelo guard)
 *   - documenta intencao: "esse endpoint precisa de auth"
 *   - tracking: log estruturado pode ler user.id automaticamente
 *
 * Bug historico que isso resolve definitivamente: 5 controllers usaram
 * req.user?.sub em vez de req.user?.id e quebraram silenciosamente
 * (commercial, odontogram, clinical-records, anamnesis). JWT.validate()
 * mapeia payload.sub -> { id }, entao .sub nao existe em req.user.
 */
import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Shape do req.user apos JwtStrategy.validate().
 * Espelhado de apps/api/src/auth/jwt.strategy.ts (validate retorna isso).
 */
export interface AuthUser {
  /** UUID do usuario (mapeado de payload.sub no JWT) */
  id: string;
  email: string;
  /** Tenant do usuario — sempre presente apos JwtAuthGuard */
  tenant_id: string;
  /** Lista completa de roles (novo formato — multi-role) */
  roles: string[];
  /** Primeiro role (compat com codigo antigo single-role) */
  role: string;
}

/**
 * @Authenticated() — extrai req.user com tipo correto.
 *
 * Lanca UnauthorizedException se nao houver req.user (defensivo —
 * JwtAuthGuard ja garante, mas se alguem esquecer de aplicar @UseGuards,
 * a falha eh explicita em vez de silencioso `undefined.tenant_id`).
 *
 * @example
 *   @Get('quotes/:id')
 *   getQuote(@Param('id') id: string, @Authenticated() user: AuthUser) {
 *     return this.svc.findOne(id, user.tenant_id);
 *   }
 */
export const Authenticated = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest();
    const user = req?.user;
    if (!user || !user.id || !user.tenant_id) {
      throw new UnauthorizedException(
        'Autenticacao ausente — verifique se o controller tem @UseGuards(JwtAuthGuard)',
      );
    }
    return user as AuthUser;
  },
);
