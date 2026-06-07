/**
 * Onda 17.32.116 — Endpoint que lista os 5 setores + catalogo de
 * permissoes. Usado pela UI do modal Editar Usuario (mostra os
 * cards de setor + checkboxes de permissoes pre-marcadas).
 *
 * Qualquer usuario autenticado pode listar.
 */
import { Controller, Get } from '@nestjs/common';
import { SECTORS, PERMISSIONS, permissionsByGroup } from '@crm/shared';

@Controller('sectors')
export class SectorsController {
  @Get()
  list() {
    return {
      sectors: SECTORS,
      permissions: PERMISSIONS,
      groups: permissionsByGroup(),
    };
  }
}
