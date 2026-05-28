import { Controller, Post, Body, Headers, Logger, HttpCode, UnauthorizedException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { PaymentGatewayService } from './payment-gateway.service';

@Public()
@SkipThrottle()
@Controller('webhooks')
export class PaymentGatewayWebhookController {
  private readonly logger = new Logger('AsaasWebhook');

  constructor(private service: PaymentGatewayService) {}

  @Post('asaas')
  @HttpCode(200)
  async handleAsaasWebhook(
    @Body() body: any,
    @Headers('asaas-access-token') accessToken: string,
  ) {
    this.logger.log(
      `[ASAAS-WEBHOOK] Evento: ${body?.event} | Payment: ${body?.payment?.id}`,
    );

    // Valida autenticidade: o Asaas envia o token configurado no painel via
    // header `asaas-access-token`. Sem isso, qualquer um poderia forjar um
    // "pagamento confirmado". Quando o token ainda nao esta configurado, o
    // service apenas avisa e aceita (nao quebra webhooks legitimos).
    const auth = await this.service.verifyWebhookToken(accessToken);
    if (auth.configured && !auth.ok) {
      this.logger.error('[ASAAS-WEBHOOK] Token invalido — rejeitando (possivel spoofing).');
      throw new UnauthorizedException('invalid webhook token');
    }

    try {
      await this.service.handleWebhook(body);
    } catch (e: any) {
      this.logger.error(`[ASAAS-WEBHOOK] Erro: ${e.message}`);
    }

    return { received: true };
  }
}
