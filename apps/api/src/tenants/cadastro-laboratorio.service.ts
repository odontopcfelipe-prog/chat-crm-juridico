import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger } from '@nestjs/common';
import { BT_LABORATORIO, soDocumento, toAlertPhone, vCpfCnpj } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { auditData } from '../common/utils/audit-log.util';
import { TenantsService } from './tenants.service';
import { CODIGO_CRIACAO_LABORATORIO_DESLIGADA } from './criacao-laboratorio.service';
import { LAB_CADASTRO_MSG } from './cadastro-laboratorio.textos';
import {
  CODIGO_CADASTRO_LAB_FECHADO,
  CODIGO_CADASTRO_LAB_TETO,
  CODIGO_CONVITE_INVALIDO,
  TETO_CADASTRO_LAB_POR_DIA,
  acharConviteValido,
  consumirConviteNaTransacao,
  lerChavesCadastroLaboratorio,
  type ConviteValido,
} from './convite-laboratorio';

/** A mesma recusa do cadastro da clínica (1 e-mail = 1 conta). */
const MSG_EMAIL_JA_USADO = 'Email do admin ja cadastrado em outro tenant'; // igual a tenants.service.ts:179

export type ModoCadastroLaboratorio = 'CONVITE' | 'ABERTO' | 'LISTA_ESPERA';
export type ConviteNaSituacao = 'AUSENTE' | 'VALIDO' | 'INVALIDO';

export interface SituacaoCadastroLaboratorio {
  modo: ModoCadastroLaboratorio;
  convite: ConviteNaSituacao;
  email: string | null;
  lab_name: string | null;
}

export interface CadastroLaboratorio {
  lab_name: string;
  cpf_cnpj: string;
  phone: string;
  admin_name: string;
  admin_email: string;
  admin_password: string;
  lab_cro_inscricao?: string;
  rt_name?: string;
  rt_cro?: string;
  convite?: string;
  /** Campo escondido na tela: só robô preenche. */
  website?: string;
}

/** Aparado, com espaço colapsado e cortado no máximo (igual à lista de espera). */
const texto = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');

const conviteInformado = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const fechado = () =>
  new ForbiddenException({ statusCode: 403, message: LAB_CADASTRO_MSG.fechado, code: CODIGO_CADASTRO_LAB_FECHADO });

const conviteRecusado = () =>
  new ForbiddenException({ statusCode: 403, message: LAB_CADASTRO_MSG.conviteInvalido, code: CODIGO_CONVITE_INVALIDO });

const tetoAtingido = () =>
  new HttpException({ statusCode: 429, code: CODIGO_CADASTRO_LAB_TETO, message: LAB_CADASTRO_MSG.teto }, 429);

/** Contas de laboratório criadas nas últimas 24 h (o teto do cadastro aberto). */
const laboratoriosNoDia = (db: any, agora: Date): Promise<number> =>
  db.tenantBusinessProfile.count({
    where: { business_type: BT_LABORATORIO, created_at: { gte: new Date(agora.getTime() - 24 * 3600_000) } },
  });

/** Trava (por transação) dos cadastros abertos: entram um por vez para o teto valer. */
const TRAVA_CADASTRO_ABERTO = 'cadastro-laboratorio-aberto';

/**
 * F11 do laboratório — cadastro de laboratório pelo /cadastrar (rotas públicas).
 *
 * Só funciona com a chave mestra CRIACAO_LABORATORIO_LIBERADA ligada e, além
 * dela, um convite válido OU o cadastro aberto (LAB_SIGNUP_ENABLED). A conta sai
 * igual à criada pelo /admin (F3): ACTIVE, plano CUSTOM, sem teste e sem e-mail.
 * O convite é gasto na mesma transação que cria a conta. O POST /signup da
 * clínica não passa por aqui.
 */
@Injectable()
export class CadastroLaboratorioService {
  private readonly logger = new Logger('CadastroLaboratorio');

  constructor(
    private prisma: PrismaService,
    private tenants: TenantsService,
  ) {}

  /** O que o /cadastrar do laboratório mostra: formulário (convite ou aberto) ou lista de espera. */
  async situacao(convite?: unknown): Promise<SituacaoCadastroLaboratorio> {
    const codigo = conviteInformado(convite);
    const chaves = await lerChavesCadastroLaboratorio(this.prisma);
    if (!chaves.criacaoLiberada) {
      return { modo: 'LISTA_ESPERA', convite: codigo ? 'INVALIDO' : 'AUSENTE', email: null, lab_name: null };
    }
    if (codigo) {
      const valido = await acharConviteValido(this.prisma, codigo, new Date());
      if (valido) return { modo: 'CONVITE', convite: 'VALIDO', email: valido.email, lab_name: valido.lab_name };
    }
    return {
      modo: chaves.cadastroAberto ? 'ABERTO' : 'LISTA_ESPERA',
      convite: codigo ? 'INVALIDO' : 'AUSENTE',
      email: null,
      lab_name: null,
    };
  }

  /** Cria a conta do laboratório. A resposta é sempre {ok:true} (sem id da conta). */
  async cadastrar(dados: CadastroLaboratorio): Promise<{ ok: true }> {
    // (a) campo escondido preenchido: robô. Mesma resposta, nenhuma leitura.
    if (texto(dados?.website, 200)) return { ok: true };

    // (b) normaliza e valida, sem banco.
    const labName = texto(dados?.lab_name, 200);
    if (labName.length < 2 || labName.length > 120) throw new BadRequestException(LAB_CADASTRO_MSG.nomeLab);
    const adminName = texto(dados?.admin_name, 200);
    if (adminName.length < 2 || adminName.length > 120) throw new BadRequestException(LAB_CADASTRO_MSG.nomeResponsavel);
    const email = typeof dados?.admin_email === 'string' ? dados.admin_email.trim().toLowerCase() : '';
    if (!email || email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException(LAB_CADASTRO_MSG.email);
    }
    const senha = typeof dados?.admin_password === 'string' ? dados.admin_password : '';
    if (senha.trim().length < 8) throw new BadRequestException(LAB_CADASTRO_MSG.senha);
    const documento = soDocumento(typeof dados?.cpf_cnpj === 'string' ? dados.cpf_cnpj : '');
    if (!documento) throw new BadRequestException(LAB_CADASTRO_MSG.documento);
    const erroDocumento = vCpfCnpj(documento);
    if (erroDocumento) throw new BadRequestException(erroDocumento);
    const phone = toAlertPhone(texto(dados?.phone, 40));
    if (!phone) throw new BadRequestException(LAB_CADASTRO_MSG.whatsapp);
    const codigo = conviteInformado(dados?.convite);

    // (c) chaves lidas na hora: sem a mestra, nada passa (nem o convite é lido).
    const agora = new Date();
    const chaves = await lerChavesCadastroLaboratorio(this.prisma);
    if (!chaves.criacaoLiberada) throw fechado();

    // (d) convite válido = via CONVITE; senão, só com o cadastro aberto.
    let convite: ConviteValido | null = null;
    if (codigo) convite = await acharConviteValido(this.prisma, codigo, agora);
    const via: 'CONVITE' | 'ABERTO' = convite ? 'CONVITE' : 'ABERTO';
    if (!convite && !chaves.cadastroAberto) throw codigo ? conviteRecusado() : fechado();

    // (e) teto diário só no cadastro aberto (o convite é controlado pelo SUPER_ADMIN).
    if (via === 'ABERTO') {
      const noDia = await laboratoriosNoDia(this.prisma, agora);
      if (noDia >= TETO_CADASTRO_LAB_POR_DIA) {
        this.logger.warn(`[CADASTRO-LABORATORIO] teto de ${TETO_CADASTRO_LAB_POR_DIA} contas de laboratório em 24 h atingido; cadastro aberto recusado`);
        throw tetoAtingido();
      }
    }

    // (f) 1 e-mail = 1 conta (clínica OU laboratório), sem diferença de maiúsculas.
    const jaUsado = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (jaUsado) throw new ConflictException(MSG_EMAIL_JA_USADO);

    // (g) a mesma criação do /admin (F3); convite gasto e auditoria na mesma transação.
    try {
      await this.tenants.create(
        {
          name: labName,
          email,
          phone,
          cpf_cnpj: documento,
          plan: 'CUSTOM',
          status: 'ACTIVE',
          admin: { name: adminName, email, password: senha, phone },
        },
        {
          lab: true,
          criadoPor: convite?.created_by_user_id ?? null,
          perfil: { lab_cro_inscricao: dados?.lab_cro_inscricao, rt_name: dados?.rt_name, rt_cro: dados?.rt_cro },
          dentroDaTransacao: async (tx, c) => {
            if (convite) await consumirConviteNaTransacao(tx, { conviteId: convite.id, tenantId: c.tenantId, agora });
            // Cadastro aberto: a mesma conta do (e), agora sob a trava. Pedidos ao mesmo
            // tempo entram um por vez e cada um já vê as contas dos anteriores.
            if (via === 'ABERTO') {
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TRAVA_CADASTRO_ABERTO}))`;
              if ((await laboratoriosNoDia(tx, agora)) >= TETO_CADASTRO_LAB_POR_DIA) throw tetoAtingido();
            }
            await tx.auditLog.create({
              data: auditData({
                tenantId: c.tenantId,
                actorUserId: c.adminUserId,
                entity: 'PLATAFORMA',
                entityId: c.tenantId,
                action: 'CADASTRO_LABORATORIO',
                meta: { via, convite_id: convite?.id ?? null },
              }),
            });
          },
        },
      );
    } catch (e: any) {
      // (h) corrida com o mesmo e-mail: o mesmo 409 (sem isso viraria 503).
      if (e?.code === 'P2002') throw new ConflictException(MSG_EMAIL_JA_USADO);
      // Mestra desligada no meio: o visitante vê o "fechado", nunca o texto do /admin.
      if (e instanceof ConflictException && (e.getResponse() as any)?.code === CODIGO_CRIACAO_LABORATORIO_DESLIGADA) {
        throw fechado();
      }
      throw e;
    }

    this.logger.log(`[CADASTRO-LABORATORIO] conta de laboratório criada pela via ${via}`);
    // (i) sem id da conta: o /cadastrar entra depois pelo POST /auth/login.
    return { ok: true };
  }
}
