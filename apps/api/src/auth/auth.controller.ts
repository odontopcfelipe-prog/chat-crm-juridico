import { Controller, Post, Body, UnauthorizedException, HttpCode, HttpStatus, Request } from '@nestjs/common';
import { AuthService } from './auth.service';
import { SignInDto } from './dto/sign-in.dto';
import { Public } from './decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { origemDaRequisicao } from '../common/utils/origem-da-requisicao';
import { SuperAdmin } from './decorators/super-admin.decorator';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  // Onda 17.61 (segurança/JWT-04) — rate-limit dedicado no login (anti brute-force/
  // credential-stuffing): 10 tentativas por minuto por IP.
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(@Body() signInDto: SignInDto, @Request() req?: any) {
    const user = await this.authService.validateUser(signInDto.email, signInDto.password);
    if (!user) {
      throw new UnauthorizedException('Credenciais inválidas');
    }
    const sessao = await this.authService.login(user);
    // Marco Civil: data, hora e IP de cada entrada, guardados por 6 meses.
    await this.authService.registrarAcesso(user, origemDaRequisicao(req));
    return sessao;
  }

  /**
   * Dono do sistema entra numa conta sem ter usuário nela ({ tenant_id, modo:
   * 'ver' | 'mexer' }) ou volta para a dele ({ tenant_id: null }). Devolve um
   * login novo. Ver auth/acesso-clinica.ts.
   */
  @SuperAdmin()
  @HttpCode(HttpStatus.OK)
  @Post('acessar-clinica')
  async acessarClinica(@Request() req: any, @Body() body: { tenant_id?: string | null; modo?: string }) {
    return this.authService.acessarClinica(req.user?.id, body?.tenant_id, body?.modo, origemDaRequisicao(req));
  }

  /**
   * Volta do dono para a própria conta: o login de sempre dele. Sem @SuperAdmin de
   * propósito (de dentro de um laboratório o guard do laboratório só deixa passar
   * rota liberada para ele); o papel é conferido no banco e quem não é o dono leva 403.
   */
  @HttpCode(HttpStatus.OK)
  @Post('voltar-conta')
  async voltarParaMinhaConta(@Request() req: any) {
    return this.authService.acessarClinica(req.user?.id, null, undefined, origemDaRequisicao(req));
  }

  /** Gera um token JWT de longa duração (1 ano) para uso no MCP. */
  @HttpCode(HttpStatus.OK)
  @Post('mcp-token')
  async mcpToken(@Request() req: any) {
    return this.authService.generateMcpToken(req.user);
  }

  // ─── Redefinicao de senha (Onda 17.32.179) ──────────────────────

  /** Pede o link de redefinicao. Sempre responde ok (anti-enumeracao). */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  async forgotPassword(@Body() body: { email: string }) {
    return this.authService.forgotPassword(body?.email);
  }

  /** Define a nova senha a partir do token recebido por e-mail. */
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('reset-password')
  async resetPassword(@Body() body: { token: string; password: string }) {
    return this.authService.resetPassword(body?.token, body?.password);
  }
}
