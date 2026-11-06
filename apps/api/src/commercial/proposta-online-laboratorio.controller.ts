import { Body, Controller, Get, Logger, Param, Post, Request } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/decorators/public.decorator';
import { origemDaRequisicao } from '../common/utils/origem-da-requisicao';
import { PrismaService } from '../prisma/prisma.service';
import { quemEnvia } from '../tenants/lab-waitlist.controller';
import { QuotesService } from './quotes.service';
import { aceitarPropostaPublica, verPropostaPublica } from './proposta-online-laboratorio';

/**
 * Página pública do orçamento de trabalho (link de aceite do laboratório). Duas rotas,
 * sem login: o token do link é a credencial e só abre o orçamento que o gerou
 * (proposta-online-laboratorio.ts). Conta de clínica não tem esse tipo de token.
 */
@Controller()
export class PropostaOnlineLaboratorioController {
  private readonly logger = new Logger(PropostaOnlineLaboratorioController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quotes: QuotesService,
  ) {}

  @Throttle({ default: { ttl: 60000, limit: 30, getTracker: quemEnvia } })
  @Public()
  @Get('portal/proposta/:token')
  ver(@Param('token') token: string) {
    return verPropostaPublica(this.prisma, token, this.logger);
  }

  @Throttle({ default: { ttl: 60000, limit: 10, getTracker: quemEnvia } })
  @Public()
  @Post('portal/proposta/:token/aceitar')
  aceitar(@Param('token') token: string, @Body() body: { nome?: string }, @Request() req: any) {
    const { ip, user_agent } = origemDaRequisicao(req);
    return aceitarPropostaPublica(
      {
        prisma: this.prisma,
        aceitar: (quoteId, tenantId) => this.quotes.accept(quoteId, tenantId),
        logger: this.logger,
      },
      token,
      { nome: String(body?.nome ?? ''), ip: ip ?? undefined, userAgent: user_agent ?? undefined },
    );
  }
}
