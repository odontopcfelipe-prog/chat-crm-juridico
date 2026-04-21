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
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
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

@UseGuards(JwtAuthGuard)
@Controller()
export class InventoryController {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly products: ProductsService,
    private readonly movements: StockMovementsService,
    private readonly consumables: ProcedureConsumablesService,
  ) {}

  // ─── Suppliers ────────────────────────────────────────────────

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

  @Patch('suppliers/:id')
  updateSupplier(@Param('id') id: string, @Body() dto: UpdateSupplierDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.suppliers.update(id, tenantId, dto);
  }

  @Delete('suppliers/:id')
  archiveSupplier(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.suppliers.archive(id, tenantId);
  }

  // ─── Products ────────────────────────────────────────────────

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

  @Patch('products/:id')
  updateProduct(@Param('id') id: string, @Body() dto: UpdateProductDto, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.products.update(id, tenantId, dto);
  }

  @Delete('products/:id')
  archiveProduct(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.products.archive(id, tenantId);
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

  @Delete('procedure-consumables/:id')
  unlinkConsumable(@Param('id') id: string, @Request() req: any) {
    const tenantId = req.user?.tenant_id;
    if (!tenantId) throw new BadRequestException('tenant_id ausente');
    return this.consumables.remove(tenantId, id);
  }
}
