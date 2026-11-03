import { BadRequestException, Body, ConflictException, Controller, Get, Logger, Post, Put, Req } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { SuperAdmin } from '../auth/decorators/super-admin.decorator';
import { registrarAuditoria } from '../common/utils/audit-log.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  CHAVE_API_PLATAFORMA,
  chamarAsaas,
  ErroDoAsaas,
  gravarContaDaPlataforma,
  lerContaDaPlataforma,
  resumoDaContaDaPlataforma,
} from './conta-asaas-da-plataforma';

export class ContaDaPlataformaDto {
  /** Vazia ou ausente = mantém a chave atual. */
  @IsOptional()
  @IsString({ message: 'A chave da API tem de ser texto' })
  @MaxLength(400, { message: 'Chave da API longa demais' })
  api_key?: string;

  @IsOptional()
  @IsBoolean({ message: 'Informe sandbox: true ou false' })
  sandbox?: boolean;
}

/**
 * Conta Asaas da plataforma, onde os laboratórios pagam a mensalidade (painel do
 * administrador, Configurações da Plataforma). Só o SUPER_ADMIN. A chave nunca volta
 * na resposta nem vai para log ou auditoria.
 */
@Controller('plataforma/mensalidade-laboratorio')
export class ContaDaPlataformaController {
  private readonly logger = new Logger('ContaDaPlataforma');

  constructor(private readonly prisma: PrismaService) {}

  @SuperAdmin()
  @Get()
  ler() {
    return resumoDaContaDaPlataforma(this.prisma);
  }

  @SuperAdmin()
  @Put()
  async salvar(@Body() body: ContaDaPlataformaDto, @Req() req: any) {
    const chaveNova = typeof body?.api_key === 'string' && body.api_key.trim().length > 0;
    await gravarContaDaPlataforma(this.prisma, { apiKey: body?.api_key, sandbox: body?.sandbox });
    const quem = typeof req?.user?.id === 'string' && req.user.id ? req.user.id : null;
    this.logger.log(`[MENSALIDADE-LAB] Conta da plataforma alterada por ${quem || '?'} (chave nova: ${chaveNova ? 'sim' : 'não'})`);
    await registrarAuditoria(
      this.prisma,
      {
        tenantId: null,
        actorUserId: quem,
        entity: 'PLATAFORMA',
        entityId: CHAVE_API_PLATAFORMA,
        action: 'MENSALIDADE_LAB_CONTA_ALTERADA',
        meta: { chave_nova: chaveNova, sandbox: typeof body?.sandbox === 'boolean' ? body.sandbox : null },
      },
      this.logger,
    );
    return resumoDaContaDaPlataforma(this.prisma);
  }

  /** Confere a chave com uma leitura simples no Asaas (não cria nada). */
  @SuperAdmin()
  @Post('testar')
  async testar() {
    const conta = await lerContaDaPlataforma(this.prisma);
    if (!conta) throw new ConflictException('Conta da plataforma não configurada: salve a chave da API antes de testar.');
    try {
      await chamarAsaas(conta, 'GET', '/customers?limit=1');
      return { ok: true, sandbox: conta.sandbox };
    } catch (e) {
      if (e instanceof ErroDoAsaas) {
        throw new BadRequestException(`O Asaas recusou a chave (${e.status}): ${e.descricao}`);
      }
      throw new BadRequestException('Não foi possível falar com o Asaas agora. Tente de novo em instantes.');
    }
  }
}
