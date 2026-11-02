import { Body, Controller, Get, Param, Put, Request, UseGuards } from '@nestjs/common';
import type {
  CasosDoClienteLabResposta,
  FichaDoCasoLabResposta,
  FichaTecnicaLabResposta,
  FichasTecnicasLabResposta,
  PerfilDoClienteLabResposta,
} from '@crm/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import { SoLaboratorioGuard } from '../business-type/so-laboratorio.guard';
import { soDoLaboratorio } from '../common/lab-gate.util';
import { LabFichasService } from './lab-fichas.service';
import { PutPatientLabProfileDto, PutProcedureLabSpecDto, PutQuoteLabCaseDto } from './dto/lab-fichas.dto';

/** Conta do login (o SoLaboratorioGuard já recusou quem não tem). */
function contaDe(req: any): string {
  const tenantId = req?.user?.tenant_id;
  if (typeof tenantId !== 'string' || tenantId === '') throw soDoLaboratorio();
  return tenantId;
}

/**
 * F8 do laboratório — fichas do cliente, do serviço e do caso.
 *
 * Só conta de laboratório: o SoLaboratorioGuard (de classe, vale para todo handler,
 * inclusive os futuros) dá 403 VERTICAL_DENIED à clínica antes do ValidationPipe e
 * de qualquer leitura. Os parâmetros se chamam :patientId, :procedureId e :quoteId:
 * com :patientId, o PatientScopeGuard global aplica a carteira do usuário restrito.
 * As permissões copiam as rotas irmãs (cadastro do cliente, serviços e orçamento).
 */
@UseGuards(JwtAuthGuard, SoLaboratorioGuard)
@Controller()
export class LabFichasController {
  constructor(private readonly service: LabFichasService) {}

  @RequiresPermission('view_patients')
  @Get('patients/:patientId/lab-profile')
  getPatientProfile(@Param('patientId') patientId: string, @Request() req: any): Promise<PerfilDoClienteLabResposta> {
    return this.service.lerPerfil(contaDe(req), patientId);
  }

  @RequiresPermission('edit_patients')
  @Put('patients/:patientId/lab-profile')
  putPatientProfile(
    @Param('patientId') patientId: string,
    @Body() dto: PutPatientLabProfileDto,
    @Request() req: any,
  ): Promise<PerfilDoClienteLabResposta> {
    return this.service.gravarPerfil(req.user, contaDe(req), patientId, dto);
  }

  @RequiresPermission('manage_proposals', 'view_proposals', 'create_evaluation')
  @Get('patients/:patientId/lab-cases')
  listPatientCases(@Param('patientId') patientId: string, @Request() req: any): Promise<CasosDoClienteLabResposta> {
    return this.service.listarCasosDoCliente(contaDe(req), patientId);
  }

  @Get('lab/procedure-specs')
  listProcedureSpecs(@Request() req: any): Promise<FichasTecnicasLabResposta> {
    return this.service.listarFichas(contaDe(req));
  }

  @Get('procedures/:procedureId/lab-spec')
  getProcedureSpec(@Param('procedureId') procedureId: string, @Request() req: any): Promise<FichaTecnicaLabResposta> {
    return this.service.lerFicha(contaDe(req), procedureId);
  }

  @Roles('ADMIN')
  @Put('procedures/:procedureId/lab-spec')
  putProcedureSpec(
    @Param('procedureId') procedureId: string,
    @Body() dto: PutProcedureLabSpecDto,
    @Request() req: any,
  ): Promise<FichaTecnicaLabResposta> {
    return this.service.gravarFicha(contaDe(req), procedureId, dto);
  }

  @RequiresPermission('manage_proposals', 'view_proposals', 'create_evaluation')
  @Get('quotes/:quoteId/lab-case')
  getQuoteCase(@Param('quoteId') quoteId: string, @Request() req: any): Promise<FichaDoCasoLabResposta> {
    return this.service.lerCaso(req.user, contaDe(req), quoteId);
  }

  @RequiresPermission('manage_proposals', 'create_evaluation')
  @Put('quotes/:quoteId/lab-case')
  putQuoteCase(
    @Param('quoteId') quoteId: string,
    @Body() dto: PutQuoteLabCaseDto,
    @Request() req: any,
  ): Promise<FichaDoCasoLabResposta> {
    return this.service.gravarCaso(req.user, contaDe(req), quoteId, dto);
  }
}
