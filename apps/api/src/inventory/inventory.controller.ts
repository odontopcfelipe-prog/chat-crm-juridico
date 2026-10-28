import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Request,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { createHash } from 'crypto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequiresPermission } from '../auth/decorators/requires-permission.decorator';
import { SuppliersService } from './suppliers.service';
import { ProductsService } from './products.service';
import { StockMovementsService } from './stock-movements.service';
import { ProcedureConsumablesService } from './procedure-consumables.service';
import { CreateSupplierDto, UpdateSupplierDto } from './dto/supplier.dto';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { CreateStockMovementDto } from './dto/stock-movement.dto';
import { CreateProcedureConsumableDto } from './dto/procedure-consumable.dto';

function parseBool(v?: string): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return v === 'true' || v === '1';
}

/**
 * Estoque. LEITURA fica aberta a qualquer usuario do tenant (a tela lista pra
 * todo mundo); toda ESCRITA exige `manage_inventory`. Antes o controller tinha
 * so o JwtAuthGuard: qualquer pessoa logada dava entrada, saida e — pior —
 * AJUSTE de saldo, que e a operacao mais sensivel de um estoque (reescreve o
 * saldo sem deixar rastro de quanto entrou ou saiu). Admin tem a permissao
 * automaticamente; recepcao e ACD/ASB recebem por padrao; os demais setores o
 * admin libera individualmente em Usuarios.
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class InventoryController {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly products: ProductsService,
    private readonly movements: StockMovementsService,
    private readonly consumables: ProcedureConsumablesService,
  ) {}

  // ─── Politica de estoque do tenant (o "botao" por clinica) ────

  /** Le a politica de saldo negativo. Aberto (a tela mostra o estado do botao). */
  @Get('inventory/policy')
  async getPolicy(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return { block_negative: await this.movements.blocksNegativeStock(tenantId) };
  }

  /** Liga/desliga o bloqueio de saida sem saldo. So quem gerencia estoque. */
  @RequiresPermission('manage_inventory')
  @Patch('inventory/policy')
  async setPolicy(@Body() body: { block_negative?: boolean }, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.movements.setBlocksNegativeStock(tenantId, body?.block_negative === true);
  }

  // ─── Consumo de insumo pela venda (fase 2) ────────────────────

  /** O que sairia do estoque se esta venda fechasse agora (tela de venda rápida). */
  @Post('inventory/consumption/preview')
  previewConsumption(
    @Body() body: { items: Array<{ procedure_id: string; quantity?: number }> },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.consumables.previewConsumption(tenantId, body?.items || []);
  }

  /** Gera as saídas de estoque da venda. Idempotente por quote_id. */
  @RequiresPermission('manage_proposals')
  @Post('inventory/consumption/commit')
  commitConsumption(
    @Body() body: {
      items: Array<{ procedure_id: string; quantity?: number }>;
      quote_id?: string;
      notes?: string;
    },
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.consumables.commitConsumption(tenantId, req.user?.id, body || { items: [] });
  }

  // ─── Suppliers ────────────────────────────────────────────────

  @RequiresPermission('manage_inventory')
  @Post('suppliers')
  createSupplier(@Body() dto: CreateSupplierDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.suppliers.create(tenantId, dto);
  }

  @Get('suppliers')
  listSuppliers(
    @Request() req: any,
    @Query('search') search?: string,
    @Query('category') category?: string,
    @Query('active') active?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.suppliers.findAll(tenantId, {
      search,
      category,
      active: parseBool(active),
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('suppliers/:id')
  getSupplier(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.suppliers.findOne(id, tenantId);
  }

  @RequiresPermission('manage_inventory')
  @Patch('suppliers/:id')
  updateSupplier(@Param('id') id: string, @Body() dto: UpdateSupplierDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.suppliers.update(id, tenantId, dto);
  }

  @RequiresPermission('manage_inventory')
  @Delete('suppliers/:id')
  archiveSupplier(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.suppliers.archive(id, tenantId);
  }

  // ─── Products ────────────────────────────────────────────────

  @RequiresPermission('manage_inventory')
  @Post('products')
  createProduct(@Body() dto: CreateProductDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.products.create(tenantId, dto);
  }

  @Get('products')
  listProducts(
    @Request() req: any,
    @Query('search') search?: string,
    @Query('category') category?: string,
    @Query('active') active?: string,
    @Query('injectable') injectable?: string,
    @Query('lowStock') lowStock?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.products.findAll(tenantId, {
      search,
      category,
      active: parseBool(active),
      injectable: parseBool(injectable),
      lowStock: parseBool(lowStock),
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('products/low-stock')
  listLowStock(@Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.products.findLowStock(tenantId);
  }

  @Get('products/:id')
  getProduct(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.products.findOne(id, tenantId);
  }

  @RequiresPermission('manage_inventory')
  @Patch('products/:id')
  updateProduct(@Param('id') id: string, @Body() dto: UpdateProductDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.products.update(id, tenantId, dto);
  }

  @RequiresPermission('manage_inventory')
  @Delete('products/:id')
  archiveProduct(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.products.archive(id, tenantId);
  }

  /** Envia/troca a foto: POST /products/:id/photo (multipart, campo "file") */
  @RequiresPermission('manage_inventory')
  @Post('products/:id/photo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  uploadProductPhoto(@Param('id') id: string, @UploadedFile() file: any, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    if (!file) throw new BadRequestException('Nenhum arquivo enviado.');
    return this.products.updatePhoto(id, tenantId, file.buffer, file.mimetype);
  }

  /** Serve a foto: GET /products/:id/photo. Fora do throttle (uma por linha da lista),
   *  com ETag do conteudo pra trocar de foto sem ficar preso no cache. */
  @SkipThrottle()
  @Get('products/:id/photo')
  async getProductPhoto(@Param('id') id: string, @Request() req: any, @Res() res: Response) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    const result = await this.products.getPhoto(id, tenantId);
    if (!result) throw new NotFoundException('Foto nao encontrada.');
    const etag = `"${createHash('sha1').update(result.buffer).digest('hex')}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'private, max-age=0, must-revalidate');
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.set('Content-Type', result.mimeType);
    res.end(result.buffer);
  }

  /** Remove a foto: DELETE /products/:id/photo */
  @RequiresPermission('manage_inventory')
  @Delete('products/:id/photo')
  removeProductPhoto(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.products.removePhoto(id, tenantId);
  }

  @Get('products/:id/stock-history')
  productStockHistory(
    @Param('id') id: string,
    @Request() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.movements.findAll(tenantId, {
      product_id: id,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  // ─── Stock Movements ────────────────────────────────────────────────

  @RequiresPermission('manage_inventory')
  @Post('stock-movements')
  createMovement(@Body() dto: CreateStockMovementDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    const userId = req.user?.id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.movements.create(tenantId, userId, dto);
  }

  @Get('stock-movements')
  listMovements(
    @Request() req: any,
    @Query('product_id') product_id?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.movements.findAll(tenantId, {
      product_id,
      type,
      from,
      to,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  /** Rastreabilidade reversa por lote — critico ANVISA. */
  @Get('stock-movements/by-batch/:batch')
  getByBatch(@Param('batch') batch: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.movements.findByBatch(tenantId, batch);
  }

  @Get('stock-movements/expiring')
  getExpiring(@Request() req: any, @Query('days') days?: string) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.movements.findExpiring(tenantId, days ? parseInt(days, 10) : 60);
  }

  // ─── Procedure Consumables ────────────────────────────────────────────────

  @RequiresPermission('manage_inventory')
  @Post('procedures/:procedureId/consumables')
  linkConsumable(
    @Param('procedureId') procedureId: string,
    @Body() dto: CreateProcedureConsumableDto,
    @Request() req: any,
  ) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.consumables.create(tenantId, procedureId, dto);
  }

  @Get('procedures/:procedureId/consumables')
  listConsumables(@Param('procedureId') procedureId: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.consumables.findByProcedure(tenantId, procedureId);
  }

  @RequiresPermission('manage_inventory')
  @Delete('procedure-consumables/:id')
  unlinkConsumable(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.consumables.remove(tenantId, id);
  }
}
