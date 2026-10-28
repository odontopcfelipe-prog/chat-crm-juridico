import { Module } from '@nestjs/common';
import { InventoryController } from './inventory.controller';
import { SuppliersService } from './suppliers.service';
import { ProductsService } from './products.service';
import { StockMovementsService } from './stock-movements.service';
import { ProcedureConsumablesService } from './procedure-consumables.service';
import { FileStorageService } from '../media/filesystem.service';

@Module({
  controllers: [InventoryController],
  providers: [
    SuppliersService,
    ProductsService,
    StockMovementsService,
    ProcedureConsumablesService,
    // Foto do produto. Provider direto (como Patients/Users/SmileDesign) em vez de
    // importar o MediaModule, pra nao puxar dependencia entre modulos.
    FileStorageService,
  ],
  exports: [
    SuppliersService,
    ProductsService,
    StockMovementsService,
    ProcedureConsumablesService,
  ],
})
export class InventoryModule {}
