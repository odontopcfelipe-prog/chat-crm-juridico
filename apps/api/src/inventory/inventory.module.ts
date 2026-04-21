import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { SuppliersService } from './suppliers.service';
import { ProductsService } from './products.service';
import { StockMovementsService } from './stock-movements.service';
import { ProcedureConsumablesService } from './procedure-consumables.service';

@Module({
  controllers: [InventoryController],
  providers: [
    SuppliersService,
    ProductsService,
    StockMovementsService,
    ProcedureConsumablesService,
  ],
  exports: [
    SuppliersService,
    ProductsService,
    StockMovementsService,
    ProcedureConsumablesService,
  ],
})
export class InventoryModule {}
