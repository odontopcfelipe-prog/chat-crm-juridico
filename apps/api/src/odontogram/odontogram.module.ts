import { Module } from '@nestjs/common';
import { OdontogramService } from './odontogram.service';
import { OdontogramController } from './odontogram.controller';
import { StateSuggestionsService } from './state-suggestions.service';

@Module({
  controllers: [OdontogramController],
  providers: [OdontogramService, StateSuggestionsService],
  exports: [OdontogramService, StateSuggestionsService],
})
export class OdontogramModule {}
