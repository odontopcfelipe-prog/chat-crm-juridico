import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Public } from '../auth/decorators/public.decorator';
import { SuperAdmin } from '../auth/decorators/super-admin.decorator';
import { quemEnvia } from './lab-waitlist.controller';
import { CadastroLaboratorioService } from './cadastro-laboratorio.service';
import { ConvitesLaboratorioService } from './convites-laboratorio.service';
import { VALIDADE_MAX_DIAS } from './convite-laboratorio';
import { LAB_CADASTRO_MSG, LAB_CONVITE_MSG } from './cadastro-laboratorio.textos';
import { origemDaRequisicao } from '../common/utils/origem-da-requisicao';

export class CadastroLaboratorioDto {
  @IsString({ message: LAB_CADASTRO_MSG.nomeLab })
  @MaxLength(120, { message: LAB_CADASTRO_MSG.nomeLab })
  lab_name: string;

  @IsString({ message: LAB_CADASTRO_MSG.documento })
  @MaxLength(20, { message: LAB_CADASTRO_MSG.documento })
  cpf_cnpj: string;

  @IsString({ message: LAB_CADASTRO_MSG.whatsapp })
  @MaxLength(40, { message: LAB_CADASTRO_MSG.whatsapp })
  phone: string;

  @IsString({ message: LAB_CADASTRO_MSG.nomeResponsavel })
  @MaxLength(120, { message: LAB_CADASTRO_MSG.nomeResponsavel })
  admin_name: string;

  @IsEmail({}, { message: LAB_CADASTRO_MSG.email })
  @MaxLength(160, { message: LAB_CADASTRO_MSG.email })
  admin_email: string;

  @IsString({ message: LAB_CADASTRO_MSG.senha })
  @MinLength(8, { message: LAB_CADASTRO_MSG.senha })
  @MaxLength(128, { message: LAB_CADASTRO_MSG.senha })
  admin_password: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  lab_cro_inscricao?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  rt_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  rt_cro?: string;

  @IsOptional()
  @IsString({ message: LAB_CADASTRO_MSG.convite })
  @MaxLength(128, { message: LAB_CADASTRO_MSG.convite })
  convite?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;

  /** Caixa do aceite dos termos marcada (o service exige true). */
  @IsOptional()
  @IsBoolean()
  aceite_termos?: boolean;
}

export class SituacaoCadastroLabDto {
  @IsOptional()
  @IsString({ message: LAB_CADASTRO_MSG.convite })
  @MaxLength(128, { message: LAB_CADASTRO_MSG.convite })
  convite?: string;
}

export class ChaveCadastroLaboratorioDto {
  @IsBoolean({ message: LAB_CONVITE_MSG.aberto })
  aberto: boolean;
}

export class NovoConviteLaboratorioDto {
  @IsOptional()
  @IsUUID('all', { message: LAB_CONVITE_MSG.inscricaoInvalida })
  waitlist_entry_id?: string;

  @IsOptional()
  @IsEmail({}, { message: LAB_CONVITE_MSG.emailInvalido })
  @MaxLength(160, { message: LAB_CONVITE_MSG.emailInvalido })
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  lab_name?: string;

  @IsOptional()
  @IsInt({ message: LAB_CONVITE_MSG.validade })
  @Min(1, { message: LAB_CONVITE_MSG.validade })
  @Max(VALIDADE_MAX_DIAS, { message: LAB_CONVITE_MSG.validade })
  dias?: number;
}

/**
 * F11 do laboratório — cadastro de laboratório pelo /cadastrar (rotas públicas,
 * com limite por visitante). O código do convite vai no CORPO, nunca na URL.
 * O POST /signup da clínica continua no SignupController, sem mudança.
 */
@Controller('signup/laboratorio')
export class CadastroLaboratorioController {
  constructor(private readonly service: CadastroLaboratorioService) {}

  @Throttle({ default: { ttl: 60000, limit: 20, getTracker: quemEnvia } })
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('situacao')
  situacao(@Body() body: SituacaoCadastroLabDto) {
    return this.service.situacao(body?.convite);
  }

  @Throttle({ default: { ttl: 60000, limit: 5, getTracker: quemEnvia } })
  @Public()
  @HttpCode(HttpStatus.OK)
  @Post()
  cadastrar(@Body() body: CadastroLaboratorioDto, @Req() req?: any) {
    return this.service.cadastrar(body, origemDaRequisicao(req));
  }
}

/**
 * F11 do laboratório — chave do cadastro aberto (LAB_SIGNUP_ENABLED) e convites
 * do cadastro de laboratório. Só o dono da plataforma (SUPER_ADMIN).
 */
@Controller('plataforma/cadastro-laboratorio')
export class CadastroLaboratorioPlataformaController {
  constructor(private readonly service: ConvitesLaboratorioService) {}

  @SuperAdmin()
  @Get()
  lerChave() {
    return this.service.lerChave();
  }

  @SuperAdmin()
  @Put()
  definirChave(@Body() body: ChaveCadastroLaboratorioDto, @Req() req: any) {
    return this.service.definirChave(body?.aberto, req?.user?.id ?? null);
  }

  @SuperAdmin()
  @Get('convites')
  listarConvites() {
    return this.service.listar();
  }

  @SuperAdmin()
  @Post('convites')
  criarConvite(@Body() body: NovoConviteLaboratorioDto, @Req() req: any) {
    return this.service.criar(body ?? {}, req?.user?.id ?? null);
  }

  @SuperAdmin()
  @HttpCode(HttpStatus.OK)
  @Post('convites/:id/revogar')
  revogarConvite(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: any) {
    return this.service.revogar(id, req?.user?.id ?? null);
  }
}
