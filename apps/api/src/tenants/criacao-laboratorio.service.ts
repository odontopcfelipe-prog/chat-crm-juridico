import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { registrarAuditoria } from '../common/utils/audit-log.util';

/**
 * F3 do laboratório — chave da PLATAFORMA que libera a criação de conta de
 * laboratório pelo /admin. Desligada por padrão: sem a linha, ou com qualquer
 * valor que não seja exatamente 'true', criar laboratório responde 409 e nada é
 * gravado. Não mexe em nada da clínica.
 */
export const CHAVE_CRIACAO_LABORATORIO = 'CRIACAO_LABORATORIO_LIBERADA';

export const CODIGO_CRIACAO_LABORATORIO_DESLIGADA = 'CRIACAO_LABORATORIO_DESLIGADA';

type PrismaChave = {
  globalSetting: { findUnique(args: { where: { key: string } }): Promise<{ value?: string | null } | null> };
};

/** A criação de laboratório está liberada? Falha de leitura conta como desligada. */
export async function criacaoLaboratorioLiberada(prisma: PrismaChave): Promise<boolean> {
  try {
    const linha = await prisma.globalSetting.findUnique({ where: { key: CHAVE_CRIACAO_LABORATORIO } });
    return linha?.value === 'true';
  } catch {
    return false;
  }
}

/** 409 com mensagem em português quando a chave da plataforma está desligada. */
export async function exigirCriacaoLaboratorioLiberada(prisma: PrismaChave): Promise<void> {
  if (await criacaoLaboratorioLiberada(prisma)) return;
  throw new ConflictException({
    statusCode: 409,
    message:
      'A criação de laboratório está desligada na plataforma. Ligue "Criação de laboratório" no painel do administrador e tente de novo.',
    code: CODIGO_CRIACAO_LABORATORIO_DESLIGADA,
  });
}

/** Leitura e liga/desliga da chave (só o SUPER_ADMIN chega aqui). */
@Injectable()
export class CriacaoLaboratorioService {
  private readonly logger = new Logger('CriacaoLaboratorio');

  constructor(private prisma: PrismaService) {}

  async ler(): Promise<{ liberada: boolean; atualizado_em: Date | null }> {
    const linha = await this.prisma.globalSetting.findUnique({ where: { key: CHAVE_CRIACAO_LABORATORIO } });
    return { liberada: linha?.value === 'true', atualizado_em: linha?.updated_at ?? null };
  }

  async definir(liberada: unknown, quem?: string | null): Promise<{ liberada: boolean; atualizado_em: Date | null }> {
    if (typeof liberada !== 'boolean') {
      throw new BadRequestException('Informe liberada: true ou false');
    }
    const key = CHAVE_CRIACAO_LABORATORIO;
    const value = liberada ? 'true' : 'false';
    const linha = await this.prisma.globalSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    this.logger.log(`[CRIACAO-LABORATORIO] ${liberada ? 'liberada' : 'desligada'} por ${quem || '?'}`);
    await registrarAuditoria(
      this.prisma,
      {
        tenantId: null,
        actorUserId: typeof quem === 'string' && quem ? quem : null,
        entity: 'PLATAFORMA',
        entityId: key,
        action: liberada ? 'CRIACAO_LABORATORIO_LIGADA' : 'CRIACAO_LABORATORIO_DESLIGADA',
      },
      this.logger,
    );
    return { liberada, atualizado_em: linha?.updated_at ?? null };
  }
}
